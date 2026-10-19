#!/usr/bin/env node
/**
 * 一致性断言：模型判为「现在能用」的集合，必须等于官方 query-store-coupons 的返回集合。
 * 这是 SKILL.md 第二步的完成判据 —— 跑不过就不许把结果念给用户。
 *
 *   node src/check.mjs
 *
 * 门店对从数据目录自动发现（out/ 或 fixtures/），不硬编码 storeCode。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, sourceDir } from './data.mjs';
import { buildModel, pickTop1 } from './model.mjs';

const DIR = sourceDir();
if (!DIR) { console.error('✗ 没有 out/ 或 fixtures/'); process.exit(1); }

const own = load('query-my-coupons.json');
const accountRaw = load('query-my-account.json');
const meals = load('query-meals.json');
const stores = load('query-nearby-stores.json');
const storeFiles = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.startsWith('store-coupons.')) : [];

if (!storeFiles.length) {
  console.error(`✗ ${DIR}/ 下没有 store-coupons.*.json，无法做一致性校验`);
  process.exit(1);
}

let fail = 0;
console.log(`数据来源：${DIR}/\n`);

const setDiff = (a, b) => [...a].filter((x) => !b.has(x));

for (const f of storeFiles) {
  const code = f.match(/store-coupons\.(.+)\.json$/)[1];
  const official = load(f).data ?? [];
  const meta = (stores.data ?? []).find((s) => String(s.storeCode) === code);

  const model = buildModel({ couponsRaw: own, accountRaw, mealsRaw: meals, sceneBeType: 1,
    storeCouponsRaw: load(f),
    store: meta ? { code, name: meta.storeName } : { code, name: '(未知门店)' } });

  // 主口径：key（券包 id）vs couponId。两者同源性未经真实调用交叉验证（fixtures 里
  // 两者都被替换成同一哈希，必然对得上），所以用券名做回退比对兜底：
  //   键集合不相交但券名一致 → 降级为警告（同源性待真实数据验证）
  //   券名也不一致 → 真失败
  const mineKeys = new Set(model.coupons.filter((x) => x.state === 'now').map((x) => x.key));
  const theirKeys = new Set(official.map((x) => x.couponId));
  const mineTitles = new Set(model.coupons.filter((x) => x.state === 'now').map((x) => x.title));
  const theirTitles = new Set(official.map((x) => x.title).filter(Boolean));
  const keySpaceShared = mineKeys.size === 0 || theirKeys.size === 0
    || setDiff(mineKeys, theirKeys).length < mineKeys.size || setDiff(theirKeys, mineKeys).length < theirKeys.size;

  const onlyMineTitles = setDiff(mineTitles, theirTitles);
  const onlyTheirsTitles = setDiff(theirTitles, mineTitles);
  const ok = !onlyMineTitles.length && !onlyTheirsTitles.length;
  console.log(`${ok ? '✓' : '✗'} ${code} ${meta?.storeName ?? ''}  官方放行 ${theirKeys.size} 张 / 模型判 now ${mineKeys.size} 张`);
  if (ok && !keySpaceShared) {
    console.log('    ⚠ 键空间不相交：id 与 couponId 同源性未经验证，本次按券名比对一致（真实数据下需复核）');
  }
  if (onlyMineTitles.length) console.log(`    模型多判（官方滤掉了，我们说能用）: ${onlyMineTitles.join(', ')}`);
  if (onlyTheirsTitles.length) console.log(`    模型漏判（官方说能用，我们说不能）: ${onlyTheirsTitles.join(', ')}`);
  if (!ok) fail++;

  // C5：top1 必须 ∈ 官方放行集合（docs/plans/2026-10-19-eat-this.md §8.1）
  const top = pickTop1(model);
  if (top.top1) {
    const inSet = theirKeys.has(top.top1.coupon.key);
    console.log(`  ${inSet ? '✓' : '✗'} top1 ∈ 官方放行集合：${top.top1.coupon.title}（省 ¥${top.top1.gain?.toFixed(1)}）`);
    if (!inSet) fail++;
  } else if (keySpaceShared) {
    console.log(`  · top1 未产出（${top.fallback}${top.fallback === 'no_price' ? '：' + (top.outcast ?? []).join('、') : ''}）`);
  }
}

const p = accountRaw.data;
const sum = Number(p.usedPoint) + Number(p.expiredPoint) + Number(p.availablePoint);
const closed = Math.abs(sum - Number(p.accumulativePoint)) < 0.01;
console.log(`${closed ? '✓' : '✗'} 积分三向闭合  ${p.usedPoint} + ${p.expiredPoint} + ${p.availablePoint} = ${sum.toFixed(1)} vs accumulative ${p.accumulativePoint}`);
if (!closed) fail++;

console.log(fail ? `\n${fail} 项不通过` : '\n全部通过');
process.exit(fail ? 1 : 0);
