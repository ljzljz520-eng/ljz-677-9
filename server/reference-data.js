// 基础资料库：采样点、指标与合法单位（实际项目可来自主数据服务 / 数据库缓存）
export const SAMPLING_POINTS = new Map([
  ['SP001', { code: 'SP001', name: '东湖湖心', type: '湖库', region: '东城区' }],
  ['SP002', { code: 'SP002', name: '东湖入水口', type: '湖库', region: '东城区' }],
  ['SP003', { code: 'SP003', name: '西河上游断面', type: '河流', region: '西河区' }],
  ['SP004', { code: 'SP004', name: '西河下游断面', type: '河流', region: '西河区' }],
  ['SP005', { code: 'SP005', name: '南湾水厂取水口', type: '饮用水源', region: '南湾区' }],
  ['SP006', { code: 'SP006', name: '北港排涝泵站', type: '排污口', region: '北港区' }],
  ['SP007', { code: 'SP007', name: '中心公园景观湖', type: '景观水', region: '中区' }],
  ['SP008', { code: 'SP008', name: '第三污水处理厂排口', type: '排污口', region: '南湾区' }],
]);

// code -> 指标定义；units 为该指标允许的全部单位，reportUnit 为平台标准单位
export const INDICATORS = new Map([
  ['PH',   { code: 'PH',   name: 'pH 值',        units: ['无量纲'], reportUnit: '无量纲', min: 0,  max: 14 }],
  ['DO',   { code: 'DO',   name: '溶解氧',        units: ['mg/L'],  reportUnit: 'mg/L',  min: 0,  max: 25 }],
  ['CODMN',{ code: 'CODMN',name: '高锰酸盐指数',  units: ['mg/L'],  reportUnit: 'mg/L',  min: 0,  max: 100 }],
  ['COD',  { code: 'COD',  name: '化学需氧量',    units: ['mg/L'],  reportUnit: 'mg/L',  min: 0,  max: 1000 }],
  ['NH3N', { code: 'NH3N', name: '氨氮',          units: ['mg/L'],  reportUnit: 'mg/L',  min: 0,  max: 200 }],
  ['TP',   { code: 'TP',   name: '总磷',          units: ['mg/L', 'μg/L'], reportUnit: 'mg/L', min: 0, max: 100 }],
  ['TN',   { code: 'TN',   name: '总氮',          units: ['mg/L'],  reportUnit: 'mg/L',  min: 0,  max: 200 }],
  ['TURB', { code: 'TURB', name: '浊度',          units: ['NTU'],   reportUnit: 'NTU',   min: 0,  max: 10000 }],
]);

// 模拟平台侧的异常判定阈值（真实项目异常结果由平台返回）
export const PLATFORM_LIMITS = {
  PH:   { min: 6,  max: 9,   label: 'pH 超出 6~9' },
  DO:   { min: 5,  max: null, label: '溶解氧低于 5 mg/L' },
  CODMN:{ max: 6,  min: null, label: '高锰酸盐指数超过 Ⅲ 类标准(6 mg/L)' },
  COD:  { max: 20, min: null, label: '化学需氧量超过 Ⅲ 类标准(20 mg/L)' },
  NH3N: { max: 1,  min: null, label: '氨氮超过 Ⅲ 类标准(1 mg/L)' },
  TP:   { max: 0.2,min: null, label: '总磷超过湖库 Ⅲ 类标准(0.2 mg/L)' },
  TN:   { max: 1,  min: null, label: '总氮超过湖库 Ⅲ 类标准(1 mg/L)' },
  TURB: { max: null,min: null,label: null },
};

export function listReference() {
  return {
    samplingPoints: [...SAMPLING_POINTS.values()],
    indicators: [...INDICATORS.values()],
  };
}
