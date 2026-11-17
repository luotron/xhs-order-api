const axios = require('axios');
const db = require('../db');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 上报一条成功订单事件。
 * 规则：失败自动重试，共 config.reportRetryTimes 次；全部失败标记为最终失败并记录错误。
 * 上报接口待定（TODO）：REPORT_URL 配置为空时仅打印日志视为成功；
 * 配置了 REPORT_URL 则 POST JSON，失败按重试规则处理。
 */
async function reportEvent(event) {
  const maxAttempts = config.reportRetryTimes;
  db.updateOrderEvent(event.id, { report_status: 1, attempt_count: 0 });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // TODO: 上报接口待定 —— 参数结构按下面这个 payload 对齐，接口定稿后替换此段即可
      const reportParams = {
        sellerId: event.seller_id,
        appId: event.app_id,
        orderId: event.order_id,
        orderStatus: event.order_status,
        order: JSON.parse(event.payload || '{}'),
      };

      if (config.reportUrl) {
        // TODO: 待定接口启用后走这里，超时 10s
        await axios.post(config.reportUrl, reportParams, {
          headers: { 'Content-Type': 'application/json;charset=utf-8' },
          timeout: 10000,
        });
        console.log(`[report] 上报成功 orderId=${event.order_id} sellerId=${event.seller_id} attempt=${attempt} url=${config.reportUrl}`);
      } else {
        // 接口待定，暂时只打印上报参数
        console.log(`[report] TODO 接口待定，模拟上报成功 orderId=${event.order_id} attempt=${attempt} params=${JSON.stringify(reportParams)}`);
      }

      db.updateOrderEvent(event.id, {
        report_status: 2,
        attempt_count: attempt,
        last_error: '',
        reported_at: Date.now(),
      });
      return true;
    } catch (e) {
      const msg = e.response ? `HTTP ${e.response.status} ${e.response.statusText}` : e.message;
      console.error(`[report] 上报失败 orderId=${event.order_id} attempt=${attempt}/${maxAttempts} error=${msg}`);
      db.updateOrderEvent(event.id, { attempt_count: attempt, last_error: msg });
      if (attempt < maxAttempts) {
        await sleep(attempt * config.reportRetryBackoffMs);
      }
    }
  }

  db.updateOrderEvent(event.id, { report_status: 3, attempt_count: maxAttempts });
  console.error(`[report] 重试${maxAttempts}次仍失败，标记最终失败 orderId=${event.order_id}`);
  return false;
}

let processing = false;

/** 处理队列：待上报(0) → 上报；兜底重试最终失败(3) 的事件 */
async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    const pending = db.listPendingOrderEvents(100);
    for (const ev of pending) {
      await reportEvent(ev);
    }
    // 兜底：重试耗尽的事件再给一次机会（仍受每次 3 次重试约束）
    const failed = db.listFailedOrderEvents(50);
    for (const ev of failed) {
      console.log(`[report] 兜底重试最终失败事件 orderId=${ev.order_id}`);
      await reportEvent(ev);
    }
  } finally {
    processing = false;
  }
}

function startReporter() {
  // 恢复崩溃卡在"上报中"的事件
  db.resetStuckOrderEvents();
  setInterval(() => {
    processQueue().catch((e) => console.error('[report] 队列处理异常', e.message));
  }, Math.max(config.monitorIntervalMs, 10000));
  console.log(`[report] 上报队列已启动，重试次数=${config.reportRetryTimes}，REPORT_URL=${config.reportUrl || '(待定，仅打印日志)'}`);
  return processQueue();
}

module.exports = { reportEvent, processQueue, startReporter };
