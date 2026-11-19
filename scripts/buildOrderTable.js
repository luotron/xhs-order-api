// 临时脚本：拉取线上店铺 token，逐单补全金额，生成订单表格
const axios = require('axios');
const { generateSign } = require('../src/services/xhsClient');

const APP_ID = 'a1e389d4fbcc47188600';
const APP_SECRET = 'cbe5c876a8d8eb3fb10fac0a7ae51467';
const GATEWAY = 'https://ark.xiaohongshu.com/ark/open_api/v3/common_controller';
const SELLER_ID = '6a8975834a2c710015a232d3';

const fmt = (ms) => {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const yuan = (fen) => (fen === null || fen === undefined || fen === '') ? '-' : (Number(fen) / 100).toFixed(2);

async function getToken() {
  const r = await axios.get(`https://exclusion8311.z2kq7vm9xr.top/api/stores/${SELLER_ID}/token?appId=${APP_ID}`, { timeout: 15000 });
  return r.data.data.accessToken;
}

async function getDetail(accessToken, orderId) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = {
    method: 'order.getOrderDetail',
    appId: APP_ID,
    timestamp,
    version: '2.0',
    sign: generateSign(APP_ID, timestamp, 'order.getOrderDetail', APP_SECRET),
    accessToken,
    orderId,
  };
  const resp = await axios.post(GATEWAY, body, { headers: { 'Content-Type': 'application/json;charset=utf-8' }, timeout: 15000 });
  if (resp.data.success !== true) throw new Error(`API错误 ${resp.data.error_code} ${resp.data.error_msg}`);
  return resp.data.data;
}

(async () => {
  const evs = require('C:/Users/User/AppData/Local/Temp/opencode/online-events.json').data.events;
  const token = await getToken();
  console.log(`获取到 token，共 ${evs.length} 条事件，逐单补全金额...`);
  const rows = [];
  let fail = 0;
  for (const e of evs) {
    try {
      const d = await getDetail(token, e.order_id);
      const amountFen = d.totalPayAmount ?? d.merchantActualReceiveAmount ?? d.totalDepositAmount ?? null;
      rows.push({
        orderId: e.order_id,
        shop: d.shopName || '麦麦皮皮的店',
        amount: yuan(amountFen),
        paidTime: fmt(d.paidTime),
        finishTime: fmt(d.finishTime),
        createdTime: fmt(d.createdTime),
      });
    } catch (err) {
      fail++;
      console.error('失败', e.order_id, err.message);
      rows.push({ orderId: e.order_id, shop: '-', amount: '-', paidTime: '-', finishTime: '-', createdTime: '-' });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  rows.sort((a, b) => (a.paidTime === '-' ? 0 : a.paidTime.localeCompare(b.paidTime)));
  const lines = ['| 单号 | 店铺 | 金额(元) | 支付时间 | 完成时间 |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.orderId} | ${r.shop} | ${r.amount} | ${r.paidTime} | ${r.finishTime} |`);
  require('fs').writeFileSync('C:/Users/User/Desktop/fsdownload/订单表-含金额.md', lines.join('\n'));
  console.log(`完成：成功 ${rows.length - fail} 条，失败 ${fail} 条。文件已保存到 C:/Users/User/Desktop/fsdownload/订单表-含金额.md`);
  console.log(lines.slice(0, 12).join('\n'));
})();
