import Excel from 'exceljs';

const LEVEL_LABEL = { OVER_LIMIT: '超标', ABNORMAL: '异常' };

/**
 * 流式生成 .xlsx 报告：概览 / 异常明细 / 校验失败 / 上报失败 四个工作表。
 * 明细从 JSONL 逐行读取、逐行 commit，内存恒定。
 */
export async function buildExcelReport(job, outputPath) {
  const wb = new Excel.stream.xlsx.WorkbookWriter({ filename: outputPath, useStyles: true });

  // —— Sheet1 概览：列宽先设，行 commit 后不再回写 ——
  const overview = wb.addWorksheet('概览');
  overview.columns = [{ width: 22 }, { width: 46 }];
  const title = overview.addRow(['水质检测上报报告']);
  title.font = { bold: true, size: 16 };
  title.commit();
  overview.addRow([]).commit();
  const rows = [
    ['任务编号', job.id],
    ['源文件', job.originalName],
    ['开始时间', fmt(job.startedAt)],
    ['完成时间', job.finishedAt ? fmt(job.finishedAt) : '-'],
    ['任务状态', statusLabel(job.status)],
    [],
    ['数据行总数', job.counts.totalRows],
    ['校验通过', job.counts.valid],
    ['校验失败', job.counts.invalid],
    ['已上报', job.counts.reported],
    ['平台返回异常', job.counts.anomalies],
    ['上报失败（可补发）', job.counts.failed],
  ];
  for (const r of rows) {
    const row = overview.addRow(r);
    if (r.length === 2 && typeof r[0] === 'string') row.getCell(1).font = { bold: true };
    row.commit();
  }
  overview.commit();

  await sheetFromJsonl(wb, '异常明细', job.files.anomalies, [
    { header: '行号', key: 'lineNo', width: 8 },
    { header: '采样点编码', key: 'pointCode', width: 12 },
    { header: '采样点', key: 'pointName', width: 18 },
    { header: '指标', key: 'indicatorName', width: 16 },
    { header: '实测值', key: 'value', width: 10 },
    { header: '单位', key: 'unit', width: 10 },
    { header: '采样时间', key: 'sampledAt', width: 22 },
    { header: '级别', key: 'levelLabel', width: 8 },
    { header: '异常说明', key: 'message', width: 46 },
  ], (o) => ({ ...o, levelLabel: LEVEL_LABEL[o.level] || o.level, sampledAt: fmt(o.sampledAt) }));

  await sheetFromJsonl(wb, '校验失败', job.files.errors, [
    { header: 'Excel 行号', key: 'lineNo', width: 10 },
    { header: '错误数', key: 'errorCount', width: 8 },
    { header: '错误明细', key: 'messages', width: 70 },
    { header: '原始内容', key: 'rawText', width: 60 },
  ], (o) => ({
    lineNo: o.lineNo,
    errorCount: o.errors.length,
    messages: o.errors.map((e) => `[${e.field}] ${e.message}`).join('；'),
    rawText: JSON.stringify(o.raw),
  }));

  await sheetFromJsonl(wb, '上报失败', job.files.failed, [
    { header: '记录ID', key: 'id', width: 26 },
    { header: 'Excel 行号', key: 'lineNo', width: 10 },
    { header: '采样点', key: 'pointCode', width: 12 },
    { header: '指标', key: 'indicatorCode', width: 12 },
    { header: '数值', key: 'value', width: 10 },
    { header: '采样时间', key: 'sampledAt', width: 22 },
    { header: '失败原因', key: 'failedReason', width: 40 },
  ], (o) => ({ ...o, sampledAt: fmt(o.sampledAt) }));

  await wb.commit();
}

async function sheetFromJsonl(wb, name, file, columns, mapper) {
  const fs = await import('node:fs');
  const readline = await import('node:readline');
  const ws = wb.addWorksheet(name);
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };

  if (fs.existsSync(file)) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      ws.addRow(mapper(obj)).commit();
    }
  }
  ws.commit();
}

function fmt(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function statusLabel(s) {
  return {
    PENDING: '等待中', PARSING: '解析校验中', REPORTING: '上报中',
    DONE: '完成', PARTIAL: '部分失败', CANCELED: '已取消', ERROR: '错误',
  }[s] || s;
}
