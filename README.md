# 水质检测 Excel 上报系统

检测站批量上传水样检测数据（单文件几万～几十万行），后端完成 **采样点 / 检测指标 / 单位 / 采样时间** 四类校验后分批上送平台，并接收平台回传的异常结果；前端实时展示处理进度、校验错误、平台异常并可导出 Excel 报告。

## 核心能力

| 环节 | 实现 |
|---|---|
| 超大文件解析 | `exceljs` 流式 `WorkbookReader`，**按 1000 行/批** 读取→校验→事务落库，文件不整体进内存。实测 50 万行峰值 RSS ≈ 420MB |
| 校验 | 采样点（编码/名称二选一，须在基础库）、指标（编码/名称 + 目录）、单位（必须匹配该指标）、检测值（数值 + 合理区间）、采样时间（Excel 日期/序列号/多种字符串格式，限近 90 天，不得晚于当前）、同文件秒级去重（点+指标+时间） |
| 平台上送 | 有效数据按 1000 条/批、3 并发上送；失败自动重试 2 次（指数退避），批次级留痕，失败记录可一键重试（**无需重新解析文件**） |
| 异常回收 | 平台逐行回传异常码/说明，回写状态，前端分页查询、可导出 |
| 实时进度 | SSE 推送：解析阶段不确定进度条 + 已处理行数；上送阶段精确百分比 + 已接收/异常计数；断线/服务重启后自动用快照恢复 |
| 报告导出 | 完整报告（汇总/异常/指标统计/全量数据）、校验错误明细、平台异常明细，均为**流式 WorkbookWriter**，不占内存 |

## 快速开始

```bash
npm install
npm start                       # http://localhost:3000

npm run sample                  # 生成 5 万行测试文件 uploads/sample_50000.xlsx
node tools/generate-sample.js 500000   # 自定义行数（含约 3% 各类错误样本）
```

页面操作：下载模板 → 上传 xlsx → 自动跳转任务详情看实时进度 → 查看「校验错误 / 平台异常」两个 Tab → 导出报告。

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload` | multipart 上传 xlsx（≤500MB），返回任务 id |
| GET | `/api/jobs` | 最近 50 个任务 |
| GET | `/api/jobs/:id` | 任务快照 |
| GET | `/api/jobs/:id/events` | SSE：snapshot/progress/done/error/canceled |
| POST | `/api/jobs/:id/cancel` | 取消（解析或上送阶段的批次边界生效） |
| POST | `/api/jobs/:id/retry` | 仅重发失败/待发记录（不重新解析） |
| GET | `/api/jobs/:id/errors` | 校验错误分页 |
| GET | `/api/jobs/:id/abnormals` | 平台异常分页 |
| GET | `/api/jobs/:id/export/report` | 完整报告（流式 xlsx） |
| GET | `/api/jobs/:id/export/errors` | 校验错误明细 |
| GET | `/api/jobs/:id/export/abnormals` | 平台异常明细 |
| GET | `/api/template` | 导入模板（含填写说明） |

## 接入真实平台

默认走内置 mock 平台（`src/platform.js`，模拟网络耗时与地表水Ⅲ类阈值复核）。接入真实平台时设置环境变量并按平台文档适配请求/响应：

```bash
PLATFORM_URL=https://water-platform.example.gov/api npm start
```

约定结构（可在 `src/platform.js` 的 `postReal` 中调整）：

```jsonc
// 请求 POST /batch
{ "batchId": "...", "jobId": "...",
  "records": [{ "rowNo": 2, "pointCode": "SP-001", "metricCode": "NH3N",
                "unit": "mg/L", "value": 1.23, "sampledAt": "2026-09-20T02:00:00.000Z" }] }
// 响应
{ "code": 0, "abnormals": [{ "rowNo": 2, "code": "NH3N_HIGH", "message": "氨氮超Ⅲ类", "value": 1.23 }] }
```

## 其他环境变量

`PORT`（3000）、`BATCH_SIZE`（1000）、`PLATFORM_BATCH`（1000）、`PLATFORM_CONCURRENCY`（3）、
`PLATFORM_RETRIES`（2）、`PLATFORM_FAIL_RATE`（mock 随机失败率，演示重试用）、`DB_PATH`、`UPLOAD_DIR`。

## 数据模型（SQLite）

- `jobs`：任务及各阶段计数（total/valid/invalid/uploaded/abnormal）
- `job_rows`：有效行，状态机 `valid → uploading → uploaded / abnormal / upload_failed`
- `row_errors`：逐行逐字段校验错误（保留原始数据 JSON，方便修正后重传）
- `platform_abnormals`：平台回传异常
- `platform_batches`：上送批次留痕（尝试次数、状态、响应）

## 目录

```
src/
  server.js     Express 路由（上传/SSE/查询/导出/重试/取消）
  pipeline.js   流式解析→分批校验落库→分批上送→异常回写（含任务串行队列）
  validate.js   表头识别 + 行级校验 + 去重
  platform.js   平台适配层（真实 HTTP + 内置 mock + 重试）
  report.js     模板与三类流式 xlsx 导出
  db.js         SQLite 表结构/索引
  master-data.js 采样点、指标、单位目录
tools/generate-sample.js 测试数据生成器
public/         原生 JS 前端（无构建）
```

> 生产化建议：多实例部署时把 SSE 事件总线换成 Redis Pub/Sub、任务队列换成 BullMQ，SQLite 换 PostgreSQL；主数据改为平台同步。
