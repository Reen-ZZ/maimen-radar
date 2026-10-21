#!/usr/bin/env node
/**
 * 「今天吃啥」可执行入口（写死链路，docs/plans/2026-10-20-eat-three-tracks.md）。
 *
 *   node src/eat.mjs                      # 默认：绑定的那家店 + 到店自取
 *   node src/eat.mjs --store 1420370      # 指定门店（编码或别名，如 --store 家）
 *   node src/eat.mjs --json               # 输出三轨结构（含官方 image，供编排/卡片用；不含任何券码）
 *
 * 三轨并列，各给一条，**不排成一张榜**（D9）：
 *   ① 优惠套餐（券）    ② 1+1 加可用优惠券套餐    ③ 当期新品优惠
 * 三个「省」不同源：① 真省=菜单现价−券价（边际收益）、② 券省=同一张券的省（1+1 分文不参与）、
 * ③ 省=原价−现价（划线价口径）。所以 ① 的 ¥10.6 和 ③ 的 ¥21.1 不许放在一起比大小。
 * 任何一轨缺数据（早餐没有 1+1 分类、上新都没折扣）→ 该轨整条不出，不留空行占位。
 *
 * 门店来源收敛在 src/store.mjs 的 resolveStore：显式指定 > 绑定的默认店 > 官方收藏第一家；
 * 店名、本轮怎么定的这家店、数据是 out/ 还是样例，全挤进标题行（正文 5 行没有别的位置放）。
 *
 * 核心设计：只判到店场景（beType=1）。外送、得来速、下单不在范围内——引导去麦当劳 App。
 * 本脚本只读 state，不写——落盘由 wake.mjs 的第四步负责。
 * 唯一产出路径：对话里说「今天吃啥」先跑本脚本，再按输出纪律复述，不许模型临场挑券。
 * 本脚本在任何路径下都不调算价通道（D4：只问不做，点头后才走 tools/quote.mjs）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, loadScoped, sourceDir } from './data.mjs';
import { buildModel, pickThree, pickComboOffer } from './model.mjs';
import { resolveStore, storeNote } from './store.mjs';
import { load as loadState } from './state.mjs';
import { withCloser } from './tone.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const storeArg = (() => { const i = argv.indexOf('--store'); return i >= 0 ? argv[i + 1] : null; })();
// 核心设计只判到店：不接受 --be 切换外送场景（外送引导去麦当劳 App）
const sceneBeType = 1;

const SRC = sourceDir();
if (!SRC) {
  console.error('✗ 没有可用数据。先拉：node tools/probe-mcp.mjs query-my-coupons');
  process.exit(1);
}
const read = (f) => { try { return load(f); } catch { return null; } };

const state = loadState(ROOT);
const favorites = read('query-nearby-stores.json')?.data ?? [];
const store = resolveStore({ state, arg: storeArg, favorites });
const storeCouponsRaw = store ? read(`store-coupons.${store.code}.json`) : null;
const couponsRaw = read('query-my-coupons.json');
const accountRaw = read('query-my-account.json') ?? { data: {} };

// 菜单是门店级响应（query-meals 必传 storeCode），响应里又不自报门店 ——
// 缺这家店的快照就不算钱，绝不拿别家店的价目表凑（错的是钱，不是图）
let mealsRaw = null;
let menuGap = null;
if (store) {
  try { mealsRaw = loadScoped('meals', store.code); } catch (e) { menuGap = e.message; }
}

// 内部提示走 stderr，不进用户可见文本
if (!couponsRaw) console.error('✗ 缺 query-my-coupons.json —— node tools/probe-mcp.mjs query-my-coupons');
if (store && !mealsRaw) console.error(`✗ ${menuGap}`);
if (store && !storeCouponsRaw) {
  console.error(`✗ 缺 store-coupons.${store.code}.json —— node tools/probe-mcp.mjs query-store-coupons --args '{"storeCode":"${store.code}","beType":1,"orderType":1}'`);
}

const model = buildModel({
  couponsRaw: couponsRaw ?? { data: {} },
  accountRaw,
  mealsRaw: mealsRaw ?? { data: {} },
  storeCouponsRaw,
  store,
  sceneBeType,
});
// ② 轨的读法（T17）与实付区间（T16）只有 query-meal-detail 能给。
// 取不到就不猜：按服务端唯一实测过的 (b)「1+1 + 另买一份用券商品」走，并在 --json 里标 readBasis。
const comboOffer = pickComboOffer(model);
const comboDetail = comboOffer ? read(`meal-detail.${comboOffer.code}.json`) : null;
const three = pickThree(model, { comboDetail });

/** 金额显示：整数不带小数点（¥48 而不是 ¥48.0），小数一律一位 */
const money = (v) => (v == null ? '—' : Number.isInteger(+v) ? String(v) : (+v).toFixed(1));

/**
 * 标题行承载「店名全名 + 本轮这家店是怎么定的 + 数据从哪来」（T10 / T14 / D12=④）。
 * 正文 5 行被三轨占满，独立的 `门店：` 行与「（样例数据…）」那句都放不下；
 * 而它们一旦被 `slice(0,5)` 静默丢掉，用户就分不清这结论是哪家店、真数据还是样例。
 */
const storeTag = (s) => {
  const notes = [storeNote(s), SRC !== 'out' ? '样例数据' : null].filter(Boolean);
  return `${s.name ?? s.code}${notes.length ? `（${notes.join(' · ')}）` : ''}`;
};

if (asJson) {
  // 只投影可展示字段。**绝不展开 model 里的 coupon.raw** —— 那是原始响应，含可核销券码，
  // 打到 stdout 等于进了对话记录（2026-10-21 复查发现旧 --json 正在这么泄漏，已修）。
  console.log(JSON.stringify({
    sceneBeType,
    store: store ? {
      code: store.code, name: store.name ?? null, alias: store.alias ?? null,
      source: store.source, origin: store.origin ?? null, note: storeNote(store),
    } : null,
    generatedAt: model.nowText,
    dataSource: SRC,
    fallback: three.fallback,
    uses: three.uses,
    outcast: three.outcast,
    counts: three.counts,
    tracks: { coupon: three.coupon, onePlusOne: three.combo, newItem: three.item },
  }, null, 2));
  process.exit(0);
}

// ── 用户可见文本：正文 → 收尾语，≤5 行 ──
const L = [];
let closerKind = 'silent';
const tag = store ? storeTag(store) : null;

if (!store) {
  L.push('🍔 还没确定门店，先说「绑店」或给我一个门店名/城市。');
} else if (menuGap) {
  L.push(`🍔 店是${tag}，但这家店的菜单快照还没有，到手价和省额先不算。`);
  L.push('   说一句「拉一下这家店」就行（只读接口，不用确认）。');
} else if (three.fallback === 'no_store_coupons') {
  L.push(`🍔 ${tag}还没拿到这家店此刻的放行名单，先按券面推断：`);
  const guess = model.coupons.find((c) => c.state === 'now');
  if (guess) L.push(`   最可能是 ${guess.title}${guess.couponPrice ? `（用券 ¥${guess.couponPrice}）` : ''}，未确认到店能不能刷出来`);
  L.push('   说「绑店」或让我拉一次这家店的可用券，我再给准话。');
} else if (three.fallback === 'no_now') {
  L.push(`🍔 ${tag}今天一张都刷不出来。`);
  const gift = model.coupons.find((c) => c.state === 'gift');
  if (gift) L.push(`   ${gift.title} 快到期且支持转赠——用不上就在麦当劳 App 里送人。`);
  else L.push('   说「权益账单」看看每张券为什么不行。');
} else if (three.fallback === 'no_price') {
  // D2/D4：join 失败出局，只问一句，不自动算价
  L.push(`🍔 ${tag}现在有 ${three.outcast.length} 张能刷，但都是多选组合、菜单里没标价：`);
  L.push(`   ${three.outcast.join('、')}`);
  L.push('   要我先算到手价再说？');
} else {
  const { coupon, combo, item } = three;
  L.push(three.trackCount >= 2
    ? `🍔 ${three.trackCount === 3 ? '三个' : '两个'}选项，${tag}现在真能用：`
    : `🍔 ${tag}现在只有一张券能用：`);
  if (coupon) {
    L.push(`   ① ${coupon.name} 用券 ¥${money(coupon.couponPrice)}（现价 ¥${money(coupon.sale)}，真省 ¥${money(coupon.gain)}）`
      + `${coupon.verdict === 'marginal' ? '（别为它专门跑一趟）' : ''}`);
  }
  if (combo) {
    L.push(combo.total != null
      // 措辞纪律：拼单总价必然高于单买券商品，所以这里只报数，不说「更划算/更省/比①值」
      ? `   ② 1+1随心配 ¥${money(combo.base)} + ${coupon.name}用券 ¥${money(coupon.couponPrice)} = ¥${money(combo.total)}（券省 ¥${money(combo.save)}）`
      : `   ② 1+1随心配 ¥${money(combo.base)} + ${coupon.name}用券 ¥${money(coupon.couponPrice)}（这一单里的 1+1 能用券，合计以 App 为准）`);
  }
  if (item) L.push(`   ③ ${item.name} ¥${money(item.cur)}（原价 ¥${money(item.orig)}，省 ¥${money(item.save)}）`);
  // 末行只约束真用了券的那几条轨（T11）：③ 新品没有券，编号按在场轨道现算，不写死 ①②
  if (coupon) {
    L.push(`   ${three.uses} 用的那张券：${coupon.windowText ? `${coupon.windowText} 能刷` : '时段以门店实际为准'}，今天余 ${coupon.quota} 次`);
  }
  closerKind = coupon && (coupon.verdict === 'ok' || coupon.verdict === 'great') ? 'saved' : 'neutral';
}

// 超上限不再静默丢行：正文进 stdout，被丢掉的那几行进 stderr 供排障（缺陷③ 的根治）
const body = L.slice(0, 5);
if (L.length > body.length) console.error(`[eat] 正文 ${L.length} 行超 5 行上限，被丢掉：${L.slice(5).join(' / ')}`);
console.log(body.join('\n'));
if (L.length && closerKind !== 'silent') console.log('\n' + withCloser('', closerKind).trim());
