import { config } from './config.js';
import { PLATFORM_LIMITS, INDICATORS } from './reference-data.js';

/**
 * 上报一批数据到平台，返回 { accepted, anomalies }
 * - 配置 WQ_PLATFORM_URL 时走真实 HTTP POST(JSON)
 * - 未配置时使用内置模拟平台：按 PLATFORM_LIMITS 返回超标异常
 * 带超时与指数退避重试。
 */
export async function reportBatch(batch, batchIndex) {
  if (config.platform.url) return reportViaHttp(batch, batchIndex);
  return mockPlatformReport(batch);
}

async function reportViaHttp(batch) {
  const payload = {
    source: 'water-quality-station',
    reportedAt: new Date().toISOString(),
    records: batch.map((r) => ({
      id: r.id,
      samplingPoint: r.pointCode,
      indicator: r.indicatorCode,
      value: r.reportUnit !== r.unit ? convertValue(r) : r.value,
      unit: r.reportUnit,
      sampledAt: r.sampledAt,
    })),
  };

  const res = await fetchWithRetry(config.platform.url, payload);
  // 期望平台返回 { anomalies: [{ id, level, rule, message }] }
  const anomalies = (res.anomalies || []).map((a) => {
    const rec = batch.find((r) => r.id === a.id);
    return rec ? toAnomaly(rec, a.level || 'ABNORMAL', a.message || '平台返回异常') : null;
  }).filter(Boolean);
  return { accepted: batch.length - anomalies.length, anomalies };
}

async function fetchWithRetry(url, payload) {
  let attempt = 0;
  let lastErr;
  while (attempt <= config.report.maxRetry) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.report.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.platform.token ? { Authorization: `Bearer ${config.platform.token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`平台 HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      attempt += 1;
      if (attempt > config.report.maxRetry) break;
      await sleep(2 ** attempt * 500); // 1s, 2s, 4s...
    }
  }
  throw new Error(`平台上报失败（重试 ${config.report.maxRetry} 次）: ${lastErr?.message || lastErr}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// —— 内置模拟平台 ——
function mockPlatformReport(batch) {
  const anomalies = [];
  for (const rec of batch) {
    const limit = PLATFORM_LIMITS[rec.indicatorCode];
    if (!limit) continue;
    let hit = false;
    let message = '';
    const value = standardValue(rec);
    if (limit.max !== null && value > limit.max) { hit = true; message = `${limit.label}，实测 ${value} ${rec.reportUnit}`; }
    if (limit.min !== null && value < limit.min) { hit = true; message = `${limit.label}，实测 ${value} ${rec.reportUnit}`; }
    if (hit) anomalies.push(toAnomaly(rec, levelOf(rec.indicatorCode), message));
  }
  return { accepted: batch.length - anomalies.length, anomalies };
}

function standardValue(rec) {
  return rec.unit === rec.reportUnit ? rec.value : convertValue(rec);
}

// 单位换算：目前仅 μg/L → mg/L
function convertValue(rec) {
  if (rec.unit === 'μg/L' && rec.reportUnit === 'mg/L') return rec.value / 1000;
  return rec.value;
}

function levelOf(code) {
  return ['COD', 'NH3N', 'TP', 'TN'].includes(code) ? 'OVER_LIMIT' : 'ABNORMAL';
}

function toAnomaly(rec, level, message) {
  return {
    recordId: rec.id,
    lineNo: rec.lineNo,
    pointCode: rec.pointCode,
    pointName: rec.pointName,
    indicatorCode: rec.indicatorCode,
    indicatorName: rec.indicatorName,
    value: rec.value,
    unit: rec.unit,
    sampledAt: rec.sampledAt,
    level,
    message,
  };
}
