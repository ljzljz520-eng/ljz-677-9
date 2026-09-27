import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

// 追加写 JSONL，分批 flush，避免几万条记录占内存
export class JsonlStore {
  constructor(file) {
    this.file = file;
    this._buf = [];
    this._stream = fs.createWriteStream(file, { flags: 'a' });
  }

  append(obj) {
    this._buf.push(JSON.stringify(obj));
    if (this._buf.length >= 200) return this.flush();
    return Promise.resolve();
  }

  flush() {
    if (!this._buf.length) return Promise.resolve();
    const chunk = this._buf.splice(0).join('\n') + '\n';
    return new Promise((resolve, reject) => {
      this._stream.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close() {
    await this.flush();
    await new Promise((resolve) => this._stream.end(resolve));
  }
}

// 分页读取（前端错误明细 / 报告明细用），配合前端侧计数过滤
export async function readJsonlPage(file, { page = 1, pageSize = 50, filter = () => true } = {}) {
  if (!fs.existsSync(file)) return { total: 0, page, pageSize, items: [] };
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  const start = (page - 1) * pageSize;
  let total = 0;
  const items = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!filter(obj)) continue;
    const idx = total;
    total += 1;
    if (idx >= start && idx < start + pageSize) items.push(obj);
  }
  return { total, page, pageSize, items };
}

export function countLines(file) {
  if (!fs.existsSync(file)) return Promise.resolve(0);
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let n = 0;
  rl.on('line', (l) => { if (l.trim()) n += 1; });
  return new Promise((resolve) => rl.on('close', () => resolve(n)));
}

export function jobFiles(jobId) {
  const dir = path.join(process.env.WQ_DATA_DIR || path.join(process.cwd(), 'data'), 'jobs', jobId);
  return {
    dir,
    valid: path.join(dir, 'valid.jsonl'),
    errors: path.join(dir, 'errors.jsonl'),
    anomalies: path.join(dir, 'anomalies.jsonl'),
    failed: path.join(dir, 'failed.jsonl'),
    meta: path.join(dir, 'meta.json'),
  };
}
