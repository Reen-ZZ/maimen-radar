#!/usr/bin/env node
/**
 * 脱敏闸门：断言「分享版 / 发群版」到底脱了什么、留了什么。
 * 与 check.mjs 并列的完成判据 —— 跑不过就不许把卡片交给用户。
 *
 *   node src/check-share.mjs
 *
 * 分两层查，因为本项目两层各管不同的事：
 *   模型层 —— 券码/券id/accountId/traceId 这类可核销或可追踪身份的字段，必须在模型里就没有
 *   渲染层 —— 门店身份由渲染器决定不印，所以查的是产物字符串
 *
 * 口径（2026-10-20 二次修订）：脱敏只剩两条硬线，其余差异归版面。
 *   硬线一 = 券码 / 券 id / accountId / traceId（能核销、能追踪，上卡片就是事故）
 *   硬线二 = 门店身份。店名本身就是地址（实测「麦当劳深圳龙胜地铁站D出口餐厅」嵌着城市+地铁站+出口编号），
 *            所以"只脱地址、留着店名"在数据上做不到——脱就得整块脱，且店名里任何一段可定位的字串都不许漏。
 *   不再脱 = 积分数值绝对值、券名。积分数值不定位人，而"还差多少分"恰恰只有数字能答；
 *            券名原本脱成品类是怕暴露消费内容，但它比积分更不定位人，而收成品类名之后用户根本不知道那是哪张券。
 *   分享版与发群版因此**共用同一个 model**，分叉只许发生在渲染器：分享版信息密度优先，
 *            发群版首屏一图一价一句腔。谁再往模型里加一个脱敏开关，这里的相等断言第一个红。
 */
import { load, loadScoped, sourceDir } from './data.mjs';
import { resolveStore } from './store.mjs';
import { buildModel } from './model.mjs';
import { renderText } from './render-text.mjs';
import { renderHTML } from './render-html.mjs';
import { renderPropagate } from './render-propagate.mjs';

const DIR = sourceDir();
if (!DIR) { console.error('✗ 没有 out/ 或 fixtures/'); process.exit(1); }

const couponsRaw = load('query-my-coupons.json');
const accountRaw = load('query-my-account.json');
const favorites = load('query-nearby-stores.json')?.data ?? [];
// 闸门固定按收藏第一家判，不读本机 state —— 结果必须可重复，不能随用户绑了哪家而变
const store = resolveStore({ favorites });
// 菜单与门店必须同源：闸门自己也不能拿 A 店的菜单去判 B 店的卡
const mealsRaw = loadScoped('meals', store.code);
const storeCouponsRaw = (() => { try { return load(`store-coupons.${store.code}.json`); } catch { return null; } })();
const common = { couponsRaw, accountRaw, mealsRaw, storeCouponsRaw, store };

const share = buildModel({ ...common, share: true });
const prop = buildModel({ ...common, share: true });

/* 敏感值：全部从真实响应里取，不硬编码 */
/**
 * 门店名里的可定位片段。
 * 店名 = 品牌 + 地名 + 后缀，地名那一段单独就能定位到人（「龙胜地铁站D出口」）。
 * 整块比对太松（渲染器只要截掉「麦当劳」前缀就"看着没有店名"），所以按 4 字滑窗逐个查。
 */
function geoFragments(name) {
  const middle = name.replace(/^麦当劳|^金拱门/, '').replace(/(餐厅|店|门市)$/u, '').trim();
  if (!middle) return [];
  if (middle.length < 4) return [middle];
  const out = [];
  for (let i = 0; i + 4 <= middle.length; i++) out.push(middle.slice(i, i + 4));
  return out;
}

const neverInModel = [];
const neverInRender = [];
for (const c of couponsRaw?.data?.coupons ?? []) {
  if (c.code) neverInModel.push(['券码', String(c.code)]);   // 可核销，模型里就不该有
  if (c.id) neverInRender.push(['券id', String(c.id)]);      // 哈希键，模型留作跨轮 diff（model.mjs:273），但不许上卡片
}
if (accountRaw?.data?.accountId) neverInModel.push(['accountId', String(accountRaw.data.accountId)]);
neverInRender.push(...neverInModel);
for (const [f, v] of [['query-my-coupons', couponsRaw], ['query-my-account', accountRaw], ['query-meals', mealsRaw]]) {
  if (v?.traceId) neverInRender.push([`traceId.${f}`, String(v.traceId)]);
}
for (const s of favorites) if (s.storeName) neverInRender.push(...geoFragments(String(s.storeName)).map((g) => ['门店定位片段', g]));

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };

console.log(`数据来源：${DIR}/`);

console.log('\n【模型层】可核销/可识别身份的字段必须在模型里就不存在');
for (const [label, model] of [['分享版', share], ['发群版', prop]]) {
  const hay = JSON.stringify(model);
  const leaks = [...new Set(neverInModel.filter(([, v]) => hay.includes(v)).map(([k]) => k))];
  ok(!leaks.length, `${label}：${leaks.length ? '泄漏 ' + leaks.join(' , ') : '券码 / accountId 一个都没有'}`);
}

console.log('\n【渲染层】产物字符串不得出现券码/券id/traceId/accountId，也不得出现门店定位片段');
for (const [name, fn, model] of [
  ['render-text', renderText, share],
  ['render-html', renderHTML, share],
  ['render-propagate', renderPropagate, prop],
]) {
  const out = fn(model);
  const leaks = [...new Set(neverInRender.filter(([, v]) => out.includes(v)).map(([k]) => k))];
  ok(!leaks.length, `${name} 产物：${leaks.length ? '泄漏 ' + leaks.join(' , ') : '干净（可核销字段 + 门店身份全无）'}`);
}

console.log('\n【模型不许分叉】分享版与发群版共用同一份脱敏结果，差异只许发生在渲染器');
ok(JSON.stringify(share) === JSON.stringify(prop),
  '两版 model 逐字节相同 —— 谁再往 buildModel 里塞一个脱敏开关，这里第一个红');

console.log('\n【券名口径】券名不可核销（要的是 code 不是标题），两版一律真名');
const rawByKey = new Map((couponsRaw?.data?.coupons ?? []).map((c) => [c.id ?? c.code ?? c.title, c]));
const isRealTitle = (c) => rawByKey.get(c.key)?.title === c.displayTitle;
ok(share.coupons.length > 0, `有券可对：${share.coupons.length} 张`);
ok(share.coupons.every(isRealTitle), `分享版保留真券名：${share.coupons.map((c) => c.displayTitle).join('、')}`);

console.log('\n【积分口径】积分数值不定位人，两版都必须印出绝对值（没有数字就答不了"还差多少分"）');
const pts = share.points;
ok(Number(accountRaw?.data?.accumulativePoint) === pts.accumulated,
  `累计积分与原始字段一致：${accountRaw?.data?.accumulativePoint} → ${pts.accumulated}`);
ok(pts.accumulated > 0, `卡上有真实累计积分可对，断言不空转：${pts.accumulated} ${pts.currency}`);
for (const [name, fn, model] of [
  ['render-text', renderText, share],
  ['render-html', renderHTML, share],
  ['render-propagate', renderPropagate, prop],
]) {
  const out = fn(model);
  const miss = ['accumulated', 'available'].filter((k) => !out.includes(String(model.points[k])));
  ok(!miss.length, `${name} 印出了累计与在手积分${miss.length ? ' → 缺 ' + miss.join('、') : ''}`);
}

console.log('\n【取图口径】脱敏不许把图一起砍掉——图是营销素材，券码才可核销');
const wantImg = (c, field) => {
  const r = rawByKey.get(c.key);
  const v = r?.[field];
  return typeof v === 'string' && /^https:\/\//.test(v) && !/example\.invalid/.test(v) ? v : null;
};
for (const [label, model] of [['分享版', share], ['发群版', prop]]) {
  const bad = model.coupons.filter((c) => (c.couponImage ?? null) !== wantImg(c, 'image'));
  ok(!bad.length, `${label} couponImage 与原始 image 一致${bad.length ? ' → ' + bad.map((c) => c.displayTitle).join('、') : ''}`);
}
const badBand = prop.coupons.filter((c) => (c.couponBand ?? null) !== wantImg(c, 'bigImage'));
ok(!badBand.length, `发群版 couponBand（官方横幅）同样不受脱敏影响${badBand.length ? ' → ' + badBand.map((c) => c.displayTitle).join('、') : ''}`);

console.log('\n【设计 token】官方随券下发的品牌色不随 share 清空');
const wantColors = (c) => [...new Set((rawByKey.get(c.key)?.tags ?? [])
  .map((t) => (typeof t?.color === 'string' ? t.color : '')).filter((x) => /^#[0-9A-Fa-f]{6}$/i.test(x))
  .map((x) => x.toUpperCase()))];
for (const [label, model] of [['分享版', share], ['发群版', prop]]) {
  const bad = model.coupons.filter((c) => JSON.stringify(c.tagColors ?? []) !== JSON.stringify(wantColors(c)));
  ok(!bad.length, `${label} tagColors 与原始 tags[].color 一致${bad.length ? ' → ' + bad.map((c) => c.displayTitle).join('、') : ''}`);
}

console.log(fail ? `\n${fail} 项不通过` : '\n全部通过');
process.exit(fail ? 1 : 0);
