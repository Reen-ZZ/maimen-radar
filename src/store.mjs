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
 * 从收藏里取一家店，供「回个数字就绑好」用。
 * 命中顺序：编码精确 > 编号（1 起） > 店名/地址关键词。
 * 多命中只给候选、零命中返回空——**不猜、不编门店**（SKILL.md 绑店第 3 步的硬规则）。
 */
export function pickFavorite(favorites, key) {
  const k = String(key ?? '').trim();
  const wrap = (hits) => ({
    matched: hits.length === 1,
    store: hits.length === 1 ? fromFavorite(hits[0]) : null,
    candidates: hits.map(fromFavorite),
  });
  const byCode = favorites.filter((f) => String(f.storeCode) === k);
  if (byCode.length) return wrap(byCode);
  if (/^[1-9]\d*$/.test(k)) {
    const f = favorites[Number(k) - 1];
    if (f) return wrap([f]);
  }
  return wrap(favorites.filter((f) => `${f.storeName ?? ''}${f.address ?? ''}`.includes(k)));
}

/**
 * 门店级结论的口径行。每轮都要有，不许沉默——
 * 结论对不对取决于店，用户不知道是哪家就没法判断。（2026-10-20 定的硬规则）
 *
 * `source`（本轮怎么定的）与 `origin`（当初怎么进 state 的）决定后缀：
 * 自动采用的不能伪装成用户确认过，临时指定的要说清不改绑定。
 */
export function storeLine(store) {
  if (!store) return '门店：未定 —— 以下结论不带任何门店口径，别当成本地某家店';
  const label = store.alias ? `${store.alias}（${store.name ?? store.code}）` : (store.name ?? store.code);
  const note = store.source === 'arg' ? '本轮临时指定，不改绑定'
    : store.origin !== 'user' ? '按收藏采用，还没跟你确认过' : '';
  return `门店：${label}${note ? `，${note}` : ''}`;
}
