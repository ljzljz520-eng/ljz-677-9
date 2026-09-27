'use strict';
// 用法: node tools/generate-sample.js [行数=50000] [输出文件]
const path = require('path');
const ExcelJS = require('exceljs');
const { SAMPLING_POINTS, METRICS } = require('../src/master-data');

const N = Number(process.argv[2]) || 50000;
const outFile = process.argv[3] || path.join(__dirname, '..', 'uploads', `sample_${N}.xlsx`);

// 可复现的伪随机
let seed = 20260926 >>> 0;
// 浮点域 LCG，避免“整数 rnd 放大”导致低位精度丢失
function rnd() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
function pad(n) { return String(n).padStart(2, '0'); }

// 固定基准时间，保证采样时间恒在 90 天窗口内
const BASE = Date.UTC(2026, 8, 20, 12, 0, 0); // 2026-09-20（相对当前日期为近期）
const WINDOW_SEC = 89 * 86400;

async function main() {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: outFile });
  const ws = wb.addWorksheet('数据上送');
  ws.columns = [
    { header: '采样点', key: 'sp', width: 26 },
    { header: '检测指标', key: 'metric', width: 14 },
    { header: '单位', key: 'unit', width: 10 },
    { header: '检测值', key: 'value', width: 12 },
    { header: '采样时间', key: 'time', width: 22 },
  ];
  ws.getRow(1).font = { bold: true };

  for (let i = 0; i < N; i++) {
    const [pcode, pname] = pick(SAMPLING_POINTS);
    const m = pick(METRICS);
    const useName = rnd() < 0.5; // 一半用名称，一半用编码
    let point = useName ? pname : pcode;
    let metric = useName ? m.name : m.code;
    let unit = pick(m.units);
    // 70% 取合理范围中部；30% 取靠近上限以制造平台侧超标异常
    let value;
    const span = m.max - m.min;
    if (rnd() < 0.3) value = m.max - span * 0.05 * rnd();
    else value = m.min + span * (0.2 + rnd() * 0.5);
    value = Number(value.toFixed(m.decimals));

    // 时间在 89 天秒级空间均匀分布
    const t = new Date(BASE - Math.floor(rnd() * WINDOW_SEC) * 1000);
    let time = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
               `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;

    // 注入约 3% 的各类校验错误
    const fault = rnd();
    if (fault < 0.007) point = 'XX-999 不存在的采样点';
    else if (fault < 0.014) metric = '氯化物(未登记)';
    else if (fault < 0.020) unit = 'ppm';
    else if (fault < 0.026) value = 'N/A';
    else if (fault < 0.032) time = '2024-01-01 00:00:00';

    ws.addRow({ sp: point, metric, unit, value, time }).commit();
  }

  await wb.commit();
  console.log(`已生成 ${N} 行: ${outFile}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
