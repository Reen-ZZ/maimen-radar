# 字段实测笔记

全部来自 `mcd-mcp v1.0.0` 真实响应（2026-10-18 抓取）。仓库内发布的是脱敏样例 `fixtures/`——业务事实（餐品、价格、时段窗、星期窗、积分口径）真实，身份字段（券码、券 id、accountId、门店名与编码、traceId）已替换。凭直觉解析这些字段一定会错，所以写解析前先过一遍。

## 门店侧时间窗优先

- 门店券 `tradeDateTime`（如 `2026-10-19 10:30:00-2026-10-23 23:59:59`）是"**这家店今天几点起能刷**"的权威口径；券包 `tradeTimePeriods` 是券面全局窗。两者冲突时**以门店侧为准**。
- 判定用法：今天在日期范围内 → 窗口取 [起点时刻（跨日则 00:00），终点时刻（跨日则 23:59）]；不在范围内 → 未到 = 还不能刷，已过 = 出局。

## 任选/组合类 SKU 不进菜单

- `9900016534`（王牌炸鸡任选2）实测在 `query-meals` 的 `meals` 字典与 `categories[].meals[]` 引用里**都不存在**。
- `query-meal-detail(code=9900016534)` 返回 `code,name,rounds[],image,supportModify`，`rounds[].choices[]` 带 `diffPrice/isDefault`，但**没有价格字段**。
- 这类券**不许显示"省 ¥X"**——算不出就直说"菜单里没标价，要我先算到手价吗"。

## 到手价需双码

- `calculate-price` 只给 `couponId` 会被拒：`600010 使用优惠券需要couponId和couponCode`。
- `items[]` 支持 `couponId/couponCode/productCode/quantity/roundList/modification/withOrder`。
- **因此任何算价脚本不得回显入参**（券码可核销），结果落盘前必须把 `couponCode` 掩码。
- `couponId+couponCode` 同时给之后的成功响应结构**尚未取证**，第一次真实算价成功后补进本文件。

## 券侧商品名 ≠ 菜单侧实体名

- 门店券 `products[].productName`（券侧写法，如"麦咖啡™冰美式中杯"）与菜单实体 `name`（如"麦咖啡™美式"）**不保证一致**。
- join 必须走 `productCode`；名称查找（如 couponLadder 按 name）要用**菜单侧真名**，否则断链。

## 券包 vs 门店券的 id 同源性（✅ 已用真实数据验证）

- **2026-10-19 实测（门店 1420370，traceId `b65aa340…`）：券包 `id` 与门店券 `couponId` 同源**。券包 4 张、门店券返回 3 张，返回的 3 张 `couponId` 与券包 `id` **逐字节完全一致**（同一大写 32 位哈希），无任何"同名不同 id"。
- 佐证：人气麦旋风券（`beTypes` 不匹配到店场景）**没有**出现在门店券返回中，与模型判定一致。
- `src/check.mjs` 的券名回退兜底保留（防服务端未来变更键语义），正常情况不再触发警告。
- A2（券价叠加进账单）的前置条件就此成立：按 `couponId` 认亲是可靠路径。

## 实现约定（非实测事实，是本项目的处理规则）

- 跨午夜时段（`endTime ≤ startTime`，如 22:00-02:00）按两段处理：`[22:00,24:00)` + `[00:00,02:00)`。官方是否存在此类券未实测。

## 时钟

- 响应**顶层**带 `datetime`（秒级），例 `2026-10-18 16:16:13`。倒计时以它为基准，别信用户设备时钟。
- 顶层还带 `traceId`。它是真实调用的证据，写进 `MCP_INTEGRATION.md`；**不要**出现在用户卡片上。

## 券（`query-my-coupons`，单张 58 个字段）

| 字段 | 事实 |
|---|---|
| `tradeEndDate` | 只到**天**。倒计时禁用它。 |
| `tradeStartDateTime` | 到秒。券存在「未到生效时间」的状态，判定必须校验；实测样例里均有值。若未来某响应缺失此字段，`datetimeText` 左侧（`2026-10-12 00:00-…`）可作兜底。 |
| `tradeEndDateTime` | 到**秒**。实测 4 张券到期时刻**全是 `23:59:59`**。 |
| `datetimeText` | 现成展示串 `2026-10-12 00:00-2026-10-18 23:59`，分钟级。 |
| `weekdays` | **`1=周日，2=周一 … 7=周六`**（即 JS `getDay()+1`）。空数组＝不限。判定依据：2026-10-19 周一，券 `weekdays=[2,3,4,5,6]`，官方门店券**周一放行**，且券面写"周一、二、三、四、五"——判别性证据。此前 2026-10-18（周日）推断的"1=周一"在周日与真映射恰好同判，属欠定，已推翻。教训：单日观测推断枚举映射必须选判别性日期。**自校验渠道**：`datetimeText` 已含中文星期窗，枚举映射改动后拿它对账，别再靠单日观测推断。 |
| `tradeTimePeriods` | `[{startTime,endTime}]`，配 `isAllTradeTime`（1＝全天）。 |
| `beTypes` | **必须校验**。已知 `1 到店自取 / 2 麦乐送 / 5 得来速 / 6 企业团餐`；`3`、`4` 官方未公开含义——只说"不支持当前取餐方式"，别猜。 |
| `enable` | 0 时券在包里但刷不出来。 |
| `currentDayAvailableCount` / `totalAvailableCount` | 当日余量 / 总余量。 |
| `tags[]` | 官方**已经**下发 `{value:"due today",label:"今日到期"}` 和 `到店专用/外送专用`。临期提醒不是空白区。 |
| `isCanGive` | 1＝可转赠。`isGiveAway` 是"已被赠出"。 |
| `discountInfo` | `{discountValue, discountDesc:"用券价格", discountTypeText:"¥"}`。 |
| `code` / `id` | `code`（`MCD6…RW09`）**可被核销**，属敏感信息；`id` 是哈希，可作内部 diff 键。两者都绝不渲染全文。 |
| `toastText` | 官方现成限制文案，如"该券仅限麦当劳App使用"，直接引用。 |
| 分页 | `pageSize` 上限 200、`page` 上限 5 → 按 1000 张设计。 |

## 积分（`query-my-account`，无入参）

- 只有**月粒度**：`currentMouthExpirePoint` / `lastMouthExpirePoint` / `nextMouthExpirePoint`。没有精确到期日，文案只能是"本月将过期 N 分"。
- 字段拼写是官方原文的 **`Mouth`**（不是 Month），照抄，改了就对不上接口。
- 三向闭合已验证：`usedPoint + expiredPoint + availablePoint === accumulativePoint`。不闭合就是数据异常，先报错别算比例。
- 值是**字符串**（`"2603.3"`），带小数。

## 菜单（`query-meals`）

归一化结构，不是平铺列表：

- `data.meals` = `{ [code]: { name, image, currentPrice, originalPrice, canWithOrder, discountType? } }`
- `data.categories[].meals[]` = `{ code, tags }` —— **只有引用，没有价格**。要 join。
- **麦金卡是另一条 SKU code**，靠引用上的 `tags:["麦金卡"]` 识别，不是价格字段。同一商品两条 code，按 `name` 归并才能拼出阶梯。
- `discountType`（如"促销优惠"）只在部分实体上存在，可选字段。
- `data.frequent = {code, tags:["我的常点"]}` 是官方个性化锚点（实测指向"人气经典随心配"），可直接用作默认偏好，但**只作排序破平局项，不作加分**。
- **麦金卡价差别当会员演算**：实测某店 15 条 `麦金卡` tag 引用的商品名下 **0 条存在同名第二条 SKU**（`gold === sale`）。💳 段展示的"麦金卡"列与现价同值时，不得当作会员价差叙述。
- 入参规则：`beType=1 → orderType=1` 不传 `beCode`；`beType=5 → orderType=1` 必传 `beCode`；`beType=2/6 → orderType=2` 必传 `beCode`。

## 门店券（`query-store-coupons`）

- 返回**已按门店 + 业务类型过滤**，是"此刻这家店真能用"的权威集合。用它校验四态判定的一致性。
- 每条带 `products[]`（`{productCode, productName}`）→ 可与 `data.meals` 硬 join，价格阶梯不用猜。
- 字段名不同：这里是 `couponId` / `couponCode` / `tradeDateTime`（一个拼接串），不是券包那套。

## 积分商城（`mall-points-products`）

- **`price` 字段恒为 0**。真实元值埋在 `selling` 文案开头（"18.8元麦辣鸡腿汉堡两件套"），要正则解析。
- 选换算锚点按 **元值/积分 性价比**，别按积分最低档——最低档是"1 分应援活动"，文案写"13.9起"不含"元"，解析不出。
- `catName` 已知取值：`到店专用 / 实物商品 / 周边产品 / 鞋袜 / 品鉴会 / 读书会 / 主题类派对 / 生日类派对 / 麦麦体验营 / 积分兑换活动`。

## 活动日历（`campaign-calendar`）

- 结构是 `{ currentTime, dailyList[], subscribedEvents[] }`。
- `dailyList[].events[]` 的正文在 **`articleDto.title` / `articleDto.content`**；`activityTitle` 常为空字符串。
- `specifiedDate`（`yyyy-MM-dd`）可锚定到某天及前后各一个有活动的日子。
- 这个接口已有 101 个参赛项目在用，别当主打。

## 错误码 ≠ 错误

- **`available-coupons` 用 `success:false, code:499, message:"No coupons available"` 表达"没有可领的券"** —— 稳定语义，不是瞬时故障，也不是限流。按标准错误处理会给用户弹"服务异常"。判"无券可领"要认这个 499，重试三次结果一致（traceId `5afa6d56…`、`6ec1351a…`）。
- **严格校验 structured content 的客户端（实测 WorkBuddy）上，`available-coupons` 无券时会直接抛 `MCP error -32602: Structured content does not match the tool's output schema: data/data must be array`**。原因：此时服务端返回 `data: null`（见 `fixtures/available-coupons.json`），过不了工具声明的 `data: array` output schema，客户端在模型看到结果之前就拦截了。**它与 code:499 是同一个「无券可领」语义的两种长相**——原文解析（probe）绕过校验拿到 499，严格客户端抛 -32602，同账号同日互证（2026-10-18）。按"无券可领"处理：直接告诉用户现在没有可领的券，**不重试、不报"服务异常"**。
- 成功场景 `data` 是否为数组未验证（需要一个有可领券的账号确认）。若届时也报 -32602，同样降级为人话提示并引导去麦当劳 App 领取，别当故障。
- 401 才是 Token 问题；429 才是限流（600 次/分钟）。

## 服务端

- `tools/list` 实际返回 **35 个**工具，官方 README 只列了 **33** 个。以 `tools/list` 为准。
- 未写进 README 的 2 个：`query-survey-coupon`、`query-promotions`。
- README 里名字已过时的 2 个：`query-partystore-date` → 实际 `query-party-store-date`；`query-partystore-session` → 实际 `query-party-store-session`。照 README 写会调不到工具。
- 入参里 `beType` / `orderType` / `searchType` 声明为 `integer`，传数字不是字符串。
- 响应顶层 `datetime` 会随真实时间推进，同一会话内多次调用时间不同属正常。
