#!/usr/bin/env node
/**
 * 麦门雷达 demo 入口
 *   node src/demo.mjs            → 实时版（倒计时）
 *   node src/demo.mjs --share    → 分享版（绝对时间，可转发）
 * 数据优先取 out/（本地真实抓取，不入库），退回 fixtures/（脱敏样例，入库）。
 * 产物写入 dist/（不入库）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, loadScoped, sourceDir } from './data.mjs';
import { buildModel } from './model.mjs';
import { resolveStore } from './store.mjs';
import { load as loadState } from './state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import { renderText } from './render-text.mjs';
import { renderHTML } from './render-html.mjs';
import { renderPropagate } from './render-propagate.mjs';

const SRC = sourceDir();
if (!SRC) {
  console.error('✗ 没有可用数据。跑 node tools/probe-mcp.mjs query-my-coupons 取真实数据，'
    + '或 node tools/make-fixtures.mjs 从本地 out/ 生成脱敏样例。');
  process.exit(1);
}
const read = (f) => { try { return load(f); } catch { return null; } };

const couponsRaw = load('query-my-coupons.json');
const accountRaw = read('query-my-account.json');
const favorites = read('query-nearby-stores.json')?.data ?? [];

const share = process.argv.includes('--share');
// --store <code|别名>：临时指定门店；不指定时按 state 绑定的默认店，没绑则按收藏第一家
const storeArg = (() => {
  const i = process.argv.indexOf('--store');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const store = resolveStore({ state: loadState(ROOT), arg: storeArg, favorites });
if (storeArg && !store) {
  console.error(`✗ 门店 ${storeArg} 既没绑过、也不在收藏里。可用：`
    + favorites.map((s) => `${s.storeCode} ${s.storeName}`).join(' / '));
  process.exit(1);
}
// 券价叠加的数据源：这家店的官方可用券（无此文件则静默降级为不显示增益）
const storeCouponsRaw = store ? read(`store-coupons.${store.code}.json`) : null;
// 菜单是门店级响应且不自报门店，只能按 code 键取；缺这家店的快照就不印增益——
// 拿别家店的价目表算这张券省多少，错的是钱
let mealsRaw = { data: {} };
let menuMissing = false;
if (store) {
  try { mealsRaw = loadScoped('meals', store.code); }
  catch (e) { menuMissing = true; console.error(`✗ ${e.message}`); }
}
const common = {
  couponsRaw,
  accountRaw: accountRaw ?? { data: {} },
  mealsRaw,
  storeCouponsRaw,
  store,
};

const model = buildModel({ ...common, share });

const text = renderText(model);
const html = renderHTML(model);
const suffix = share ? '.share' : '';

mkdirSync('dist', { recursive: true });
writeFileSync(join('dist', `demo${suffix}.txt`), text);
writeFileSync(join('dist', `demo${suffix}.html`), `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>麦门雷达 · ${share ? '分享版' : '权益账单'}</title>
</head><body style="margin:0;padding:32px 12px;background:hsl(220 12% 95%);font-family:sans-serif">${html}</body></html>`);

// --propagate：另出一张发群用的传播版。口径与账单分享版不同——券名保留真名，
// 只脱门店名与积分数值（图与券名不敏感，可核销的券码本来就不上卡片）
if (process.argv.includes('--propagate')) {
  const pm = buildModel({ ...common, share: true, keepTitles: true });
  const ph = renderPropagate(pm);
  writeFileSync(join('dist', 'propagate.html'), `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>麦门雷达 · 传播版</title>
</head><body style="margin:0;padding:32px 12px;background:hsl(220 12% 95%);font-family:sans-serif">${ph}</body></html>`);
}

console.log(text);
console.log('\n' + '─'.repeat(64));
console.log(`数据来源：${SRC === 'out' ? 'out/ 本地真实抓取' : 'fixtures/ 脱敏样例'}（${SRC === 'fixtures' ? '餐品与价格为真实公开目录，身份字段已替换' : '注意别把 out/ 提交'}）`);
console.log(`已写出 dist/demo${suffix}.txt（${text.length} 字符）与 dist/demo${suffix}.html${share ? '　【分享版·已脱敏】' : ''}`);
console.log(`判店：${store ? `${store.code} ${store.name ?? ''}（来源 ${store.source}）` : '未定 —— 卡片不印任何门店结论'}`
  + `${menuMissing ? ' · 缺这家店的菜单快照，卡片不含到手价与上新' : ''}`);
console.log(`模型统计：券 ${model.coupons.length} 张 · 菜单实体 ${model.meals.length} 项 · 状态分布 ${JSON.stringify(model.counts)}`);