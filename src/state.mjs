/**
 * 惰性重放的状态层 —— 全产品的记忆所在。
 *
 * 没有定时任务：每次被唤醒时读上次快照、拉一次只读接口、补算这段时间发生了什么。
 * 效果等同"它一直在盯着"，但一次自动化调用都不做。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { bindStore } from './store.mjs';

const SCHEMA = 1;
const EMPTY = { schema: SCHEMA, last_seen: null, stores: [], sceneBeType: 1, coupons: {}, points: {}, saved: { entries: 0, total: 0 }, menu: {} };

export function statePath(root) {
  return join(root, 'state', 'maimen-radar.json');
}

export function load(root) {
  const p = statePath(root);
  if (!existsSync(p)) return { ...EMPTY };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (raw?.schema !== SCHEMA) return { ...EMPTY };
    return { ...EMPTY, ...raw };
  } catch {
    return { ...EMPTY };
  }
}

export function save(root, s) {
  const p = statePath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ...s, schema: SCHEMA }, null, 2), 'utf8');
  return p;
}

/**
 * 把本轮所判门店折进 state —— SKILL.md 冷启动第②步「写进 state 并起别名」的代码落点。
 * 没有这一步，`stores` 永远为空、`needStore` 永远为真，催绑话术每轮都占一行且永远闭不了嘴。
 *
 * 只有 state 里还没有店时才占默认位：临时指定或收藏里换了一家，都只登记不抢位——
 * 静默换店的后果是结论全错而用户不知情，这个代价比多问一句大。
 */
function foldStore(prev, model) {
  const stores = prev?.stores ?? [];
  if (!model?.store?.code) return stores;
  return bindStore(prev, model.store, {
    setDefault: stores.length === 0,
    source: model.store.source ?? 'adopted',
    lastUsed: model.trace?.serverDatetime || model.nowText || null,
  }).stores;
}

/** 把当前 model 折成下一轮的快照 */
export function snapshot(prev, model) {
  const coupons = {};
  for (const c of model.coupons) coupons[c.key] = { title: c.title, state: c.state, endAt: c.endText };
  const menu = {};
  for (const m of model.meals) menu[m.name] = m.tiers.list ?? 0;
  return {
    ...prev,
    last_seen: model.trace.serverDatetime || model.nowText,
    sceneBeType: model.sceneBeType,
    stores: foldStore(prev, model),
    coupons,
    menu,
    points: {
      available: model.points.available,
      accumulated: model.points.accumulated,
      used: model.points.used,
      expired: model.points.expired,
    },
  };
}

const mins = (s) => {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
};
const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));

/**
 * 上次快照 vs 本次实况，算出"这段时间发生了什么"。
 * 播报只消费这里的结论，不自己解析原始响应。
 */
export function diff(prev, model) {
  // needStore：没有门店就没有「此刻这家店真能用哪张」——它是"今天吃啥/划算吗"的前置条件。
  // 冷启动引导第②步靠它驱动，不靠对话里临时猜。
  const needStore = !(prev?.stores ?? []).length;
  if (!prev?.last_seen || !Object.keys(prev.coupons ?? {}).length) {
    return { firstRun: true, needStore, daysSince: null, wasted: [], arrived: [], revived: [], newlyLocked: [], pointsLost: 0 };
  }

  const t0 = mins(prev.last_seen);
  const t1 = mins(model.trace.serverDatetime || model.nowText);
  const daysSince = t0 !== null && t1 !== null ? Math.max(0, (t1 - t0) / 8.64e7) : null;

  const cur = new Map(model.coupons.map((c) => [c.key, c]));
  const wasted = [];
  const newlyLocked = [];
  const revived = [];

  for (const [key, was] of Object.entries(prev.coupons)) {
    const now = cur.get(key);
    if (!now) { wasted.push(was.title); continue; }
    if (was.state !== 'now' && now.state === 'now') revived.push(now.displayTitle);
    if (was.state === 'now' && now.state === 'locked') newlyLocked.push(now.displayTitle);
  }
  const arrived = Object.keys(Object.fromEntries(cur)).length
    ? [...cur.values()].filter((c) => !prev.coupons[c.key]).map((c) => c.displayTitle)
    : [];

  const pointsLost = Math.max(0, num(model.points.expired) - num(prev.points?.expired));

  return { firstRun: false, needStore, daysSince, wasted, arrived, revived, newlyLocked, pointsLost };
}

/** 冷启动引导第②步。有收藏门店时模型会静默采用并在回复里明示，这里只给一句告知，绝不追问。 */
const STORE_HINT = '→ 下一句起按你的收藏门店判定（会告诉你是哪家），换店随时说一声';

/** 三行抬头。超过三行就是刷屏，播报越克制用户越信它。 */
export function wakeLines(d, model) {
  if (d.firstRun) {
    return [`📡 麦门雷达 · 第一次见面，先把你的券和积分扫了一遍`,
      `   ${model.coupons.length} 张券 · ${model.points.available} ${model.points.currency}`,
      // 缺门店时不说"以后都替你想好"，直接把下一步摆出来
      d.needStore ? STORE_HINT : `   以后每次开口，我都会先替你想好这些。`];
  }
  const L = [];
  const gap = d.daysSince == null ? '' : d.daysSince < 1 ? '不到 1 天' : `${d.daysSince.toFixed(1)} 天`;
  L.push(`📡 麦门雷达 · 距上次${gap ? ` ${gap}` : '上次'}`);
  if (d.needStore) L.push(STORE_HINT);

  const bad = [];
  if (d.wasted.length) bad.push(`${d.wasted.length} 张券已经不在了`);
  if (d.pointsLost > 0) bad.push(`${d.pointsLost} 积分过期`);
  if (bad.length) L.push(`⚠ ${bad.join('、')}`);

  const good = [];
  if (d.arrived.length) good.push(`新到 ${d.arrived.length} 张`);
  if (d.revived.length) good.push(`${d.revived.length} 张现在能用了`);
  if (good.length) L.push(`✅ ${good.join('、')}`);

  const now = model.coupons.filter((c) => c.state === 'now').length;
  if (!bad.length && !good.length) L.push(`　 没什么变化，${now} 张券照常待命`);
  else if (now) L.push(`→ 此刻能用 ${now} 张`);

  return L.slice(0, 3);
}
