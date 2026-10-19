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

function classify(coupon, now, sceneBeType = 1) {
  const reasons = [];
  const wd = isoWeekday(now);
  const weekdays = Array.isArray(coupon.weekdays) ? coupon.weekdays.map(Number) : [];
  const dayOk = !weekdays.length || weekdays.includes(wd);
  if (!dayOk) reasons.push(`限${weekdayRange(weekdays)}可用，今天${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][wd - 1]}不行`);

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

  const startAt = parseStart(coupon);
  const notStarted = startAt !== null && now < startAt;
  if (notStarted) {
    const hm = startAt.getHours() || startAt.getMinutes()
      ? ` ${String(startAt.getHours()).padStart(2, '0')}:${String(startAt.getMinutes()).padStart(2, '0')}` : '';
    reasons.push(`${startAt.getMonth() + 1}月${startAt.getDate()}日${hm} 生效，还没到`);
  }

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const wins = windowsToday(coupon, now);
  const inWin = wins.some((w) => nowMin >= w.from && nowMin < w.to);
  const future = wins.filter((w) => nowMin < w.from).sort((a, b) => a.from - b.from)[0];

  let state;
  if (notStarted) state = startAt.toDateString() === now.toDateString() ? 'later' : 'locked';
  else if (!dayOk) state = 'locked';
  else if (!sceneOk) state = 'locked';
  else if (!enabled) state = 'locked';
  else if (quota <= 0) state = 'locked';
  else if (inWin) state = 'now';
  else if (future) state = 'later';
  else state = 'locked';

  if (state === 'locked' && Number(coupon.isCanGive) === 1) {
    const endAt = parseServerTime(coupon.tradeEndDateTime);
    const hoursLeft = endAt ? (endAt - now) / 3.6e6 : Infinity;
    if (hoursLeft <= 72) state = 'gift';
  }

  const label = { now: '现在能用', later: '今天晚些能用', locked: '今天用不了', gift: '用不上就送人' }[state];
  const glyph = { now: '🟢', later: '🟠', locked: '🔴', gift: '🟡' }[state];
  return { state, label, glyph, reasons, wins, dayOk, inWin, nextWindow: future ?? null };
}

function hoursLeftText(endAt, now) {
  if (!endAt) return '';
  const h = (endAt - now) / 3.6e6;
  if (h <= 0) return '已过期';
  if (h < 24) return `剩 ${h.toFixed(1)} 小时`;
  return `剩 ${Math.ceil(h / 24)} 天`;
}

export function buildModel({ couponsRaw, accountRaw, mealsRaw, store, serverNow, share = false, sceneBeType = 1 }) {
  const now = serverNow ?? parseServerTime(couponsRaw?.datetime) ?? new Date();
  // code:499 =「无券可领/券包为空」，稳定语义非故障；其余 success:false 才是接口异常
  const couponsNote = (couponsRaw?.success === false)
    ? (isNoCouponsAvailable(couponsRaw)
      ? '券包当前为空（服务端 code:499，稳定语义非故障）'
      : `券包接口返回异常 code:${couponsRaw?.code ?? '?'}，以下结果不可信`)
    : '';
  const coupons = (couponsRaw?.data?.coupons ?? []).map((c) => {
    const cls = classify(c, now, sceneBeType);
    const endAt = parseServerTime(c.tradeEndDateTime);
    const di = c.discountInfo ?? {};
    const realTitle = c.title ?? '(未命名券)';
    return {
      title: realTitle,
      displayTitle: share ? categorize(realTitle) : realTitle,
      // 内部稳定键：id 是哈希，不可核销，可安全用于跨轮 diff；绝不渲染给用户
      key: c.id ?? c.code ?? realTitle,
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

  const counts = coupons.reduce((a, c) => ((a[c.state] = (a[c.state] ?? 0) + 1), a), {});
  const nowMin = now.getHours() * 60 + now.getMinutes();

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
    meals: [...mealIndex.values()].filter((m) => m.tiers.list),
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
 * 券的真实增益 = 菜单现价 − 券价。
 * 很多券看着"原价 19 → 券价 9.9"很香，但菜单现价已经 11.9，券其实只多省 2 块。
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
