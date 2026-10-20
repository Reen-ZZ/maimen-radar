#!/usr/bin/env node
/**
 * 麦门雷达卡片入口 —— 三档，默认走中间那档
 *   node src/demo.mjs --share     → 分享版（默认交付的那张：抹掉门店身份，其余全真值，绝对时间可转发）
 *   node src/demo.mjs --propagate → 发群版（同一份脱敏 model，换版面：首屏一图一价一句腔）
 *   node src/demo.mjs             → 自用版（连门店名与地址一起印，只给自己核对）
 * 三档脱敏只差"门店身份"这一件事，其余区别发生在渲染器——见 src/check-share.mjs 的【模型不许分叉】。
 * 数据优先取 out/（本地真实抓取，不入库），退回 fixtures/（脱敏样例，入库）。
 * 产物写入 dist/（不入库）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, loadScoped, sourceDir } from './data.mjs';
import { buildModel } from './model.mjs';
import { resolveStore, storeLine } from './store.mjs';
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
const page = (title, body) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>麦门雷达 · ${title}</title>
</head><body style="margin:0;padding:32px 12px;background:hsl(220 12% 95%);font-family:sans-serif">${body}</body></html>`;

mkdirSync('dist', { recursive: true });
writeFileSync(join('dist', share ? 'demo.share.txt' : 'demo.txt'), text);
// 带门店地址的那一张不再是交付档：自用播报只落文本，HTML 一律过了脱敏才写。
// 少一个出口就少一种"截错图发进群"的可能——renderHTML 本身仍能吃非脱敏 model，但不给它这条路。
if (share) writeFileSync(join('dist', 'demo.share.html'), page('分享版', renderHTML(model)));

// --propagate：另出一张发群版。脱敏与分享版共用同一份 model（券名与积分都留真值），
// 区别只在版面；发进群这一张不由"有没有传 --share"决定，门店身份一定抹。
if (process.argv.includes('--propagate')) {
  const pm = share ? model : buildModel({ ...common, share: true });
  writeFileSync(join('dist', 'propagate.html'), page('发群版', renderPropagate(pm)));
}

console.log(text);
console.log('\n' + '─'.repeat(64));
console.log(`数据来源：${SRC === 'out' ? 'out/ 本地真实抓取' : 'fixtures/ 脱敏样例'}（${SRC === 'fixtures' ? '餐品与价格为真实公开目录，身份字段已替换' : '注意别把 out/ 提交'}）`);
console.log(share
  ? `已写出 dist/demo.share.txt（${text.length} 字符）与 dist/demo.share.html —— 只抹门店身份，券名与积分都是真值`
  : `已写出 dist/demo.txt（${text.length} 字符）—— 自用播报，含门店全名，不是卡片档`);
console.log(`${storeLine(store)} · 编码 ${store?.code ?? '—'}`
  + `${menuMissing ? ' · 缺这家店的菜单快照，卡片不含到手价与上新' : ''}`);
console.log(share
  ? '要发进群：node src/demo.mjs --propagate　（对话里回用户：要发群说「发群」）'
  : '要出可转发的卡片：node src/demo.mjs --share　（对话里回用户：说「生成卡片」）');
console.log(`模型统计：券 ${model.coupons.length} 张 · 菜单实体 ${model.meals.length} 项 · 状态分布 ${JSON.stringify(model.counts)}`);