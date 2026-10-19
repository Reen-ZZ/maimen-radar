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

/** 分享版脱敏：券名 → 品类，不暴露具体消费内容 */
const CATEGORY_RULES = [
  [/咖啡|美式|拿铁|麦咖啡|卡布奇诺|摩卡/i, '咖啡饮品'],
  [/麦旋风|新地|圆筒|冰淇淋|圣代|甜筒/, '冰淇淋'],
  [/鸡腿堡|巨无霸|麦辣|板烧|安格斯|汉堡|堡/, '汉堡类'],
  [/炸鸡|鸡翅|麦翅|王牌鸡|蘸酱/, '炸鸡小食'],
  [/薯条|薯饼|薯格/, '薯类'],
  [/松饼|猪柳蛋|早餐|粥|油条/, '早餐'],
  [/派|曲奇|蛋糕|甜品|可可|黑巧/, '甜品'],
  [/可乐|汽水|奶昔|果汁|饮料|茶/, '饮料'],
  [/沙拉|玉米|杯|果蔬/, '轻食'],
];
const categorize = (title) => {
  for (const [re, name] of CATEGORY_RULES) if (re.test(String(title))) return `${name}券`;
  return '其他权益券';
};

/** 门店名脱敏：「麦当劳惠州博罗天虹餐厅」→「一家麦当劳餐厅」 */
const genericStore = () => '一家麦当劳餐厅';

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
  const glyph = { now: '🟢', later: '🟠', locked: '🔴', gift: '🟡' }[state];
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
    const cur = mealIndex.get(key) ?? { name: key, tiers: {} };
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
      if ((ref.tags ?? []).includes('麦金卡')) rec.tiers.gold = Number(e.currentPrice);
    }
  }
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
      displayTitle: share ? categorize(realTitle) : realTitle,
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
      storeWindow: storeWin && !storeWin.outOfRange ? `这家店 ${hhmm(storeWin.from)}-${storeWin.to >= 1440 ? '23:59' : hhmm(storeWin.to)} 能刷` : null,
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

  points.showAbsolute = !share;
  points.headline = share
    ? `你赚到的${p.currency ?? '积分'}里，${points.expiredPct.toFixed(1)}% 已经作废`
    : `你累计赚到 ${points.accumulated} ${points.currency}`;

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

