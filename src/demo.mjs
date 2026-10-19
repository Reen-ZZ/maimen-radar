#!/usr/bin/env node
/**
 * 麦门雷达 demo 入口
 *   node src/demo.mjs            → 实时版（倒计时）
 *   node src/demo.mjs --share    → 分享版（绝对时间，可转发）
 * 数据优先取 out/（本地真实抓取，不入库），退回 fixtures/（脱敏样例，入库）。
 * 产物写入 dist/（不入库）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { load, sourceDir } from './data.mjs';
import { buildModel } from './model.mjs';
import { renderText } from './render-text.mjs';
import { renderHTML } from './render-html.mjs';

const SRC = sourceDir();
if (!SRC) {
  console.error('✗ 没有可用数据。跑 node tools/probe-mcp.mjs query-my-coupons 取真实数据，'
    + '或 node tools/make-fixtures.mjs 从本地 out/ 生成脱敏样例。');
  process.exit(1);
}
const read = (f) => { try { return load(f); } catch { return null; } };

const couponsRaw = load('query-my-coupons.json');
const accountRaw = read('query-my-account.json');
const mealsRaw = read('query-meals.json');
const storesRaw = read('query-nearby-stores.json');

const share = process.argv.includes('--share');
// --store <code>：指定门店（默认取收藏列表第一家）
const storeArg = (() => {
  const i = process.argv.indexOf('--store');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const stores = storesRaw?.data ?? [];
const pick = storeArg ? stores.find((s) => String(s.storeCode) === String(storeArg)) : stores[0];
if (storeArg && !pick) {
  console.error(`✗ 没有门店 ${storeArg}。可用：${stores.map((s) => s.storeCode + ' ' + s.storeName).join(' / ')}`);
  process.exit(1);
}
// 券价叠加的数据源：指定/默认门店的官方可用券（无此文件则静默降级为不显示增益）
const storeCouponsRaw = pick ? read(`store-coupons.${pick.storeCode}.json`) : null;

const model = buildModel({
  couponsRaw,
  accountRaw: accountRaw ?? { data: {} },
  mealsRaw: mealsRaw ?? { data: {} },
  storeCouponsRaw,
  store: pick ? { code: pick.storeCode, name: pick.storeName } : null,
  share,
});

const text = renderText(model);
const html = renderHTML(model);
const suffix = share ? '.share' : '';

mkdirSync('dist', { recursive: true });
writeFileSync(join('dist', `demo${suffix}.txt`), text);
writeFileSync(join('dist', `demo${suffix}.html`), `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>麦门雷达 · ${share ? '分享版' : '权益账单'}</title>
</head><body style="margin:0;padding:32px 12px;background:hsl(220 12% 95%);font-family:sans-serif">${html}</body></html>`);

console.log(text);
console.log('\n' + '─'.repeat(64));
console.log(`数据来源：${SRC === 'out' ? 'out/ 本地真实抓取' : 'fixtures/ 脱敏样例'}（${SRC === 'fixtures' ? '餐品与价格为真实公开目录，身份字段已替换' : '注意别把 out/ 提交'}）`);
console.log(`已写出 dist/demo${suffix}.txt（${text.length} 字符）与 dist/demo${suffix}.html${share ? '　【分享版·已脱敏】' : ''}`);
console.log(`模型统计：券 ${model.coupons.length} 张 · 菜单实体 ${model.meals.length} 项 · 状态分布 ${JSON.stringify(model.counts)}`);
