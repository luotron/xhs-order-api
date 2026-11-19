const db = require('../db');
const config = require('../config');
const xhs = require('./xhsClient');
const tokenManager = require('./tokenManager');

/** 判断订单是否已支付：paidTime > 0 即支付成功（状态 1 待付款的订单 paidTime 为空） */
function isPaid(order) {
  return !!order.paidTime && Number(order.paidTime) > 0;
}

/**
 * 拉取店铺指定更新时间窗口内的全部订单（自动翻页，最大 100 页保护）
 * 平台限制：timeType=2（更新时间）窗口 ≤30 分钟
 */
async function fetchOrdersByUpdateTime(appId, sellerId, startTime, endTime) {
  const app = db.getApp(appId);
  let accessToken = await tokenManager.getValidAccessToken(appId, sellerId);

  const results = [];
  let pageNo = 1;
  const pageSize = 100;
  const maxPages = 100;

  while (pageNo <= maxPages) {
    const params = { startTime, endTime, timeType: 2, orderStatus: 0, pageNo, pageSize };
    let data;
    try {
      data = await xhs.getOrderList(app, accessToken, params);
    } catch (e) {
      if (e.errorCode === 10008) {
        accessToken = await tokenManager.doRefresh(appId, sellerId);
        data = await xhs.getOrderList(app, accessToken, params);
      } else {
        throw e;
      }
    }
    results.push(...(data.orderList || []));
    const maxPageNo = Number(data.maxPageNo) || 1;
    if (pageNo >= maxPageNo) break;
    pageNo++;
  }
  return results;
}

/** 处理某店铺一个时间窗口：发现已支付订单 → 去重入库 → 交给上报队列（上报时补全金额等详情） */
async function pollWindow(appId, sellerId, startTime, endTime) {
  const orders = await fetchOrdersByUpdateTime(appId, sellerId, startTime, endTime);
  let fresh = 0;
  for (const o of orders) {
    if (!isPaid(o)) continue; // 待付款/未支付订单不触发上报
    const inserted = db.insertOrderEvent({
      sellerId,
      appId,
      orderId: o.orderId,
      orderStatus: o.orderStatus,
      payload: o,
    });
    if (inserted) fresh++;
  }
  if (fresh > 0) {
    console.log(`[orderMonitor] 发现新支付订单 sellerId=${sellerId} 窗口内共${orders.length}条 新增${fresh}条`);
  }
  return { total: orders.length, fresh };
}

/** 为新捕获的成功订单补全订单详情（金额/快递等字段在 order.getOrderDetail 中才有） */
async function enrichEventWithDetail(event) {
  try {
    const app = db.getApp(event.app_id);
    const accessToken = await tokenManager.getValidAccessToken(event.app_id, event.seller_id);
    const detail = await xhs.getOrderDetail(app, accessToken, event.order_id);
    const base = JSON.parse(event.payload || '{}');
    const merged = { ...base, detail };
    db.updateOrderEvent(event.id, { payload: JSON.stringify(merged) });
    return merged;
  } catch (e) {
    console.error(`[orderMonitor] 补全订单详情失败 orderId=${event.order_id} error=${e.message}`);
    return JSON.parse(event.payload || '{}');
  }
}

/** 获取所有已授权店铺（有 token 记录的） */
function listAuthorizedStores() {
  const stores = [];
  for (const appInfo of db.listApps()) {
    for (const s of db.listStores(appInfo.app_id)) {
      if (db.getCredential(s.seller_id, appInfo.app_id)) stores.push({ appId: appInfo.app_id, sellerId: s.seller_id });
    }
  }
  return stores;
}

/** 一次轮询：所有店铺 × 最近 30 分钟更新窗口 */
async function pollOnce() {
  const stores = listAuthorizedStores();
  const now = Math.floor(Date.now() / 1000);
  const start = now - config.monitorWindowMinutes * 60;
  const summary = [];
  for (const { appId, sellerId } of stores) {
    try {
      const r = await pollWindow(appId, sellerId, start, now);
      summary.push({ sellerId, ...r });
    } catch (e) {
      console.error(`[orderMonitor] 轮询失败 sellerId=${sellerId} error=${e.message}`);
      summary.push({ sellerId, error: e.message });
    }
    // 店铺间错峰 300ms，降低突发请求被网关限流/重置的概率
    await new Promise((r) => setTimeout(r, 300));
  }
  return summary;
}

/**
 * 启动时回填：最近 N 分钟（默认60）的已支付订单。
 * 因平台单窗口上限 30 分钟，按 30 分钟切片补查，跨过当前轮询窗口的部分需分段。
 */
async function backfillOnce() {
  const stores = listAuthorizedStores();
  const now = Math.floor(Date.now() / 1000);
  const total = config.monitorBackfillMinutes;
  const chunk = config.monitorWindowMinutes; // 30
  console.log(`[orderMonitor] 启动回填最近${total}分钟已支付订单，店铺数=${stores.length}`);
  for (const { appId, sellerId } of stores) {
    try {
      for (let from = now - total * 60; from < now; from += chunk * 60) {
        const to = Math.min(from + chunk * 60, now);
        await pollWindow(appId, sellerId, from, to);
      }
    } catch (e) {
      console.error(`[orderMonitor] 回填失败 sellerId=${sellerId} error=${e.message}`);
    }
  }
  console.log('[orderMonitor] 启动回填完成');
}

function startMonitor() {
  backfillOnce().then(() => {
    pollOnce(); // 回填后立即正式轮询一次
    setInterval(() => {
      pollOnce().catch((e) => console.error('[orderMonitor] 轮询异常', e.message));
    }, config.monitorIntervalMs);
    console.log(`[orderMonitor] 监听已启动：每 ${config.monitorIntervalMs / 1000}s 轮询所有店铺最近 ${config.monitorWindowMinutes} 分钟更新的订单，支付成功(paidTime>0)即触发上报`);
  });
}

module.exports = { startMonitor, pollOnce, backfillOnce, listAuthorizedStores, enrichEventWithDetail };
