#!/usr/bin/env node
/**
 * 「今天吃啥」可执行入口（写死链路，docs/plans/2026-10-19-eat-this.md §4）。
 *
 *   node src/eat.mjs                      # 默认：绑定的那家店 + 到店自取
 *   node src/eat.mjs --store 1420370      # 指定门店（编码或别名，如 --store 家）
 *   node src/eat.mjs --json               # 输出 top1 结构（含官方 image，供编排/卡片用）
 *
 * 门店来源收敛在 src/store.mjs 的 resolveStore：显式指定 > 绑定的默认店 > 官方收藏第一家。
 * 本脚本只读 state，不写——落盘由 wake.mjs 的第四步负责。
 *
 * 核心设计：只判到店场景（beType=1）。外送、得来速、下单不在范围内——引导去麦当劳 App。
 *
 * 唯一产出路径：对话里说「今天吃啥」先跑本脚本，再按输出纪律复述，不许模型临场挑券。
 * 本脚本在任何路径下都不调算价通道（D4：只问不做，点头后才走 tools/quote.mjs）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, loadScoped, sourceDir } from './data.mjs';
import { buildModel, pickTop1 } from './model.mjs';
import { resolveStore, storeLine } from './store.mjs';
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
const top = pickTop1(model);

if (asJson) {
  console.log(JSON.stringify({
    ...top,
    sceneBeType,
    store: store ? { code: store.code, name: store.name, source: store.source } : null,
    generatedAt: model.nowText,
    dataSource: SRC,
  }, null, 2));
  process.exit(0);
}

// ── 用户可见文本：正文 → （引导）→ 收尾语，≤5 行 ──
const L = [];
let closerKind = 'silent';

if (!store) {
  L.push('🍔 还没确定门店，先说「绑店」或给我一个门店名/城市。');
} else if (menuGap) {
  L.push(`🍔 店是 ${store.name ?? store.code}，但这家店的菜单快照还没有，到手价和省额先不算。`);
  L.push('   说一句「拉一下这家店」就行（只读接口，不用确认）。');
} else if (top.fallback === 'no_store_coupons') {
  L.push('🍔 还没拿到这家店此刻的放行名单，先按券面推断：');
  const guess = model.coupons.find((c) => c.state === 'now');
  if (guess) L.push(`   最可能是 ${guess.title}${guess.couponPrice ? `（用券 ¥${guess.couponPrice}）` : ''}，未确认到店能不能刷出来`);
  L.push('   说「绑店」或让我拉一次这家店的可用券，我再给准话。');
} else if (top.fallback === 'no_now') {
  L.push('🍔 今天这家店一张都刷不出来。');
  const gift = model.coupons.find((c) => c.state === 'gift');
  if (gift) L.push(`   ${gift.title} 快到期且支持转赠——用不上就在麦当劳 App 里送人。`);
  else L.push('   说「权益账单」看看每张券为什么不行。');
} else if (top.fallback === 'no_price') {
  // D2/D4：join 失败出局，只问一句，不自动算价
  L.push(`🍔 现在有 ${top.outcast.length} 张能刷，但都是多选组合、菜单里没标价：`);
  L.push(`   ${top.outcast.join('、')}`);
  L.push('   要我先算到手价再说？');
} else {
  const t = top.top1;
  const price = t.product?.sale != null
    ? `菜单现价 ¥${t.product.sale}，用券 ¥${t.coupon.couponPrice} —— 省 ¥${t.gain.toFixed(1)}`
    : `用券 ¥${t.coupon.couponPrice}`;
  L.push(`🍔 现在最划得来：${t.coupon.title}`);
  L.push(`   ${price}${t.verdict === 'marginal' ? '（别为它专门跑一趟）' : ''}`);
  L.push(`   ${t.windowsNote ?? '以门店实际为准'}，今天余 ${t.coupon.quota} 次`);
  if (top.second && top.second.gain != null && top.second.gain !== t.gain) {
    L.push(`   其次：${top.second.coupon.title}（少省 ¥${(t.gain - top.second.gain).toFixed(1)}）`);
  }
  if (top.outcast.length) {
    L.push(`   另外：${top.outcast[0]} 现在能刷，但菜单没标价——要我先算到手价再说？`);
  }
  closerKind = t.verdict === 'ok' || t.verdict === 'great' ? 'saved' : 'neutral';
}

// 门店级结论每轮都要点名（2026-10-20 硬规则）——插在第 2 行，不会被 5 行上限截掉
if (store) L.splice(1, 0, `   ${storeLine(store)}`);
if (SRC !== 'out') L.push(`（样例数据 · fixtures 快照）`);

console.log(L.slice(0, 5).join('\n'));
if (L.length && closerKind !== 'silent') console.log('\n' + withCloser('', closerKind).trim());
