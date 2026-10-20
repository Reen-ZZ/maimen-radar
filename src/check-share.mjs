#!/usr/bin/env node
/**
 * 脱敏闸门：断言「分享版 / 传播版」到底脱了什么、留了什么。
 * 与 check.mjs 并列的完成判据 —— 跑不过就不许把卡片交给用户。
 *
 *   node src/check-share.mjs
 *
 * 分两层查，因为本项目两层各管不同的事：
 *   模型层 —— 券码/券id/accountId 这类可核销或可识别身份的字段，必须在模型里就没有
 *   渲染层 —— 门店真名与积分数值绝对值由渲染器决定不印，所以查的是产物字符串
 *
 * 口径（2026-10-20 决策）：
 *   敏感 = 券码、券 id、accountId、traceId、门店名、积分数值绝对值
 *   不敏感 = 券名（可核销的是 code，不是标题）、官方券面图（营销素材）
 *   分享版（账单）：券名仍收成品类名，防回归
 *   传播版（keepTitles）：券名保留真名，且必须拿得到图
 */
import { load, sourceDir } from './data.mjs';
import { buildModel } from './model.mjs';
import { renderText } from './render-text.mjs';
import { renderHTML } from './render-html.mjs';
import { renderPropagate } from './render-propagate.mjs';

const DIR = sourceDir();
if (!DIR) { console.error('✗ 没有 out/ 或 fixtures/'); process.exit(1); }

const couponsRaw = load('query-my-coupons.json');
const accountRaw = load('query-my-account.json');
const mealsRaw = load('query-meals.json');
const stores = load('query-nearby-stores.json')?.data ?? [];
const pick = stores[0];
const storeCouponsRaw = (() => { try { return load(`store-coupons.${pick.storeCode}.json`); } catch { return null; } })();
const common = { couponsRaw, accountRaw, mealsRaw, storeCouponsRaw,
  store: pick ? { code: pick.storeCode, name: pick.storeName } : null };

const share = buildModel({ ...common, share: true });
const prop = buildModel({ ...common, share: true, keepTitles: true });

/* 敏感值：全部从真实响应里取，不硬编码 */
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
for (const s of stores) if (s.storeName) neverInRender.push(['门店真名', String(s.storeName)]);
for (const k of ['accumulativePoint', 'expiredPoint', 'usedPoint', 'availablePoint']) {
  const v = String(accountRaw?.data?.[k] ?? '');
  if (v.length >= 4) neverInRender.push([`积分.${k}`, v]);
}

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };

console.log(`数据来源：${DIR}/`);

console.log('\n【模型层】可核销/可识别身份的字段必须在模型里就不存在');
for (const [label, model] of [['分享版', share], ['传播版', prop]]) {
  const hay = JSON.stringify(model);
  const leaks = [...new Set(neverInModel.filter(([, v]) => hay.includes(v)).map(([k]) => k))];
  ok(!leaks.length, `${label}：${leaks.length ? '泄漏 ' + leaks.join(' , ') : '券码 / accountId 一个都没有'}`);
}

console.log('\n【渲染层】产物字符串不得出现门店真名与积分数值绝对值');
for (const [name, fn, model] of [
  ['render-text', renderText, share],
  ['render-html', renderHTML, share],
  ['render-propagate', renderPropagate, prop],
]) {
  const out = fn(model);
  const leaks = [...new Set(neverInRender.filter(([, v]) => out.includes(v)).map(([k]) => k))];
  ok(!leaks.length, `${name} 产物：${leaks.length ? '泄漏 ' + leaks.join(' , ') : '干净（券码/券id/traceId/门店名/积分数值）'}`);
}

console.log('\n【券名口径】');
const rawByKey = new Map((couponsRaw?.data?.coupons ?? []).map((c) => [c.id ?? c.code ?? c.title, c]));
const isRealTitle = (c) => rawByKey.get(c.key)?.title === c.displayTitle;
ok(!share.coupons.some(isRealTitle), `分享版仍收成品类名（防回归）：${share.coupons.map((c) => c.displayTitle).join('、')}`);
ok(prop.coupons.every(isRealTitle), `传播版保留真券名：${prop.coupons.map((c) => c.displayTitle).join('、')}`);

console.log('\n【取图口径】脱敏不许把图一起砍掉——图是营销素材，券码才可核销');
const wantImg = (c, field) => {
  const r = rawByKey.get(c.key);
  const v = r?.[field];
  return typeof v === 'string' && /^https:\/\//.test(v) && !/example\.invalid/.test(v) ? v : null;
};
for (const [label, model] of [['分享版', share], ['传播版', prop]]) {
  const bad = model.coupons.filter((c) => (c.couponImage ?? null) !== wantImg(c, 'image'));
  ok(!bad.length, `${label} couponImage 与原始 image 一致${bad.length ? ' → ' + bad.map((c) => c.displayTitle).join('、') : ''}`);
}
const badBand = prop.coupons.filter((c) => (c.couponBand ?? null) !== wantImg(c, 'bigImage'));
ok(!badBand.length, `传播版 couponBand（官方横幅）同样不受脱敏影响${badBand.length ? ' → ' + badBand.map((c) => c.displayTitle).join('、') : ''}`);

console.log('\n【设计 token】官方随券下发的品牌色不随 share 清空');
const wantColors = (c) => [...new Set((rawByKey.get(c.key)?.tags ?? [])
  .map((t) => (typeof t?.color === 'string' ? t.color : '')).filter((x) => /^#[0-9A-Fa-f]{6}$/i.test(x))
  .map((x) => x.toUpperCase()))];
for (const [label, model] of [['分享版', share], ['传播版', prop]]) {
  const bad = model.coupons.filter((c) => JSON.stringify(c.tagColors ?? []) !== JSON.stringify(wantColors(c)));
  ok(!bad.length, `${label} tagColors 与原始 tags[].color 一致${bad.length ? ' → ' + bad.map((c) => c.displayTitle).join('、') : ''}`);
}

console.log(fail ? `\n${fail} 项不通过` : '\n全部通过');
process.exit(fail ? 1 : 0);
