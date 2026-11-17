const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');

/**
 * 小红书开放平台签名算法（OAuth2 新版）
 * sign = md5( method + "?" + sorted("appId=" + appId, "timestamp=" + ts, "version=2.0").join("&") + appSecret )
 * accessToken 不参与签名
 */
function generateSign(appId, timestamp, method, appSecret) {
  const params = [`appId=${appId}`, `timestamp=${timestamp}`, `version=${config.version}`].sort();
  const source = `${method}?${params.join('&')}${appSecret}`;
  return crypto.createHash('md5').update(source, 'utf8').digest('hex');
}

class XhsApiError extends Error {
  constructor(errorCode, errorMsg, raw) {
    super(`小红书API错误 ${errorCode}: ${errorMsg}`);
    this.errorCode = errorCode;
    this.raw = raw;
  }
}

/**
 * 调用小红书开放平台网关
 * @param {string} method   接口名，如 order.getOrderDetail
 * @param {object} params   业务参数
 * @param {object} app      { appId, appSecret, gateway }
 * @param {string} accessToken 店铺 accessToken（可空，如 oauth 接口）
 */
async function callGateway(method, params, app, accessToken) {
  const appId = app.app_id || app.appId;
  const appSecret = app.app_secret || app.appSecret;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = {
    method,
    appId,
    timestamp,
    version: config.version,
    sign: generateSign(appId, timestamp, method, appSecret),
    ...params,
  };
  if (accessToken) body.accessToken = accessToken;

  const gateway = app.gateway || config.gateway;
  const resp = await axios.post(gateway, body, {
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    timeout: 15000,
  });
  const data = resp.data || {};
  if (data.success !== true || data.error_code !== 0) {
    throw new XhsApiError(data.error_code, data.error_msg || '未知错误', data);
  }
  return data.data;
}

/** 用授权 code 换取 accessToken（oauth.getAccessToken） */
async function getAccessToken(app, code) {
  return callGateway('oauth.getAccessToken', { code }, app, null);
}

/** 刷新 accessToken（oauth.refreshToken），成功后自动返回新的 refreshToken */
async function refreshToken(app, refreshToken) {
  return callGateway('oauth.refreshToken', { refreshToken }, app, null);
}

/** 订单列表 order.getOrderList */
async function getOrderList(app, accessToken, params) {
  return callGateway('order.getOrderList', params, app, accessToken);
}

/** 订单详情/状态 order.getOrderDetail（入参仅 orderId） */
async function getOrderDetail(app, accessToken, orderId) {
  return callGateway('order.getOrderDetail', { orderId }, app, accessToken);
}

module.exports = {
  generateSign,
  callGateway,
  getAccessToken,
  refreshToken,
  getOrderList,
  getOrderDetail,
  XhsApiError,
};
