import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config, UPLOAD_DIR } from './config.js';
import { parseExcel, getRowCountHint } from './parser.js';
import { validateRow } from './validator.js';
import { JsonlStore, jobFiles, countLines } from './storage.js';
import { reportBatch } from './platform-client.js';
import { buildExcelReport } from './report.js';

const jobs = new Map(); // jobId -> job
const MAX_LISTENERS = 50;

export function createJob(originalName, tmpPath, size) {
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const files = jobFiles(id);
  fs.mkdirSync(files.dir, { recursive: true });
  const ext = path.extname(originalName) || '.xlsx';
  const filePath = path.join(files.dir, `source${ext}`);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // 临时目录与数据目录跨设备时退化为拷贝
    fs.copyFileSync(tmpPath, filePath);
    fs.unlinkSync(tmpPath);
  }

  const bus = new EventEmitter();
  bus.setMaxListeners(MAX_LISTENERS);

  const job = {
    id,
    originalName,
    filePath,
    size,
    status: 'PENDING', // PENDING/PARSING/REPORTING/DONE/PARTIAL/CANCELED/ERROR
    phase: 'parse',
    cancelRequested: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    rowCountHint: null,
    counts: {
      totalRows: 0,       // 扫描的数据行（不含表头、空行）
      valid: 0,
      invalid: 0,
      reported: 0,
      anomalies: 0,
      failed: 0,
    },
    progress: { parse: 0, report: 0 },
    speed: { rowsPerSec: 0, recordsPerSec: 0 },
    files,
    bus,
  };
  jobs.set(id, job);
  persist(job).catch(() => {});
  run(job).catch((err) => fail(job, err));
  return job;
}

export function getJob(id) {
  const j = jobs.get(id);
  if (j) return j;
  // 服务重启后支持只读查询（从 meta.json 恢复快照，并补回文件路径）
  const files = jobFiles(id);
  if (fs.existsSync(files.meta)) {
    const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8'));
    return { ...meta, files, bus: null };
  }
  return null;
}

export function listJobs(limit = 20) {
  return [...jobs.values()]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, limit)
    .map(snapshot);
}

export function snapshot(job) {
  return {
    id: job.id,
    originalName: job.originalName,
    status: job.status,
    phase: job.phase,
    cancelRequested: job.cancelRequested,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    counts: job.counts,
    progress: job.progress,
    speed: job.speed,
    rowCountHint: job.rowCountHint,
    size: job.size,
  };
}

export function requestCancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (['DONE', 'PARTIAL', 'CANCELED', 'ERROR'].includes(job.status)) return false;
  job.cancelRequested = true;
  return true;
}

async function run(job) {
  job.status = 'PARSING';
  job.rowCountHint = await getRowCountHint(job.filePath).catch(() => null);
  emit(job);

  const validStore = new JsonlStore(job.files.valid);
  const errorStore = new JsonlStore(job.files.errors);

  let batch = [];
  let validSeq = 0;
  const t0 = Date.now();
  let lastEmit = 0;

  try {
    await parseExcel(
      job.filePath,
      async (raw, lineNo) => {
        if (job.cancelRequested) throw new Error('__CANCEL__');
        job.counts.totalRows += 1;

        const result = validateRow(raw, lineNo);
        if (result.ok) {
          validSeq += 1;
          batch.push({ id: `${job.id}-${validSeq}`, ...result.record });
          job.counts.valid += 1;
        } else {
          await errorStore.append({
            lineNo,
            raw: sanitizeRaw(raw),
            errors: result.errors,
          });
          job.counts.invalid += 1;
        }

        // 分批落盘，保证内存只持有当前批次
        if (batch.length >= config.parse.batchSize) {
          for (const rec of batch) await validStore.append(rec);
          batch = [];
        }

        const now = Date.now();
        if (now - lastEmit > 300) {
          const elapsed = Math.max(1, (now - t0) / 1000);
          job.speed.rowsPerSec = Math.round(job.counts.totalRows / elapsed);
          job.progress.parse = job.rowCountHint
            ? Math.min(99, Math.round((job.counts.totalRows / job.rowCountHint) * 100))
            : -1; // 总行数未知时前端展示不确定进度
          emit(job);
          await persist(job);
          lastEmit = now;
        }
      },
    );

    for (const rec of batch) await validStore.append(rec);
    await validStore.close();
    await errorStore.close();

    job.progress.parse = 100;
    if (job.cancelRequested) return finish(job, 'CANCELED');

    job.status = 'REPORTING';
    emit(job);
    await persist(job);

    await reportPhase(job, t0);

    if (job.cancelRequested) return finish(job, 'CANCELED');
    return finish(job, job.counts.failed > 0 ? 'PARTIAL' : 'DONE');
  } catch (err) {
    await validStore.close().catch(() => {});
    await errorStore.close().catch(() => {});
    if (err.message === '__CANCEL__') return finish(job, 'CANCELED');
    return fail(job, err);
  }
}

// 分批 + 有界并发上报；有界 Channel 保证内存只保留少量批次
async function reportPhase(job, t0) {
  const { batchSize, concurrency } = config.report;
  const channel = new BoundedChannel(concurrency + 1);

  const producer = (async () => {
    const rl = readline.createInterface({
      input: fs.createReadStream(job.files.valid),
      crlfDelay: Infinity,
    });
    let chunk = [];
    try {
      for await (const line of rl) {
        if (job.cancelRequested) break;
        if (!line.trim()) continue;
        chunk.push(JSON.parse(line));
        if (chunk.length >= batchSize) {
          await channel.put(chunk);
          chunk = [];
        }
      }
      if (chunk.length) await channel.put(chunk);
    } finally {
      rl.close();
      channel.close();
    }
  })();

  const anomalyStore = new JsonlStore(job.files.anomalies);
  const failedStore = new JsonlStore(job.files.failed);
  let lastEmit = 0;

  const worker = async () => {
    let index = 0;
    while (true) {
      if (job.cancelRequested) break;
      const b = await channel.take();
      if (!b) return; // channel 关闭且队列取空
      index += 1;
      try {
        const { anomalies } = await reportBatch(b, index);
        for (const a of anomalies) await anomalyStore.append(a);
        job.counts.reported += b.length;
        job.counts.anomalies += anomalies.length;
      } catch (err) {
        // 整批重试后仍失败：落 failed.jsonl 稍后可补发
        for (const rec of b) {
          await failedStore.append({ ...rec, failedReason: err.message });
        }
        job.counts.reported += b.length;
        job.counts.failed += b.length;
      }
      const now = Date.now();
      if (now - lastEmit > 300) {
        const total = job.counts.valid || 1;
        job.progress.report = Math.min(99, Math.round((job.counts.reported / total) * 100));
        job.speed.recordsPerSec = Math.round(job.counts.reported / Math.max(1, (now - t0) / 1000));
        emit(job);
        await persist(job);
        lastEmit = now;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  // 取消时 worker 提前退出，可能仍有批次滞留；排空让生产者的 put 解除阻塞
  while (channel.items.length) channel.items.shift();
  channel.close();
  await producer.catch(() => {});
  await anomalyStore.close();
  await failedStore.close();
  job.progress.report = 100;
  emit(job);
  await persist(job);
}

function sanitizeRaw(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = typeof v === 'string' ? v.slice(0, 100) : v;
  }
  return out;
}

function finish(job, status) {
  job.status = status;
  job.finishedAt = new Date().toISOString();
  job.progress = { parse: 100, report: 100 };
  emit(job);
  return persist(job);
}

function fail(job, err) {
  job.status = 'ERROR';
  job.error = err.message;
  job.finishedAt = new Date().toISOString();
  emit(job);
  return persist(job);
}

function emit(job) {
  job.bus?.emit('progress', snapshot(job));
}

let persistChain = Promise.resolve();
function persist(job) {
  persistChain = persistChain.then(async () => {
    const snap = snapshot(job);
    await fs.promises.writeFile(job.files.meta, JSON.stringify(snap, null, 2)).catch(() => {});
  });
  return persistChain;
}

export function subscribe(job, cb) {
  if (!job.bus) return () => {};
  job.bus.on('progress', cb);
  cb(snapshot(job));
  return () => job.bus.off('progress', cb);
}

export { countLines };
export { buildExcelReport };

// 有界异步队列：put 满时等待，take 空时等待；close 后 take 返回 null
class BoundedChannel {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = [];
    this.waitingPut = [];
    this.waitingTake = [];
    this.closed = false;
  }

  put(item) {
    if (this.waitingTake.length) {
      this.waitingTake.shift()(item);
      return Promise.resolve();
    }
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waitingPut.push(() => { this.items.push(item); resolve(); }));
  }

  take() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waitingTake.push(resolve));
  }

  close() {
    this.closed = true;
    // 唤醒所有等待者：先交付剩余，再通知结束
    while (this.waitingPut.length) this.waitingPut.shift()();
    while (this.waitingTake.length) {
      const resolve = this.waitingTake.shift();
      resolve(this.items.shift() ?? null);
    }
  }
}
