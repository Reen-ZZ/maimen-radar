/**
 * 门店解析层 —— 「这一轮判的是哪家店」的唯一决定点。
 *
 * 为什么要有这个文件（2026-10-20 实测出的缺陷）：
 *   wake/eat/demo 各自取 `query-nearby-stores.json` 的 `data[0]`，谁都不读 state。
 *   于是「用户绑定的门店」和「实际拿来算价的门店」是两个从不相交的东西：
 *   账单抬头印哪家，取决于上次抓包时收藏列表里谁排第一。门店成了抓包顺序的副产物。
 *
 * 优先级（对齐 SKILL.md 冷启动第②步的「上次用过的那家优先；无历史则取收藏第一家」）：
 *   显式指定（code 或别名）> state 默认店 > state 里唯一一家 > 官方收藏第一家 > null
 *
 * 采用收藏店时返回值带 `source: 'favorites'`，调用方必须在回复里明示用的是哪家——
 * 静默选店比问一句更危险：结论全错而用户不知情。
 */

const normCode = (v) => {
  const code = String(v?.code ?? v?.storeCode ?? v ?? '').trim();
  if (!/^\d+$/.test(code)) throw new Error(`门店编码必须全部由数字组成，收到 "${code}"`);
  return code;
};

/** 收藏响应（storeCode/storeName/address）→ state 条目（code/name/address） */
const fromFavorite = (f) => ({ code: String(f.storeCode), name: f.storeName ?? null, address: f.address ?? null });

/**
 * @param state      `load(root)` 读出的 state
 * @param arg        用户/命令行显式指定的门店编码或别名
 * @param favorites  `query-nearby-stores(searchType=1)` 的 data 数组
 * @returns {{code:string,name:(string|null),alias:(string|null),source:('arg'|'state'|'favorites')}} 或 null
 */
export function resolveStore({ state, arg, favorites = [] } = {}) {
  const stores = state?.stores ?? [];
  if (arg !== undefined && arg !== null && arg !== '') {
    const key = String(arg).trim();
    const hit = stores.find((s) => s.alias && s.alias === key) ?? stores.find((s) => s.code === key);
    if (hit) return { ...hit, origin: hit.source ?? null, source: 'arg' };
    // 指定的店没绑过、也不在官方收藏里 → 不猜门店名，也不替它编一个 code
    const fav = favorites.find((f) => String(f.storeCode) === key);
    if (fav) return { ...fromFavorite(fav), alias: null, origin: 'favorites', source: 'arg' };
    return null;
  }
  const def = stores.find((s) => s.isDefault) ?? stores[0];
  // `source` 说的是「本轮怎么定下来的」，`origin` 说的是「这家店当初怎么进 state 的」。
  // 少了 origin，按收藏自动采用的店会在第二轮被说成「你绑定的」——可用户从没确认过。
  if (def) return { ...def, origin: def.source ?? null, source: 'state' };
  const fav = favorites[0];
  if (fav) return { ...fromFavorite(fav), alias: null, origin: 'favorites', source: 'favorites' };
  return null;
}

/**
 * 绑定/更新一家店。别名与城市来自用户口述，不从店名里正则反推——
 * 接口不返回 city（实测），反推出来的城市是猜测，猜错会让「哪个城市」这个问题以后再也问不准。
 */
export function bindStore(state, store, opts = {}) {
  const { alias, city, address, setDefault = true, source = 'user', lastUsed = null } = opts;
  const code = normCode(store);
  const prev = (state?.stores ?? []).find((s) => s.code === code);
  const others = (state?.stores ?? []).filter((s) => s.code !== code);
  const isDefault = setDefault || !others.some((s) => s.isDefault);
  // 用户确认过的绑定，不因「本轮只是按 state 取到它」就降级成 state——
  // 「确认过」是本产品唯一允许静默沿用一家店的凭据
  const src = prev?.source === 'user' && source === 'state' ? 'user' : source;
  const entry = {
    code,
    name: store?.name ?? store?.storeName ?? prev?.name ?? null,
    alias: alias ?? prev?.alias ?? null,
    city: city ?? prev?.city ?? null,
    address: address ?? store?.address ?? prev?.address ?? null,
    source: src,
    isDefault,
    lastUsed: lastUsed ?? prev?.lastUsed ?? null,
  };
  return {
    ...state,
    stores: [entry, ...(isDefault ? others.map((s) => ({ ...s, isDefault: false })) : others)],
  };
}

/** 换默认店：只切 isDefault，不丢历史记录（出差临时店不该把家挤掉） */
export function useStore(state, code) {
  const target = normCode(code);
  const stores = state?.stores ?? [];
  if (!stores.some((s) => s.code === target)) throw new Error(`门店 ${target} 没绑过，先绑再切`);
  return { ...state, stores: stores.map((s) => ({ ...s, isDefault: s.code === target })) };
}

/**
 * 这家店是否需要向用户明示来源。
 * 判据只有一条：**用户确认过没有**。按收藏自动采用的、本轮临时指定的，都得说；
 * 确认绑定过的不必每轮重复声明。少了这个判据，自动采用会在第二轮伪装成用户的选择。
 */
export function needsAnnounce(store) {
  return !!store && store.origin !== 'user';
}

/** 给回复用的一句门店声明。来源不同，话不同——采用收藏店必须说清是"按收藏判的" */
export function storeAnnounce(store) {
  if (!store) return '未绑店，以下按券包字段推断，未经门店过滤确认';
  const label = store.alias || store.name || store.code;
  if (store.source === 'arg') return `本轮按「${label}」判（临时指定，不改绑定）`;
  if (needsAnnounce(store)) return `按你收藏的「${label}」判的——这家还没跟你确认过，换店说一声`;
  return `按你绑定的「${label}」判的`;
}
