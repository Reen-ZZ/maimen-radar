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
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { load, sourceDir } from './data.mjs';
import { buildModel } from './model.mjs';
import { renderText } from './render-text.mjs';
import { renderPropagate } from './render-propagate.mjs';
import { snapshot, diff, wakeLines } from './state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = sourceDir();
if (!DIR) { console.error('✗ 没有 out/ 或 fixtures/'); process.exit(1); }

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };

/* store.mjs 是解析层。缺它时闸门要「红得起来」而不是崩在半路，所以按可选依赖取。 */
let resolveStore = null;
let bindStore = null;
let storeLine = null;
let pickFavorite = null;
try {
  ({ resolveStore, bindStore, storeLine, pickFavorite } = await import('./store.mjs'));
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
const commonOf = (code) => ({
  couponsRaw: load('query-my-coupons.json'),
  accountRaw: load('query-my-account.json'),
  mealsRaw: mealsOf(code),
  storeCouponsRaw: (() => { try { return load(`store-coupons.${code}.json`); } catch { return null; } })(),
  store: asStore(favorites.find((s) => s.storeCode === code)),
  sceneBeType: 1,
});
/**
 * 缺这家店的菜单快照时返回 null，**不抛**。
 * 早先这里直接 buildModel(commonOf(code))，而 commonOf 里的 loadScoped 会抛 —— 于是【绑定层】第 99 行
 * 就把整个进程带堆栈打出去了，后面【来源层】那三条专为「缺快照要优雅报告」准备的断言一条都没跑到。
 * 闸门要红得起来，不能崩在半路。
 */
const modelWith = (code) => {
  try { return buildModel(commonOf(code)); } catch { return null; }
};
const gapMsg = (code) => `门店 ${code} 没有菜单快照，依赖它实盘的断言判不了`
  + ` —— 先抓：node tools/probe-mcp.mjs query-meals --args '{"storeCode":"${code}","orderType":1,"beType":1}'`;
// 每家收藏店现算一次；缺快照的存 null，由各段自己记红并继续（见 modelWith 的注释）
const MODEL = new Map(favorites.map((s) => [s.storeCode, modelWith(s.storeCode)]));
const modelOr = (code) => MODEL.get(code) ?? null;

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
  const mB = modelOr(FB.storeCode);
  if (!mB) {
    ok(false, gapMsg(FB.storeCode));
  } else {
    const d = diff(bound, mB);
    ok(d.needStore === false, `绑定后 needStore 变 false（当前 ${d.needStore}）`);
    ok(!wakeLines(d, mB).some((l) => l.includes('按你的收藏门店判定')),
      '抬头三行里不再出现催绑句（这句现在每轮都印，且永远闭不了嘴）');
    ok(diff(EMPTY, mB).needStore === true, '没绑店时仍须判 needStore（防反向回归）');
    const folded = snapshot(EMPTY, mB);
    ok(folded.stores?.length === 1 && folded.stores[0].code === FB.storeCode,
      `snapshot 把本次所判门店折进 state：${JSON.stringify(folded.stores ?? null)}`);
    const twice = snapshot(bindStore(EMPTY, asStore(FA), { alias: '默认' }), mB);
    ok(twice.stores.some((s) => s.code === FB.storeCode)
      && twice.stores.find((s) => s.isDefault)?.code === FA.storeCode,
      '折入新店不得抢走已有默认店（静默换店会让结论全错而用户不知情）');
    // 采用≠绑定：没确认过的店，落盘之后也不能升格成「用户绑的」
    const again = resolveStore({ state: snapshot(EMPTY, mB), favorites });
    ok(again.origin !== 'user' && again.source === 'state',
      `自动采用的店落盘后 origin 仍是 ${again.origin}，不许伪装成用户确认过`);
  }
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
/**
 * 缺陷① 的自检：闸门自己不许在半路崩。
 * 2026-10-20 实测 —— `modelWith` 直接 buildModel(loadScoped(...))，缺快照时抛异常带堆栈退出，
 * 于是上面这条专为「缺快照要停下」准备的断言之后、【点名层】【口径路由表】一条都没跑到，
 * 而 preflight 那时只查文件存在，还照样打印「可以提交」。
 */
let modelGuard = 'no-throw';
try { modelGuard = modelWith(GHOST) === null ? 'no-throw' : '返回了非 null'; } catch { modelGuard = 'throw'; }
ok(modelGuard === 'no-throw',
  `modelWith 缺快照时必须返回 null 让闸门继续（实得 ${modelGuard}）—— 闸门要红得起来，不能崩在半路`);

// 结构性断言：门店无关的文件名再也不能被门店级消费点读走
const legacy = ['wake.mjs', 'eat.mjs', 'demo.mjs', 'check.mjs', 'check-share.mjs']
  .filter((f) => {
    try { return readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').includes("'query-meals.json'"); }
    catch { return false; }
  });
ok(!legacy.length, `没有代码从无 key 的 query-meals.json 读菜单${legacy.length ? ` → 仍在读：${legacy.join('、')}` : ''}`);

console.log('\n【点名层】凡门店级结论，每一轮都要说清是哪家店');
if (storeLine) {
  const mB = modelOr(FB.storeCode);
  const none = storeLine(null);
  ok(typeof none === 'string' && none.includes('未定'),
    `没有门店时也要出一行口径说明，不能沉默：「${none}」`);
  const l2 = storeLine(resolveStore({ state: bindStore(EMPTY, asStore(FB), { alias: '家' }), favorites }));
  ok(l2.includes('家') && !/还没跟你确认/.test(l2),
    `确认绑定过的店：点名即可，不再带注记 →「${l2}」`);
  const l3 = storeLine(resolveStore({ state: EMPTY, arg: FA.storeCode, favorites }));
  ok(l3.includes(FA.storeName) && /临时/.test(l3), `临时指定的店必须写明不改绑定 →「${l3}」`);

  if (mB) {
    const adopted2 = resolveStore({ state: snapshot(EMPTY, mB), favorites });
    const l1 = storeLine(adopted2);
    ok(l1.includes(FB.storeName) && /还没跟你确认|未确认/.test(l1),
      `按收藏自动采用的店：点名 + 标注没确认过 →「${l1}」`);
    // 脱面口径：发群卡刻意匿名，账单卡必须带真名
    ok(renderText(mB).includes(FB.storeName), '账单文本版印真店名（使用面不脱）');
    ok(!renderPropagate(buildModel({ ...commonOf(FB.storeCode), share: true })).includes(FB.storeName),
      '发群版仍不得出现真店名——点名是对话里那句，不是卡片上');
  } else {
    ok(false, gapMsg(FB.storeCode));
  }

  // 真跑一次「今天吃啥」——用户看到的那句里到底有没有门店，只有产物能证明
  let eatOut = '';
  try {
    eatOut = execFileSync(process.execPath, ['src/eat.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  } catch (e) { eatOut = String(e.stdout ?? '') + String(e.stderr ?? ''); }
  /*
    三轨版（D12=④ / T10 / T14）：店名、本轮这家店是怎么定的、样例来源，全部并进标题行；
    独立的 `门店：` 行取消 —— 5 行正文要给三条轨，多占一行就会把末行的时段与余量挤掉。
    所以这里查的是「标题里有没有店名」与「有没有多占一行」，不再是「有没有 门店： 那三个字」。
  */
  ok(eatOut.includes(FA.storeName ?? FA.storeCode),
    `eat.mjs 产物必须点名是哪家店（店名要出现在标题行里）${eatOut.split('\n')[0] ? ` →「${eatOut.split('\n')[0]}」` : ''}`);
  ok(!/^\s*门店：/m.test(eatOut), '三轨版不得再出现独立的「门店：」行 —— 那一行要还给三条轨');
  ok(/还没跟你确认|临时指定/.test(eatOut),
    '本轮是自动采用还是临时指定，必须在同一行说清（不能让用户以为绑过了）');
  if (!eatOut.includes(FA.storeName ?? '')) console.log('    实际输出：' + eatOut.split('\n').slice(0, 3).join(' / '));
} else {
  ok(false, 'storeLine 未实现');
}

console.log('\n【绑店入口】零输入绑店：从收藏里挑，别让用户打店名');
if (pickFavorite) {
  const byIndex = pickFavorite(favorites, '1');
  ok(byIndex?.matched && byIndex.store.code === FA.storeCode,
    `编号 1 → ${byIndex?.store?.code} ${byIndex?.store?.name ?? ''}`);
  ok(pickFavorite(favorites, FA.storeCode)?.store?.code === FA.storeCode, '按编码也能取到');
  ok(pickFavorite(favorites, '麦当劳')?.candidates?.length === favorites.length
    && pickFavorite(favorites, '麦当劳').matched === false,
    '多命中只给候选、不替用户挑（两家都叫"麦当劳"）');
  ok(pickFavorite(favorites, '不存在的地名').candidates.length === 0
    && !pickFavorite(favorites, '不存在的地名').store,
    '零命中不返回任何门店——不猜、不编');
  ok(!!pickFavorite(favorites, '龙胜')?.store?.address, '候选带地址，供"是这家吗"那句确认');
} else {
  ok(false, 'pickFavorite 未实现');
}

console.log('\n【口径路由表】SKILL.md 每个意图都要标口径，门店级与全国级不许混为一谈');
{
  const md = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  const seg = md.split('## 按意图选路')[1]?.split(/\n## /)[0] ?? '';
  const rows = seg.split('\n').filter((l) => l.trim().startsWith('|') && !/^\s*\|[-:\s|]+\|\s*$/.test(l));
  const dataRows = rows.slice(1); // 第 0 行是表头
  ok(dataRows.length >= 8, `路由表读到 ${dataRows.length} 行意图（异常偏少说明表结构变了）`);
  const noScope = dataRows.filter((r) => (r.split('|').length - 2) < 4).map((r) => r.split('|')[1]?.trim());
  ok(!noScope.length, `每行都有「口径」列${noScope.length ? ` → 缺列：${noScope.join('、')}` : ''}`);
  const badScope = dataRows.filter((r) => !/(门店级|账户级|全国)/.test(r)).map((r) => r.split('|')[1]?.trim());
  ok(!badScope.length, `口径取值必须是 门店级 / 账户级 / 全国${badScope.length ? ` → 非法：${badScope.join('、')}` : ''}`);
  const lies = dataRows.filter((r) => /campaign-calendar|mall-points-products/.test(r) && /门店级/.test(r));
  ok(!lies.length, `活动日历与积分商城不得被标成门店级（实测入参无 storeCode、响应无地域键）`);
}

console.log('\n【现算一遍】两家店各自的结论。菜单 traceId 若两家相同，就是在拿同一家店的价目表算两家');
const traces = [];
for (const s of favorites) {
  const m = modelOr(s.storeCode);
  if (!m) {
    ok(false, gapMsg(s.storeCode));
    continue;
  }
  let trace = null;
  try { trace = mealsOf(s.storeCode)?.traceId ?? null; } catch { /* 上面已记红 */ }
  traces.push([s.storeCode, trace]);
  const top = m.coupons.filter((c) => c.state === 'now')
    .reduce((a, c) => (!a || (c.realGain ?? -1) > (a.realGain ?? -1) ? c : a), null);
  console.log(`   ${s.storeCode} ${s.storeName}`);
  console.log(`     菜单 traceId=${String(trace).slice(0, 8)}`
    + ` · 放行 ${m.coupons.filter((c) => c.state === 'now').length} 张`
    + `${top ? ` · top1 ${top.displayTitle} 到手¥${top.ladderProduct?.sale} 省¥${top.realGain?.toFixed(1)}` : ''}`);
}
// 只在两家都取到 traceId 时才判——缺一家时上面已经红过了，不该再叠一条假红
if (traces.length === favorites.length && traces.every(([, t]) => t)) {
  ok(new Set(traces.map(([, t]) => t)).size === traces.length,
    `每家店的菜单 traceId 必须互不相同${traces.map(([c, t]) => ` ${c}=${String(t).slice(0, 8)}`).join('')}`);
} else {
  console.log('   · traceId 互异性本跳过（有门店缺快照，已在上面记红）');
}

console.log(fail ? `\n${fail} 项不通过` : '\n全部通过');
process.exit(fail ? 1 : 0);
