#!/usr/bin/env node
/**
 * 门店闸门：断言「判的是哪家店」由**用户决定**，而不是由抓包文件的顺序决定。
 * 与 check.mjs / check-share.mjs 并列的完成判据 —— 跑不过就不许把结果交给用户。
 *
 *   node src/check-store.mjs
 *
 * 为什么需要它（2026-10-20 实测出的两个缺陷）：
 *   1) `state.stores` 全仓只有读没有写 → needStore 恒真 → 催绑话术每轮都占一行且永远闭不了嘴
 *   2) wake/eat/demo 都取 `query-nearby-stores.json` 的 `data[0]`，菜单读无 key 的 `query-meals.json`
 *      → 「绑定的门店」与「算价的门店」是两个从不相交的东西
 *      → 实测两店菜单 17 个价差 / 20 个店独占单品，`query-meals` 又**必须**传 storeCode
 *
 * 能力上限（诚实声明）：`query-meals` 响应里**没有任何门店身份字段**（实测顶层只有
 * success/code/message/datetime/traceId/data），所以门店来源只能由**文件名**承载。
 * 本闸门查的是「文件名与所判门店是否一致」与「缺该店快照时是否停下」，
 * 查不出「有人把 A 店文件改名成 B 店」——那只能靠抓取时不手改文件名。
 */
import { readFileSync } from 'node:fs';
import { load, sourceDir } from './data.mjs';
import { buildModel } from './model.mjs';
import { snapshot, diff, wakeLines } from './state.mjs';

const DIR = sourceDir();
if (!DIR) { console.error('✗ 没有 out/ 或 fixtures/'); process.exit(1); }

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };

/* store.mjs 是解析层。缺它时闸门要「红得起来」而不是崩在半路，所以按可选依赖取。 */
let resolveStore = null;
let bindStore = null;
let needsAnnounce = null;
try {
  ({ resolveStore, bindStore, needsAnnounce } = await import('./store.mjs'));
} catch {
  console.log('（src/store.mjs 尚不存在，解析与绑定两项按未实现记红）');
}
const { loadScoped } = await import('./data.mjs');
if (!loadScoped) {
  console.log('✗ data.mjs 未提供 loadScoped —— 门店级菜单无从按 code 取起，闸门其余部分判不了');
  process.exit(1);
}

const favorites = load('query-nearby-stores.json')?.data ?? [];
if (favorites.length < 2) {
  console.error('✗ 收藏门店少于 2 家，无法验证「绑过的店优先于收藏第一条」');
  process.exit(1);
}
const [FA, FB] = favorites;
const asStore = (s) => ({ code: s.storeCode, name: s.storeName });
const EMPTY = { schema: 1, last_seen: null, stores: [], sceneBeType: 1, coupons: {}, points: {}, saved: { entries: 0, total: 0 }, menu: {} };

const mealsOf = (code) => loadScoped('meals', code);
const modelWith = (code) => buildModel({
  couponsRaw: load('query-my-coupons.json'),
  accountRaw: load('query-my-account.json'),
  mealsRaw: mealsOf(code),
  storeCouponsRaw: (() => { try { return load(`store-coupons.${code}.json`); } catch { return null; } })(),
  store: asStore(favorites.find((s) => s.storeCode === code)),
  sceneBeType: 1,
});

console.log(`数据来源：${DIR}/  收藏：${favorites.map((s) => `${s.storeCode} ${s.storeName}`).join(' / ')}\n`);

console.log('【解析层】门店由 state 决定，不许落到收藏第一条');
if (resolveStore) {
  const r0 = resolveStore({ state: EMPTY, favorites });
  ok(r0?.source === 'favorites' && r0.code === FA.storeCode,
    `未绑店时按收藏第一家采用并标注来源：${r0?.code} ${r0?.name ?? ''}（source=${r0?.source}）`);
  const boundB = bindStore(EMPTY, asStore(FB), { alias: '示例店' });
  const r1 = resolveStore({ state: boundB, favorites });
  ok(r1?.code === FB.storeCode && r1.source === 'state',
    `绑过 ${FB.storeCode} 后，它优先于收藏第一条 ${FA.storeCode}（实得 ${r1?.code}, source=${r1?.source}）`);
  const r2 = resolveStore({ state: boundB, arg: FA.storeCode, favorites });
  ok(r2?.code === FA.storeCode && r2.source === 'arg', `临时指定优先于绑定（source=${r2?.source}）`);
  const r3 = resolveStore({ state: boundB, arg: '示例店', favorites });
  ok(r3?.code === FB.storeCode, '可按别名取店（别名是 SKILL.md:138 已写的字段）');
  ok(resolveStore({ state: EMPTY, favorites: [] }) === null, '既没绑店又没收藏时返回 null，不编门店');
} else {
  ok(false, 'resolveStore 未实现');
}

console.log('\n【绑定层】绑上的店要能落盘，落盘后催绑必须闭嘴');
if (bindStore) {
  const bound = bindStore(EMPTY, asStore(FB), { alias: '家' });
  ok(bound.stores?.length === 1 && bound.stores[0].code === FB.storeCode && bound.stores[0].isDefault === true,
    `bindStore 落盘 1 家且置默认：${JSON.stringify(bound.stores)}`);
  ok(bound.stores[0].alias === '家' && bound.stores[0].name === FB.storeName,
    '别名与店名一起落盘（对齐 SKILL.md:138 的 {alias, code, name, city}）');
  const d = diff(bound, modelWith(FB.storeCode));
  ok(d.needStore === false, `绑定后 needStore 变 false（当前 ${d.needStore}）`);
  ok(!wakeLines(d, modelWith(FB.storeCode)).some((l) => l.includes('按你的收藏门店判定')),
    '抬头三行里不再出现催绑句（这句现在每轮都印，且永远闭不了嘴）');
  ok(diff(EMPTY, modelWith(FB.storeCode)).needStore === true, '没绑店时仍须判 needStore（防反向回归）');
  const folded = snapshot(EMPTY, modelWith(FB.storeCode));
  ok(folded.stores?.length === 1 && folded.stores[0].code === FB.storeCode,
    `snapshot 把本次所判门店折进 state：${JSON.stringify(folded.stores ?? null)}`);
  const twice = snapshot(bindStore(EMPTY, asStore(FA), { alias: '默认' }), modelWith(FB.storeCode));
  ok(twice.stores.some((s) => s.code === FB.storeCode)
    && twice.stores.find((s) => s.isDefault)?.code === FA.storeCode,
    '折入新店不得抢走已有默认店（静默换店会让结论全错而用户不知情）');
  // 采用≠绑定：没确认过的店，落盘之后也必须被认出来并明示
  const adopted = snapshot(EMPTY, modelWith(FB.storeCode));
  const again = resolveStore({ state: adopted, favorites });
  ok(needsAnnounce?.(again) === true,
    `按收藏自动采用的店，下一轮仍要求明示（不能升格成「你绑定的」）：source=${again?.source} origin=${again?.origin}`);
  ok(needsAnnounce?.(resolveStore({ state: bindStore(EMPTY, asStore(FB), { alias: '家' }), favorites })) === false,
    '用户确认过的绑定不必每轮重复声明');
  ok(needsAnnounce?.(resolveStore({ state: EMPTY, favorites })) === true,
    '本轮刚采用收藏店时必须明示');
} else {
  ok(false, 'bindStore 未实现');
}

console.log('\n【来源层】门店级数据按 code 键，缺这家店的快照就停下');
for (const s of favorites) {
  let err = null;
  try { mealsOf(s.storeCode); } catch (e) { err = e; }
  ok(!err, `${s.storeCode} 能取到它自己的菜单快照${err ? ` → ${err.message}` : ''}`);
}
const GHOST = '9999999';
let guard = null;
try { mealsOf(GHOST); } catch (e) { guard = e; }
ok(!!guard && String(guard.message).includes(GHOST),
  `不存在的门店 ${GHOST} 必须报错且点名门店，不许回退到别家店的菜单${guard ? ` → "${guard.message}"` : ' → 静默返回了数据'}`);

// 结构性断言：门店无关的文件名再也不能被门店级消费点读走
const legacy = ['wake.mjs', 'eat.mjs', 'demo.mjs', 'check.mjs', 'check-share.mjs']
  .filter((f) => {
    try { return readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').includes("'query-meals.json'"); }
    catch { return false; }
  });
ok(!legacy.length, `没有代码从无 key 的 query-meals.json 读菜单${legacy.length ? ` → 仍在读：${legacy.join('、')}` : ''}`);

console.log('\n【现算一遍】两家店各自的结论。菜单 traceId 若两家相同，就是在拿同一家店的价目表算两家');
for (const s of favorites) {
  const m = modelWith(s.storeCode);
  const top = m.coupons.filter((c) => c.state === 'now')
    .reduce((a, c) => (!a || (c.realGain ?? -1) > (a.realGain ?? -1) ? c : a), null);
  console.log(`   ${s.storeCode} ${s.storeName}`);
  console.log(`     菜单 traceId=${String(mealsOf(s.storeCode)?.traceId).slice(0, 8)}`
    + ` · 放行 ${m.coupons.filter((c) => c.state === 'now').length} 张`
    + `${top ? ` · top1 ${top.displayTitle} 到手¥${top.ladderProduct?.sale} 省¥${top.realGain?.toFixed(1)}` : ''}`);
}

console.log(fail ? `\n${fail} 项不通过` : '\n全部通过');
process.exit(fail ? 1 : 0);
