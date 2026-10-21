# 字段实测笔记

全部来自 `mcd-mcp v1.0.0` 真实响应。仓库内发布的是脱敏样例 `fixtures/`——业务事实（餐品、价格、时段窗、星期窗、积分口径）真实，身份字段（券码、券 id、accountId、门店名与编码、traceId）已替换。凭直觉解析这些字段一定会错，所以写解析前先过一遍。

> 样例快照日期：券包/积分/门店券 **2026-10-18**；菜单 `meals.<code>.json` **2026-10-20**（改造成按 storeCode 键存时只能从当前 `out/` 重新生成，其余文件留在 10-18 那次快照上，所以两份日期不同——菜单是公开目录，跨这两天没变出口径）。

## 门店侧时间窗优先

- 门店券 `tradeDateTime`（如 `2026-10-19 10:30:00-2026-10-23 23:59:59`）是"**这家店今天几点起能刷**"的权威口径；券包 `tradeTimePeriods` 是券面全局窗。两者冲突时**以门店侧为准**。
- 判定用法：今天在日期范围内 → 窗口取 [起点时刻（跨日则 00:00），终点时刻（跨日则 23:59）]；不在范围内 → 未到 = 还不能刷，已过 = 出局。

## 任选/组合类 SKU 不进菜单

- `9900016534`（王牌炸鸡任选2）实测在 `query-meals` 的 `meals` 字典与 `categories[].meals[]` 引用里**都不存在**。
- `query-meal-detail(code=9900016534)` 返回 `code,name,rounds[],image,supportModify`，`rounds[].choices[]` 带 `diffPrice/isDefault`，但**没有价格字段**。
- 这类券**不许显示"省 ¥X"**——算不出就直说"菜单里没标价，要我先算到手价吗"。

## 到手价需双码（⚠ 静默陷阱：业务失败不抛错）

- `calculate-price` 只给 `couponId` 会被拒：`600010 使用优惠券需要couponId和couponCode`；错配商品报 `600012 促销规则不支持该商品`；**多 item 每件都挂同一张券的双码报 `600022 暂不支持多张券使用`**（服务端读成"多张券"）——**双码只挂第一个 item 后组合报价实测可用**（2026-10-19：507411x1 带券 + 1440x1 无券 → 合计 `price:3240` = ¥9.9 + ¥22.5，券只作用于挂双码的那件）。
- `items[]` 支持 `couponId/couponCode/productCode/quantity/roundList/modification/withOrder`，**双码按 item 挂**。
- **不带券是完全合法的输入**：返回 `200 + discount:0 + price=无券价`，没有任何"你没带券"的提示。**`discount > 0` 是"券真的生效了"的唯一可靠信号**。
- **业务失败放在响应体**（`success:false` + `code`），`result.isError` 恒为 `false`——**任何走麦当劳 MCP 的代码都不得只靠 `isError` 判成败**（`available-coupons` 的 `code:499` 是同一套风格）。
- **因此任何算价脚本不得回显入参**（券码可核销），结果落盘前必须把 `couponCode` 掩码。
- **单位约定**：`calculate-price` 的金额字段**单位是分**；`query-meals.currentPrice` **单位是元**。混算必须显式换算（×100 / ÷100），换算点唯一。
- **quantity 会被静默降件**（实测 `507411x2` → `productList:[{quantity:1, subtotal:990}]`，traceId `fa2b353d…`）：金额合理、无任何报错，基线自证也抓不到（无券那一枪同样被降件）。**必须逐单核对请求 quantity 与响应 `productList[].quantity` 总数**，不一致不得播到手价。
- **productCode 可能被服务端归一化**（实测 `507411` → 响应里 `507410`）：quantity 比对按总件数，不按编码逐件对。
- **样本落盘带时间戳**：同一张券多次报价互不覆盖（slug = 门店 + 券掩码 + 服务端 HHmmss），失败响应不落盘。
- ✅ **2026-10-19 首次成功取证**（traceId `c081dcd0…`，麦辣券+双码）：响应 `data.{productOriginalPrice, productPrice, originalPrice, discount, price, productList[]}`，**单位是分**（`price: 1190` = ¥11.9）。对照样本：无券（`bbdf9a51…`）`price:2250, discount:0`；错配（`e1adeef3…`）`600012`；冰美式券（`add1f944…`）`price:990` = 券价 ¥9.9，与"现价−券价=省 ¥2.0"的估算交叉吻合。

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

## 券面图（✅ 2026-10-20 真实账号实测）

- 每张券自带 `image`（600×600 方图，多为透明底抠图）与 `bigImage`（1035×516 官方促销横幅），实测 **4/4 有值**。host 是腾讯云 COS `mcd-portal-prod-cos1-…myqcloud.com`，与菜单图 `menu-img.mcd.cn`、商城图 `img.mcd.cn` **分属三个域名**——"图来自官方"不等于来自同一个 CDN。
- URL 带 `sign` 参数（COS 标准签名，内含 `q-sign-algorithm/q-ak/q-sign-time/q-key-time/q-signature`）。实测 `q-sign-time` 为 `2026-10-12 → 2031-10-11`，**有效期 5 年，不是短时效签名**；无 referer 防盗链（三种 referer 均 200）。热链可用，但仍是外链依赖。
- `bigImage` 图上**烘焙了价格与渠道字样**：实测三张横幅烘焙价与券价一致（11.9/19.9/9.9），但「到店／麦乐送同享」**不是每张都有**（冰美式那张是 IIAC 金奖杯图，没有外送字样）。图是像素，程序判不了里面写了什么字——所以任何"小字注明"必须写成**无条件为真**的句子，不许断言"图中有某字样"。
- 「任选」类券的 SKU 菜单里没有（见上节），但官方为它单独画了组合图（8 选 2 全画出来了）。**券自带图正好补在菜单图覆盖不到的地方**，这是取图链把它排在第 ① 级的原因；菜单图（`meals[].image`，实测 107/107）降为兜底。
- 品牌色：`tags[].color` 实测稳定下发 `#FFBC0D`（金）；`#DB0007`（红）**只在 fixtures 的 `instructions.availableTime[].color` 里出现过，真实数据未见**。金色可以数据驱动，红色不行——写死并标注来源，别假装是取来的。
- 券面图与券名一样**不属于敏感信息**，故模型里以 `couponImage`/`couponBand` 独立存在、不随 `share` 清空（可核销的 `code` 与整包 `raw` 仍然清空）。判据见 `src/check-share.mjs`。

## 积分（`query-my-account`，无入参）

- 只有**月粒度**：`currentMouthExpirePoint` / `lastMouthExpirePoint` / `nextMouthExpirePoint`。没有精确到期日，文案只能是"本月将过期 N 分"。
- 字段拼写是官方原文的 **`Mouth`**（不是 Month），照抄，改了就对不上接口。
- 三向闭合已验证：`usedPoint + expiredPoint + availablePoint === accumulativePoint`。不闭合就是数据异常，先报错别算比例。
- 值是**字符串**（`"2603.3"`），带小数。

## 菜单（`query-meals`）

归一化结构，不是平铺列表：

- `data.meals` = `{ [code]: { name, image, currentPrice, originalPrice, canWithOrder, discountType? } }`
- `data.categories[].meals[]` = `{ code, tags }` —— **只有引用，没有价格**。要 join。
- **麦金卡价商品的判据是实体字段，不是引用 tag**（✅ 2026-10-20 两店全量核对）：`discountType === '随单购麦金卡优惠'` ⟺ `canWithOrder === true`，两店集合完全相同。只认分类引用的 `tags:["麦金卡"]` 会**漏判 2 条（1420721）/ 5 条（1420370）**——漏的都是引用没 tag 的实体。反向为 0 条（引用带 tag 而实体没这个 dt 的不存在）。
- **`currentPrice` 对这些商品就是麦金卡价**：实测 17/17、19/19 条麦金卡商品在菜单里**只有一条 SKU**，不存在"非麦金卡的那条"。所以 `原价 − 麦金卡价` 是**营销口径**，不是"用卡比不用卡省多少"；菜单里根本没有非麦金卡用户付的那个价。💳 段"现价"与"麦金卡"两列同数即为此。
- **1+1 只存在于分类名里**（✅ 2026-10-20）：分类名是 `随心配\n1+1`（**含换行**，匹配前要去掉），实体名却是 `9900013304 人气经典随心配` / `9900015568 精选超值随心配`——名字里没有"1+1"，**按商品名搜永远搜不到**。同一分类下可能有多款（1420370 两款、1420721 一款），不得假设唯一。
- **「上新」tag 必须精确匹配，且里面混着周边**（✅ 2026-10-20 两店）：近似 tag `韩式芝士风味酱上新` / `新升级` / `清爽上新` 语义不纯，不认。精确 `上新` 的名单里混着非餐品——实测 1420721 有 3 件、1420370 有 6 件（旋旋水手帽 / 按摩捶痒痒挠 / 薯条脆卜卜毛绒周边 / 复古棒球帽 / **联名徽章** / 旋旋星愿贴）。**周边没有结构化字段可认**（实体字段与真餐品完全同构、分类也同在「小食甜品/其他」），只能用两条易碎启发式的并集：tag 表（`汪苏泷限量周边 / 既可捶背 / 又可挠痒`）∪ 名字表（`周边|帽|徽章|捶痒痒挠|毛绒`）。**两张表缺一不可**：`521946 旋旋星愿贴` 全靠 tag、`521955 麦当劳联名徽章` 全靠名字（官方只给 `["上新"]`）。
- **周边在两处的筛法不同，是有意的**：「今天吃啥」的新品轨排除它（答「吃什么」，推帽子是噪音），权益账单**不**排除（答「这期有什么」，周边也是权益）。实测 1420721 = 账单 13 项（含 3 件周边）／今天吃啥 4 条能吃的；1420370 = 16 项（含 6 件）／3 条。`node src/check.mjs` 的 **【周边分叉】** 段把这条钉住：账单 🆕 段的条数必须等于菜单上新全量、周边名字必须出现在账单里、候选池里必须一件周边都没有，并按 code 钉 `521955 麦当劳联名徽章`（它只靠名字表里的「徽章」命中）。别把两处"统一"掉。
- `discountType`（如"促销优惠"）只在部分实体上存在，可选字段。
- `data.frequent = {code, tags:["我的常点"]}` 是官方个性化锚点（实测指向"人气经典随心配"），可直接用作默认偏好，但**只作排序破平局项，不作加分**。**⚠ 它不每店每时段都下发**：1420721 午餐有、1420721 早餐**没有**、1420370 晚餐**没有**——所以「frequent 缺失时的兜底」是常态路径，代码不许假设它一定在。
- **菜单随时段漂移**（✅ 2026-10-20）：同一家店 `reservationDate` 早 7:30 是 **77 实体 / 11 分类**，午后是 **111 / 15**——早餐没有「随心配1+1」这一档（连分类都没有），上新也从 13 条掉到 2 条。做"清单条数"类断言前先确认这份是哪个时段的。
- 入参规则：`beType=1 → orderType=1` 不传 `beCode`；`beType=5 → orderType=1` 必传 `beCode`；`beType=2/6 → orderType=2` 必传 `beCode`。

## 菜单是门店级响应，却不自报门店（✅ 2026-10-20 实测，据此改的落盘规则）

- `query-meals` 的 required = `["storeCode","orderType","beType"]`，但响应顶层只有 `success/code/message/datetime/traceId/data`，`data` 里也只有 `categories/meals/frequent` —— **没有任何门店身份字段**。门店来源只存在于请求参数里，落盘即丢失。
- 所以**文件名就是唯一的来源记录**：`out/meals.<storeCode>.json`（`store-coupons.<code>.json` 早就是这个约定，菜单漏了）。`src/data.mjs` 的 `loadScoped()` 只认带 key 的文件、**拒绝回退**，缺这家店的快照就报错并点名门店。
- 两店菜单实测差集（同一账号，2026-10-20）：共同且同价 85 / **价差 17** / **仅一家有 20**。而券的放行集合两家相同 —— 意味着 `check.mjs` 那种"只比集合不比价"的闸门**抓不到这种错配**，故另立 `src/check-store.mjs`。
- 教训：`storeCode` 进了入参就必须进文件名。否则 A 店的券会拿着 B 店的价目表算"省多少"，而错的是钱，不是图。

## 收藏门店（`query-nearby-stores`，✅ 2026-10-20 真实账号实测）

- 必传 `beType` 与 `searchType`（`1`=收藏餐厅，默认；`2`=按 `city`+`keyword` 位置搜索）。**不传参数直接没有 `data`**。
- 每条返回 `storeCode / storeName / address / reservation / reservationTimeOptions[] / distance / longitude / latitude`。
- **没有 `city` 字段**。城市只能从 `storeName`/`address` 反推，那是猜——所以 `state.stores[].city` 只在用户自己说过城市时才写。
- **`searchType=1` 下 `distance`、`longitude`、`latitude` 全是 0** ⇒ 拿不到就近信息，"按距离自动选店"这条路接口不支持。
- `reservationTimeOptions[].reservationOptionText` 给的是**这家店当天**的分段时段（如"午餐(10:44至14:15)，下午茶(14:44至16:45)，夜市…"），可直接用作绑定时报给用户的"几点能刷"。
- 实测该账号收藏 **2 家、跨 2 个城市**（惠州博罗天虹 / 深圳龙胜地铁站）⇒ 多店是真实形状，不是假设。但同一天两家的放行集合与 top1 省额**完全一致**（0 差异），差异只存在于上面那 17/20 个菜单条目里，所以多店 UI 的收益**尚未被证实**。

## 门店券（`query-store-coupons`）

- 返回**已按门店 + 业务类型过滤**，是"此刻这家店真能用"的权威集合。用它校验四态判定的一致性。
- 每条带 `products[]`（`{productCode, productName}`）→ 可与 `data.meals` 硬 join，价格阶梯不用猜。
- 字段名不同：这里是 `couponId` / `couponCode` / `tradeDateTime`（一个拼接串），不是券包那套。

## 积分商城（`mall-points-products`）

- **`price` 字段恒为 0**。真实元值埋在 `selling` 文案开头（"18.8元麦辣鸡腿汉堡两件套"），要正则解析。
- 选换算锚点按 **元值/积分 性价比**，别按积分最低档——最低档是"1 分应援活动"，文案写"13.9起"不含"元"，解析不出。
- `catName` 已知取值：`到店专用 / 实物商品 / 周边产品 / 鞋袜 / 品鉴会 / 读书会 / 主题类派对 / 生日类派对 / 麦麦体验营 / 积分兑换活动`。

## 活动日历（`campaign-calendar`）

- **不分店，也不分城**（✅ 2026-10-20 实测）：入参 schema 里**没有 `storeCode`**，响应全树扫下来**一个地域键都没有**（无 city/region/store/area/province）。所以这句结论不许挂门店名——SKILL.md 路由表把它标成 `全国`，`src/check-store.mjs` 有断言专门盯这一点：谁把 campaign-calendar 或 mall-points-products 标成门店级，闸门就红。
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
