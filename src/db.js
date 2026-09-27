'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { DB_PATH } = require('./config');
const { SAMPLING_POINTS, METRICS } = require('./master-data');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  status TEXT NOT NULL,            -- parsing|parsed|uploading|done|failed|canceled
  total_rows INTEGER DEFAULT 0,
  valid_rows INTEGER DEFAULT 0,
  invalid_rows INTEGER DEFAULT 0,
  uploaded_rows INTEGER DEFAULT 0,
  abnormal_rows INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS job_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  row_no INTEGER NOT NULL,                 -- Excel 物理行号（含表头偏移）
  point_code TEXT, point_name TEXT,
  metric_code TEXT, metric_name TEXT,
  unit TEXT, value REAL,
  sampled_at TEXT,                         -- ISO 时间
  status TEXT NOT NULL,                    -- valid|invalid|uploading|uploaded|abnormal
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS row_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  field TEXT NOT NULL,                     -- sampling_point|metric|unit|value|sampled_at|duplicate|header
  message TEXT NOT NULL,
  raw TEXT
);

CREATE TABLE IF NOT EXISTS platform_abnormals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  code TEXT NOT NULL,                      -- 平台异常码
  message TEXT NOT NULL,
  value REAL,
  returned_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  batch_no INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  attempts INTEGER DEFAULT 0,
  status TEXT NOT NULL,                    -- ok|retry|failed
  response TEXT,
  created_at TEXT NOT NULL
);
`);

for (const sql of [
  'CREATE INDEX IF NOT EXISTS idx_rows_job ON job_rows(job_id)',
  'CREATE INDEX IF NOT EXISTS idx_rows_status ON job_rows(job_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_errors_job ON row_errors(job_id)',
  'CREATE INDEX IF NOT EXISTS idx_abn_job ON platform_abnormals(job_id)',
]) db.exec(sql);

// 主数据视图（给前端/校验共用）
const meta = {
  points: SAMPLING_POINTS.map(([code, name]) => ({ code, name })),
  metrics: METRICS,
};

module.exports = { db, meta };
