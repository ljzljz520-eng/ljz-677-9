'use strict';
const path = require('path');

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db'),
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),
  // 分批大小：每 1000 行做一次校验+事务落库
  BATCH_SIZE: Number(process.env.BATCH_SIZE) || 1000,
  // 平台上送：默认打到本服务内置的模拟平台，真实环境改成平台地址
  PLATFORM_URL: process.env.PLATFORM_URL || null, // null => 内置 mock
  PLATFORM_BATCH: 1000,        // 每次上送平台的记录数
  PLATFORM_CONCURRENCY: 3,     // 平台上送并发数
  PLATFORM_RETRIES: 2,         // 单批失败重试次数
  PLATFORM_FAIL_RATE: Number(process.env.PLATFORM_FAIL_RATE) || 0, // mock 随机失败率（演示用）
  SAMPLING_TIME_LIMIT_DAYS: 90, // 采样时间只允许距今 90 天内
};
