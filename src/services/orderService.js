const db = require('../db');
const xhs = require('./xhsClient');
const tokenManager = require('./tokenManager');

const ORDER_STATUS_TEXT = {
  1: '已下单待付款',
  2: '已支付处理中',
  3: '清关中',
  4: '待发货',
  5: '部分发货',
  6: '待收货',
  7: '已完成',
  8: '已关闭',
  9: '已取消',
  10: '换货申请中',
};

const AFTER_SALES_STATUS_TEXT = {
  1: '无售后',
  2: '售后处理中',
  3: '售后完成',
  4: '售后拒绝',
  5: '售后关闭',
  6: '平台介入中',
  7: '售后取消',
};

/**
 * 核心能力：根据 店铺ID + 订单号 查询订单状态
 */
async function queryOrderStatus(appId, { sellerId, orderId }) {
  if (!sellerId) throw new Error('缺少店铺ID sellerId');
  if (!orderId) throw new Error('缺少订单号 orderId');
  const store = db.getStore(String(sellerId), appId);
  if (!store) throw new Error('店铺不存在：请先在控制台添加授权店铺并完成授权');

  const app = db.getApp(appId);
  let accessToken = await tokenManager.getValidAccessToken(appId, store.seller_id);

  let detail;
  try {
    detail = await xhs.getOrderDetail(app, accessToken, orderId);
  } catch (e) {
    if (e.errorCode === 10008) { // accessToken 失效
      accessToken = await tokenManager.doRefresh(appId, store.seller_id);
      detail = await xhs.getOrderDetail(app, accessToken, orderId);
    } else {
      throw e;
    }
  }

  return {
    store: { sellerId: store.seller_id, name: store.name },
    orderId: detail.orderId,
    orderStatus: detail.orderStatus,
    orderStatusText: ORDER_STATUS_TEXT[detail.orderStatus] || `未知(${detail.orderStatus})`,
    orderAfterSalesStatus: detail.orderAfterSalesStatus,
    orderAfterSalesStatusText: AFTER_SALES_STATUS_TEXT[detail.orderAfterSalesStatus] || '',
    cancelStatus: detail.cancelStatus,
    createdTime: detail.createdTime,
    paidTime: detail.paidTime,
    updateTime: detail.updateTime,
    deliveryTime: detail.deliveryTime,
    finishTime: detail.finishTime,
    promiseLastDeliveryTime: detail.promiseLastDeliveryTime,
    expressTrackingNo: detail.expressTrackingNo || null,
    expressCompanyCode: detail.expressCompanyCode || null,
    totalPayAmount: detail.totalPayAmount,
    detail,
  };
}

/**
 * 解析时间范围：前端只需传 lastHours / lastMinutes，由后端计算 startTime/endTime。
 * 也可显式传 startTime/endTime/timeType（保持兼容）。
 * 平台限制：timeType=1（创建时间）窗口 ≤24h；timeType=2（更新时间）窗口 ≤30min
 */
function resolveTimeRange(body) {
  const now = Math.floor(Date.now() / 1000);
  if (body.startTime && body.endTime && body.timeType) {
    return { startTime: Number(body.startTime), endTime: Number(body.endTime), timeType: Number(body.timeType) };
  }
  if (body.lastMinutes) {
    const m = Math.min(Number(body.lastMinutes), 30); // timeType=2 限制 30 分钟
    return { startTime: now - m * 60, endTime: now, timeType: 2 };
  }
  const h = Math.min(Number(body.lastHours || 24), 24); // timeType=1 限制 24 小时
  return { startTime: now - h * 3600, endTime: now, timeType: 1 };
}

/**
 * 订单列表（分页）
 * 入参：sellerId、lastHours（默认24）/ lastMinutes、orderType、orderStatus、pageNo、pageSize
 */
async function queryOrderList(appId, body) {
  const { sellerId, orderType, orderStatus } = body;
  if (!sellerId) throw new Error('缺少店铺ID sellerId');
  const store = db.getStore(String(sellerId), appId);
  if (!store) throw new Error('店铺不存在：请先在控制台添加授权店铺并完成授权');

  const app = db.getApp(appId);
  let accessToken = await tokenManager.getValidAccessToken(appId, store.seller_id);
  const { startTime, endTime, timeType } = resolveTimeRange(body);
  const params = {
    startTime,
    endTime,
    timeType,
    pageNo: body.pageNo ? Number(body.pageNo) : 1,
    pageSize: body.pageSize ? Number(body.pageSize) : 50,
  };
  if (orderType !== undefined && orderType !== null && orderType !== '') params.orderType = Number(orderType);
  if (orderStatus !== undefined && orderStatus !== null && orderStatus !== '') params.orderStatus = Number(orderStatus);

  let data;
  try {
    data = await xhs.getOrderList(app, accessToken, params);
  } catch (e) {
    if (e.errorCode === 10008) {
      accessToken = await tokenManager.doRefresh(appId, store.seller_id);
      data = await xhs.getOrderList(app, accessToken, params);
    } else {
      throw e;
    }
  }
  const orderList = (data.orderList || []).map((o) => ({
    ...o,
    orderStatusText: ORDER_STATUS_TEXT[o.orderStatus] || '',
  }));
  return { ...data, orderList, query: { startTime, endTime, timeType } };
}

module.exports = { queryOrderStatus, queryOrderList, ORDER_STATUS_TEXT };
