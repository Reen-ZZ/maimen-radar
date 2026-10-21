/**
 * 麦门雷达 · 数据模型
 * 唯一的事实来源。文本渲染器和 HTML 渲染器都只吃这个结构，不许各自加工数据。
 */

const BLOCKS = { full: '█', tail: '▓', empty: '░' };
const TRACK = 32;

/** 官方 weekdays 映射：1=周日，2=周一 … 7=周六（即 JS getDay()+1）。
 *  2026-10-19 周一实测判别：券 weekdays=[2,3,4,5,6]，官方周一放行，且券面写"周一、二、三、四、五"。
 *  （2026-10-18 周日推断的"1=周一…7=周日"在周日与真映射同判，属欠定，已被推翻。） */
function isoWeekday(d) {
  return d.getDay() + 1;
}

/** 门店侧时间窗：store-coupons 的 tradeDateTime（"2026-10-19 10:30:00-2026-10-23 23:59:59"）
 *  是"这家店今天几点起能刷"的权威口径，冲突时优先于券包 tradeTimePeriods。 */
function parseStoreWindow(s, now) {
  const m = String(s ?? '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})-(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
  if (!m) return null;
  const start = parseServerTime(`${m[1]} ${m[2]}`);
  const end = parseServerTime(`${m[3]} ${m[4]}`);
  if (!start || !end) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
  if (today < startDay || today > endDay) return { outOfRange: true, start, end };
  const from = startDay === today ? start.getHours() * 60 + start.getMinutes() : 0;
  const to = endDay === today ? Math.max(from, end.getHours() * 60 + end.getMinutes()) : 1440;
  return { outOfRange: false, from, to, start, end };
}

function parseServerTime(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function hhmm(mins) {
  const h = Math.floor(mins / 60);
  const mm = mins % 60;
  return `${String(h).padStart(2, '0')}:${mm ? String(mm).padStart(2, '0') : '00'}`;
}

function maskCode(code) {
  const s = String(code ?? '');
  if (s.length <= 8) return s ? '•'.repeat(s.length) : '';
  return `${s.slice(0, 3)}${'•'.repeat(s.length - 7)}${s.slice(-4)}`;
}

/** 把券的时段窗换算成今天的可用分钟区间。跨午夜段（endTime ≤ startTime）拆成两段。 */
function windowsToday(coupon, now) {
  const periods = Array.isArray(coupon.tradeTimePeriods) ? coupon.tradeTimePeriods : [];
  const toMin = (t) => {
    const m = String(t).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    return m ? +m[1] * 60 + +m[2] : null;
  };
  let wins = periods.map((p) => ({ from: toMin(p.startTime), to: toMin(p.endTime) }))
    .filter((w) => w.from !== null && w.to !== null);
  if (!wins.length || Number(coupon.isAllTradeTime) === 1) wins = [{ from: 0, to: 1440 }];
  const fixed = [];
  for (const w of wins) {
    if (w.to > w.from) { fixed.push(w); continue; }
    // 跨午夜：22:00-02:00 → [22:00,24:00) + [00:00,02:00)
    if (w.to > 0) fixed.push({ from: 0, to: w.to });
    if (w.from < 1440) fixed.push({ from: w.from, to: 1440 });
  }
  return fixed;
}

/** 把 [2,3,4,5,6] 压成「周二~周六」 */
function weekdayRange(weekdays) {
  const NAME = ['', '周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const sorted = [...new Set(weekdays.map(Number))].filter((n) => n >= 1 && n <= 7).sort((a, b) => a - b);
  if (!sorted.length) return '';
  const runs = [];
  let s = sorted[0];
  let prev = sorted[0];
  for (const n of sorted.slice(1)) {
    if (n === prev + 1) { prev = n; continue; }
    runs.push([s, prev]);
    s = n; prev = n;
  }
  runs.push([s, prev]);
  return runs.map(([a, b]) => (a === b ? NAME[a] : `${NAME[a]}~${NAME[b]}`)).join('、');
}

/**
 * 门店身份脱敏。
 * 店名本身就是地址（实测「麦当劳深圳龙胜地铁站D出口餐厅」嵌城市+地铁站+出口编号），
 * 所以"只抹地址、留着店名"在数据上做不到——只能整块换成通用称谓。
 * 券名与积分数值不在此列：券名不可核销（要的是 code 不是标题），积分数值不定位人，
 * 把它们脱掉只会让卡片答不了"那是哪张券""还差多少分"。
 */
const genericStore = () => '一家麦当劳餐厅';

/**
 * 券面图（方图与横幅）是官方营销素材，不含任何可核销信息，因此**不随 share 清空**。
 * 脱敏脱的是券码与门店身份，把图一起砍掉等于让传播版没有图。
 * `.invalid` 是 RFC 保留域，脱敏样例用它占位——按此排除，样例才不会渲染出裂图。
 */
const couponImg = (v) => (typeof v === 'string' && v.startsWith('https://') && !v.includes('.invalid/') ? v : null);

export const REPORT_NAME = '权益账单';

/**
 * available-coupons 用 success:false + code:499 表达「没有可领的券」——稳定语义，不是故障。
 * 实测三次重试结果一致（见 references/fields.md）。按标准错误处理会给用户弹「服务异常」。
 */
export function isNoCouponsAvailable(raw) {
  return raw?.success === false && Number(raw?.code) === 499;
}

/**
 * beTypes 与官方 query-store-coupons 的门店场景过滤一致。
 * 官方枚举：1-到店自取 2-麦乐送 5-得来速 6-企业团餐；3/4 官方未公开含义。
 * 未命中当前场景时只说「不支持当前取餐方式」，不猜具体含义。
 */
const BETYPE_NAME = { 1: '到店自取', 2: '麦乐送', 5: '得来速', 6: '企业团餐' };

/**
 * 麦金卡价商品的唯一判据（T2）。
 * 实测 `canWithOrder === true` ⟺ `discountType === '随单购麦金卡优惠'`，两家店集合完全相同。
 * 判据**必须是实体字段**：只认分类引用的「麦金卡」tag 会漏判 2 条（1420721）/ 5 条（1420370）。
 * 而这些商品的 `currentPrice` 就是麦金卡价 —— 非麦金卡用户并不付这个价。
 */
export const GOLD_DISCOUNT_TYPE = '随单购麦金卡优惠';
const isGoldPriced = (e) => e?.discountType === GOLD_DISCOUNT_TYPE;

/**
 * 「周边」（帽子/徽章/毛绒这类非餐品）**没有任何结构化字段可认**（2026-10-20 两店全量核对）：
 * 实体字段与真餐品完全同构，分类也同在「小食甜品/其他」。只剩两条易碎启发式的并集——
 * tag 表（`521946 旋旋星愿贴` 名字里没关键词，全靠 tag 命中）与名字表（`521954 复古棒球帽`
 * 官方只给 ["上新"]，全靠「帽」命中；`521955 麦当劳联名徽章` 两个都没有原名字表，是复查补的「徽章」）。
 * 官方改个名就会静默漏判，所以 `src/check.mjs` 必须对**两家店**都留断言。
 */
const PERIPHERY_NAME = /周边|帽|徽章|捶痒痒挠|毛绒/;
const PERIPHERY_TAGS = new Set(['汪苏泷限量周边', '既可捶背', '又可挠痒']);
export const isPeriphery = (name, tags = []) =>
  PERIPHERY_NAME.test(name ?? '') || (tags ?? []).some((t) => PERIPHERY_TAGS.has(t));

/**
 * 命中了哪一条信号（`'name'` / `'tag'` / `'both'` / `null`）。
 * 存在的理由是让闸门能证明**两条线各自都在干活**：只测一家店时，删掉任何一条表都不报错，
 * 漏判要等官方改名那天才暴露。实测 1420721 没有 tag-only 的周边、1420370 才有（`521946`），
 * 而 name-only 两家都有（`521743` / `521954` / `521955`）。
 */
export const peripherySignal = (name, tags = []) => {
  const byName = PERIPHERY_NAME.test(name ?? '');
  const byTag = (tags ?? []).some((t) => PERIPHERY_TAGS.has(t));
  return byName && byTag ? 'both' : byName ? 'name' : byTag ? 'tag' : null;
};

/**
 * 生效起始时间。优先结构化字段 tradeStartDateTime；
 * 若未来只给 datetimeText（"2026-10-12 00:00-2026-10-18 23:59"），取左侧兜底。
 */
function parseStart(c) {
  if (c.tradeStartDateTime) return parseServerTime(c.tradeStartDateTime);
  const m = String(c.datetimeText ?? '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  return m ? parseServerTime(`${m[1]} ${m[2]}:${m[3]}:00`) : null;
}

function classify(coupon, now, sceneBeType = 1, storeWin = null) {
  const reasons = [];
  const beTypes = Array.isArray(coupon.beTypes) ? coupon.beTypes.map(Number) : [];
  const sceneOk = !beTypes.length || beTypes.includes(Number(sceneBeType));
  if (!sceneOk) {
    const alt = beTypes.map((b) => BETYPE_NAME[b]).filter(Boolean);
    reasons.push(alt.length ? `不支持「${BETYPE_NAME[sceneBeType] ?? sceneBeType}」，仅${alt.join('/')}可用` : '不支持当前取餐方式');
  }

  const enabled = Number(coupon.enable) === 1;
  if (!enabled) reasons.push('券当前未启用');

  const quota = Number(coupon.currentDayAvailableCount ?? 1);
  if (quota <= 0) reasons.push('今日次数已用完');

  const nowMin = now.getHours() * 60 + now.getMinutes();
  let wins = [], inWin = false, future = null, blocked = null, notStarted = false;
  let startAt = null;

  if (storeWin) {
    // 门店侧时间窗优先：有官方窗口就不再查券包 weekdays / periods
    if (storeWin.outOfRange) {
      blocked = now < storeWin.start
        ? `${storeWin.start.getMonth() + 1}月${storeWin.start.getDate()}日起这家店能刷`
        : '这家店的可用期已过';
    } else {
      wins = [{ from: storeWin.from, to: storeWin.to }];
      if (nowMin < storeWin.from) {
        future = { from: storeWin.from, to: storeWin.to };
        reasons.push(`这家店 ${hhmm(storeWin.from)} 起能刷`);
      } else if (nowMin >= storeWin.to) {
        blocked = '这家店今天的可刷时段已过';
      } else {
        inWin = true;
      }
    }
  } else {
    const wd = isoWeekday(now);
    const weekdays = Array.isArray(coupon.weekdays) ? coupon.weekdays.map(Number) : [];
    const dayOk = !weekdays.length || weekdays.includes(wd);
    if (!dayOk) reasons.push(`限${weekdayRange(weekdays)}可用，今天${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][wd - 1]}不行`);

    startAt = parseStart(coupon);
    notStarted = startAt !== null && now < startAt;
    if (notStarted) {
      const hm = startAt.getHours() || startAt.getMinutes()
        ? ` ${String(startAt.getHours()).padStart(2, '0')}:${String(startAt.getMinutes()).padStart(2, '0')}` : '';
      reasons.push(`${startAt.getMonth() + 1}月${startAt.getDate()}日${hm} 生效，还没到`);
    }

    wins = windowsToday(coupon, now);
    inWin = wins.some((w) => nowMin >= w.from && nowMin < w.to);
    future = wins.filter((w) => nowMin < w.from).sort((a, b) => a.from - b.from)[0] ?? null;
  }

  const blockedByRule = !sceneOk || !enabled || quota <= 0;
  let state;
  if (blocked) state = 'locked';
  // 券包侧生效起始（仅无门店窗口时生效）：今天晚些生效 → later，未来某天 → locked
  else if (!storeWin && notStarted) state = startAt.toDateString() === now.toDateString() ? 'later' : 'locked';
  else if (inWin) state = blockedByRule ? 'locked' : 'now';
  else if (future) state = blockedByRule ? 'locked' : 'later';
  else state = 'locked';

  if (state === 'locked' && Number(coupon.isCanGive) === 1) {
    const endAt = parseServerTime(coupon.tradeEndDateTime);
    const hoursLeft = endAt ? (endAt - now) / 3.6e6 : Infinity;
    if (hoursLeft <= 72) state = 'gift';
  }

  const label = { now: '现在能用', later: '今天晚些能用', locked: '今天用不了', gift: '用不上就送人' }[state];
  // 红色整卡只留给「钱/损失」，状态色不碰红，否则与积分条的「已作废」撞色
  const glyph = { now: '🟢', later: '🟠', locked: '⬜', gift: '🔵' }[state];
  return { state, label, glyph, reasons, wins, inWin, nextWindow: future ?? null };
}

function hoursLeftText(endAt, now) {
  if (!endAt) return '';
  const h = (endAt - now) / 3.6e6;
  if (h <= 0) return '已过期';
  if (h < 24) return `剩 ${h.toFixed(1)} 小时`;
  return `剩 ${Math.ceil(h / 24)} 天`;
}

export function buildModel({ couponsRaw, accountRaw, mealsRaw, storeCouponsRaw, store, serverNow, share = false, sceneBeType = 1 }) {
  const now = serverNow ?? parseServerTime(couponsRaw?.datetime) ?? new Date();
  // code:499 =「无券可领/券包为空」，稳定语义非故障；其余 success:false 才是接口异常
  const couponsNote = (couponsRaw?.success === false)
    ? (isNoCouponsAvailable(couponsRaw)
      ? '券包当前为空（服务端 code:499，稳定语义非故障）'
      : `券包接口返回异常 code:${couponsRaw?.code ?? '?'}，以下结果不可信`)
    : '';
  // 菜单归并索引（券/商品 join 与价格阶梯的唯一来源）——先建索引，后面认亲与增益都靠它
  const mealIndex = new Map();
  for (const [code, e] of Object.entries(mealsRaw?.data?.meals ?? {})) {
    const key = e.name;
    const cur = mealIndex.get(key) ?? { name: key, tiers: {}, image: null };
    // 同名多条 SKU（麦金卡是另一条 code）取第一个能用的官方图，供渲染器兜底取图
    if (!cur.image) cur.image = couponImg(e.image);
    if (Number(e.originalPrice) > 0) {
      cur.tiers.list = Math.max(cur.tiers.list ?? 0, Number(e.originalPrice));
      cur.tiers.sale = cur.tiers.sale == null ? Number(e.currentPrice) : Math.min(cur.tiers.sale, Number(e.currentPrice));
    }
    mealIndex.set(key, cur);
  }
  for (const cat of mealsRaw?.data?.categories ?? []) {
    for (const ref of cat.meals ?? []) {
      const e = mealsRaw.data.meals[ref.code];
      if (!e) continue;
      const rec = mealIndex.get(e.name);
      if (!rec) continue;
      // 新品只认 "上新" 这一个精确 tag——"新升级""清爽上新"等营销 tag 语义不纯，不猜
      if ((ref.tags ?? []).includes('上新')) rec.isNew = true;
      // 麦金卡档按实体字段判，不按引用 tag（见 GOLD_DISCOUNT_TYPE 的注释）
      if (isGoldPriced(e)) rec.tiers.gold = Number(e.currentPrice);
    }
  }

  /**
   * 分类维度（T1）。为什么模型层非留不可：
   *   组合套餐的**实体名里没有「1+1」**（`9900013304` 叫「人气经典随心配」），只有分类名有，
   *   实测原始分类名还含换行（「随心配\n1+1」），所以必须先去换行再匹配。
   * ⚠️ 分类名**不得进 `mealIndex` 的 key** —— 那套名字空间是券商品 join 与价格阶梯的唯一来源，
   *   混进第二套命名必然串味。同理 `newItems` 按 code 存：归并后的 `tiers` 是
   *   max(原价)/min(现价)，官方一旦给同名不同价的新品就会算错省额。
   */
  const categories = [];
  const comboMap = new Map();
  const newMap = new Map();
  /**
   * 同一个 code 可能被多个分类引用，而**周边的 tag 信号不一定落在第一次引用的那个分类上**
   * （实测 `521946 旋旋星愿贴` 的名字里没有关键词，全靠 tag「既可捶背」命中）。
   * 所以按 code 收、tag 取并集，再判周边 —— 只认第一次引用会漏。
   */
  const mergeRef = (map, row) => {
    const prev = map.get(row.code);
    if (!prev) { map.set(row.code, { ...row, tags: [...row.tags], periphery: isPeriphery(row.name, row.tags) }); return; }
    prev.tags = [...new Set([...prev.tags, ...row.tags])];
    prev.periphery = isPeriphery(prev.name, prev.tags);
  };
  for (const cat of mealsRaw?.data?.categories ?? []) {
    const name = String(cat.name ?? '').replace(/\n/g, '');
    const isCombo = /1\+1/.test(name);
    const codes = [];
    for (const ref of cat.meals ?? []) {
      const e = mealsRaw?.data?.meals?.[ref.code];
      if (!e) continue;
      codes.push(ref.code);
      const tags = ref.tags ?? [];
      if (isCombo) mergeRef(comboMap, { code: ref.code, name: e.name, base: Number(e.currentPrice), tags });
      if (tags.includes('上新')) {
        const cur = Number(e.currentPrice);
        const orig = Number(e.originalPrice);
        mergeRef(newMap, {
          code: ref.code, name: e.name, cur, orig, tags,
          // 省额必须 toFixed（实测 30 − 19.9 = 10.100000000000001，不修会印出这条尾巴）
          save: +(orig - cur).toFixed(1),
          goldPriced: isGoldPriced(e),
          discounted: cur < orig,
        });
      }
    }
    categories.push({ name, isCombo, codes });
  }
  const comboOffers = [...comboMap.values()];
  const newItems = [...newMap.values()];
  // 官方个性化锚点：data.frequent = {code, tags:["我的常点"]}（fields.md 已记录）
  const frequent = mealsRaw?.data?.frequent
    ? (() => {
      const e = mealsRaw.data.meals[mealsRaw.data.frequent.code];
      return e ? { code: mealsRaw.data.frequent.code, name: e.name } : null;
    })()
    : null;

  // 官方放行集合索引：couponId → 门店券条目（认亲、门店侧时间窗、商品 join 都靠它）
  const officialCoupons = new Map(Array.isArray(storeCouponsRaw?.data)
    ? storeCouponsRaw.data.map((x) => [x.couponId, x])
    : []);

  const coupons = (couponsRaw?.data?.coupons ?? []).map((c) => {
    const realTitle = c.title ?? '(未命名券)';
    const key = c.id ?? c.code ?? realTitle;
    const off = officialCoupons.get(key) ?? null;
    const storeWin = off ? parseStoreWindow(off.tradeDateTime, now) : null;
    const cls = classify(c, now, sceneBeType, storeWin);
    const endAt = parseServerTime(c.tradeEndDateTime);
    const di = c.discountInfo ?? {};
    return {
      title: realTitle,
      displayTitle: realTitle,
      couponImage: couponImg(c.image),
      couponBand: couponImg(c.bigImage),
      // 内部稳定键：id 是哈希，不可核销，可安全用于跨轮 diff；绝不渲染给用户
      key,
      codeMasked: maskCode(c.code),
      endAt,
      endText: c.tradeEndDateTime ?? c.tradeEndDate ?? '',
      countdown: hoursLeftText(endAt, now),
      absoluteDue: endAt ? `${endAt.getMonth() + 1}月${endAt.getDate()}日 ${String(endAt.getHours()).padStart(2, '0')}:${String(endAt.getMinutes()).padStart(2, '0')}` : '',
      couponPrice: di.discountValue ? Number(di.discountValue) : null,
      priceLabel: di.discountDesc ?? '',
      ...cls,
      givable: Number(c.isCanGive) === 1,
      quota: Number(c.currentDayAvailableCount ?? 0),
      totalQuota: Number(c.totalAvailableCount ?? 0),
      scopeTags: (c.tags ?? []).filter((t) => t?.type === 2).map((t) => t.label),
      // 官方随券下发的品牌色（实测金 #FFBC0D 稳定下发，红只在部分文案里出现）
      // 属设计 token 不属个人信息，故同样不随 share 清空
      tagColors: [...new Set((c.tags ?? [])
        .map((t) => t?.color).filter((x) => typeof x === 'string' && /^#[0-9A-Fa-f]{6}$/.test(x))
        .map((x) => x.toUpperCase()))],
      dueTodayTag: (c.tags ?? []).some((t) => t?.value === 'due today'),
      channelNote: c.toastText ?? '',
      receivedDays: c.receivedDays ?? null,
      // 认亲结果：官方门店券的商品 join（inMenu = 菜单里有现价，可算增益）
      matchedProducts: off
        ? (off.products ?? []).map((p) => {
          const e = mealsRaw?.data?.meals?.[p.productCode];
          const rec = e ? mealIndex.get(e.name) : null;
          return {
            productCode: p.productCode,
            productName: p.productName ?? e?.name ?? '',
            // 菜单侧真名：券侧 productName 与菜单 name 不保证一致（实测冰美式两样写法），阶梯查找必须用这个
            menuName: e?.name ?? null,
            sale: rec?.tiers?.sale ?? null,
            image: e?.image ?? null,
            inMenu: rec?.tiers?.sale != null,
          };
        })
        : null,
      storeWindow: storeWin && !storeWin.outOfRange
        ? `这家店 ${hhmm(storeWin.from)}-${storeWin.to >= 1440 ? '23:59' : hhmm(storeWin.to)} 能刷` : null,
      // 「今天吃啥」的末行要把时段挂在券上（`①② 用的那张券：10:30-23:59 能刷`），
      // 那里不能再带「这家店」三个字 —— 时段留一份纯文本，别在渲染层做字符串手术
      windowText: storeWin && !storeWin.outOfRange
        ? `${hhmm(storeWin.from)}-${storeWin.to >= 1440 ? '23:59' : hhmm(storeWin.to)}` : null,
      raw: share ? null : c,
    };
  });

  const order = { now: 0, later: 1, gift: 2, locked: 3 };
  coupons.sort((a, b) => order[a.state] - order[b.state] || (a.endAt ?? 0) - (b.endAt ?? 0));

  const p = accountRaw?.data ?? {};
  const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));
  const accum = num(p.accumulativePoint);
  const points = {
    available: num(p.availablePoint),
    accumulated: accum,
    used: num(p.usedPoint),
    expired: num(p.expiredPoint),
    expireThisMonth: num(p.currentMouthExpirePoint),
    currency: p.currency ?? '积分',
    expiredPct: accum ? (num(p.expiredPoint) / accum) * 100 : 0,
    usedPct: accum ? (num(p.usedPoint) / accum) * 100 : 0,
    heldPct: accum ? (num(p.availablePoint) / accum) * 100 : 0,
  };

  const counts = coupons.reduce((a, c) => ((a[c.state] = (a[c.state] ?? 0) + 1), a), {});
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // 增益统一走 couponLadder（"今天吃啥"与"这张券划算吗"同一口径）：
  // 对认亲成功且 join 成功的券，取最优商品回写 realGain / verdict / ladderProduct。
  // join 全失败（任选组合类 SKU 不在菜单）→ 不写增益，由 pickTop1 出局并给问话。
  for (const c of coupons) {
    if (!c.matchedProducts?.length || c.couponPrice == null) continue;
    let best = null;
    for (const mp of c.matchedProducts) {
      if (!mp.inMenu) continue;
      // 用菜单侧真名查阶梯——券侧 productName 可能对不上（实测冰美式两种写法）
      const lad = couponLadder({ meals: [...mealIndex.values()] }, mp.menuName ?? mp.productName, c.couponPrice);
      if (lad.realGain == null) continue;
      if (!best || lad.realGain > best.lad.realGain) best = { mp, lad };
    }
    if (best) {
      c.realGain = best.lad.realGain;
      c.verdict = best.lad.verdict;
      c.ladderProduct = {
        code: best.mp.productCode,
        name: best.mp.menuName ?? best.mp.productName,
        sale: best.lad.sale,
        image: best.mp.image,
      };
    }
  }

  points.headline = `你累计赚到 ${points.accumulated} ${points.currency}`;

  const rawStore = store ?? { code: '', name: '未绑定门店' };

  return {
    share,
    couponsNote,
    sceneBeType: Number(sceneBeType),
    sceneName: BETYPE_NAME[Number(sceneBeType)] ?? '到店自取',
    reportName: REPORT_NAME,
    now,
    nowText: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    weekdayLabel: '周' + '日一二三四五六'[now.getDay()],
    nowMin,
    track: TRACK,
    store: { code: share ? '' : rawStore.code, name: share ? genericStore() : (rawStore.name || '未绑定门店') },
    coupons,
    counts,
    points,
    meals: [...mealIndex.values()].filter((m) => m.tiers.list != null || m.tiers.sale != null),
    categories,
    comboOffers,
    newItems,
    frequent,
    storeCouponIds: [...officialCoupons.keys()],
    trace: share
      ? { couponTraceId: '', accountTraceId: '', serverDatetime: '' }
      : {
        couponTraceId: couponsRaw?.traceId ?? '',
        accountTraceId: accountRaw?.traceId ?? '',
        serverDatetime: couponsRaw?.datetime ?? '',
      },
  };
}

/**
 * 券的真实增益 = 菜单现价 − 券价（"今天吃啥"与"这张券划算吗"共用的唯一口径）。
 * gold（麦金卡价）只作展示档，不参与 verdict 判定——实测 gold === sale，无价差可叙。
 */
export function couponLadder(model, productName, couponPrice) {
  const rec = model.meals.find((x) => x.name === productName);
  const list = rec?.tiers?.list ?? null;
  const sale = rec?.tiers?.sale ?? null;
  const gold = rec?.tiers?.gold ?? null;
  const real = couponPrice != null && sale != null ? sale - couponPrice : null;
  return {
    list, sale, gold, couponPrice,
    vsList: couponPrice != null && list != null ? list - couponPrice : null,
    realGain: real,
    verdict: real == null ? 'unknown'
      : real <= 0 ? 'worthless'
      : real < 3 ? 'marginal'
      : real < 10 ? 'ok'
      : 'great',
  };
}

/**
 * 三轨各挑一条（T3）。**排成一张榜是被明令禁止的**（D9）：
 *   ① 的「真省」= 菜单现价 − 券价（有券 vs 无券，用户真到手的差额）；
 *   ③ 的「省」= 原价 − 现价（划线价口径，用户本来就只付现价，那 ¥48 从来没付到过）。
 * 两个数不同源、份量也不同（¥11.9 的汉堡 vs ¥26.9 的三件套）—— 拿 21.1 压 10.6，
 * 会推出「看着省最多、其实你本来就要付 ¥26.9」的新品，把真省的券挤掉。
 * ② 的省**恒等于** ① 的省：1+1 是套餐价，那一分不参与任何减法（用户裁定 D-新2）。
 */
export function pickThree(model, { comboDetail = null } = {}) {
  const one = pickTop1(model);
  const t = one.top1;
  const coupon = t ? {
    title: t.coupon.title,
    name: t.product?.name ?? t.coupon.title,
    code: t.product?.code ?? null,
    image: t.product?.image ?? null,
    sale: t.product?.sale ?? null,
    couponPrice: t.coupon.couponPrice ?? null,
    gain: t.gain != null ? +t.gain.toFixed(1) : null,
    verdict: t.verdict ?? null,
    windowText: t.coupon.windowText ?? null,
    quota: t.coupon.quota ?? 0,
  } : null;

  // ② 轨的意义是「顺手把券用掉」，没有券就没有这一轨（1+1 单买属 ③ 之外的另一件事）
  const offer = coupon ? pickComboOffer(model) : null;
  let combo = null;
  if (offer) {
    const read = comboReadMode(comboDetail, coupon.code ? [coupon.code] : []);
    const mode = read?.mode ?? 'b';
    combo = {
      code: offer.code, name: offer.name, base: offer.base,
      via: model.frequent && offer.code === model.frequent.code ? 'frequent' : 'priceAsc',
      interval: comboInterval(comboDetail, offer.base),
      readMode: mode,
      // no-detail 时 (a) 无从判断，按服务端唯一实测过的 (b) 走，并把依据标出来
      readBasis: read ? 'choices' : 'no-detail',
      // (a)「1+1 里那件能用券」的合计从没取过证 —— 不报金额，只报单品价（D5 的降级口径）
      total: mode === 'b' ? +(offer.base + (coupon.couponPrice ?? 0)).toFixed(1) : null,
      save: coupon.gain,
    };
  }

  // ③ 轨的三道闸（D15=②：**这里排除周边，权益账单不排除，是有意的两把筛子**）
  //   · 这一屏答「吃什么」，帽子徽章是噪音；账单答「这期有什么」，联名周边也是权益。
  //   · 麦金卡价商品必须挡住：它们的 currentPrice 就是麦金卡价，非会员并不付这个价，
  //     拿它算「省 ¥5」是假账（当前两店的麦金卡新品恰好都是周边、被上一条挡着，
  //     但那是巧合，规则必须显式写，不能指望周边规则兜底）。
  const rows = model.newItems ?? [];
  const pool = rows.filter((x) => !x.periphery && !x.goldPriced && x.discounted)
    .sort((a, b) => b.save - a.save || a.cur - b.cur);

  return {
    coupon, combo, item: pool[0] ?? null,
    second: one.second ? { title: one.second.coupon.title, gain: +one.second.gain.toFixed(1) } : null,
    outcast: one.outcast, fallback: one.fallback,
    // 末行归属必须按「哪几条轨真的用了这张券」现算（T11）：早餐 ② 缺席时要变成「①」
    uses: coupon ? (combo ? '①②' : '①') : null,
    // ③ 轨的**真实候选池**必须暴露出来：闸门若自己再算一遍"正确的池子"就是同义反复，
    // pickThree 的筛选回归（比如哪天忘了排除周边）它一条都抓不到 —— 2026-10-21 变异测试实测
    newPool: pool.map((x) => ({ code: x.code, name: x.name, save: x.save })),
    trackCount: [coupon, combo, pool[0] ?? null].filter(Boolean).length,
    counts: {
      newTotal: rows.length,
      periphery: rows.filter((x) => x.periphery).length,
      goldPriced: rows.filter((x) => x.goldPriced && !x.periphery).length,
      eatable: pool.length,
    },
  };
}

/**
 * 积分商城的 `price` 字段恒为 0，真实元值埋在 `selling` 文案开头（"18.8元麦辣鸡腿汉堡两件套"）。
 * 必须解析，不许硬编码。解析不出返回 null，由调用方决定不展示金额。
 */
export function parseYuan(...strs) {
  for (const s of strs) {
    const m = String(s ?? '').match(/([0-9]+(?:\.[0-9]+)?)\s*元/);
    if (m) return Number(m[1]);
  }
  return null;
}

export { TRACK, BLOCKS };

/**
 * ② 轨选款（T19 / 裁定 D13=②）。顺序不能反：
 *   1. 官方个性化锚点 `frequent` 命中候选 → 用它（与券轨「我的常点」同口径）；
 *   2. 否则在候选里按**菜单到手价升序**取第一款。
 * 分支 2 是常态而不是备胎：实测 `frequent` 不每店每时段都下发（1420721 早餐、1420370 晚餐都没有）。
 * ⚠️ 不得只认分类里的第一项 —— 两店 refs 恰好都是 3304 在前，那是巧合；官方一改顺序就会错 ¥1。
 */
export function pickComboOffer(model) {
  const offers = model?.comboOffers ?? [];
  if (!offers.length) return null;
  const freq = model.frequent?.code ?? null;
  return offers.find((o) => o.code === freq)
    ?? [...offers].sort((a, b) => a.base - b.base)[0];
}

/**
 * `diffPrice` 是**给普通人看的字符串**（实测 `"+ ¥0"` / `"- ¥1"`），不是数字。
 * 解析不出就返回 null 让调用方**别算**，不许猜一个 0 —— 猜错是错钱。
 */
function diffValue(c) {
  const raw = c?.diffPrice;
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw);
  const digits = s.replace(/[^\d.]/g, '');
  // 剥完一个数字都不剩（例：「待定」）必须返回 null 让上层**别算** ——
  // Number('') === 0，不拦就把认不出的差价静默当成 ¥0 加价
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return /[-−]/.test(s) ? -n : n;
}

/** 组合套餐的全部可选件 code —— 这是唯一能看到「1+1 里面是什么」的地方（菜单里没有构成信息） */
export function comboChoiceCodes(detailRaw) {
  const codes = new Set();
  for (const r of detailRaw?.data?.rounds ?? []) {
    for (const c of r.choices ?? []) if (c?.code) codes.add(String(c.code));
  }
  return codes;
}

/**
 * 1+1 的实付区间（T16）。锚点是**该款自己的基准价**（菜单 `currentPrice`）+ 各 round 选中项的 `diffPrice`。
 * 实测两款的符号方向相反：同一批 5 个单品在 `9900013304`（基准 ¥14.9）里标 −¥1，
 * 在 `9900015568`（基准 ¥13.9）里标 +¥0 → **写死「负号=更便宜」会在第二款上算反 ¥1**。
 * 每个 round 恰选 `quantity` 件，所以 min/max 各取该 round 最小/最大的 q 个 diff 之和。
 * 拿不到 rounds、或有任一选项解析不出 → 返回 null（不算，不猜）。
 */
export function comboInterval(detailRaw, base) {
  const rounds = detailRaw?.data?.rounds ?? [];
  if (!rounds.length || !Number.isFinite(base)) return null;
  let lo = base, hi = base, def = base;
  for (const r of rounds) {
    const choices = r.choices ?? [];
    const vals = choices.map(diffValue);
    if (!choices.length || vals.some((v) => v == null)) return null;
    const q = Math.max(1, Number(r.quantity ?? 1));
    const sorted = [...vals].sort((a, b) => a - b);
    lo += sorted.slice(0, q).reduce((a, b) => a + b, 0);
    hi += sorted.slice(-q).reduce((a, b) => a + b, 0);
    def += choices.filter((c) => Number(c.isDefault) === 1)
      .reduce((a, c) => a + (diffValue(c) ?? 0), 0);
  }
  return { lo: +lo.toFixed(1), hi: +hi.toFixed(1), def: +def.toFixed(1) };
}

/**
 * ② 轨的读法（T17）：可选件里有没有放行券的商品。
 *   有 → (a) 一单两件（1+1 里那件直接用券）；没有 → (b) 1+1 再另买一份用券商品。
 * 当前券包实测走 (b)：三张放行券的商品都不在 24 个可选件里，且服务端亲自拒过单独挂券
 * （`600012 促销规则不支持该商品`）。**但这是数据结论，不是规则** —— 官方换券就要翻回 (a)，
 * 所以这里只认 `query-meal-detail` 的 choices，不写死。取不到构成时返回 null，由调用方按 (b) 降级。
 */
export function comboReadMode(detailRaw, releasedCodes = []) {
  const codes = comboChoiceCodes(detailRaw);
  if (!codes.size) return null;
  const hits = [...new Set(releasedCodes.map(String))].filter((c) => codes.has(c));
  return { mode: hits.length ? 'a' : 'b', hits, choices: codes.size };
}

/**
 * 「今天吃啥」的 top1 选择器（写死，回复里不许另挑）。
 * 候选池 = 官方放行集合 ∩ 模型判 now（docs/plans/2026-10-19-eat-this.md §3.1）。
 * 排序（D1/D3）：realGain 降序 → 今日余量升序 → 到期升序 → frequent「我的常点」仅破三键全平。
 * fallback：'no_store_coupons' 无门店券数据 / 'no_now' 放行了但没判出 now / 'no_price' 全部 join 失败。
 */
export function pickTop1(model) {
  const inOfficial = new Set(model.storeCouponIds ?? []);
  const hasStore = inOfficial.size > 0;
  const pool = model.coupons.filter((c) => c.state === 'now' && inOfficial.has(c.key));
  if (!pool.length) return { top1: null, second: null, outcast: [], fallback: hasStore ? 'no_now' : 'no_store_coupons' };

  const comparable = pool.filter((c) => c.realGain != null);
  if (!comparable.length) return { top1: null, second: null, outcast: pool.map((c) => c.title), fallback: 'no_price' };

  const rank = (c) => ({
    c,
    hitsFrequent: !!model.frequent && (c.matchedProducts ?? []).some((mp) => mp.productCode === model.frequent.code),
  });
  const cmp = (a, b) => {
    if (b.c.realGain !== a.c.realGain) return b.c.realGain - a.c.realGain;        // 主键：增益降序
    if ((a.c.quota ?? 99) !== (b.c.quota ?? 99)) return (a.c.quota ?? 99) - (b.c.quota ?? 99); // 次键：余量升序
    const ea = a.c.endAt?.getTime() ?? Infinity, eb = b.c.endAt?.getTime() ?? Infinity;
    if (ea !== eb) return ea - eb;                                               // 三键：到期升序
    return (b.hitsFrequent ? 1 : 0) - (a.hitsFrequent ? 1 : 0);                  // 四键：常点破平局
  };
  const sorted = comparable.map(rank).sort(cmp);
  const mk = ({ c, hitsFrequent }) => ({
    coupon: c,
    product: c.ladderProduct ?? null,
    gain: c.realGain,
    verdict: c.verdict ?? null,
    windowsNote: c.storeWindow ?? null,
    hitsFrequent,
  });
  return {
    top1: mk(sorted[0]),
    second: sorted[1] ? mk(sorted[1]) : null,
    outcast: pool.filter((c) => c.realGain == null).map((c) => c.title),
    fallback: null,
  };
}

