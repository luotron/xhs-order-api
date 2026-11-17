const express = require('express');
const config = require('./config');
const db = require('./db');
const tokenManager = require('./services/tokenManager');
const orderService = require('./services/orderService');
const xhs = require('./services/xhsClient');

const app = express();
app.use(express.json());

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function getAppId(req) {
  return (req.query.appId || req.body.appId || (config.defaultApp && config.defaultApp.appId)) || '';
}

// ---------- 基础 ----------
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// ---------- 应用管理 ----------
app.get('/api/apps', (req, res) => {
  res.json({ data: db.listApps() });
});

app.post('/api/apps', (req, res) => {
  const { appId, appSecret, redirectUri, name } = req.body || {};
  if (!appId || !appSecret) return res.status(400).json({ success: false, error: 'appId/appSecret 必填' });
  db.upsertApp({ appId, appSecret, redirectUri: redirectUri || '', name: name || '' });
  res.json({ success: true, data: db.getApp(appId) });
});

// ---------- 店铺管理 ----------
app.post('/api/stores', (req, res) => {
  const { sellerId, storeCode, name } = req.body || {};
  const appId = getAppId(req);
  if (!appId) return res.status(400).json({ success: false, error: '缺少 appId' });
  if (!sellerId) return res.status(400).json({ success: false, error: 'sellerId 必填（店铺ID）' });
  db.upsertStore({ sellerId: String(sellerId), appId, storeCode: storeCode || '', name: name || '' });
  res.json({ success: true, data: db.getStore(String(sellerId), appId) });
});

app.get('/api/stores', (req, res) => {
  const appId = getAppId(req);
  if (!appId) return res.status(400).json({ success: false, error: '缺少 appId' });
  const stores = db.listStores(appId).map((s) => {
    const cred = db.getCredential(s.seller_id, appId);
    return {
      ...s,
      accessTokenExpiresAt: cred ? cred.access_token_expires_at : 0,
      refreshTokenExpiresAt: cred ? cred.refresh_token_expires_at : 0,
      tokenValid: !!(cred && cred.access_token && Date.now() < cred.access_token_expires_at),
    };
  });
  res.json({ data: stores });
});

app.get('/api/stores/:sellerId/auth-url', (req, res) => {
  const appId = getAppId(req);
  const appInfo = db.getApp(appId);
  if (!appInfo) return res.status(404).json({ success: false, error: '应用不存在' });
  const url = `${config.authorizeUrl}?appId=${appInfo.app_id}&redirectUri=${encodeURIComponent(appInfo.redirect_uri)}`;
  res.json({ data: { url } });
});

/** 获取店铺可用 accessToken（给业务后端同步 token 用） */
app.get('/api/stores/:sellerId/token', asyncH(async (req, res) => {
  const appId = getAppId(req);
  const token = await tokenManager.getValidAccessToken(appId, String(req.params.sellerId));
  const cred = db.getCredential(String(req.params.sellerId), appId);
  res.json({ data: { accessToken: token, expiresAt: cred.access_token_expires_at } });
}));

app.delete('/api/stores/:sellerId', (req, res) => {
  const appId = getAppId(req);
  db.deleteStore(String(req.params.sellerId), appId);
  res.json({ success: true });
});

// ---------- 授权 ----------
/**
 * 控制台配置的"应用授权回调地址"应指向本服务：GET /callback/xhs/oauth
 * 店铺主账号在授权页点"授权"后，平台 302 带 code 跳转过来，本接口自动完成：
 * code 换 token → 持久化（credentials 表）→ 店铺标记已授权。
 */
app.get('/callback/xhs/oauth', asyncH(async (req, res) => {
  const { code, appId, ...restQuery } = req.query;
  const targetAppId = appId || (config.defaultApp && config.defaultApp.appId);
  console.log('[callback] 收到授权回调', JSON.stringify({
    time: new Date().toISOString(),
    appId: targetAppId,
    code: code ? `${code.slice(0, 12)}***` : undefined,
    restQuery,
  }));
  if (!code) {
    console.error('[callback] 回调缺少 code，参数=', JSON.stringify(req.query));
    return res.status(400).send('缺少 code');
  }
  try {
    const r = await tokenManager.exchangeCode(targetAppId, code);
    console.log('[callback] 授权成功，店铺信息=', JSON.stringify({
      sellerId: r.sellerId,
      sellerName: r.sellerName,
      appId: r.appId,
      time: new Date().toISOString(),
    }));
    res.send(`授权成功：sellerId=${r.sellerId} sellerName=${r.sellerName}，可关闭本页面`);
  } catch (e) {
    console.error('[callback] code换取token失败', e.message, 'code前缀=', code.slice(0, 12));
    res.status(500).send(`换取token失败: ${e.message}`);
  }
}));

/** 手动 code 换 token：现有订单系统的回调里收到 code 后调用本接口即可完成 token 托管 */
app.post('/api/oauth/exchange', asyncH(async (req, res) => {
  const { code, appId } = req.body || {};
  if (!code) return res.status(400).json({ success: false, error: 'code 必填' });
  const targetAppId = appId || (config.defaultApp && config.defaultApp.appId);
  console.log('[oauth] 手动 code 换 token，code 前缀=', code.slice(0, 12));
  const r = await tokenManager.exchangeCode(targetAppId, code);
  console.log('[oauth] 换 token 成功', JSON.stringify(r));
  res.json({ success: true, data: r });
}));

/** 开发测试：保存控制台"获取测试账号"产生的测试 code */
app.post('/api/test-code', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ success: false, error: 'code 必填' });
  db.saveTestCode(code);
  res.json({ success: true });
});

app.get('/api/test-code', (req, res) => {
  const c = db.getLatestTestCode();
  res.json({ data: c || null });
});

// ---------- token 维护 ----------
app.post('/api/stores/:sellerId/refresh', asyncH(async (req, res) => {
  const appId = getAppId(req);
  const token = await tokenManager.doRefresh(appId, String(req.params.sellerId));
  const cred = db.getCredential(String(req.params.sellerId), appId);
  res.json({ success: true, data: { accessToken: token, expiresAt: cred.access_token_expires_at } });
}));

app.post('/api/token/sweep', asyncH(async (req, res) => {
  const results = await tokenManager.sweepRefresh();
  res.json({ success: true, data: results });
}));

// ---------- 订单查询 ----------
/**
 * GET /api/order/status?sellerId=xxx&orderId=Pxxxx 或 ?storeCode=xxx&orderId=Pxxxx
 * 返回标准化订单状态
 */
app.get('/api/order/status', asyncH(async (req, res) => {
  const { sellerId, storeCode, orderId } = req.query;
  if (!sellerId && !storeCode) return res.status(400).json({ success: false, error: 'sellerId 或 storeCode 至少一个' });
  const appId = getAppId(req);
  const data = await orderService.queryOrderStatus(appId, { sellerId, storeCode, orderId });
  res.json({ success: true, data });
}));

/**
 * POST /api/order/list
 * 简化入参（时间由后端计算）：
 *   body: { sellerId | storeCode, lastHours?=24, lastMinutes?, orderType?, orderStatus?, pageNo?=1, pageSize?=50 }
 * 兼容入参：{ startTime, endTime, timeType, ... }
 */
app.post('/api/order/list', asyncH(async (req, res) => {
  const { sellerId, storeCode } = req.body || {};
  if (!sellerId && !storeCode) return res.status(400).json({ success: false, error: 'sellerId 或 storeCode 至少一个' });
  const appId = getAppId(req);
  const data = await orderService.queryOrderList(appId, req.body || {});
  res.json({ success: true, data });
}));

// ---------- 订单事件（监控/上报状态查看） ----------
/** 查看已捕获的成功订单事件及上报状态（0待上报 1上报中 2上报成功 3最终失败） */
app.get('/api/order-events', (req, res) => {
  const { sellerId } = req.query;
  let rows;
  if (sellerId) {
    rows = db.db.prepare('SELECT * FROM order_events WHERE seller_id = ? ORDER BY id DESC LIMIT 100').all(String(sellerId));
  } else {
    rows = db.db.prepare('SELECT * FROM order_events ORDER BY id DESC LIMIT 100').all();
  }
  res.json({ success: true, data: { count: rows.length, stats: db.countOrderEvents(), events: rows } });
});

// ---------- 错误处理 ----------
app.use((err, req, res, next) => {
  if (err instanceof xhs.XhsApiError) {
    return res.status(502).json({ success: false, error: err.message, code: err.errorCode });
  }
  console.error('[error]', err);
  res.status(500).json({ success: false, error: err.message || String(err) });
});

// ---------- 启动 ----------
if (config.defaultApp.appId && config.defaultApp.appSecret) {
  db.upsertApp({
    appId: config.defaultApp.appId,
    appSecret: config.defaultApp.appSecret,
    redirectUri: config.defaultApp.redirectUri,
    name: '默认应用',
  });
  console.log(`[app] 默认应用已同步: ${config.defaultApp.appId}`);
}

tokenManager.startScheduler();
const orderMonitor = require('./services/orderMonitor');
const reportService = require('./services/reportService');
reportService.startReporter();
orderMonitor.startMonitor();

app.listen(config.port, () => {
  console.log(`小红书订单API服务已启动: http://127.0.0.1:${config.port}`);
  console.log(`网关: ${config.gateway}`);
  console.log('接口文档：GET /api/order/status、POST /api/order/list、POST /api/oauth/exchange、GET /callback/xhs/oauth');
});
