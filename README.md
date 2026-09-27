# 水质检测 Excel 上报系统

检测站上传几万条水样数据的 Excel，后端完成**采样点 / 指标 / 单位 / 采样时间**校验，
分批上报平台并回收异常结果，前端实时展示进度、错误明细与 Excel 报告。
超大文件采用 SAX 流式解析 + 分批落盘，内存占用有界，不会把整个文件读进内存。

## 快速开始

```bash
npm install
npm start                 # http://localhost:4321

# 造一个 5 万行（默认）的样本 Excel，含约 2% 校验错误与超标值
npm run gen:sample
npm run gen:sample -- 100000   # 指定行数

# 端到端冒烟测试（自动起服务、上传、校验、下载报告、校验断言）
npm run smoke
```

## Excel 模板

第一行为表头，必需列（支持常见别名，顺序不限）：

| 采样点编码 | 指标编码 | 数值 | 单位 | 采样时间 |
|---|---|---|---|---|
| SP001 | NH3N | 0.85 | mg/L | 2026-09-20 10:00:00 |

- 采样时间支持 Excel 日期单元格、`2026-09-20 10:00`、`2026/9/20`、`2026年9月20日` 等格式
- 也支持 `.csv`（含引号转义）
- 合法编码/单位可在前端「查看合法编码/单位」弹窗或 `server/reference-data.js` 中查看

## 校验规则（`server/validator.js`）

1. **采样点**：编码必须在采样点主数据内（`SAMPLING_POINTS`）
2. **指标**：编码必须在指标主数据内（`INDICATORS`）
3. **单位**：必须是该指标允许的单位（如 TP 允许 `mg/L`、`μg/L`，不允许 `ppm`）
4. **数值**：必须为有效数字，且在指标物理合理范围内（如 pH 0~14）
5. **采样时间**：可解析、不早于 2000 年、不晚于当前时间 + 1 天
6. 一行内的全部错误一次性返回，减少检测站来回修改

## 大文件为什么不会撑爆内存

| 环节 | 做法 |
|---|---|
| Excel 解析 | `exceljs` 的 `WorkbookReader`（SAX 风格）逐行迭代，不建立完整工作簿模型 |
| 行数预判 | 用 `yauzl` 只读 ZIP 内 sheet XML 头部 `<dimension>`（缺失时扫尾部 256KB 最后行号），用于进度条 |
| 解析→校验 | 每 1000 行（`WQ_BATCH_SIZE`）把有效/错误数据追加落盘 JSONL，内存只留当前批次 |
| 上报 | 有界 Channel 背压 + 可配并发（默认 4）与批大小（默认 500），队列只保留少量批次 |
| 明细分页 | 错误/异常/失败清单走 JSONL 流式分页（每页 50），不一次加载 |
| Excel 报告 | `exceljs` 流式 `WorkbookWriter` 逐行 commit |
| 进度推送 | SSE 每 300ms 最多一帧，节流避免高频事件 |

实测（Node 20，容器）：

- 5 万行解析 + 校验：堆峰值 ~30MB，端到端（含模拟上报）约 1.2s
- 10 万行解析：0.9~1.4s，堆峰值 ~34MB（RSS 135MB，主要为 Node/exceljs 基线），内存不随行数线性增长

## 平台对接

- 默认使用**内置模拟平台**：按地表水环境质量 Ⅲ 类阈值返回超标/异常（氨氮>1、总磷>0.2 等）
- 真实平台：设置环境变量后按 JSON POST，超时 15s + 指数退避重试 3 次

```bash
WQ_PLATFORM_URL=https://platform.example.gov/api/water/report \
WQ_PLATFORM_TOKEN=xxxx \
npm start
```

平台响应约定：

```json
{ "anomalies": [{ "id": "记录ID", "level": "OVER_LIMIT", "message": "氨氮超过 Ⅲ 类标准" }] }
```

整批复试后仍失败的记录写入 `上报失败` 清单（可补发），任务状态标记为「部分失败」。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/reference` | 合法采样点/指标/单位 |
| POST | `/api/jobs` | multipart 字段 `file` 上传，202 返回任务 |
| GET | `/api/jobs/:id` | 任务快照（计数/阶段/速度） |
| GET | `/api/jobs/:id/events` | SSE 实时进度 |
| POST | `/api/jobs/:id/cancel` | 取消（解析/上报循环均检查取消标记） |
| GET | `/api/jobs/:id/details/:type?page&pageSize` | 明细：`errors`/`anomalies`/`failed` |
| GET | `/api/jobs/:id/report` | 下载四表 Excel 报告（进行中也可下载当前阶段） |

## 任务产物（`data/jobs/<jobId>/`）

- `source.xlsx` 原始上传文件
- `valid.jsonl` 校验通过记录（上报阶段分批读取）
- `errors.jsonl` 校验失败（行号 + 字段级错误 + 原始内容）
- `anomalies.jsonl` 平台返回的异常
- `failed.jsonl` 平台上报失败批次（含失败原因，可补发）
- `meta.json` 任务快照（服务重启后仍可查询/下载报告）

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 4321 | 监听端口 |
| `WQ_DATA_DIR` | `./data` | 任务/上传数据目录 |
| `WQ_BATCH_SIZE` | 1000 | 解析落盘批大小 |
| `WQ_REPORT_BATCH_SIZE` | 500 | 平台上报批大小 |
| `WQ_REPORT_CONCURRENCY` | 4 | 上报并发批次数 |
| `WQ_PLATFORM_TIMEOUT` | 15000 | 单批超时 ms |
| `WQ_PLATFORM_MAX_RETRY` | 3 | 失败重试次数 |
| `WQ_PLATFORM_URL` / `WQ_PLATFORM_TOKEN` | 空（模拟平台） | 真实平台地址与令牌 |
| `WQ_MAX_FILE_SIZE` | 500MB | 上传大小上限 |

## 目录结构

```
server/
  config.js           配置（批大小/并发/平台/时间容忍）
  reference-data.js   采样点、指标、单位、阈值主数据
  parser.js           流式 Excel/CSV 解析 + 行数预判
  validator.js        表头映射 + 行校验（时间/单位/范围）
  storage.js          JSONL 追加写 / 分页读
  platform-client.js  平台上报（真实 HTTP 重试 / 内置模拟）
  report.js           流式 Excel 报告
  job-manager.js      任务编排：解析→校验→分批上报→汇总
  index.js            Express 路由 / SSE / 上传
public/               前端（上传、进度、明细、报告）
scripts/
  generate-sample.js  样本生成器
  smoke.js            端到端冒烟测试
```
