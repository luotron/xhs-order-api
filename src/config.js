require('dotenv').config();

module.exports = {
  port: Number(process.env.PORT || 8899),
  dbPath: process.env.DB_PATH || './data/xhs.db',
  gateway: process.env.XHS_GATEWAY || 'https://ark.xiaohongshu.com/ark/open_api/v3/common_controller',
  authorizeUrl: process.env.XHS_AUTHORIZE_URL || 'https://ark.xiaohongshu.com/ark/authorization',
  version: '2.0',
  tokenRefreshAheadMs: Number(process.env.TOKEN_REFRESH_AHEAD_MS || 600000),
  refreshSweepIntervalMs: Number(process.env.REFRESH_SWEEP_INTERVAL_MS || 300000),
  defaultApp: {
    appId: process.env.APP_ID || '',
    appSecret: process.env.APP_SECRET || '',
    redirectUri: process.env.APP_REDIRECT_URI || '',
  },
  // ---------- 成功订单监听与上报 ----------
  // 监听轮询间隔（毫秒），默认每 10 秒查一次所有店铺
  monitorIntervalMs: Number(process.env.MONITOR_INTERVAL_MS || 10000),
  // 每次轮询拉取的更新时间窗口（分钟）。平台限制 timeType=2 窗口 ≤30 分钟
  monitorWindowMinutes: Number(process.env.MONITOR_WINDOW_MINUTES || 30),
  // 服务启动时回填的订单时长（分钟），默认最近 60 分钟
  monitorBackfillMinutes: Number(process.env.MONITOR_BACKFILL_MINUTES || 60),
  // 上报接口地址（TODO：上报接口待定，配置后生效；为空则仅打印日志）
  reportUrl: process.env.REPORT_URL || '',
  // 上报失败重试次数，默认 3 次
  reportRetryTimes: Number(process.env.REPORT_RETRY_TIMES || 3),
  // 上报重试间隔基数（毫秒），第 n 次重试等待 n * 该值
  reportRetryBackoffMs: Number(process.env.REPORT_RETRY_BACKOFF_MS || 2000),
};
