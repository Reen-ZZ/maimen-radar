#!/usr/bin/env node
/**
 * 唤醒四步的可执行入口（SKILL.md「每次唤醒的固定顺序」）。
 *
 *   node src/wake.mjs
 *
 *   1. 补算   读 state/maimen-radar.json + 拉数据源，diff 上次快照，先播 ≤3 行
 *   2. 判四态 buildModel 内 classify()
 *   3. 答题   渲染权益账单（账单即答案）
 *   4. 写回   snapshot 落盘，last_seen 用服务端时间
 *
 * 数据来源与 demo 相同：优先 out/（真实抓取），退回 fixtures/（脱敏样例）。
 * demo.mjs 是纯渲染演示，不碰 state；本文件才是带记忆的完整唤醒。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, sourceDir } from './data.mjs';
import { buildModel } from './model.mjs';
import { renderText } from './render-text.mjs';
import { load as loadState, save, snapshot, diff, wakeLines } from './state.mjs';
import { withCloser, banter } from './tone.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SRC = sourceDir();
if (!SRC) {
  console.error('✗ 没有可用数据。跑 node tools/probe-mcp.mjs query-my-coupons 取真实数据，'
    + '或 node tools/make-fixtures.mjs 从本地 out/ 生成脱敏样例。');
  process.exit(1);
}
const read = (f) => { try { return load(f); } catch { return null; } };

const couponsRaw = load('query-my-coupons.json');
const accountRaw = read('query-my-account.json') ?? { data: {} };
const mealsRaw = read('query-meals.json') ?? { data: {} };
const storesRaw = read('query-nearby-stores.json');

// ── 1+2+3. 补算 → 四态 → 答题 ──
const pick = storesRaw?.data?.[0] ?? null;
const storeCouponsRaw = pick ? read(`store-coupons.${pick.storeCode}.json`) : null;
const model = buildModel({
  couponsRaw,
  accountRaw,
  mealsRaw,
  storeCouponsRaw,
  store: pick ? { code: pick.storeCode, name: pick.storeName } : null,
});

// ── 4. 写回 state（diff 要先算，写回会覆盖 prev）──
const prev = loadState(ROOT);
const d = diff(prev, model);
save(ROOT, snapshot(prev, model));

// ── 播报 ≤3 行 + 正文 + 收尾语（俏皮话最多一处）──
const lines = wakeLines(d, model);
const quiet = !d.firstRun && !d.wasted.length && !d.pointsLost && !d.arrived.length && !d.revived.length;
if (quiet) lines.push(`　 ${banter('all_good')}`);

const kind = d.firstRun ? 'welcome'
  : (d.wasted.length || d.pointsLost > 0) ? 'lost'
  : model.coupons.some((c) => c.state === 'gift') ? 'rescue'
  : 'neutral';

console.log(lines.join('\n'));
console.log('');
console.log(withCloser(renderText(model), kind));
console.log('');
console.log(`state 已写回：${join('state', 'maimen-radar.json')}（last_seen = ${model.trace.serverDatetime || model.nowText}）`);
if (d.needStore) {
  console.log('冷启动引导：第①步（账户级盘点）已完成，停在第②步补门店——'
    + 'query-nearby-stores(searchType=1) 读收藏，无则 searchType=2 按城市+关键词，仍无则明示降级口径。');
} else {
  console.log('冷启动引导：已完成，常态唤醒（补算 → 四态 → 答题 → 写回）。');
}
