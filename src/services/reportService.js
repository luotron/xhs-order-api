const axios = require('axios');
const db = require('../db');
const config = require('../config');
const orderMonitor = require('./orderMonitor');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 分 → 元（两位小数），空值显示 - */
function yuan(fen) {
  if (fen === null || fen === undefined || fen === '' || Number.isNaN(Number(fen))) return '-';
  return (Number(fen) / 100).toFixed(2);
}

/** 计算字符串显示宽度（中文按 2 个字符宽度），用于对齐表格 */
function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\uFFFD]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s, w) {
  const padLen = w - strWidth(s);
  return String(s) + (padLen > 0 ? ' '.repeat(padLen) : '');
}

/** 生成日志表格：单号 | 店铺 | 金额 | 支付时间 | 完成时间 */
function renderOrderTable(rows) {
  const headers = ['单号', '店铺', '金额(元)', '支付时间', '完成时间'];
  const data = rows.map((r) => [r.orderId, r.shop, r.amount, r.paidTime, r.finishTime]);
  const widths = headers.map((h, i) => Math.max(strWidth(h), ...data.map((d) => strWidth(d[i]))));

  const border = (l, m, r) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const row = (cells) =>
    '│' + cells.map((c, i) => ` ${pad(c, widths[i])} `).join('│') + '│';

  const lines = [];
  lines.push(border('┌', '┬', '┐'));
  lines.push(row(headers));
  lines.push(border('├', '┼', '┤'));
  for (const d of data) lines.push(row(d));
  lines.push(border('└', '┴', '┘'));
  return lines.join('\n');
}

/** 从事件 payload 提取关键字段（金额来自补全的订单详情） */
function buildSummary(event) {
  let payload;
  try {
    payload = JSON.parse(event.payload || '{}');
  } catch {
    payload = {};
  }
  const detail = payload.detail || {};
  const store = db.getStore(event.seller_id, event.app_id) || {};
  // 金额优先级：订单实付金额 → 商家实际收款 → 定金总额
  const amountFen = detail.totalPayAmount ?? detail.merchantActualReceiveAmount ?? detail.totalDepositAmount ?? null;
  return {
    sellerId: event.seller_id,
    orderId: event.order_id,
    shopName: store.name || event.seller_id,
    amountYuan: yuan(amountFen),
    paidTime: fmtTime(payload.paidTime),
    finishTime: fmtTime(payload.finishTime),
    expressTrackingNo: detail.expressTrackingNo || '',
    expressCompanyCode: detail.expressCompanyCode || '',
    receiver: [payload.receiverProvinceName, payload.receiverCityName, payload.receiverDistrictName]
      .filter(Boolean).join(''),
  };
}

/** 打印一条订单的表格日志（单号/店铺/金额/时间） */
function logOrderTable(event, summary) {
  console.log('[report] ── 监听到支付成功订单，明细如下 ──');
  console.log(renderOrderTable([
    {
      orderId: summary.orderId,
      shop: `${summary.shopName}(${summary.sellerId})`,
      amount: summary.amountYuan,
      paidTime: summary.paidTime,
      finishTime: summary.finishTime,
    },
  ]));
  if (summary.expressTrackingNo) {
    console.log(`[report] 快递: ${summary.expressCompanyCode || ''} ${summary.expressTrackingNo} | 收件: ${summary.receiver}`);
  }
}

/**
 * 上报一条成功订单事件。
 * 规则：失败自动重试，共 config.reportRetryTimes 次；全部失败标记为最终失败并记录错误。
 * 上报接口待定（TODO）：REPORT_URL 配置为空时仅打印日志视为成功；
 * 配置了 REPORT_URL 则 POST JSON，失败按重试规则处理。
 */
async function reportEvent(event) {
  const maxAttempts = config.reportRetryTimes;
  db.updateOrderEvent(event.id, { report_status: 1, attempt_count: 0 });

  // 金额/快递等字段在订单详情接口才有，上报前补全（列表接口不含金额）
  const enrichedPayload = await orderMonitor.enrichEventWithDetail(event);
  const summary = buildSummary({ ...event, payload: JSON.stringify(enrichedPayload) });
  logOrderTable(event, summary);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // TODO: 上报接口待定 —— 简化后的平铺参数结构，接口定稿后按此对接
      const reportParams = {
        sellerId: summary.sellerId,
        orderId: summary.orderId,
        shopName: summary.shopName,
        amount: summary.amountYuan,            // 实付金额（元，两位小数）
        paidTime: summary.paidTime,            // 支付时间 YYYY-MM-DD HH:mm:ss
        finishTime: summary.finishTime,        // 完成时间 YYYY-MM-DD HH:mm:ss
        expressCompanyCode: summary.expressCompanyCode || undefined,
        expressTrackingNo: summary.expressTrackingNo || undefined,
      };

      if (config.reportUrl) {
        // TODO: 待定接口启用后走这里，超时 10s
        await axios.post(config.reportUrl, reportParams, {
          headers: { 'Content-Type': 'application/json;charset=utf-8' },
          timeout: 10000,
        });
        console.log(`[report] 上报成功 orderId=${event.order_id} sellerId=${event.seller_id} attempt=${attempt} url=${config.reportUrl}`);
      } else {
        // 接口待定，暂时只打印上报参数（表格已在上方输出）
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

module.exports = { reportEvent, processQueue, startReporter, buildSummary, renderOrderTable };
