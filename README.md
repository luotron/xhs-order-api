# 小红书开放平台 - 多店铺订单状态查询服务

基于 Node.js + Express + SQLite，封装小红书电商开放平台（商家自研应用）的授权与订单查询能力：

1. 一个应用支持多个店铺授权（平台上限 10 个，超出需工单白名单）
2. 自动维护每个店铺的 accessToken / refreshToken（到期前自动刷新、调用时自动恢复）
3. 提供「店铺ID / 店铺标识 + 订单号」查询订单状态的标准接口，以及订单列表接口
4. 成功订单监听：每 10 秒轮询所有已授权店铺最近 30 分钟"更新"的已完成订单（自动分页），启动时回填最近 60 分钟
5. 成功订单上报：去重入库（sellerId+orderId 唯一），失败自动重试 3 次；上报接口待定（TODO），当前在日志打印上报参数
6. 授权回调：控制台回调地址指向本服务 `/callback/xhs/oauth` 后，主账号授权一次即自动接收 code、换 token、持久化，全程有日志

## 快速开始

```bash
npm install
npm start          # http://127.0.0.1:8899
npm test           # 校验签名算法与官方示例一致
```

配置在 `.env`（应用级凭证）：

| 变量 | 说明 |
|---|---|
| `APP_ID` | 控制台-应用管理-应用详情 的 AppId |
| `APP_SECRET` | 应用详情页点"显示"查看 |
| `APP_REDIRECT_URI` | 与开放平台控制台配置的应用授权回调地址一致 |
| `XHS_GATEWAY` | 生产默认 `https://ark.xiaohongshu.com/ark/open_api/v3/common_controller` |

## 整体流程：平台侧 vs 本服务侧（为什么平台有店铺，还要"注册店铺"）

关键理解：**小红书开放平台控制台里看到的店铺，和本服务数据库里的店铺，是两份不同的记录**，各管各的事。

| | 小红书平台（控制台） | 本服务（本地 SQLite） |
|---|---|---|
| 记录内容 | 应用绑定了哪些店铺（授权关系） | 店铺映射（sellerId ↔ storeCode）+ 每店 token |
| 谁能写 | 平台：主账号点授权时写入 | 本服务：你调接口写入 |
| 谁能读 | 你（控制台页面） | 本服务接口 |
| 平台提供读取 API 吗 | **不提供**（控制台那个"授权列表"是网页内部接口，需要开发者登录态，不能用于服务器） | — |

所以：平台只负责"某店授权给了某应用"，但它**不会把授权关系推给你的服务器**，你的服务器必须自己留一份店铺清单和 token。`POST /api/stores`（注册店铺）就是把"我要管理哪家店、它的 sellerId、给它起个 storeCode"记录到本地库——这一步是**告诉本服务**，不是去平台开新店，对平台没有任何影响。

### 完整生命周期

```
① 平台侧：控制台"授权管理"→ 添加授权店铺（输入 sellerId）
   作用：让平台知道这家店允许被你的应用授权

② 服务侧：POST /api/stores 注册店铺（sellerId + storeCode）
   作用：让本服务知道要管理这家店，建立本地映射
   ↓
③ 授权：店铺主账号打开授权链接点"授权"
   平台生成 code → 302 跳到回调地址
   ↓
④ 服务侧：GET /callback/xhs/oauth?code=xxx（或 POST /api/oauth/exchange）
   code → accessToken/refreshToken → 持久化到 credentials 表 → 店铺标记已授权
   ↓
⑤ 运行期（全自动）：
   - token 到期前自动刷新续期
   - 查订单状态 / 订单列表：按 sellerId 或 storeCode 查询
   - 成功订单监听：每 10 秒轮询所有店铺已完成订单 → 去重 → 上报（失败重试3次）
```

### 换服务器部署怎么办

`data/xhs.db` 是服务侧全部"注册+授权"记录的载体。新服务器要么：

- **拷库**（推荐）：把旧服务器 `data/xhs.db`（含 -wal/-shm）复制到新服务器 → 店铺和 token 全部就位，无需重新注册授权
- **重建**：在新服务器重新执行 ②③④（注册 + 重新点授权）

注意：平台控制台里的店铺列表不会因为拷库/删库而消失，那是平台侧的记录；但 token 只存在于你的本地库，删库后必须重新授权才能再拿到 token。

## 哪些参数需要长期维护（对照文档）

| 参数 | 维护方式 |
|---|---|
| `appId` / `appSecret` / `redirectUri` | **长期固定**，写在 `.env`，启动时自动同步进 DB（`apps` 表）。App Secret 重置后需同步更新 |
| `method` / `version` | 代码内固定，`version=2.0` |
| `timestamp` / `sign` | **每次请求动态计算**，无需维护。`sign = md5(method + "?" + 按字典序排列的 appId/timestamp/version + appSecret)`，accessToken 不参与签名 |
| 每店铺 `accessToken` | **自动维护**（`credentials` 表）：授权时入库；快过期（默认提前10分钟）由后台调度自动用 refreshToken 刷新；调用中遇到失效会即时刷新重试一次 |
| 每店铺 `refreshToken` | 刷新时随平台响应更新入库（平台每次刷新都会下发新的 refreshToken 并重置授权到期时间） |
| 店铺映射 | `stores` 表：sellerId（平台店铺ID）+ 自定义 storeCode（业务标识），支持两种方式查询 |

## 接口清单

### 关键概念

| 概念 | 说明 | 示例 |
|---|---|---|
| `sellerId` | 小红书**店铺ID**（平台唯一标识），控制台-授权管理可查看，或千帆后台→店铺→店铺账号信息 | `6a8975834a2c710015a232d3` |
| `storeCode` | 本服务注册店铺时设置的自定义标识，与 sellerId 等价使用，二选一 | `maimai` |
| `orderId` | 订单号（以 P 开头），由订单列表接口返回 | `P810431500196403651` |
| 时间参数 | 由**后端自动计算**（lastHours/lastMinutes），前端无需传 Unix 时间戳 | - |

### 1. 订单状态查询（核心接口）

```
GET /api/order/status?sellerId=xxx&orderId=Pxxxx
GET /api/order/status?storeCode=maimai&orderId=Pxxxx
```

响应示例：

```json
{
  "success": true,
  "data": {
    "store": { "sellerId": "68c11b4b047ce6002a1f33c6", "storeCode": "testshop", "name": "测试店铺" },
    "orderId": "P810431500196403651",
    "orderStatus": 6,
    "orderStatusText": "待收货",
    "orderAfterSalesStatus": 1,
    "orderAfterSalesStatusText": "无售后",
    "cancelStatus": 0,
    "createdTime": 1794879512753,
    "paidTime": 1794879513000,
    "updateTime": 1794882548829,
    "expressTrackingNo": null,
    "detail": { "...": "平台原始完整字段" }
  }
}
```

### 2. 订单列表

```
POST /api/order/list
{ "sellerId": "xxx", "lastHours": 24, "orderStatus": 0, "pageNo": 1, "pageSize": 50 }
```

时间参数**由后端计算**，前端只需传查多少小时内的订单：

```json
{ "storeCode": "maimai", "lastHours": 24 }      // 最近24小时内创建/更新的订单（默认24，≤24）
{ "sellerId": "xxx", "lastMinutes": 30 }        // 最近30分钟内"更新过"的订单（≤30，用于增量拉取）
```

完整入参说明：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sellerId` / `storeCode` | string | 二选一 | 店铺ID / 自定义店铺标识 |
| `lastHours` | number | 否 | 查最近 N 小时的订单，默认 24，上限 24（平台限制，按创建时间） |
| `lastMinutes` | number | 否 | 查最近 N 分钟"更新过"的订单，上限 30（平台限制，按更新时间） |
| `orderType` | number | 否 | 订单类型：0全部 1现货 2定金预售 3全款预售(废弃) 4全款预售(新) 5换货补发 |
| `orderStatus` | number | 否 | 订单状态过滤，0全部，其余见下方状态码对照 |
| `pageNo` | number | 否 | 页码，默认 1 |
| `pageSize` | number | 否 | 每页数量，默认 50，上限 100 |
| `startTime` / `endTime` / `timeType` | number | 否 | 兼容旧用法：显式指定 Unix 秒级时间范围，timeType=1 创建时间(窗口≤24h)、2 更新时间(窗口≤30min) |

响应中的 `query` 字段会返回后端实际计算的时间窗口，便于核对。

### 3. 授权相关

| 接口 | 说明 |
|---|---|
| `GET /api/stores/:sellerId/auth-url` | 生成店铺授权链接（发给店铺主账号打开） |
| `GET /callback/xhs/oauth?code=xxx` | 控制台回调地址指向本服务时接收 code 自动换 token |
| `POST /api/oauth/exchange` `{code}` | **手动换 token**：现有订单系统回调里收到 code 后调用此接口完成托管 |
| `POST /api/stores/:sellerId/refresh` | 手动强制刷新某店铺 token |
| `POST /api/token/sweep` | 立即触发一轮全部店铺 token 扫描刷新 |
| `GET /api/stores/:sellerId/token` | 取当前有效 accessToken（供业务后端同步） |
| `GET /api/order-events` | 查看已捕获的成功订单事件及上报状态（0待上报 1上报中 2上报成功 3最终失败） |
| `POST /api/monitor/poll` | 手动触发一次订单轮询（运维/测试用） |
| `POST /api/order-events/:id/report` | 手动重新上报某个事件（测试/补报用） |

### 5. 成功订单监听与上报（自动运行）

无需手动调用，服务启动后自动运行：

```
启动回填：最近 60 分钟的已完成订单（30 分钟切片，自动翻页）
轮询：每 10 秒 × 所有已授权店铺 × 最近 30 分钟更新的 orderStatus=7（已完成）订单
去重：sellerId + orderId 唯一（order_events 表），重复轮询不会重复上报
补全：捕获后自动调 order.getOrderDetail 补全金额/快递等字段（订单列表接口不含金额）
上报：失败重试 3 次（间隔 2s/4s 递增）；3 次仍失败标记最终失败并定期兜底重试
```

**日志表格**：每条监听到的成功订单，日志都会输出一张明细表（单号/店铺/金额/时间）：

```
[report] ── 监听到成功订单，明细如下 ──
┌─────────────────────┬────────────────────────────────────────┬──────────┬─────────────────────┬─────────────────────┐
│ 单号                │ 店铺                                   │ 金额(元) │ 支付时间            │ 完成时间            │
├─────────────────────┼────────────────────────────────────────┼──────────┼─────────────────────┼─────────────────────┤
│ P810472712429350281 │ 麦麦皮皮的店(6a8975834a2c710015a232d3) │ 199.98   │ 2026-11-17 21:11:07 │ 2026-11-18 15:18:55 │
└─────────────────────┴────────────────────────────────────────┴──────────┴─────────────────────┴─────────────────────┘
[report] 快递: shentong 770360276716845 | 收件: 黑龙江省齐齐哈尔市铁锋区
```

**上报参数结构**（TODO：接口待定，当前打印在日志，`REPORT_URL` 配置后自动 POST 该结构）：

```json
{
  "sellerId": "6a8975834a2c710015a232d3",
  "appId": "a1e389d4fbcc47188600",
  "orderId": "P810472712429350281",
  "orderStatus": 7,
  "summary": {
    "shopName": "麦麦皮皮的店",
    "storeCode": "maimai",
    "amountFen": 19998,
    "amountYuan": "199.98",
    "totalShippingFreeYuan": "0.00",
    "merchantActualReceiveYuan": "199.98",
    "createdTime": "2026-11-17 21:05:12",
    "paidTime": "2026-11-17 21:11:07",
    "finishTime": "2026-11-18 15:18:55",
    "updateTime": "2026-11-19 20:10:42"
  },
  "order": {
    "...": "订单列表接口的完整字段（见下方字段说明）",
    "detail": { "...": "订单详情接口补全的完整字段（金额/快递/商品明细等）" }
  }
}
```

相关配置（.env）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MONITOR_INTERVAL_MS` | 10000 | 轮询间隔，每 10 秒 |
| `MONITOR_WINDOW_MINUTES` | 30 | 每次轮询的更新时间窗口（平台上限 30 分钟） |
| `MONITOR_BACKFILL_MINUTES` | 60 | 启动时回填最近多少分钟 |
| `REPORT_URL` | 空 | 上报接口地址，待定；空则仅打印日志 |
| `REPORT_RETRY_TIMES` | 3 | 上报失败重试次数 |
| `REPORT_RETRY_BACKOFF_MS` | 2000 | 重试间隔基数 |

### 4. 店铺/应用管理

| 接口 | 说明 |
|---|---|
| `POST /api/stores` `{sellerId, storeCode, name}` | 注册店铺（sellerId 必填，storeCode 为自定义标识） |
| `GET /api/stores` | 店铺列表（含 token 有效性） |
| `DELETE /api/stores/:sellerId` | 删除店铺及其凭证 |
| `POST /api/apps` `{appId, appSecret, redirectUri, name}` | 注册更多应用（多应用场景） |

## 真实店铺授权步骤

1. 控制台 → 应用管理 → 授权管理 → 输入店铺 ID（千帆-店铺账号信息里的 sellerId）→ 添加授权店铺
2. 获取授权链接（或本服务 `GET /api/stores/:sellerId/auth-url`），发给店铺**主账号**在浏览器打开并点授权
3. 平台 302 跳转到回调地址并携带 `code`（10 分钟有效）
   - 若回调指向本服务：自动换 token 入库
   - 若回调指向你的订单系统 `https://ark.xiaohongshu.com/app-order/order/query`：在该页面解析出 `code` 后调用本服务 `POST /api/oauth/exchange` 完成托管
4. 之后 token 全程自动维护，直接调订单接口即可

## 订单状态码对照（orderStatus）

| 值 | 状态 | 值 | 状态 |
|---|---|---|---|
| 1 | 已下单待付款 | 6 | 待收货 |
| 2 | 已支付处理中 | 7 | 已完成 |
| 3 | 清关中 | 8 | 已关闭 |
| 4 | 待发货 | 9 | 已取消 |
| 5 | 部分发货 | 10 | 换货申请中 |

售后状态（orderAfterSalesStatus）：1 无售后 / 2 售后处理中 / 3 售后完成 / 4 售后拒绝 / 5 售后关闭 / 6 平台介入中 / 7 售后取消
取消申请（cancelStatus）：0 未申请取消 / 1 取消处理中

## 监听到的订单数据字段说明

`order` 对象 = 订单列表接口字段 + `detail`（订单详情接口补全字段）。所有时间字段均为毫秒时间戳，金额字段单位均为**分**。

### 订单列表字段（order 顶层）

| 字段 | 类型 | 说明 / 可取值 |
|---|---|---|
| `orderId` | string | 订单号（以 P 开头） |
| `orderType` | integer | 订单类型：1 现货 2 定金预售 3 全款预售(废弃) 4 全款预售(新) 5 换货补发 |
| `orderStatus` | integer | 订单状态：1 已下单待付款 2 已支付处理中 3 清关中 4 待发货 5 部分发货 6 待收货 7 已完成 8 已关闭 9 已取消 10 换货申请中 |
| `orderAfterSalesStatus` | integer | 售后状态：1 无售后 2 售后处理中 3 售后完成 4 售后拒绝 5 售后关闭 6 平台介入中 7 售后取消 |
| `cancelStatus` | integer | 取消申请状态：0 未申请取消 1 取消处理中 |
| `createdTime` | integer | 创建时间（ms） |
| `paidTime` | integer | 支付时间（ms） |
| `updateTime` | integer | 更新时间（ms） |
| `deliveryTime` | integer | 发货时间（ms） |
| `finishTime` | integer | 完成时间（ms） |
| `cancelTime` | integer | 取消时间（ms，0=未取消） |
| `promiseLastDeliveryTime` | integer | 承诺最晚发货时间（ms） |
| `planInfoId` / `planInfoName` | string | 物流方案 ID / 名称（如"【系统创建】物流模板默认—联系人"） |
| `logistics` | string | 物流模式：`red_auto` 自动发货 / `red_express` 快递发货 |
| `receiverCountryName` | string | 收件人国家（目前仅"中国"） |
| `receiverProvinceName` / `receiverCityName` / `receiverDistrictName` | string | 收件人省 / 市 / 区（名称字段；对应 ID 字段常为空） |
| `sellerRemarkFlag` | integer | 商家备注标记：0 无备注 1 有备注 2 其他（平台枚举） |
| `orderTagList` | array | 订单标签：`BANK_ASSET_CUSTODY` 资产托管 `EXPLODE` 易爆特殊商品 `VIRTUAL_COUPON` 虚拟券 `NO_LOGISTICS_SHIP` 无物流发货 `SAME_DAY_DELIVERY` 当日达 `SHIPMENT_ABNORMAL` 发货异常 `LACK_GOOD` 缺货 `API_RECHARGE` 虚拟充值API履约 |
| `xhsOpenId` | string | 买家小红书 OpenId（加密串，URL 编码） |
| `xhsBrandId` | string | 品牌 ID（无品牌时为空字符串） |
| `originalOrderId` | string | 换货/补发场景的原订单号（无则 null） |

### 订单详情字段（order.detail，补全自 order.getOrderDetail）

| 字段 | 类型 | 说明 |
|---|---|---|
| `totalPayAmount` | integer | **订单实付总额（分）**——表格"金额"字段来源 |
| `totalShippingFree` | integer | 运费（分） |
| `merchantActualReceiveAmount` | integer | 商家实际收款（分） |
| `totalDepositAmount` | integer | 定金总额（分，预售订单） |
| `totalMerchantDiscount` / `totalRedDiscount` | integer | 商家优惠 / 平台优惠（分） |
| `totalChangePriceAmount` | integer | 改价金额（分） |
| `paymentType` | integer | 支付方式：1 在线支付（以平台文档为准） |
| `outTradeNo` | string | 平台支付交易号 |
| `expressCompanyCode` | string | 快递公司编码（如 `shentong`） |
| `expressTrackingNo` | string | 快递单号 |
| `receiverName` / `receiverPhone` / `receiverAddress` | string | 收件人姓名/电话/地址（密文或空） |
| `skuList` | array | 商品明细：`skuName` 商品名、`skuQuantity` 数量、`skuId`、`itemId`/`itemName`、`totalPaidAmount` 该SKU实付(分)、`skuImage` 图片、`skuSpec` 规格、`erpcode` 商家编码、`kolId`/`kolName` 达人、`skuAfterSaleStatus` SKU售后状态(同售后状态枚举)、`deliveryMode` 发货模式 |
| `simpleDeliveryOrderList` | array | 包裹明细：`deliveryOrderIndex` 包裹序号、`status` 包裹状态(7已完成)、`expressTrackingNo`、`expressCompanyCode`、`skuIdList`/`itemIdList` 包裹内商品 |
| `shopId` / `shopName` | string | 店铺ID / 店铺名 |
| `userId` | string | 买家用户ID |
| `boundExtendInfo` | object | 支付扩展：`payNo`、`payChannel`、`payAmount`、`taxAmount`、`shippingFee`、`discountAmount`、`zoneCodes` |
| `transferExtendInfo` | object | 跨境扩展：`internationalExpressNo`、`orderDeclaredAmount`、`paintMarker`、`collectionPlace`、`threeSegmentCode` |
| `unpack` | boolean | 是否拆包裹 |
| `logisticsMode` | integer | 物流模式（平台枚举） |

### 上报摘要字段（summary）

| 字段 | 说明 |
|---|---|
| `amountFen` / `amountYuan` | 实付金额：分 / 元（两位小数字符串） |
| `totalShippingFreeYuan` | 运费（元） |
| `merchantActualReceiveYuan` | 商家实际收款（元） |
| `createdTime` / `paidTime` / `finishTime` / `updateTime` | 已格式化为 `YYYY-MM-DD HH:mm:ss` |

## curl 测试示例（PowerShell）

```powershell
# 订单列表：最近24小时，最多10条（时间由后端算）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8899/api/order/list `
  -ContentType 'application/json' `
  -Body '{"sellerId":"68c11b4b047ce6002a1f33c6","lastHours":24,"pageSize":10}' | ConvertTo-Json -Depth 5

# 订单状态：按店铺标识+订单号
Invoke-RestMethod -Uri "http://127.0.0.1:8899/api/order/status?storeCode=testshop&orderId=P810431500196403651" | ConvertTo-Json -Depth 3

# 订单状态：按店铺ID+订单号
Invoke-RestMethod -Uri "http://127.0.0.1:8899/api/order/status?sellerId=68c11b4b047ce6002a1f33c6&orderId=P810431500196403651" | ConvertTo-Json -Depth 3
```

## ApiPost 一键导入

项目根目录提供两个文件：

1. `小红书订单API.postman_collection.json` — 接口集合（已按文件夹分组）
2. `小红书订单API环境.postman_environment.json` — 环境变量

导入步骤：ApiPost 客户端 → 导入 → Postman 格式 → 依次导入上面两个文件 → 右上角环境切换选择「小红书订单API-本地环境」。

集合分组：`1-基础`、`2-店铺管理`、`3-授权与Token`、`4-订单查询`。

环境变量（可在 ApiPost 环境管理里修改）：`baseUrl`、`appId`、`sellerId`、`storeCode`、`storeName`、`orderId`、`authCode`。

## PM2 部署

```powershell
# 1. 全局安装 PM2（一次性）
npm install -g pm2

# 2. 进入项目目录，启动（会读取 ecosystem.config.js）
cd C:\Users\User\code\xhs-order-api
npm run pm2:start

# 3. 常用命令
npm run pm2:logs      # 查看日志
npm run pm2:restart   # 重启（改代码后）
npm run pm2:stop      # 停止
npm run pm2:delete    # 从 PM2 移除
pm2 save              # 保存当前进程列表（重启机器后 pm2 resurrect 恢复）
pm2 status            # 查看状态
```

说明：

- `ecosystem.config.js` 已配置：进程名 `xhs-order-api`、崩溃自动重启、内存超 300M 自动重启、日志输出到 `logs/out.log` 与 `logs/error.log`
- Windows 下 PM2 不支持 cluster 模式，配置为 `fork` 单实例；如需多实例请在 Linux 服务器上改 `instances: 2` + `exec_mode: 'cluster'`
- 开机自启（Windows）：`npm install -g pm2-installer` 后运行 `pm2-installer install`（会自动安装 Windows 服务并执行 pm2 save 的列表）；Linux：`pm2 startup` + `pm2 save`

## 已验证（生产网关实测）

- [x] 签名算法与官方示例一致（`npm test`）
- [x] 测试店铺 code 换取 accessToken 成功
- [x] `oauth.refreshToken` 刷新成功并更新有效期（约 7 天）
- [x] `order.getOrderList` 返回真实订单
- [x] `order.getOrderDetail` 按 storeCode / sellerId + 订单号查询状态成功
