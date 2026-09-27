const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;

let selectedFile = null;
let currentJob = null;
let evtSource = null;
let detailTab = 'anomalies';
let detailPage = 1;
let detailTotal = 0;

const STATUS_TEXT = {
  PENDING: '等待中', PARSING: '解析校验中', REPORTING: '平台上报中',
  DONE: '已完成', PARTIAL: '部分失败', CANCELED: '已取消', ERROR: '系统错误',
};

$('pickBtn').addEventListener('click', () => $('fileInput').click());
$('dropZone').addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') $('fileInput').click(); });
$('fileInput').addEventListener('change', (e) => selectFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((ev) => $('dropZone').addEventListener(ev, (e) => {
  e.preventDefault(); $('dropZone').classList.add('drag');
}));
['dragleave', 'drop'].forEach((ev) => $('dropZone').addEventListener(ev, (e) => {
  e.preventDefault(); $('dropZone').classList.remove('drag');
}));
$('dropZone').addEventListener('drop', (e) => selectFile(e.dataTransfer.files[0]));

$('uploadBtn').addEventListener('click', uploadFile);
$('cancelBtn').addEventListener('click', async () => {
  if (!currentJob) return;
  await fetch(`/api/jobs/${currentJob.id}/cancel`, { method: 'POST' });
});
$('reportBtn').addEventListener('click', () => {
  if (currentJob) window.open(`/api/jobs/${currentJob.id}/report`, '_blank');
});
$('refBtn').addEventListener('click', loadReference);
$('refClose').addEventListener('click', () => { $('refModal').hidden = true; });
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  detailTab = t.dataset.tab;
  detailPage = 1;
  loadDetails();
}));
$('prevPage').addEventListener('click', () => { if (detailPage > 1) { detailPage -= 1; loadDetails(); } });
$('nextPage').addEventListener('click', () => {
  if (detailPage * PAGE_SIZE < detailTotal) { detailPage += 1; loadDetails(); }
});

function selectFile(file) {
  if (!file) return;
  if (!/\.(xlsx|csv)$/i.test(file.name)) { alert('仅支持 .xlsx / .csv 文件'); return; }
  selectedFile = file;
  $('fileMeta').textContent = `${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`;
  $('uploadBtn').disabled = false;
}

async function uploadFile() {
  if (!selectedFile) return;
  $('uploadBtn').disabled = true;
  const fd = new FormData();
  fd.append('file', selectedFile);
  try {
    const res = await fetch('/api/jobs', { method: 'POST', body: fd });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || '上传失败');
    startProgress(job);
  } catch (err) {
    alert(err.message);
    $('uploadBtn').disabled = false;
  }
}

function startProgress(job) {
  currentJob = job;
  $('progressCard').hidden = false;
  $('detailCard').hidden = false;
  $('cancelBtn').hidden = false;
  connectSSE(job.id);
}

function connectSSE(id) {
  evtSource?.close();
  evtSource = new EventSource(`/api/jobs/${id}/events`);
  evtSource.addEventListener('progress', (e) => {
    const snap = JSON.parse(e.data);
    currentJob = snap;
    render(snap);
    if (['DONE', 'PARTIAL', 'CANCELED', 'ERROR'].includes(snap.status)) {
      evtSource.close();
      $('cancelBtn').hidden = true;
      $('uploadBtn').disabled = false;
      loadDetails();
    }
  });
  evtSource.onerror = () => {
    // 网络抖动时 EventSource 会自动重连；刷新页面也可用快照兜底
    setTimeout(async () => {
      try {
        const r = await fetch(`/api/jobs/${id}`);
        if (r.ok) render(await r.json());
      } catch {}
    }, 2000);
  };
}

function render(s) {
  const finished = ['DONE', 'PARTIAL', 'CANCELED', 'ERROR'].includes(s.status);
  $('jobMeta').innerHTML = `任务 ${s.id} · ${escapeHtml(s.originalName)} ·
    <span class="status-pill ${s.status}">${STATUS_TEXT[s.status] || s.status}</span>`;

  // 阶段一
  const parseBar = $('parseBar');
  if (s.progress.parse === -1) {
    parseBar.classList.add('indeterminate');
    $('parsePct').textContent = '解析中';
  } else {
    parseBar.classList.remove('indeterminate');
    parseBar.style.width = `${s.progress.parse}%`;
    $('parsePct').textContent = `${s.progress.parse}%`;
  }
  $('parseSub').textContent = `已扫描 ${s.counts.totalRows.toLocaleString()} 行 · 通过 ${s.counts.valid.toLocaleString()} · 失败 ${s.counts.invalid.toLocaleString()} · ${s.speed.rowsPerSec.toLocaleString()} 行/秒`;

  // 阶段二
  $('reportBar').style.width = `${s.progress.report}%`;
  $('reportPct').textContent = `${s.progress.report}%`;
  $('reportSub').textContent = s.phase === 'report' || finished
    ? `已上报 ${s.counts.reported.toLocaleString()} 条 · 异常 ${s.counts.anomalies.toLocaleString()} · 失败 ${s.counts.failed.toLocaleString()} · ${s.speed.recordsPerSec.toLocaleString()} 条/秒`
    : '等待校验完成…';

  $('stats').innerHTML = statHtml([
    ['校验通过', s.counts.valid, 'ok'],
    ['校验失败', s.counts.invalid, 'warn'],
    ['已上报', s.counts.reported, 'muted'],
    ['平台异常', s.counts.anomalies, 'bad'],
    ['上报失败', s.counts.failed, 'bad'],
    ['数据行', s.counts.totalRows, 'muted'],
  ]);

  $('cntAnomalies').textContent = s.counts.anomalies;
  $('cntErrors').textContent = s.counts.invalid;
  $('cntFailed').textContent = s.counts.failed;
  $('reportBtn').disabled = !finished && s.counts.totalRows === 0;
  if (s.error) $('parseSub').innerHTML += ` <span class="err-text">系统错误: ${escapeHtml(s.error)}</span>`;
}

function statHtml(items) {
  return items.map(([l, n, cls]) =>
    `<div class="stat"><div class="n ${cls}">${Number(n || 0).toLocaleString()}</div><div class="l">${l}</div></div>`).join('');
}

async function loadDetails() {
  if (!currentJob) return;
  const r = await fetch(`/api/jobs/${currentJob.id}/details/${detailTab}?page=${detailPage}&pageSize=${PAGE_SIZE}`);
  const data = await r.json();
  detailTotal = data.total;
  $('pageInfo').textContent = `${data.page} / ${Math.max(1, Math.ceil(data.total / data.pageSize))}`;
  $('detailBody').innerHTML = detailTab === 'anomalies' ? anomaliesTable(data.items)
    : detailTab === 'errors' ? errorsTable(data.items) : failedTable(data.items);
}

function anomaliesTable(items) {
  if (!items.length) return emptyHint('暂无平台返回的异常记录');
  return table(
    ['行号', '采样点', '指标', '实测值', '采样时间', '级别', '异常说明'],
    items.map((o) => [o.lineNo, `${o.pointCode} ${o.pointName}`, o.indicatorName,
      `${o.value} ${o.unit}`, fmtTime(o.sampledAt),
      `<span class="tag-lvl ${o.level}">${o.level === 'OVER_LIMIT' ? '超标' : '异常'}</span>`,
      escapeHtml(o.message)]),
  );
}

function errorsTable(items) {
  if (!items.length) return emptyHint('暂无校验失败记录');
  return table(
    ['Excel 行号', '字段', '错误说明', '原始内容'],
    items.flatMap((o) => o.errors.map((e, i) => [
      i === 0 ? o.lineNo : '', e.field, escapeHtml(e.message),
      i === 0 ? `<code>${escapeHtml(JSON.stringify(o.raw))}</code>` : '',
    ])),
  );
}

function failedTable(items) {
  if (!items.length) return emptyHint('全部批次上报成功');
  return table(
    ['行号', '采样点', '指标', '数值', '采样时间', '失败原因'],
    items.map((o) => [o.lineNo, o.pointCode, o.indicatorCode, o.value, fmtTime(o.sampledAt), escapeHtml(o.failedReason)]),
  );
}

function table(headers, rows) {
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function emptyHint(text) { return `<p style="text-align:center;color:#94a6b5;padding:24px">${text}</p>`; }

async function loadReference() {
  const r = await fetch('/api/reference');
  const { samplingPoints, indicators } = await r.json();
  $('refContent').innerHTML = `
    <h4>采样点（${samplingPoints.length}）</h4>
    <table><thead><tr><th>编码</th><th>名称</th><th>类型</th><th>区域</th></tr></thead>
    <tbody>${samplingPoints.map((p) => `<tr><td>${p.code}</td><td>${p.name}</td><td>${p.type}</td><td>${p.region}</td></tr>`).join('')}</tbody></table>
    <h4>指标与合法单位（${indicators.length}）</h4>
    <table><thead><tr><th>编码</th><th>名称</th><th>允许单位</th><th>物理范围</th></tr></thead>
    <tbody>${indicators.map((i) => `<tr><td>${i.code}</td><td>${i.name}</td><td>${i.units.join(' / ')}</td><td>[${i.min}, ${i.max}]</td></tr>`).join('')}</tbody></table>`;
  $('refModal').hidden = false;
}

function fmtTime(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : ''; }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
