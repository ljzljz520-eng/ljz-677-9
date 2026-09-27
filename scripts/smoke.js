// 端到端冒烟测试：生成数据 → 上传 → 等待完成 → 校验计数/明细分页/报告下载
import { spawn } from 'node:child_process';
import Excel from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 4399;
const ROWS = Number(process.env.SMOKE_ROWS || 5000);
const BASE = `http://localhost:${PORT}`;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-smoke-'));
const sample = path.join(workDir, 'sample.xlsx');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✅ ${msg}`); }
  else { failures += 1; console.error(`  ❌ ${msg}`); }
}

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try { const r = await fetch(`${BASE}/api/reference`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务器未在 10s 内就绪');
}

async function generateSample() {
  console.log(`生成 ${ROWS} 行样本…`);
  const wb = new Excel.stream.xlsx.WorkbookWriter({ filename: sample });
  const ws = wb.addWorksheet('水质数据');
  ws.columns = [
    { header: '采样点编码', key: 'p', width: 12 }, { header: '指标编码', key: 'i', width: 10 },
    { header: '数值', key: 'v', width: 10 }, { header: '单位', key: 'u', width: 10 },
    { header: '采样时间', key: 't', width: 20 },
  ];
  ws.getRow(1).commit();
  const points = ['SP001', 'SP002', 'SP003', 'SP004', 'SP005'];
  for (let n = 0; n < ROWS; n += 1) {
    const bad = n % 100 === 0;
    const overLimit = n % 37 === 0;
    ws.addRow({
      p: bad && n % 3 === 0 ? 'SPX' : points[n % points.length],
      i: bad && n % 3 === 1 ? 'NOPE' : 'NH3N',
      v: bad && n % 3 === 2 ? 'abc' : overLimit ? 1.8 : 0.3,
      u: 'mg/L',
      t: new Date(Date.now() - n * 60000).toISOString().replace('T', ' ').slice(0, 19),
    }).commit();
  }
  await wb.commit();
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// SSE 需要在拿到 jobId 后才能连接，用 deferred 把 id 传给等待中的监听协程
function waitForJobId() {
  const d = deferred();
  return Object.assign(d.promise, { provide: d.resolve });
}

async function upload(jobIdBridge) {
  const buf = fs.readFileSync(sample);
  const blob = new Blob([buf]);
  const fd = new FormData();
  fd.append('file', blob, 'sample.xlsx');
  const r = await fetch(`${BASE}/api/jobs`, { method: 'POST', body: fd });
  assert(r.status === 202, `上传返回 202（实际 ${r.status}）`);
  const job = await r.json();
  jobIdBridge.provide(job.id);
  return job;
}

async function waitDone(id) {
  let snap;
  const t0 = Date.now();
  while (true) {
    const r = await fetch(`${BASE}/api/jobs/${id}`);
    snap = await r.json();
    if (['DONE', 'PARTIAL', 'CANCELED', 'ERROR'].includes(snap.status)) break;
    if (Date.now() - t0 > 60000) throw new Error('任务超时未完成');
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('  最终快照:', JSON.stringify(snap.counts), snap.status);
  return snap;
}

async function main() {
  const server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), WQ_REPORT_BATCH_SIZE: '200', WQ_REPORT_CONCURRENCY: '4' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`));

  try {
    await waitForServer();
    await generateSample();

    // 先建立 SSE，再上传，验证能收到「实时」进度帧（而非只收到最终快照）
    const sseFrames = [];
    const sseReady = waitForJobId();
    const sseDone = sseReady.then((id) => new Promise((resolve, reject) => {
      const ac = new AbortController();
      fetch(`${BASE}/api/jobs/${id}/events`, { signal: ac.signal })
        .then(async (r) => {
          if (r.status !== 200) return reject(new Error('SSE 非 200'));
          const reader = r.body.getReader();
          const decoder = new TextDecoder();
          while (sseFrames.length < 3) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            const m = text.match(/data: (\{.*\})/);
            if (m) sseFrames.push(JSON.parse(m[1]));
          }
          ac.abort();
          resolve();
        }).catch((e) => { if (e.name !== 'AbortError') reject(e); else resolve(); });
    }));

    const job = await upload(sseReady);
    assert(job.id && job.status === 'PARSING', '任务创建并进入解析阶段');
    await sseDone;
    assert(sseFrames.length >= 3, `SSE 实时推送多帧进度（收到 ${sseFrames.length} 帧）`);
    assert(sseFrames.some((f) => f.counts && f.counts.totalRows > 0), 'SSE 帧包含递增的解析计数');

    const snap = await waitDone(job.id);
    assert(snap.counts.totalRows === ROWS, `总行数 ${snap.counts.totalRows} = ${ROWS}`);
    assert(snap.counts.invalid > 0, `存在校验失败行（${snap.counts.invalid}）`);
    assert(snap.counts.valid + snap.counts.invalid === ROWS, '通过 + 失败 = 总行数');
    assert(snap.counts.reported === snap.counts.valid, '全部有效记录已上报');
    assert(snap.counts.anomalies > 0, `平台返回异常（${snap.counts.anomalies} 条氨氮超标）`);
    assert(snap.status === 'DONE', '模拟平台下任务状态为 DONE');

    const errPage = await (await fetch(`${BASE}/api/jobs/${job.id}/details/errors?page=1&pageSize=10`)).json();
    assert(errPage.items.length === 10 && errPage.total === snap.counts.invalid, '错误明细分页正确');
    assert(errPage.items[0].errors[0].field, '错误项含字段名与说明');

    const anPage = await (await fetch(`${BASE}/api/jobs/${job.id}/details/anomalies?page=1&pageSize=5`)).json();
    assert(anPage.total === snap.counts.anomalies && anPage.items[0].message, '异常明细分页与说明正确');

    const rep = await fetch(`${BASE}/api/jobs/${job.id}/report`);
    assert(rep.status === 200, 'Excel 报告可下载');
    const repBuf = Buffer.from(await rep.arrayBuffer());
    assert(repBuf.slice(0, 2).toString() === 'PK', '报告为合法 xlsx（ZIP 头 PK）');
    assert(repBuf.length > 1000, `报告体积合理（${(repBuf.length / 1024).toFixed(1)} KB）`);

    console.log(`\n内存占用（服务进程 RSS）: ${(serverRss(server) / 1024 / 1024).toFixed(1)} MB`);
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\n🎉 全部冒烟测试通过' : `\n💥 ${failures} 项断言失败`);
  process.exit(failures === 0 ? 0 : 1);
}

function serverRss(proc) {
  try {
    const stat = fs.readFileSync(`/proc/${proc.pid}/stat`, 'utf8').split(' ');
    return Number(stat[23]) * 4096; // Linux page size
  } catch { return 0; }
}

main().catch((err) => { console.error(err); process.exit(1); });
