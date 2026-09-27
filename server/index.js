import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { config, PUBLIC_DIR } from './config.js';
import { listReference } from './reference-data.js';
import {
  createJob, getJob, listJobs, requestCancel, subscribe, snapshot, countLines,
} from './job-manager.js';
import { readJsonlPage } from './storage.js';
import { buildExcelReport } from './report.js';

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  dest: path.join(process.cwd(), 'data', 'uploads'),
  limits: { fileSize: config.upload.maxFileSize },
});

// 参考数据（前端下拉/提示）
app.get('/api/reference', (req, res) => res.json(listReference()));

// 历史任务
app.get('/api/jobs', (req, res) => res.json({ jobs: listJobs() }));

// 上传并创建任务
app.post('/api/jobs', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件（字段名需为 file）' });
  try {
    const job = createJob(req.file.originalname, req.file.path, req.file.size);
    res.status(202).json(snapshot(job));
  } catch (err) {
    fs.promises.unlink(req.file.path).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// 任务快照
app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(snapshot(job));
});

// SSE 实时进度
app.get('/api/jobs/:id/events', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (snap) => res.write(`event: progress\ndata: ${JSON.stringify(snap)}\n\n`);
  const unsubscribe = subscribe(job, send);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); unsubscribe(); });
});

// 取消
app.post('/api/jobs/:id/cancel', (req, res) => {
  res.json({ canceled: requestCancel(req.params.id) });
});

// 明细分页：type = errors | anomalies | failed
app.get('/api/jobs/:id/details/:type', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  const map = { errors: job.files.errors, anomalies: job.files.anomalies, failed: job.files.failed };
  const file = map[req.params.type];
  if (!file) return res.status(400).json({ error: '未知明细类型' });
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize) || 50));
  const result = await readJsonlPage(file, { page, pageSize });
  res.json(result);
});

// 下载 Excel 报告（未结束也允许下载当前阶段报告）
app.get('/api/jobs/:id/report', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  const out = path.join(job.files.dir, `水质上报报告_${job.id}.xlsx`);
  try {
    // 任务进行中时从磁盘实时重建；结束后缓存
    const running = !['DONE', 'PARTIAL', 'CANCELED', 'ERROR'].includes(job.status);
    if (running || !fs.existsSync(out)) {
      await buildExcelReport(job, out);
    }
    res.download(out, `水质上报报告_${job.originalName.replace(/\.[^.]+$/, '')}.xlsx`);
  } catch (err) {
    res.status(500).json({ error: `报告生成失败: ${err.message}` });
  }
});

// multer 错误（超限等）
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
});

app.listen(config.port, () => {
  console.log(`水质检测上报系统已启动: http://localhost:${config.port}`);
  console.log(`平台地址: ${config.platform.url || '内置模拟平台（将返回模拟超标异常）'}`);
});
