#!/usr/bin/env node
/**
 * 零输入绑店入口 —— 用户不打店名，只回一个编号。
 *
 *   node src/bind.mjs                # 列出收藏候选（编号 / 店名 / 地址 / 今天几点能刷）
 *   node src/bind.mjs 1              # 绑定第 1 家
 *   node src/bind.mjs 1 --alias 家   # 顺带起个别名，以后说「家」就行
 *   node src/bind.mjs 龙胜            # 关键词命中；多命中只列候选，不替用户挑
 *   node src/bind.mjs --show         # 只看当前绑了哪家
 *
 * 为什么要有这个文件：SKILL.md 的绑店六步里，"落盘"这一步此前只有一句散文、没有代码落点，
 * 结果 `state.stores` 恒空、催绑永远走不完（2026-10-20 缺陷）。写操作一律走 bindStore，
 * 用户敲下这条命令就是确认，所以这里记 `source: 'user'`。
 *
 * 关键词多命中/零命中的处理在 pickFavorite 里（不猜、不编门店），本文件只负责印和落盘。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, sourceDir } from './data.mjs';
import { pickFavorite, bindStore, storeLine, resolveStore } from './store.mjs';
import { load as loadState, save } from './state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!sourceDir()) {
  console.error('✗ 没有可用数据。先拉收藏：node tools/probe-mcp.mjs query-nearby-stores --args \'{"searchType":1,"beType":1}\'');
  process.exit(1);
}
const favorites = load('query-nearby-stores.json')?.data ?? [];
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const key = argv.find((a) => !a.startsWith('--'));

if (argv.includes('--show') && !key) {
  const cur = resolveStore({ state: loadState(ROOT), favorites });
  console.log(storeLine(cur) + `${cur ? ` · 编码 ${cur.code}` : ''}`);
  process.exit(0);
}

/** 今日可刷时段——绑定时顺手交付，省得用户再问一次"这家几点开门" */
const todayWindow = (f) => (f?.reservationTimeOptions ?? [])
  .find((x) => x.today)?.reservationOptionText ?? '（未提供）';

if (!key) {
  if (!favorites.length) {
    console.log('收藏里没有门店。给我一个「城市 + 地标」，我查完念给你确认：');
    console.log('  node tools/probe-mcp.mjs query-nearby-stores --args \'{"searchType":2,"city":"深圳","keyword":"龙胜","beType":1}\'');
    process.exit(0);
  }
  console.log(`📍 你收藏了 ${favorites.length} 家，回个编号就绑好（不用打店名）：\n`);
  favorites.forEach((f, i) => {
    console.log(`  ${i + 1}. ${f.storeName}`);
    console.log(`     地址：${f.address ?? '—'} · 编码 ${f.storeCode}`);
    console.log(`     今天能刷：${todayWindow(f)}`);
  });
  const cur = resolveStore({ state: loadState(ROOT), favorites });
  console.log(`\n${storeLine(cur)}${cur ? ` · 编码 ${cur.code}` : ''}`);
  console.log('绑哪一家说编号就行，想不起编号就给「城市 + 地标」。');
  process.exit(0);
}

const hit = pickFavorite(favorites, key);
if (!hit.matched) {
  if (!hit.candidates.length) {
    console.log(`收藏里没有匹配「${key}」的门店。给个「城市 + 地标」我按位置查：`
      + `node tools/probe-mcp.mjs query-nearby-stores --args '{"searchType":2,"city":"<城市>","keyword":"${key}","beType":1}'`);
    process.exit(1);
  }
  console.log(`「${key}」命中 ${hit.candidates.length} 家，不替你挑：\n`);
  hit.candidates.forEach((c) => console.log(`  ${c.code} ${c.name} —— ${c.address ?? '—'}`));
  console.log('\n回编码或收藏编号都行。');
  process.exit(1);
}

const state = bindStore(loadState(ROOT), hit.store, { alias: opt('alias'), city: opt('city') });
save(ROOT, state);
console.log(`✓ 绑好了：${hit.store.name}（编码 ${hit.store.code}）`);
console.log('  以后每次开口都按这家算，落盘于 ' + join('state', 'maimen-radar.json'));
console.log(`  今天能刷：${todayWindow(favorites.find((f) => String(f.storeCode) === hit.store.code))}`);
console.log(`  ${opt('alias') ? `别名「${opt('alias')}」，以后说 --store ${opt('alias')} 或「${opt('alias')}」就行` : '想起名就说 --alias 家'}`);
