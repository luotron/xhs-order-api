const db = require('../db');
const xhs = require('./xhsClient');
const config = require('../config');

const refreshing = new Map(); // `${appId}:${sellerId}` -> Promise

function key(appId, sellerId) { return `${appId}:${sellerId}`; }

function isNearExpiry(expiresAt) {
  return Date.now() >= expiresAt - config.tokenRefreshAheadMs;
}

/**
 * 获取可用 accessToken：快过期或已过期时自动用 refreshToken 刷新并入库。
 */
async function getValidAccessToken(appId, sellerId) {
  const app = db.getApp(appId);
  if (!app) throw new Error(`应用不存在: ${appId}`);
  let cred = db.getCredential(sellerId, appId);
  if (!cred || !cred.access_token) throw new Error(`店铺未授权: sellerId=${sellerId}`);
  if (isNearExpiry(cred.access_token_expires_at)) {
    return doRefresh(appId, sellerId);
  }
  return cred.access_token;
}

/** 强制刷新并入库（并发去重） */
async function doRefresh(appId, sellerId) {
  const k = key(appId, sellerId);
  if (refreshing.has(k)) return refreshing.get(k);
  const p = (async () => {
    const app = db.getApp(appId);
    const cred = db.getCredential(sellerId, appId);
    if (!app) throw new Error(`应用不存在: ${appId}`);
    if (!cred || !cred.refresh_token) throw new Error(`店铺无 refreshToken: sellerId=${sellerId}`);
    const data = await xhs.refreshToken(app, cred.refresh_token);
    db.saveCredential({
      sellerId,
      appId,
      accessToken: data.accessToken,
      accessTokenExpiresAt: Number(data.accessTokenExpiresAt),
      refreshToken: data.refreshToken,
      refreshTokenExpiresAt: Number(data.refreshTokenExpiresAt),
      sellerName: data.sellerName || cred.seller_name || '',
    });
    db.setAuthStatus(sellerId, appId, 1);
    return data.accessToken;
  })().finally(() => refreshing.delete(k));
  refreshing.set(k, p);
  return p;
}

/** 用授权 code 换 token 并入库（同时更新店铺信息与授权状态） */
async function exchangeCode(appId, code) {
  const app = db.getApp(appId);
  if (!app) throw new Error(`应用不存在: ${appId}`);
  const data = await xhs.getAccessToken(app, code);
  const sellerId = String(data.sellerId);
  db.upsertStore({ sellerId, appId, name: data.sellerName || '' });
  db.saveCredential({
    sellerId,
    appId,
    accessToken: data.accessToken,
    accessTokenExpiresAt: Number(data.accessTokenExpiresAt),
    refreshToken: data.refreshToken,
    refreshTokenExpiresAt: Number(data.refreshTokenExpiresAt),
    sellerName: data.sellerName || '',
  });
  db.setAuthStatus(sellerId, appId, 1);
  return { sellerId, sellerName: data.sellerName, appId };
}

/** 定时任务：扫描所有凭证，对即将过期/已过期的自动刷新 */
async function sweepRefresh() {
  const creds = db.listCredentials();
  const results = [];
  for (const cred of creds) {
    if (isNearExpiry(cred.access_token_expires_at) && cred.refresh_token) {
      try {
        await doRefresh(cred.app_id, cred.seller_id);
        results.push({ sellerId: cred.seller_id, ok: true });
      } catch (e) {
        results.push({ sellerId: cred.seller_id, ok: false, error: e.message });
      }
    }
  }
  return results;
}

function startScheduler() {
  const timer = setInterval(() => {
    sweepRefresh().catch((e) => console.error('[tokenScheduler]', e.message));
  }, config.refreshSweepIntervalMs);
  timer.unref && timer.unref();
  console.log(`[tokenScheduler] 已启动，每 ${config.refreshSweepIntervalMs / 1000}s 扫描刷新`);
  return timer;
}

module.exports = {
  getValidAccessToken,
  doRefresh,
  exchangeCode,
  sweepRefresh,
  startScheduler,
};
