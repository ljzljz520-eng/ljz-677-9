'use strict';
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { db, meta } = require('./db');
const { enqueue, enqueueUploadOnly, requestCancel } = require('./pipeline');
const bus = require('./events');
const report = require('./report');

fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: config.UPLOAD_DIR,
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}_${crypto.randomUUID()}${path.extname(file.originalname) || '.xlsx'}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.xlsx?$/i.test(file.originalname) ||
      file.mimetype.includes('spreadsheet') || file.mimetype === 'application/octet-stream';
    cb(ok ? null : new Error('仅支持 .xlsx/.xls 文件'), ok);
  },
});

// ---------------- 基础数据 ----------------
app.get('/api/meta', (_req, res) => res.json(meta));

app.get('/api/template', (_req, res) => report.writeTemplate(res));

// ---------------- 上传 & 任务 ----------------
app.post('/api/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    next();
  });
}, (req, res) => {
  const id = crypto.randomUUID().slice(0, 8);
  db.prepare(`INSERT INTO jobs (id,filename,status,created_at) VALUES (?,?,?,?)`)
    .run(id, req.file.originalname, 'queued', new Date().toISOString());
  enqueue(id, req.file.path);
  res.json({ id });
});

app.get('/api/jobs', (_req, res) => {
  res.json(db.prepare('SELECT * FROM jobs ORDER BY rowid DESC LIMIT 50').all());
});

app.get('/api/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(job);
});

// SSE 进度
app.get('/api/jobs/:id/events', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('snapshot', job);
  const onProgress = (d) => send('progress', d);
  const onDone = (d) => { send('done', d); cleanup(); };
  const onError = (d) => { send('error', d); cleanup(); };
  const onCancel = (d) => { send('canceled', d); cleanup(); };
  function cleanup() {
    bus.off(job.id, 'progress', onProgress);
    bus.off(job.id, 'done', onDone);
    bus.off(job.id, 'error', onError);
    bus.off(job.id, 'canceled', onCancel);
  }
  bus.on(job.id, 'progress', onProgress);
  bus.on(job.id, 'done', onDone);
  bus.on(job.id, 'error', onError);
  bus.on(job.id, 'canceled', onCancel);
  // 已在终态（服务重启后重连）
  if (['done', 'failed', 'canceled'].includes(job.status)) {
    send(job.status === 'done' ? 'done' : job.status === 'canceled' ? 'canceled' : 'error', job);
  }
  req.on('close', cleanup);
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (!['queued', 'parsing', 'uploading'].includes(job.status)) {
    return res.status(409).json({ error: '当前状态不可取消' });
  }
  requestCancel(job.id);
  res.json({ ok: true });
});

app.post('/api/jobs/:id/retry', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  const pending = db.prepare(
    "SELECT COUNT(*) c FROM job_rows WHERE job_id=? AND status IN ('valid','upload_failed')"
  ).get(job.id).c;
  if (!pending) return res.status(409).json({ error: '没有待重试的记录' });
  // 原文件已删除时无法重跑解析，但上送阶段数据已在库，可直接重发
  db.prepare("UPDATE jobs SET status='queued', error_message=NULL, finished_at=NULL WHERE id=?").run(job.id);
  enqueueUploadOnly(job.id);
  res.json({ ok: true, pending });
});

// ---------------- 明细 / 异常查询 ----------------
app.get('/api/jobs/:id/errors', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(500, Number(req.query.size) || 20);
  const total = db.prepare('SELECT COUNT(*) c FROM row_errors WHERE job_id=?').get(req.params.id).c;
  const rows = db.prepare(`SELECT row_no,field,message,raw FROM row_errors WHERE job_id=? ORDER BY id LIMIT ? OFFSET ?`)
    .all(req.params.id, size, (page - 1) * size);
  res.json({ total, page, size, rows });
});

app.get('/api/jobs/:id/abnormals', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(500, Number(req.query.size) || 20);
  const total = db.prepare('SELECT COUNT(*) c FROM platform_abnormals WHERE job_id=?').get(req.params.id).c;
  const rows = db.prepare(`
    SELECT a.row_no,a.code,a.message,a.value,a.returned_at,
           jr.point_code,jr.point_name,jr.metric_code,jr.metric_name,jr.unit,jr.sampled_at
    FROM platform_abnormals a LEFT JOIN job_rows jr ON jr.job_id=a.job_id AND jr.row_no=a.row_no
    WHERE a.job_id=? ORDER BY a.id LIMIT ? OFFSET ?`)
    .all(req.params.id, size, (page - 1) * size);
  res.json({ total, page, size, rows });
});

// ---------------- 导出（全部流式） ----------------
app.get('/api/jobs/:id/export/report', (req, res, next) =>
  loadJob(req, res, next, (j) => report.writeReport(res, j)));
app.get('/api/jobs/:id/export/errors', (req, res, next) =>
  loadJob(req, res, next, (j) => report.writeErrors(res, j)));
app.get('/api/jobs/:id/export/abnormals', (req, res, next) =>
  loadJob(req, res, next, (j) => report.writeAbnormals(res, j)));

function loadJob(req, res, next, fn) {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  Promise.resolve(fn(job)).catch(next);
}

// ---------------- 错误处理 ----------------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(config.PORT, () => {
  console.log(`水质检测上报系统已启动: http://localhost:${config.PORT}`);
});
