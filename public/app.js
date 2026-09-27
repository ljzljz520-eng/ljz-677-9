'use strict';

const app = document.getElementById('app');
const STATUS_CN = {
  queued: '排队中', parsing: '解析中', parsed: '待上送',
  uploading: '上送中', done: '已完成', failed: '失败', canceled: '已取消',
};
const FIELD_CN = {
  sampling_point: '采样点', metric: '检测指标', unit: '单位',
  value: '检测值', sampled_at: '采样时间', duplicate: '重复报送', header: '表头',
};

function toast(msg, isErr) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (s) => s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-';
const fmtNum = (n) => Number(n || 0).toLocaleString('zh-CN');
const badge = (s) => `<span class="badge ${s}">${STATUS_CN[s] || s}</span>`;

// ---------------- 路由 ----------------
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);

function route() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/jobs\/([\w-]+)/);
  if (m) renderDetail(m[1]);
  else renderHome();
}

// ---------------- 首页：上传 + 任务列表 ----------------
async function renderHome() {
  app.innerHTML = `
    <div class="card">
      <h2>📤 上传检测数据</h2>
      <div class="dropzone" id="dz">
        <div class="big">📊</div>
        <p>点击选择 或 拖拽 Excel 文件到此处（.xlsx，最大 500MB）</p>
        <p class="muted">支持几万至几十万行，服务端按 1000 行/批流式解析，不会整体读入内存</p>
        <p style="margin-top:10px">
          <a class="btn ghost" href="/api/template">⬇️ 下载导入模板</a>
        </p>
        <input type="file" id="file" accept=".xlsx,.xls">
      </div>
    </div>
    <div class="card">
      <h2>📋 上报任务 <button class="ghost" id="refresh" style="margin-left:auto">刷新</button></h2>
      <div id="joblist"><p class="muted">加载中…</p></div>
    </div>`;

  const dz = document.getElementById('dz');
  const input = document.getElementById('file');
  dz.onclick = () => input.click();
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('dragover'); };
  dz.ondragleave = () => dz.classList.remove('dragover');
  dz.ondrop = (e) => {
    e.preventDefault(); dz.classList.remove('dragover');
    if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
  };
  input.onchange = () => input.files[0] && upload(input.files[0]);
  document.getElementById('refresh').onclick = loadJobs;
  loadJobs();
}

async function upload(file) {
  const fd = new FormData();
  fd.append('file', file);
  toast(`正在上传 ${file.name}（${(file.size / 1048576).toFixed(1)} MB）…`);
  try {
    const { id } = await api('/api/upload', { method: 'POST', body: fd });
    toast('上传成功，开始后台处理');
    location.hash = `#/jobs/${id}`;
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadJobs() {
  const box = document.getElementById('joblist');
  try {
    const jobs = await api('/api/jobs');
    if (!jobs.length) { box.innerHTML = '<p class="muted">暂无任务</p>'; return; }
    box.innerHTML = `<table>
      <thead><tr><th>任务</th><th>文件</th><th>状态</th><th>总行数</th>
      <th>有效</th><th>校验错误</th><th>已接收</th><th>平台异常</th><th>创建时间</th></tr></thead>
      <tbody>${jobs.map((j) => `<tr style="cursor:pointer" onclick="location.hash='#/jobs/${j.id}'">
        <td><code>${j.id}</code></td>
        <td title="${esc(j.filename)}">${esc(j.filename.length > 22 ? j.filename.slice(0, 20) + '…' : j.filename)}</td>
        <td>${badge(j.status)}</td>
        <td>${fmtNum(j.total_rows)}</td>
        <td>${fmtNum(j.valid_rows)}</td>
        <td class="${j.invalid_rows ? 'tag-err' : ''}">${fmtNum(j.invalid_rows)}</td>
        <td>${fmtNum(j.uploaded_rows)}</td>
        <td class="${j.abnormal_rows ? 'tag-warn' : ''}">${fmtNum(j.abnormal_rows)}</td>
        <td>${fmtTime(j.created_at)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch (err) {
    box.innerHTML = `<p class="tag-err">加载失败：${esc(err.message)}</p>`;
  }
}

// ---------------- 任务详情 ----------------
let es = null;
async function renderDetail(id) {
  if (es) { es.close(); es = null; }
  app.innerHTML = `<a class="back" href="#/">← 返回任务列表</a>
    <div class="card"><p class="muted">加载中…</p></div>`;
  let job;
  try { job = await api(`/api/jobs/${id}`); }
  catch (err) { app.innerHTML += `<p class="tag-err">${esc(err.message)}</p>`; return; }

  app.innerHTML = `
    <a class="back" href="#/">← 返回任务列表</a>
    <div class="card">
      <h2>任务 <code>${id}</code> <span id="st" style="margin-left:8px"></span>
        <span style="margin-left:auto">
          <button class="ghost" id="btnCancel">取消任务</button>
          <button class="ghost" id="btnRetry">重试上送</button>
        </span>
      </h2>
      <div class="progress-wrap">
        <div class="progress" id="prog"><div class="bar" id="bar"></div></div>
        <div class="progress-msg" id="pmsg">连接中…</div>
      </div>
      <div class="stats-grid">
        <div class="stat info"><div class="num" id="s-total">0</div><div class="lbl">已解析行</div></div>
        <div class="stat ok"><div class="num" id="s-valid">0</div><div class="lbl">校验有效</div></div>
        <div class="stat err"><div class="num" id="s-invalid">0</div><div class="lbl">校验错误</div></div>
        <div class="stat"><div class="num" id="s-uploaded">0</div><div class="lbl">平台已接收</div></div>
        <div class="stat warn"><div class="num" id="s-abnormal">0</div><div class="lbl">平台异常</div></div>
      </div>
      <div class="meta-list" id="meta"></div>
      <p id="errmsg" class="tag-err" style="display:none"></p>
      <p style="margin-top:14px">
        <a class="btn" id="exp-report">⬇️ 完整报告</a>
        <a class="btn ghost" id="exp-errors">⬇️ 校验错误明细</a>
        <a class="btn ghost" id="exp-abn">⬇️ 平台异常明细</a>
      </p>
    </div>
    <div class="card">
      <div class="tabs">
        <div class="tab active" data-tab="errors">校验错误（采样点/指标/单位/时间）</div>
        <div class="tab" data-tab="abnormals">平台异常结果</div>
      </div>
      <div id="detail"></div>
    </div>`;

  for (const [bid, href] of [
    ['exp-report', `/api/jobs/${id}/export/report`],
    ['exp-errors', `/api/jobs/${id}/export/errors`],
    ['exp-abn', `/api/jobs/${id}/export/abnormals`],
  ]) document.getElementById(bid).href = href;

  document.getElementById('btnCancel').onclick = async () => {
    try { await api(`/api/jobs/${id}/cancel`, { method: 'POST' }); toast('已请求取消'); }
    catch (e) { toast(e.message, true); }
  };
  document.getElementById('btnRetry').onclick = async () => {
    try { await api(`/api/jobs/${id}/retry`, { method: 'POST' }); toast('已重新排入上送队列'); window.location.reload(); }
    catch (e) { toast(e.message, true); }
  };
  document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    loadTable(id, t.dataset.tab, 1);
  });

  renderJob(job);
  loadTable(id, 'errors', 1);
  subscribe(id);
}

function renderJob(j, phase) {
  document.getElementById('st').innerHTML = badge(j.status);
  const set = (k, v) => { const el = document.getElementById(k); if (el) el.textContent = v; };
  set('s-total', fmtNum(j.total_rows));
  set('s-valid', fmtNum(j.valid_rows));
  set('s-invalid', fmtNum(j.invalid_rows));
  set('s-uploaded', fmtNum(j.uploaded_rows));
  set('s-abnormal', fmtNum(j.abnormal_rows));
  document.getElementById('meta').innerHTML = `
    <div><b>源文件：</b>${esc(j.filename)}</div>
    <div><b>创建时间：</b>${fmtTime(j.created_at)}</div>
    <div><b>开始时间：</b>${fmtTime(j.started_at)}</div>
    <div><b>完成时间：</b>${fmtTime(j.finished_at)}</div>`;
  const em = document.getElementById('errmsg');
  if (j.error_message) { em.style.display = 'block'; em.textContent = '⚠️ ' + j.error_message; }

  const prog = document.getElementById('prog');
  const bar = document.getElementById('bar');
  const msg = document.getElementById('pmsg');
  const active = ['queued', 'parsing', 'uploading'].includes(j.status);
  if (phase === 'parsing' && active) {
    prog.classList.add('unknown'); bar.style.width = '35%';
    msg.textContent = j.message || '解析中…（流式分批，行总数解析完成后可知）';
  } else {
    prog.classList.remove('unknown');
    const pct = (phase === 'finished' || j.status === 'done') ? 100
      : (j.percent ?? (j.valid_rows ? Math.round((j.uploaded_rows + j.abnormal_rows) / j.valid_rows * 100) : 0));
    bar.style.width = pct + '%';
    msg.textContent = j.message ||
      (j.status === 'done' ? '✅ 全部完成' :
       j.status === 'failed' ? '❌ 处理失败' :
       j.status === 'canceled' ? '🚫 已取消' : '准备中…');
  }
  const canCancel = ['queued', 'parsing', 'uploading'].includes(j.status);
  document.getElementById('btnCancel').disabled = !canCancel;
}

function subscribe(id) {
  es = new EventSource(`/api/jobs/${id}/events`);
  es.addEventListener('snapshot', (e) => renderJob(JSON.parse(e.data)));
  es.addEventListener('progress', (e) => {
    const d = JSON.parse(e.data);
    renderJob(d, d.phase);
  });
  es.addEventListener('done', (e) => {
    const d = JSON.parse(e.data);
    renderJob(d, 'finished');
    es.close(); es = null;
    const tab = document.querySelector('.tab.active')?.dataset.tab || 'errors';
    loadTable(id, tab, 1);
    toast('任务完成');
  });
  es.addEventListener('error', (e) => {
    try { renderJob(JSON.parse(e.data), 'finished'); } catch {}
    es?.close(); es = null;
    const tab = document.querySelector('.tab.active')?.dataset.tab || 'errors';
    loadTable(id, tab, 1);
  });
  es.addEventListener('canceled', () => { es?.close(); es = null; });
  es.onerror = () => { /* 网络抖动浏览器会自动重连 */ };
}

// ---------------- 错误/异常 明细表 ----------------
const pageState = {};
async function loadTable(id, kind, page) {
  const box = document.getElementById('detail');
  pageState[id + kind] = page;
  box.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const url = `/api/jobs/${id}/${kind === 'errors' ? 'errors' : 'abnormals'}?page=${page}&size=15`;
    const data = await api(url);
    if (!data.total) {
      box.innerHTML = kind === 'errors'
        ? '<p class="muted">✅ 没有校验错误</p>'
        : '<p class="muted">平台未返回异常结果</p>';
      return;
    }
    const head = kind === 'errors'
      ? ['Excel行号', '字段', '错误说明', '原始数据']
      : ['Excel行号', '采样点', '指标', '检测值', '单位', '采样时间', '异常码', '平台判定'];
    const rows = data.rows.map((r) => kind === 'errors'
      ? `<tr><td>${r.row_no}</td><td class="tag-err">${FIELD_CN[r.field] || r.field}</td>
         <td>${esc(r.message)}</td><td class="muted" style="max-width:380px;word-break:break-all">${esc(r.raw)}</td></tr>`
      : `<tr><td>${r.row_no}</td><td>${esc(r.point_name || '-')}</td>
         <td>${esc(r.metric_name || '-')}</td><td>${r.value ?? '-'}</td>
         <td>${esc(r.unit || '-')}</td><td>${fmtTime(r.sampled_at)}</td>
         <td><code>${esc(r.code)}</code></td><td class="tag-warn">${esc(r.message)}</td></tr>`
    ).join('');
    const pages = Math.ceil(data.total / data.size);
    box.innerHTML = `
      <div style="overflow-x:auto"><table><thead><tr>
        ${head.map((h) => `<th>${h}</th>`).join('')}
      </tr></thead><tbody>${rows}</tbody></table></div>
      <div class="pager">
        <span class="pill">共 ${fmtNum(data.total)} 条，第 ${page}/${pages} 页</span>
        <button class="ghost" ${page <= 1 ? 'disabled' : ''} data-p="${page - 1}">上一页</button>
        <button class="ghost" ${page >= pages ? 'disabled' : ''} data-p="${page + 1}">下一页</button>
      </div>`;
    box.querySelectorAll('button[data-p]').forEach((b) =>
      b.onclick = () => loadTable(id, kind, Number(b.dataset.p)));
  } catch (err) {
    box.innerHTML = `<p class="tag-err">${esc(err.message)}</p>`;
  }
}
