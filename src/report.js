'use strict';
const ExcelJS = require('exceljs');
const { db } = require('./db');
const { METRICS } = require('./master-data');

function wb(res, filename) {
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
}

async function writeErrors(res, job) {
  const workbook = wb(res, `校验错误_${job.id}.xlsx`);
  const ws = workbook.addWorksheet('校验错误');
  ws.columns = [
    { header: 'Excel行号', key: 'row_no', width: 10 },
    { header: '错误字段', key: 'field', width: 14 },
    { header: '错误说明', key: 'message', width: 60 },
    { header: '原始数据', key: 'raw', width: 80 },
  ];
  ws.getRow(1).font = { bold: true };
  const rows = db.prepare('SELECT row_no,field,message,raw FROM row_errors WHERE job_id=? ORDER BY id').all(job.id);
  const fieldCN = {
    sampling_point: '采样点', metric: '检测指标', unit: '单位',
    value: '检测值', sampled_at: '采样时间', duplicate: '重复报送', header: '表头',
  };
  for (const r of rows) {
    ws.addRow({ ...r, field: fieldCN[r.field] || r.field }).commit();
  }
  await workbook.commit();
}

async function writeAbnormals(res, job) {
  const workbook = wb(res, `平台异常_${job.id}.xlsx`);
  const ws = workbook.addWorksheet('平台异常结果');
  ws.columns = [
    { header: 'Excel行号', key: 'row_no', width: 10 },
    { header: '采样点', key: 'point', width: 28 },
    { header: '检测指标', key: 'metric', width: 14 },
    { header: '检测值', key: 'value', width: 10 },
    { header: '单位', key: 'unit', width: 10 },
    { header: '采样时间', key: 'sampled_at', width: 22 },
    { header: '异常码', key: 'code', width: 14 },
    { header: '平台判定', key: 'message', width: 44 },
    { header: '返回时间', key: 'returned_at', width: 22 },
  ];
  ws.getRow(1).font = { bold: true };
  const rows = db.prepare(`
    SELECT a.*, jr.point_name, jr.metric_name, jr.unit, jr.sampled_at
    FROM platform_abnormals a LEFT JOIN job_rows jr ON jr.job_id=a.job_id AND jr.row_no=a.row_no
    WHERE a.job_id=? ORDER BY a.id`).all(job.id);
  for (const r of rows) {
    ws.addRow({
      row_no: r.row_no, point: r.point_name, metric: r.metric_name,
      value: r.value, unit: r.unit,
      sampled_at: r.sampled_at && r.sampled_at.replace('T', ' ').slice(0, 19),
      code: r.code, message: r.message,
      returned_at: r.returned_at.replace('T', ' ').slice(0, 19),
    }).commit();
  }
  await workbook.commit();
}

async function writeReport(res, job) {
  const workbook = wb(res, `水质检测报告_${job.id}.xlsx`);

  // --- 汇总页 ---
  const s = workbook.addWorksheet('报告汇总');
  const kv = [
    ['任务编号', job.id], ['源文件', job.filename],
    ['任务状态', statusCN(job.status)],
    ['数据总行数', job.total_rows],
    ['校验有效', job.valid_rows], ['校验错误', job.invalid_rows],
    ['平台已接收', job.uploaded_rows], ['平台异常', job.abnormal_rows],
    ['创建时间', fmt(job.created_at)], ['完成时间', fmt(job.finished_at)],
    ['错误信息', job.error_message || ''],
  ];
  s.getColumn(1).width = 16; s.getColumn(2).width = 60;
  for (const [k, v] of kv) {
    const row = s.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    row.commit();
  }
  s.commit();

  // --- 异常明细 ---
  const aw = workbook.addWorksheet('平台异常明细');
  aw.columns = [
    { header: '行号', key: 'row_no', width: 8 }, { header: '采样点', key: 'p', width: 28 },
    { header: '指标', key: 'm', width: 12 }, { header: '检测值', key: 'v', width: 10 },
    { header: '异常说明', key: 'msg', width: 44 },
  ];
  aw.getRow(1).font = { bold: true };
  const abn = db.prepare(`
    SELECT a.row_no,a.message,a.value,jr.point_name,jr.metric_name
    FROM platform_abnormals a LEFT JOIN job_rows jr ON jr.job_id=a.job_id AND jr.row_no=a.row_no
    WHERE a.job_id=?`).all(job.id);
  for (const r of abn) {
    aw.addRow({ row_no: r.row_no, p: r.point_name, m: r.metric_name, v: r.value, msg: r.message }).commit();
  }
  aw.commit();

  // --- 指标统计 ---
  const mw = workbook.addWorksheet('指标统计');
  mw.columns = [
    { header: '指标编码', key: 'c', width: 10 }, { header: '指标名称', key: 'n', width: 14 },
    { header: '条数', key: 'cnt', width: 8 }, { header: '最小值', key: 'mn', width: 10 },
    { header: '最大值', key: 'mx', width: 10 }, { header: '平均值', key: 'avg', width: 10 },
    { header: '异常数', key: 'abn', width: 8 },
  ];
  mw.getRow(1).font = { bold: true };
  const stats = db.prepare(`
    SELECT metric_code c, metric_name n, COUNT(*) cnt,
           ROUND(MIN(value),4) mn, ROUND(MAX(value),4) mx, ROUND(AVG(value),4) avg,
           SUM(status='abnormal') abn
    FROM job_rows WHERE job_id=? GROUP BY metric_code ORDER BY metric_code`).all(job.id);
  for (const r of stats) mw.addRow(r).commit();
  mw.commit();

  // --- 全部有效/已上送数据（流式，不进内存）---
  const dw = workbook.addWorksheet('数据明细');
  dw.columns = [
    { header: '行号', key: 'row_no', width: 8 },
    { header: '采样点编码', key: 'point_code', width: 12 },
    { header: '采样点', key: 'point_name', width: 28 },
    { header: '指标编码', key: 'metric_code', width: 10 },
    { header: '指标', key: 'metric_name', width: 14 },
    { header: '检测值', key: 'value', width: 10 },
    { header: '单位', key: 'unit', width: 10 },
    { header: '采样时间', key: 'sampled_at', width: 22 },
    { header: '状态', key: 'status', width: 10 },
  ];
  dw.getRow(1).font = { bold: true };
  const statusMap = { uploaded: '已接收', abnormal: '异常', valid: '待上送', upload_failed: '上送失败', uploading: '上送中' };
  const cursor = db.prepare('SELECT * FROM job_rows WHERE job_id=? ORDER BY id').iterate(job.id);
  for (const r of cursor) {
    dw.addRow({
      ...r,
      sampled_at: r.sampled_at && r.sampled_at.replace('T', ' ').slice(0, 19),
      status: statusMap[r.status] || r.status,
    }).commit();
  }
  await workbook.commit();
}

async function writeTemplate(res) {
  const workbook = wb(res, '水质检测数据导入模板.xlsx');
  const ws = workbook.addWorksheet('数据上送');
  ws.columns = [
    { header: '采样点', key: 'sampling_point', width: 26 },
    { header: '检测指标', key: 'metric', width: 14 },
    { header: '单位', key: 'unit', width: 10 },
    { header: '检测值', key: 'value', width: 10 },
    { header: '采样时间', key: 'sampled_at', width: 22 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRow({
    sampling_point: 'SP-001', metric: 'PH', unit: '无量纲',
    value: 7.21, sampled_at: '2026-09-25 09:00:00',
  }).commit();
  ws.addRow({
    sampling_point: '长江-南京段-取水口', metric: '溶解氧', unit: 'mg/L',
    value: 6.8, sampled_at: '2026-09-25 09:00:00',
  }).commit();
  ws.commit();

  const guide = workbook.addWorksheet('填写说明');
  guide.columns = [{ header: '说明', key: 't', width: 90 }];
  const lines = [
    '1. 采样点/检测指标均支持“编码”或“名称”填写，须在基础库目录内。',
    `2. 检测指标：${METRICS.map((m) => `${m.name}(${m.code})`).join('、')}`,
    '3. 单位必须与指标匹配，例如 氨氮=mg/L、浊度=NTU、水温=℃、pH=无量纲。',
    '4. 采样时间支持 Excel 日期格式或 2026-09-25 09:00:00，仅允许最近 90 天内数据。',
    '5. 同一采样点 + 指标 + 采样时间(秒级) 在同一文件中重复出现将被判为重复报送。',
    '6. 大文件无需拆分，系统按每 1000 行分批流式解析，建议单文件不超过 50 万行。',
  ];
  guide.getRow(1).font = { bold: true };
  for (const t of lines) guide.addRow({ t }).commit();
  guide.commit();

  await workbook.commit();
}

function statusCN(s) {
  return { parsing: '解析中', parsed: '待上送', uploading: '上送中', done: '已完成', failed: '失败', canceled: '已取消' }[s] || s;
}
function fmt(s) { return s ? s.replace('T', ' ').slice(0, 19) : ''; }

module.exports = { writeErrors, writeAbnormals, writeReport, writeTemplate };
