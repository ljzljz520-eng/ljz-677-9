'use strict';
// 行级校验：采样点、指标、单位、数值、采样时间，以及批次内去重
const {
  POINT_BY_CODE, POINT_BY_NAME,
  METRIC_BY_CODE, METRIC_BY_NAME,
} = require('./master-data');
const { SAMPLING_TIME_LIMIT_DAYS } = require('./config');

// Excel 序列号日期 -> Date
const EXCEL_EPOCH_OFFSET = 25569; // 1899-12-30 -> unix
function excelSerialToDate(serial) {
  const ms = Math.round((serial - EXCEL_EPOCH_OFFSET) * 86400 * 1000);
  return new Date(ms);
}

function parseSampledAt(raw) {
  if (raw == null) return { error: '采样时间为空' };
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { error: '采样时间格式无法识别' };
    return { value: raw };
  }
  if (typeof raw === 'number') {
    if (raw < 1 || raw > 80000) return { error: '采样时间不是有效的日期序列值' };
    return { value: excelSerialToDate(raw) };
  }
  const s = String(raw).trim().replace(/[./年月]/g, '-').replace(/日/g, '');
  // 2026-09-26 10:20:30 / 2026-09-26T10:20:30Z
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return { error: `采样时间格式无法识别: "${String(raw).slice(0, 30)}"` };
  return { value: d };
}

const CN_HEADERS = {
  sampling_point: '采样点',
  metric: '检测指标',
  unit: '单位',
  value: '检测值',
  sampled_at: '采样时间',
};

// 返回 { map, missing[] }
function resolveHeader(headers) {
  const normalized = headers.map((h) => String(h ?? '').trim().replace(/\s+/g, ''));
  const aliases = {
    sampling_point: ['采样点', '采样点名称', '采样点位', '点位名称'],
    metric: ['检测指标', '指标', '指标名称', '监测指标'],
    unit: ['单位', '计量单位'],
    value: ['检测值', '数值', '结果值', '监测值'],
    sampled_at: ['采样时间', '采样日期', '取样时间'],
  };
  const map = {};
  const missing = [];
  for (const key of Object.keys(aliases)) {
    const idx = normalized.findIndex((h) => aliases[key].includes(h));
    if (idx === -1) missing.push(CN_HEADERS[key]);
    else map[key] = idx;
  }
  return { map, missing, headers: normalized };
}

/**
 * 校验单行
 * @param {object} row {sampling_point, metric, unit, value, sampled_at}
 * @param {Set} seen  批次去重集合
 * @returns {{errors: Array, normalized: object|null}}
 */
function validateRow(row, seen) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });
  const out = {
    point_code: null, point_name: null,
    metric_code: null, metric_name: null,
    unit: null, value: null, sampled_at: null,
  };

  // ---- 采样点：允许编码或名称 ----
  const pointRaw = row.sampling_point == null ? '' : String(row.sampling_point).trim();
  if (!pointRaw) push('sampling_point', '采样点为空');
  else if (POINT_BY_CODE.has(pointRaw)) {
    out.point_code = pointRaw; out.point_name = POINT_BY_CODE.get(pointRaw);
  } else if (POINT_BY_NAME.has(pointRaw)) {
    out.point_name = pointRaw; out.point_code = POINT_BY_NAME.get(pointRaw);
  } else push('sampling_point', `采样点不存在: "${pointRaw.slice(0, 30)}"，请先在基础库登记`);

  // ---- 指标：允许编码或名称 ----
  const metricRaw = row.metric == null ? '' : String(row.metric).trim();
  let metricDef = null;
  if (!metricRaw) push('metric', '检测指标为空');
  else if (METRIC_BY_CODE.has(metricRaw)) metricDef = METRIC_BY_CODE.get(metricRaw);
  else if (METRIC_BY_NAME.has(metricRaw)) metricDef = METRIC_BY_CODE.get(METRIC_BY_NAME.get(metricRaw));
  else push('metric', `检测指标不在目录: "${metricRaw.slice(0, 20)}"`);
  if (metricDef) {
    out.metric_code = metricDef.code; out.metric_name = metricDef.name;
  }

  // ---- 单位：必须是该指标的合法单位 ----
  const unitRaw = row.unit == null ? '' : String(row.unit).trim();
  if (!unitRaw) push('unit', '单位为空');
  else if (metricDef && !metricDef.units.includes(unitRaw)) {
    push('unit', `单位 "${unitRaw}" 对指标 ${metricDef.name} 不合法，允许: ${metricDef.units.join('/')}`);
  } else out.unit = unitRaw;

  // ---- 检测值 ----
  const valueRaw = row.value;
  if (valueRaw == null || String(valueRaw).trim() === '') push('value', '检测值为空');
  else {
    const num = typeof valueRaw === 'number' ? valueRaw : Number(String(valueRaw).replace(/,/g, ''));
    if (!Number.isFinite(num)) push('value', `检测值不是数字: "${String(valueRaw).slice(0, 20)}"`);
    else if (metricDef) {
      if (num < metricDef.min || num > metricDef.max) {
        push('value', `检测值 ${num} 超出合理范围 [${metricDef.min}, ${metricDef.max}]`);
      }
    }
    out.value = Number.isFinite(num) ? num : null;
  }

  // ---- 采样时间 ----
  const t = parseSampledAt(row.sampled_at);
  if (t.error) push('sampled_at', t.error);
  else {
    const now = Date.now();
    if (t.value.getTime() > now + 60000) push('sampled_at', '采样时间晚于当前时间');
    else if (now - t.value.getTime() > SAMPLING_TIME_LIMIT_DAYS * 86400 * 1000) {
      push('sampled_at', `采样时间超出最近 ${SAMPLING_TIME_LIMIT_DAYS} 天上报范围`);
    } else out.sampled_at = t.value.toISOString();
  }

  // ---- 同文件内去重：采样点 + 指标 + 采样时间(秒级) ----
  if (out.point_code && out.metric_code && out.sampled_at) {
    const second = out.sampled_at.slice(0, 19);
    const key = `${out.point_code}|${out.metric_code}|${second}`;
    if (seen.has(key)) push('duplicate', '同一采样点/指标/采样时间重复报送');
    else seen.add(key);
  }

  return { errors, normalized: errors.length ? null : out };
}

module.exports = { resolveHeader, validateRow, parseSampledAt };
