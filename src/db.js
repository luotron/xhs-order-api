const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS apps (
  app_id       TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  app_secret   TEXT NOT NULL,
  redirect_uri TEXT NOT NULL DEFAULT '',
  gateway      TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS stores (
  seller_id   TEXT NOT NULL,
  app_id      TEXT NOT NULL,
  store_code  TEXT NOT NULL DEFAULT '',          -- 自定义店铺标识，便于业务方传 storeCode 查询
  name        TEXT NOT NULL DEFAULT '',
  auth_status INTEGER NOT NULL DEFAULT 0,        -- 0 未授权 1 已授权
  extra       TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  PRIMARY KEY (seller_id, app_id),
  FOREIGN KEY (app_id) REFERENCES apps(app_id)
);
CREATE INDEX IF NOT EXISTS idx_stores_code ON stores(store_code, app_id);

CREATE TABLE IF NOT EXISTS credentials (
  seller_id               TEXT NOT NULL,
  app_id                  TEXT NOT NULL,
  access_token            TEXT NOT NULL DEFAULT '',
  access_token_expires_at INTEGER NOT NULL DEFAULT 0,
  refresh_token           TEXT NOT NULL DEFAULT '',
  refresh_token_expires_at INTEGER NOT NULL DEFAULT 0,
  seller_name             TEXT NOT NULL DEFAULT '',
  updated_at              INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  PRIMARY KEY (seller_id, app_id),
  FOREIGN KEY (seller_id, app_id) REFERENCES stores(seller_id, app_id)
);

-- 成功订单事件表：去重（seller_id+order_id 唯一）+ 上报状态机
CREATE TABLE IF NOT EXISTS order_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id     TEXT NOT NULL,
  app_id        TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  order_status  INTEGER NOT NULL DEFAULT 7,
  payload       TEXT NOT NULL DEFAULT '{}',
  report_status INTEGER NOT NULL DEFAULT 0,  -- 0待上报 1上报中 2上报成功 3上报失败(重试耗尽)
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  reported_at   INTEGER,
  UNIQUE(seller_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_order_events_status ON order_events(report_status, updated_at);
`);

function upsertApp({ appId, appSecret, redirectUri, name = '' }) {
  db.prepare(`
    INSERT INTO apps (app_id, name, app_secret, redirect_uri, gateway)
    VALUES (@appId, @name, @appSecret, @redirectUri, @gateway)
    ON CONFLICT(app_id) DO UPDATE SET
      name = excluded.name,
      app_secret = excluded.app_secret,
      redirect_uri = excluded.redirect_uri,
      gateway = excluded.gateway
  `).run({ appId, name, appSecret, redirectUri, gateway: config.gateway });
}

function getApp(appId) {
  return db.prepare('SELECT * FROM apps WHERE app_id = ?').get(appId);
}

function listApps() {
  return db.prepare('SELECT app_id, name, redirect_uri, gateway FROM apps').all();
}

function upsertStore({ sellerId, appId, storeCode = '', name = '' }) {
  db.prepare(`
    INSERT INTO stores (seller_id, app_id, store_code, name, updated_at)
    VALUES (@sellerId, @appId, @storeCode, @name, @now)
    ON CONFLICT(seller_id, app_id) DO UPDATE SET
      store_code = COALESCE(NULLIF(excluded.store_code, ''), stores.store_code),
      name = COALESCE(NULLIF(excluded.name, ''), stores.name),
      updated_at = excluded.updated_at
  `).run({ sellerId, appId, storeCode, name, now: Date.now() });
}

function getStore(sellerId, appId) {
  return db.prepare('SELECT * FROM stores WHERE seller_id = ? AND app_id = ?').get(sellerId, appId);
}

function getStoreByCode(storeCode, appId) {
  return db.prepare('SELECT * FROM stores WHERE store_code = ? AND app_id = ?').get(storeCode, appId);
}

function listStores(appId) {
  return db.prepare('SELECT * FROM stores WHERE app_id = ?').all(appId);
}

function setAuthStatus(sellerId, appId, status) {
  db.prepare('UPDATE stores SET auth_status = ?, updated_at = ? WHERE seller_id = ? AND app_id = ?')
    .run(status, Date.now(), sellerId, appId);
}

function saveCredential({ sellerId, appId, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, sellerName = '' }) {
  db.prepare(`
    INSERT INTO credentials (seller_id, app_id, access_token, access_token_expires_at, refresh_token, refresh_token_expires_at, seller_name, updated_at)
    VALUES (@sellerId, @appId, @accessToken, @accessTokenExpiresAt, @refreshToken, @refreshTokenExpiresAt, @sellerName, @now)
    ON CONFLICT(seller_id, app_id) DO UPDATE SET
      access_token = excluded.access_token,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token = excluded.refresh_token,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      seller_name = excluded.seller_name,
      updated_at = excluded.updated_at
  `).run({ sellerId, appId, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, sellerName, now: Date.now() });
}

function getCredential(sellerId, appId) {
  return db.prepare('SELECT * FROM credentials WHERE seller_id = ? AND app_id = ?').get(sellerId, appId);
}

function listCredentials(appId) {
  return db.prepare('SELECT * FROM credentials WHERE app_id = ?').all(appId);
}

function deleteStore(sellerId, appId) {
  db.transaction(() => {
    db.prepare('DELETE FROM credentials WHERE seller_id = ? AND app_id = ?').run(sellerId, appId);
    db.prepare('DELETE FROM stores WHERE seller_id = ? AND app_id = ?').run(sellerId, appId);
  })();
}

function saveTestCode(code) {
  db.prepare('CREATE TABLE IF NOT EXISTS test_codes (code TEXT PRIMARY KEY, created_at INTEGER)').run();
  db.prepare('INSERT OR REPLACE INTO test_codes (code, created_at) VALUES (?, ?)').run(code, Date.now());
}

function getLatestTestCode() {
  db.prepare('CREATE TABLE IF NOT EXISTS test_codes (code TEXT PRIMARY KEY, created_at INTEGER)').run();
  return db.prepare('SELECT * FROM test_codes ORDER BY created_at DESC LIMIT 1').get();
}

// ---------- 订单事件 ----------
/** 插入新订单事件（去重）。返回 true=新增，false=已存在 */
function insertOrderEvent({ sellerId, appId, orderId, orderStatus, payload }) {
  const r = db.prepare(`
    INSERT OR IGNORE INTO order_events (seller_id, app_id, order_id, order_status, payload, report_status, created_at, updated_at)
    VALUES (@sellerId, @appId, @orderId, @orderStatus, @payload, 0, @now, @now)
  `).run({
    sellerId, appId, orderId, orderStatus,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    now: Date.now(),
  });
  return r.changes > 0;
}

function getOrderEvent(sellerId, orderId) {
  return db.prepare('SELECT * FROM order_events WHERE seller_id = ? AND order_id = ?').get(sellerId, orderId);
}

/** 待上报的事件（0待上报；含上次因崩溃卡在"上报中"的事件可另行重置） */
function listPendingOrderEvents(limit = 100) {
  return db.prepare('SELECT * FROM order_events WHERE report_status = 0 ORDER BY id ASC LIMIT ?').all(limit);
}

/** 上报失败（重试耗尽）的事件，供定期兜底重试 */
function listFailedOrderEvents(limit = 50) {
  return db.prepare('SELECT * FROM order_events WHERE report_status = 3 ORDER BY id ASC LIMIT ?').all(limit);
}

function updateOrderEvent(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE order_events SET ${sets}, updated_at = @now WHERE id = @id`)
    .run({ ...fields, id, now: Date.now() });
}

/** 服务重启后，把因崩溃停留在"上报中"的事件重置为"待上报" */
function resetStuckOrderEvents() {
  db.prepare('UPDATE order_events SET report_status = 0, updated_at = ? WHERE report_status = 1').run(Date.now());
}

function countOrderEvents() {
  return db.prepare('SELECT report_status, COUNT(*) AS n FROM order_events GROUP BY report_status').all();
}

module.exports = {
  db,
  upsertApp,
  getApp,
  listApps,
  upsertStore,
  getStore,
  getStoreByCode,
  listStores,
  setAuthStatus,
  saveCredential,
  getCredential,
  listCredentials,
  deleteStore,
  saveTestCode,
  getLatestTestCode,
  insertOrderEvent,
  getOrderEvent,
  listPendingOrderEvents,
  listFailedOrderEvents,
  updateOrderEvent,
  resetStuckOrderEvents,
  countOrderEvents,
};
