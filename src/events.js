'use strict';
// 每个 job 一个事件通道，SSE 订阅；服务重启后前端可通过轮询 /api/jobs/:id 恢复
const { EventEmitter } = require('events');
const channels = new Map();

function channel(jobId) {
  if (!channels.has(jobId)) {
    const ch = new EventEmitter();
    ch.setMaxListeners(50);
    channels.set(jobId, ch);
  }
  return channels.get(jobId);
}

function emit(jobId, event, data) {
  channel(jobId).emit(event, data);
}
function on(jobId, event, fn) { channel(jobId).on(event, fn); }
function off(jobId, event, fn) {
  const ch = channels.get(jobId);
  if (ch) ch.off(event, fn);
}

module.exports = { emit, on, off };
