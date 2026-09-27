'use strict';
// 主数据：采样点、检测指标、单位（生产中可改为从基础库/平台同步）

const SAMPLING_POINTS = [
  ['SP-001', '长江-南京段-取水口'],
  ['SP-002', '长江-镇江段-对照断面'],
  ['SP-003', '太湖-梅梁湖-湖心'],
  ['SP-004', '太湖-竺山湖-入湖口'],
  ['SP-005', '秦淮河-七桥瓮'],
  ['SP-006', '秦淮河-三汊河口'],
  ['SP-007', '淮河-蚌埠闸'],
  ['SP-008', '淮河-小柳巷'],
  ['SP-009', '京杭运河-苏州段'],
  ['SP-010', '京杭运河-扬州段'],
  ['SP-011', '洪泽湖-临淮'],
  ['SP-012', '固城湖-大花滩'],
];

// metric: 编码 / 名称 / 允许单位 / 上下限（检出合理性范围，超出视为异常）
const METRICS = [
  { code: 'PH',   name: 'pH值',        units: ['无量纲'],     min: 0,   max: 14,    decimals: 2 },
  { code: 'DO',   name: '溶解氧',       units: ['mg/L'],      min: 0,   max: 25,    decimals: 2 },
  { code: 'COD',  name: '高锰酸盐指数', units: ['mg/L'],      min: 0,   max: 50,    decimals: 2 },
  { code: 'NH3N', name: '氨氮',         units: ['mg/L'],      min: 0,   max: 20,    decimals: 3 },
  { code: 'TP',   name: '总磷',         units: ['mg/L'],      min: 0,   max: 5,     decimals: 3 },
  { code: 'TN',   name: '总氮',         units: ['mg/L'],      min: 0,   max: 30,    decimals: 3 },
  { code: 'TURB', name: '浊度',         units: ['NTU', '度'], min: 0,   max: 10000, decimals: 1 },
  { code: 'EC',   name: '电导率',       units: ['μS/cm'],     min: 0,   max: 100000,decimals: 0 },
  { code: 'WT',   name: '水温',         units: ['℃', '°C'],   min: 0,   max: 45,    decimals: 1 },
];

const POINT_BY_CODE = new Map(SAMPLING_POINTS.map(([code, name]) => [code, name]));
const POINT_BY_NAME = new Map(SAMPLING_POINTS.map(([code, name]) => [name, code]));
const METRIC_BY_CODE = new Map(METRICS.map((m) => [m.code, m]));
const METRIC_BY_NAME = new Map(METRICS.map((m) => [m.name, m.code]));
const ALLOWED_UNITS = new Set(METRICS.flatMap((m) => m.units));

module.exports = {
  SAMPLING_POINTS,
  METRICS,
  POINT_BY_CODE,
  POINT_BY_NAME,
  METRIC_BY_CODE,
  METRIC_BY_NAME,
  ALLOWED_UNITS,
};
