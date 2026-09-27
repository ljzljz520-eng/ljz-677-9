'use strict';
const fs = require('fs');
const ExcelJS = require('exceljs');
const config = require('./config');
const { db } = require('./db');
const { resolveHeader, validateRow } = require('./validate');
const { postBatch } = require('./platform');
const bus = require('./events');

const cancelRequested = new Set();

// ---------------- 任务队列：同进程内串行处理，避免超大文件并发压垮内存 ----------------
let queueTail = Promise.resolve();
function enqueue(jobId, filePath) {
  queueTail = queueTail.then(() => runJob(jobId, filePath)).catch(() => {});
}
function requestCancel(jobId) { cancelRequested.add(jobId); }
const isCanceled = (jobId) => cancelRequested.has(jobId);

// 批量落库的预编译语句
const insertRow = db.prepare(`INSERT INTO job_rows
  (job_id,row_no,point_code,point_name,metric_code,metric_name,unit,value,sampled_at,status)
  VALUES (@job_id,@row_no,@point_code,@point_name,@metric_code,@metric_name,@unit,@value,@sampled_at,'valid')`);
const insertError = db.prepare(
  'INSERT INTO row_errors (job_id,row_no,field,message,raw) VALUES (?,?,?,?,?)'
);

const flushBatch = db.transaction((jobId, batch) => {
  const seen = snapshotSeen.get(jobId);
  for (const item of batch) {
    const rawText = (() => {
      try {
        const s = JSON.stringify(item.raw, (_k, v) => (v instanceof Date ? v.toISOString() : v));
        return s ? s.slice(0, 1000) : '';
      } catch {
        return String(item.raw).slice(0, 1000);
      }
    })();
    const { errors, normalized } = validateRow(item.row, seen);
    if (errors.length) {
      for (const e of errors) insertError.run(jobId, item.rowNo, e.field, e.message, rawText);
    } else {
      insertRow.run({ job_id: jobId, row_no: item.rowNo, ...normalized });
    }
  }
});
// 每个 job 的去重集合（仅包含 key 字符串，几万条占用很小，job 结束清理）
const snapshotSeen = new Map();

function cellToRaw(cell) {
  const v = cell?.value;
  if (v == null) return v;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text && v.hyperlink) return v.text;
    if (v.result !== undefined) return v.result;          // 公式取结果
    if (v.error) return v.error;
    if (v.text) return v.text;
  }
  return v;
}

async function runJob(jobId, filePath) {
  const updateJob = (patch) => {
    const keys = Object.keys(patch).map((k) => `${k}=@${k}`).join(',');
    db.prepare(`UPDATE jobs SET ${keys} WHERE id=@id`).run({ id: jobId, ...patch });
  };

  try {
    updateJob({ status: 'parsing', started_at: new Date().toISOString() });
    bus.emit(jobId, 'progress', {
  ...db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId),
  phase: 'parsing', percent: null, message: '开始解析 Excel…',
});

    const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
      sharedStrings: 'cache', entries: 'emit', worksheets: 'emit',
    });

    let headerMap = null;
    let batch = [];
    let total = 0;
    let lastEmit = 0;
    snapshotSeen.set(jobId, new Set());

    const processBatch = (finalFlush = false) => {
      if (!batch.length) return;
      flushBatch(jobId, batch);
      total += batch.length;
      batch = [];
      const counts = countValidInvalid(jobId);
      updateJob({
        total_rows: total,
        valid_rows: counts.valid,
        invalid_rows: counts.invalid,
      });
      const now = Date.now();
      if (finalFlush || now - lastEmit > 250) {
        lastEmit = now;
        bus.emit(jobId, 'progress', {
          ...db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId),
          phase: 'parsing', percent: null,
          message: `解析中：已处理 ${total} 行（有效 ${counts.valid} / 异常 ${counts.invalid}）`,
        });
      }
    };

    for await (const worksheet of reader) {
      if (headerMap) break; // 只处理第一个工作表
      for await (const row of worksheet) {
        if (isCanceled(jobId)) throw new Error('CANCELED');

        if (!headerMap) {
          if (row.number !== 1) {
            throw new Error('未找到表头：请确保第 1 行为表头（采样点/检测指标/单位/检测值/采样时间）');
          }
          const headers = [];
          row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            headers[colNumber - 1] = cellToRaw(cell);
          });
          const resolved = resolveHeader(headers);
          if (resolved.missing.length) {
            throw new Error(`表头缺少必需列：${resolved.missing.join('、')}`);
          }
          headerMap = resolved.map;
          continue;
        }

        // 跳过完全空白行
        let hasValue = false;
        const raw = {};
        for (const [key, colIdx] of Object.entries(headerMap)) {
          const v = cellToRaw(row.getCell(colIdx + 1));
          raw[key] = v;
          if (v !== null && v !== undefined && String(v).trim() !== '') hasValue = true;
        }
        if (!hasValue) continue;

        batch.push({ rowNo: row.number, row: raw });
        if (batch.length >= config.BATCH_SIZE) processBatch();
      }
    }
    if (!headerMap) throw new Error('文件为空或没有可识别的工作表');
    processBatch(true);

    const counts = countValidInvalid(jobId);
    if (counts.valid === 0) {
      updateJob({ status: 'failed', finished_at: new Date().toISOString(),
        error_message: '没有可上送的有效数据，请修正校验错误后重新上传' });
      bus.emit(jobId, 'progress', {
    ...db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId),
    phase: 'finished', percent: 0, message: '无有效数据',
  });
      bus.emit(jobId, 'done', db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId));
      return;
    }

    await uploadPhase(jobId, updateJob);

    snapshotSeen.delete(jobId);
    cancelRequested.delete(jobId);
    fs.promises.unlink(filePath).catch(() => {});
    const final = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
    bus.emit(jobId, 'done', final);
  } catch (err) {
    console.error('[pipeline]', err.stack);
    snapshotSeen.delete(jobId);
    const canceled = err.message === 'CANCELED';
    cancelRequested.delete(jobId);
    db.prepare(`UPDATE jobs SET status=?, error_message=?, finished_at=? WHERE id=?`)
      .run(canceled ? 'canceled' : 'failed',
           canceled ? '用户取消' : String(err.message || err),
           new Date().toISOString(), jobId);
    bus.emit(jobId, canceled ? 'canceled' : 'error', {
      ...db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId),
      message: err.message,
    });
  }
}

function countValidInvalid(jobId) {
  const valid = db.prepare("SELECT COUNT(*) c FROM job_rows WHERE job_id=? AND status='valid'").get(jobId).c;
  const invalid = db.prepare('SELECT COUNT(*) c FROM row_errors WHERE job_id=?').get(jobId).c;
  return { valid, invalid };
}

// ---------------- 平台上送阶段 ----------------
async function uploadPhase(jobId, updateJob) {
  updateJob({ status: 'uploading' });
  bus.emit(jobId, 'progress', {
  ...db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId),
  phase: 'uploading', percent: 0, message: '校验通过，开始分批上送平台…',
});

  const poolSize = config.PLATFORM_CONCURRENCY;
  const BATCH = config.PLATFORM_BATCH;
  let lastId = 0;
  const pickBatch = db.prepare(
    `SELECT * FROM job_rows WHERE job_id=? AND status IN ('valid','upload_failed') AND id > ?
     ORDER BY id LIMIT ?`
  );
  const totalValid = countValidInvalid(jobId).valid;
  let dispatched = 0;

  async function worker() {
    for (;;) {
      if (isCanceled(jobId)) throw new Error('CANCELED');
      const rows = pickBatch.all(jobId, lastId, BATCH);
      if (!rows.length) return;
      lastId = rows[rows.length - 1].id;
      dispatched += rows.length;
      await sendOneBatch(jobId, rows, updateJob, totalValid);
    }
  }
  await Promise.all(Array.from({ length: poolSize }, worker));

  const remaining = db.prepare(
    "SELECT COUNT(*) c FROM job_rows WHERE job_id=? AND status IN ('valid','upload_failed')"
  ).get(jobId).c;

  const j = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  updateJob({
    status: remaining > 0 ? 'failed' : 'done',
    finished_at: new Date().toISOString(),
    error_message: remaining > 0 ? `${remaining} 条记录上送平台失败（可在任务页重试）` : null,
  });
  bus.emit(jobId, 'progress', {
    ...db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId),
    phase: 'finished', percent: 100,
    message: remaining > 0 ? `完成，${remaining} 条上送失败` : '上送完成',
  });
}

async function sendOneBatch(jobId, rows, updateJob, totalValid) {
  const batchNo = db.prepare('SELECT COALESCE(MAX(batch_no),0)+1 n FROM platform_batches WHERE job_id=?').get(jobId).n;
  const mark = (status) => {
    const ids = rows.map((r) => r.id);
    db.prepare(`UPDATE job_rows SET status=? WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(status, ...ids);
  };
  const payload = {
    batchId: `${jobId}-${batchNo}`,
    jobId,
    records: rows.map((r) => ({
      rowNo: r.row_no, pointCode: r.point_code, pointName: r.point_name,
      metricCode: r.metric_code, metricName: r.metric_name,
      unit: r.unit, value: r.value, sampledAt: r.sampled_at,
    })),
  };

  mark('uploading');
  let result, attempt = 0, lastErr;
  for (attempt = 1; attempt <= config.PLATFORM_RETRIES + 1; attempt++) {
    try { result = await postBatch(payload); break; }
    catch (err) {
      lastErr = err;
      if (attempt <= config.PLATFORM_RETRIES) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }

  const now = new Date().toISOString();
  if (!result) {
    mark('upload_failed');
    db.prepare(`INSERT INTO platform_batches (job_id,batch_no,row_count,attempts,status,response,created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(jobId, batchNo, rows.length, attempt, 'failed', String(lastErr?.message || lastErr), now);
  } else {
    const abnormalRowNos = new Set((result.abnormals || []).map((a) => a.rowNo));
    const tx = db.transaction(() => {
      for (const r of rows) {
        db.prepare('UPDATE job_rows SET status=? WHERE id=?')
          .run(abnormalRowNos.has(r.row_no) ? 'abnormal' : 'uploaded', r.id);
      }
      for (const a of result.abnormals || []) {
        db.prepare(`INSERT INTO platform_abnormals (job_id,row_no,code,message,value,returned_at)
          VALUES (?,?,?,?,?,?)`).run(jobId, a.rowNo, a.code, a.message, a.value ?? null, now);
      }
      db.prepare(`INSERT INTO platform_batches (job_id,batch_no,row_count,attempts,status,response,created_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run(jobId, batchNo, rows.length, result.attempt || attempt,
             result.attempt > 1 ? 'retry' : 'ok',
             JSON.stringify({ abnormalCount: abnormalRowNos.size }), now);
    });
    tx();
  }

  const agg = db.prepare(`SELECT
      SUM(status='uploaded') uploaded,
      SUM(status='abnormal') abnormal,
      SUM(status IN ('valid','upload_failed')) pending
    FROM job_rows WHERE job_id=?`).get(jobId);
  updateJob({ uploaded_rows: agg.uploaded || 0, abnormal_rows: agg.abnormal || 0 });
  const done = (agg.uploaded || 0) + (agg.abnormal || 0);
  const percent = totalValid ? Math.round((done / totalValid) * 100) : 0;
  bus.emit(jobId, 'progress', {
    ...db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId),
    phase: 'uploading', percent,
    message: `平台上送 ${done}/${totalValid}，异常结果 ${agg.abnormal || 0} 条`,
  });
}

function enqueueUploadOnly(jobId) {
  queueTail = queueTail.then(async () => {
    const updateJob = (patch) => {
      const keys = Object.keys(patch).map((k) => `${k}=@${k}`).join(',');
      db.prepare(`UPDATE jobs SET ${keys} WHERE id=@id`).run({ id: jobId, ...patch });
    };
    try {
      await uploadPhase(jobId, updateJob);
      const final = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
      bus.emit(jobId, 'done', final);
    } catch (err) {
      const canceled = err.message === 'CANCELED';
      cancelRequested.delete(jobId);
      db.prepare('UPDATE jobs SET status=?, error_message=?, finished_at=? WHERE id=?')
        .run(canceled ? 'canceled' : 'failed',
             canceled ? '用户取消' : String(err.message || err),
             new Date().toISOString(), jobId);
      bus.emit(jobId, canceled ? 'canceled' : 'error', {
        ...db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId), message: err.message,
      });
    }
  }).catch(() => {});
}

module.exports = { enqueue, enqueueUploadOnly, requestCancel };
