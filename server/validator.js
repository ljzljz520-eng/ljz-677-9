import { SAMPLING_POINTS, INDICATORS } from './reference-data.js';
import { config } from './config.js';

const HEADER_ALIASES = {
  采样点编码: 'pointCode', 采样点: 'pointCode', 采样点编号: 'pointCode', pointcode: 'pointCode',
  指标编码: 'indicatorCode', 指标: 'indicatorCode', 指标代码: 'indicatorCode', indicator: 'indicatorCode',
  数值: 'value', 检测值: 'value', 监测值: 'value', value: 'value',
  单位: 'unit', 计量单位: 'unit', unit: 'unit',
  采样时间: 'sampledAt', 采样日期: 'sampledAt', 监测时间: 'sampledAt',
};

// 表头标准化：支持中英文常见别名
export function normalizeHeader(rawHeaders) {
  return rawHeaders.map((h) => {
    const key = String(h ?? '').trim();
    return HEADER_ALIAS(key) || null;
  });
}

function HEADER_ALIAS(text) {
  const lower = text.toLowerCase();
  return HEADER_ALIASES[text] || HEADER_ALIASES[lower] || null;
}

// 兼容 Excel 日期序列号、常见字符串格式
export function parseSampleTime(raw) {
  if (raw === null || raw === undefined || raw === '') return { error: '采样时间为空' };

  // exceljs 默认会把日期单元格转成 Date 对象
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isNaN(t) ? { error: '采样时间格式无法识别' } : { value: t };
  }
  if (typeof raw === 'number') {
    // Excel 1900 日期系统序列号
    const t = excelSerialToMs(raw);
    return t === null ? { error: '采样时间格式无法识别' } : { value: t };
  }
  const s = String(raw).trim();
  // 统一为 ISO 可解析格式：2026/3/5 6:07 → 2026-03-05T06:07:00
  let normalized = s.replace(/[./年月]/g, '-').replace(/日/g, '').replace(/\s+/g, 'T');
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(normalized)) normalized += 'T00:00:00';
  if (/^\d{4}-\d{1,2}-\d{1,2}T\d{1,2}:\d{2}$/.test(normalized)) normalized += ':00';
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return { error: `采样时间格式无法识别: ${s}` };
  return { value: ms };
}

function excelSerialToMs(serial) {
  if (serial < 1 || serial > 80000) return null; // 合理日期区间 1900~2119
  const utcDays = Math.floor(serial - 25569);
  const utcSeconds = utcDays * 86400;
  const frac = serial - Math.floor(serial);
  return Math.round(utcSeconds * 1000 + frac * 86400 * 1000);
}

function parseValue(raw) {
  if (raw === null || raw === undefined || raw === '') return { error: '数值为空' };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : { error: '数值不是有效数字' };
  const s = String(raw).trim().replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? { value: n } : { error: `数值不是有效数字: ${String(raw).slice(0, 30)}` };
}

/**
 * 校验单行。返回 { ok, record, errors:[{field,message}] }
 * 一条行内多个问题一次性全部返回，减少检测站反复修改次数。
 */
export function validateRow(raw, lineNo) {
  const errors = [];

  const pointCode = str(raw.pointCode);
  const indicatorCode = str(raw.indicatorCode).toUpperCase();
  const unitRaw = str(raw.unit);

  // 1) 采样点
  const point = pointCode ? SAMPLING_POINTS.get(pointCode) : undefined;
  if (!pointCode) errors.push({ field: 'pointCode', message: '采样点编码为空' });
  else if (!point) errors.push({ field: 'pointCode', message: `未知采样点: ${pointCode}` });

  // 2) 指标
  const indicator = indicatorCode ? INDICATORS.get(indicatorCode) : undefined;
  if (!indicatorCode) errors.push({ field: 'indicatorCode', message: '指标编码为空' });
  else if (!indicator) errors.push({ field: 'indicatorCode', message: `未知指标: ${indicatorCode}` });

  // 3) 数值
  const valueRes = parseValue(raw.value);
  if (valueRes.error) errors.push({ field: 'value', message: valueRes.error });

  // 4) 单位：必须在该指标允许单位列表内
  if (!unitRaw) {
    errors.push({ field: 'unit', message: '单位为空' });
  } else if (indicator && !indicator.units.includes(unitRaw)) {
    errors.push({ field: 'unit', message: `指标 ${indicatorCode} 不支持单位「${unitRaw}」，允许: ${indicator.units.join('/')}` });
  }

  // 5) 数值物理范围（在指标存在时才判断）
  if (indicator && valueRes.value !== undefined) {
    const { min, max } = indicator;
    if (valueRes.value < min || valueRes.value > max) {
      errors.push({ field: 'value', message: `数值 ${valueRes.value} 超出物理合理范围 [${min}, ${max}]` });
    }
  }

  // 6) 采样时间
  const timeRes = parseSampleTime(raw.sampledAt);
  if (timeRes.error) {
    errors.push({ field: 'sampledAt', message: timeRes.error });
  } else {
    const now = Date.now();
    if (timeRes.value < config.sampleTime.min) {
      errors.push({ field: 'sampledAt', message: '采样时间早于 2000 年' });
    } else if (timeRes.value > now + config.sampleTime.futureToleranceMs) {
      errors.push({ field: 'sampledAt', message: '采样时间晚于当前时间（超出容忍范围）' });
    }
  }

  if (errors.length) return { ok: false, lineNo, errors };

  const record = {
    lineNo,
    pointCode,
    pointName: point.name,
    indicatorCode,
    indicatorName: indicator.name,
    value: valueRes.value,
    unit: unitRaw,
    reportUnit: indicator.reportUnit,
    sampledAt: new Date(timeRes.value).toISOString(),
  };
  return { ok: true, lineNo, record };
}

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}
