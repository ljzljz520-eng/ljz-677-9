import path from 'node:path';
import fs from 'node:fs';

const ROOT = process.cwd();
export const DATA_DIR = process.env.WQ_DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const JOB_DIR = path.join(DATA_DIR, 'jobs');
export const PUBLIC_DIR = path.join(ROOT, 'public');

for (const d of [DATA_DIR, UPLOAD_DIR, JOB_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

export const config = {
  port: Number(process.env.PORT || 4321),
  upload: {
    maxFileSize: Number(process.env.WQ_MAX_FILE_SIZE || 500 * 1024 * 1024), // 500MB
  },
  parse: {
    // 每多少行落一次盘 / 推一次进度，避免高频事件打爆内存
    batchSize: Number(process.env.WQ_BATCH_SIZE || 1000),
  },
  report: {
    // 平台上报并发批次数
    concurrency: Number(process.env.WQ_REPORT_CONCURRENCY || 4),
    batchSize: Number(process.env.WQ_REPORT_BATCH_SIZE || 500),
    // 单批超时与重试
    timeoutMs: Number(process.env.WQ_PLATFORM_TIMEOUT || 15000),
    maxRetry: Number(process.env.WQ_PLATFORM_MAX_RETRY || 3),
  },
  // 配置真实平台地址即走 HTTP，留空走内置模拟平台（返回模拟超标异常）
  platform: {
    url: process.env.WQ_PLATFORM_URL || '',
    token: process.env.WQ_PLATFORM_TOKEN || '',
  },
  // 采样时间合法区间
  sampleTime: {
    // 不允许早于该时间（系统上线前的离谱时间）
    min: new Date('2000-01-01T00:00:00Z').getTime(),
    // 不允许晚于「当前时间 + 1 天」（时钟漂移容忍）
    futureToleranceMs: 24 * 3600 * 1000,
  },
};
