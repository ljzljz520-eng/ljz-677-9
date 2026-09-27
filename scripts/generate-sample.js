// 生成几万行的水质检测样本（约 2% 校验错误、若干超标值）
import Excel from 'exceljs';
import path from 'node:path';
import fs from 'node:fs';

const rows = Number(process.argv[2] || 50000);
const outDir = path.join(process.cwd(), 'data', 'samples');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `water-sample-${rows}.xlsx`);

const points = ['SP001', 'SP002', 'SP003', 'SP004', 'SP005', 'SP006', 'SP007', 'SP008'];
const indicators = [
  { code: 'PH', units: ['无量纲'], range: [5.5, 9.5] },
  { code: 'DO', units: ['mg/L'], range: [2, 12] },
  { code: 'CODMN', units: ['mg/L'], range: [1, 9] },
  { code: 'COD', units: ['mg/L'], range: [5, 35] },
  { code: 'NH3N', units: ['mg/L'], range: [0.05, 2.2] },
  { code: 'TP', units: ['mg/L', 'μg/L'], range: [0.03, 0.35] },
  { code: 'TN', units: ['mg/L'], range: [0.3, 2.5] },
  { code: 'TURB', units: ['NTU'], range: [1, 400] },
];
const rnd = (a, b) => a + Math.random() * (b - a);

const wb = new Excel.stream.xlsx.WorkbookWriter({ filename: out });
const ws = wb.addWorksheet('水质数据');
ws.columns = [
  { header: '采样点编码', key: 'pointCode', width: 12 },
  { header: '指标编码', key: 'indicatorCode', width: 12 },
  { header: '数值', key: 'value', width: 10 },
  { header: '单位', key: 'unit', width: 10 },
  { header: '采样时间', key: 'sampledAt', width: 20 },
];
ws.getRow(1).commit();

const baseTime = Date.now();
for (let i = 0; i < rows; i += 1) {
  const ind = indicators[i % indicators.length];
  const roll = Math.random();
  let pointCode = points[i % points.length];
  let code = ind.code;
  let value = Number(rnd(ind.range[0], ind.range[1]).toFixed(3));
  let unit = ind.units[0];

  // ~2% 校验错误
  if (roll < 0.005) pointCode = 'SP999';            // 未知采样点
  else if (roll < 0.010) code = 'XX';               // 未知指标
  else if (roll < 0.015) unit = 'ppm';              // 非法单位
  else if (roll < 0.020) value = '非数字';           // 数值非法

  // 偶发未来时间（非法）
  let sampledAt = new Date(baseTime - Math.floor(rnd(0, 30 * 86400e3)));
  if (roll >= 0.020 && roll < 0.023) sampledAt = new Date(baseTime + 10 * 86400e3);

  ws.addRow({
    pointCode, indicatorCode: code,
    value,
    unit,
    sampledAt: sampledAt.toISOString().replace('T', ' ').slice(0, 19),
  }).commit();

  if (i % 10000 === 0) console.log(`生成 ${i}/${rows}`);
}
await wb.commit();
const stat = fs.statSync(out);
console.log(`完成: ${out} (${(stat.size / 1024 / 1024).toFixed(2)} MB, ${rows} 行)`);
