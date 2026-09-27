import Excel from 'exceljs';
import readline from 'node:readline';
import fs from 'node:fs';
import yauzl from 'yauzl';
import { normalizeHeader } from './validator.js';

/**
 * 流式解析 Excel，逐行通过 onRow 回调产出，回调可异步（自动背压）。
 * 不会把整个工作簿模型放进内存，几万行 / 几百 MB 文件内存占用基本恒定。
 *
 * 文件要求：第一行表头，必须包含
 *   采样点编码 | 指标编码 | 数值 | 单位 | 采样时间
 */
export async function parseExcel(filePath, onRow, onHeader) {
  const ext = filePath.toLowerCase().split('.').pop();
  if (ext === 'csv') return parseCsv(filePath, onRow, onHeader);
  if (ext !== 'xlsx') throw new Error(`不支持的文件类型: ${ext}（仅支持 .xlsx / .csv）`);
  return parseXlsx(filePath, onRow, onHeader);
}

async function parseXlsx(filePath, onRow, onHeader) {
  // worksheets: 'emit' 使每张表通过迭代器产出，而非一次性加载
  const workbook = new Excel.stream.xlsx.WorkbookReader(filePath, {
    worksheets: 'emit',
    entries: 'emit',
  });

  let sheetIndex = 0;
  for await (const worksheet of workbook) {
    sheetIndex += 1;
    if (sheetIndex > 1) break; // 仅处理第一张工作表
    let headers = null;
    let lineNo = 0;

    for await (const row of worksheet) {
      lineNo += 1;
      const values = rowToValues(row);

      if (!headers) {
        headers = buildHeaders(values, onHeader);
        continue;
      }
      if (values.every((v) => v === null || v === undefined || v === '')) continue; // 跳过空行

      const obj = {};
      headers.forEach((key, idx) => {
        if (key) obj[key] = values[idx];
      });
      await onRow(obj, lineNo);
    }
  }
}

function rowToValues(row) {
  const out = [];
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    out[colNumber - 1] = normalizeCell(cell);
  });
  return out;
}

function normalizeCell(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    // 公式结果 { formula, result } / 富文本 { richText:[...] } / 超链接
    if ('result' in v) return v.result;
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return v.text;
    if ('hyperlink' in v) return v.text ?? v.hyperlink;
  }
  return v;
}

function buildHeaders(values, onHeader) {
  const headers = normalizeHeader(values);
  const required = ['pointCode', 'indicatorCode', 'value', 'unit', 'sampledAt'];
  const missing = required.filter((k) => !headers.includes(k));
  if (missing.length) {
    const nameMap = { pointCode: '采样点编码', indicatorCode: '指标编码', value: '数值', unit: '单位', sampledAt: '采样时间' };
    throw new Error(`表头缺少必需列: ${missing.map((m) => nameMap[m]).join('、')}`);
  }
  onHeader?.(values.map((v) => String(v ?? '').trim()));
  return headers;
}

// —— CSV：逐行读取，内存恒定 ——
async function parseCsv(filePath, onRow, onHeader) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headers = null;
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    const values = parseCsvLine(line);
    if (!headers) {
      headers = buildHeaders(values, onHeader);
      continue;
    }
    if (values.every((v) => v === '')) continue;
    const obj = {};
    headers.forEach((key, idx) => { if (key) obj[key] = values[idx]; });
    await onRow(obj, lineNo);
  }
}

// 支持引号、转义双引号的极简 CSV 行解析
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * 最佳努力：从 xlsx 的 sheet XML 读取 <dimension ref="A1:G50001"/> 估算总行数。
 * 只读 ZIP 中单个 sheet 的开头一小段，失败不影响主流程。
 */
export function getRowCountHint(filePath) {
  if (!filePath.toLowerCase().endsWith('.xlsx')) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    yauzl.open(filePath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return finish(null);
      const timer = setTimeout(() => { try { zip.close(); } catch {} finish(null); }, 5000);

      zip.on('entry', (entry) => {
        if (/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.fileName)) {
          zip.openReadStream(entry, (e, stream) => {
            if (e) { clearTimeout(timer); finish(null); return; }
            // 头部保留 200KB 用于 <dimension>；尾部滚动保留 256KB 用于取最后行号
            let head = Buffer.alloc(0);
            let tail = Buffer.alloc(0);
            const TAIL = 262144;
            stream.on('data', (chunk) => {
              if (head.length < 200000) {
                head = Buffer.concat([head, chunk]).subarray(0, 200000);
                const m = head.toString('utf8').match(/<dimension[^>]*ref="[A-Z]+\d+(?::[A-Z]+(\d+))?"/);
                if (m && m[1]) {
                  stream.destroy();
                  clearTimeout(timer);
                  finish(Math.max(0, Number(m[1]) - 1)); // 减去表头行
                }
              }
              tail = Buffer.concat([tail, chunk]).subarray(-TAIL);
            });
            stream.on('end', () => {
              clearTimeout(timer);
              // 无 dimension（exceljs 流式输出即如此）→ 取尾部最大单元格行号
              const refs = tail.toString('utf8').match(/<(?:row r="|c r="[A-Z]+)(\d+)"/g) || [];
              let max = 0;
              for (const ref of refs) {
                const n = Number(ref.match(/(\d+)"?$/)[1]);
                if (n > max) max = n;
              }
              finish(max > 0 ? max - 1 : null);
            });
            stream.on('error', () => { clearTimeout(timer); finish(null); });
          });
        } else {
          zip.readEntry();
        }
      });
      zip.on('end', () => { clearTimeout(timer); finish(null); });
      zip.on('error', () => { clearTimeout(timer); finish(null); });
      zip.readEntry();
    });
  });
}
