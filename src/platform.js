'use strict';
// 平台对接层：
//  - 默认使用内置 mock（/mock/platform/batch），模拟平台审核并返回异常结果
//  - 配置 PLATFORM_URL 后走真实 HTTP 接口（约定的请求/响应结构见下方注释）
const config = require('./config');

/* 真实平台约定（对接时按平台文档适配）：
 * POST {PLATFORM_URL}/batch
 * body: { batchId, jobId, records: [{rowNo, pointCode, metricCode, unit, value, sampledAt}] }
 * 200 : { code: 0, abnormals: [{rowNo, code, message, value}] }
 * 非200 / code!=0: 触发重试
 */

async function postBatch(payload) {
  if (config.PLATFORM_URL) return postReal(payload);
  return postMock(payload);
}

async function postReal(payload) {
  let lastErr;
  for (let attempt = 1; attempt <= config.PLATFORM_RETRIES + 1; attempt++) {
    try {
      const res = await fetch(`${config.PLATFORM_URL}/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbSignal(30000),
      });
      if (!res.ok) throw new Error(`平台 HTTP ${res.status}`);
      const data = await res.json();
      if (data.code !== 0) throw new Error(data.message || '平台返回失败');
      return { abnormals: data.abnormals || [], attempt };
    } catch (err) {
      lastErr = err;
      if (attempt <= config.PLATFORM_RETRIES) await sleep(400 * attempt);
    }
  }
  throw lastErr;
}

function AbSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  return undefined;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 内置模拟平台 ----------------
async function postMock(payload) {
  await sleep(60 + Math.random() * 140); // 模拟网络耗时
  if (Math.random() < config.PLATFORM_FAIL_RATE) {
    const err = new Error('模拟平台临时不可用');
    err.mockRetryable = true;
    throw err;
  }
  // 平台侧复核规则（示例：地表水 III 类阈值思路，仅用于演示异常回收闭环）
  const RULES = {
    PH:   (v) => (v < 6 ? ['PH_LOW', 'pH低于地表水Ⅲ类下限(6.0)'] : v > 9 ? ['PH_HIGH', 'pH高于地表水Ⅲ类上限(9.0)'] : null),
    DO:   (v) => (v < 5 ? ['DO_LOW', '溶解氧低于Ⅲ类标准(5.0 mg/L)'] : null),
    COD:  (v) => (v > 6 ? ['COD_HIGH', '高锰酸盐指数高于Ⅲ类标准(6.0 mg/L)'] : null),
    NH3N: (v) => (v > 1.0 ? ['NH3N_HIGH', '氨氮高于Ⅲ类标准(1.0 mg/L)'] : null),
    TP:   (v) => (v > 0.2 ? ['TP_HIGH', '总磷高于Ⅲ类标准(0.2 mg/L)'] : null),
    TN:   (v) => (v > 1.0 ? ['TN_HIGH', '总氮高于Ⅲ类标准(1.0 mg/L)'] : null),
  };
  const abnormals = [];
  for (const r of payload.records) {
    const rule = RULES[r.metricCode];
    const hit = rule ? rule(r.value) : null;
    if (hit) abnormals.push({ rowNo: r.rowNo, code: hit[0], message: hit[1], value: r.value });
  }
  return { abnormals, attempt: 1 };
}

module.exports = { postBatch };
