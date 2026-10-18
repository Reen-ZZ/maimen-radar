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
import { buildModel } from './model.mjs';

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
for (const f of storeFiles) {
  const code = f.match(/store-coupons\.(.+)\.json$/)[1];
  const official = load(f).data ?? [];
  const meta = (stores.data ?? []).find((s) => String(s.storeCode) === code);

  const model = buildModel({ couponsRaw: own, accountRaw, mealsRaw: meals, sceneBeType: 1,
    store: meta ? { code, name: meta.storeName } : { code, name: '(未知门店)' } });

  const mine = new Set(model.coupons.filter((x) => x.state === 'now').map((x) => x.key));
  const theirs = new Set(official.map((x) => x.couponId));
  const onlyMine = [...mine].filter((k) => !theirs.has(k)).map((k) => model.coupons.find((x) => x.key === k).title);
  const onlyTheirs = [...theirs].filter((k) => !mine.has(k)).map((k) => own.data.coupons.find((x) => x.id === k)?.title ?? k);

  const ok = !onlyMine.length && !onlyTheirs.length;
  console.log(`${ok ? '✓' : '✗'} ${code} ${meta?.storeName ?? ''}  官方放行 ${theirs.size} 张 / 模型判 now ${mine.size} 张`);
  if (onlyMine.length) console.log(`    模型多判（官方滤掉了，我们说能用）: ${onlyMine.join(', ')}`);
  if (onlyTheirs.length) console.log(`    模型漏判（官方说能用，我们说不能）: ${onlyTheirs.join(', ')}`);
  if (!ok) fail++;
}

const p = accountRaw.data;
const sum = Number(p.usedPoint) + Number(p.expiredPoint) + Number(p.availablePoint);
const closed = Math.abs(sum - Number(p.accumulativePoint)) < 0.01;
console.log(`${closed ? '✓' : '✗'} 积分三向闭合  ${p.usedPoint} + ${p.expiredPoint} + ${p.availablePoint} = ${sum.toFixed(1)} vs accumulative ${p.accumulativePoint}`);
if (!closed) fail++;

console.log(fail ? `\n${fail} 项不通过` : '\n全部通过');
process.exit(fail ? 1 : 0);
