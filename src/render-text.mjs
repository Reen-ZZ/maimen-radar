/**
 * 文本渲染器 —— 单一事实版式
 * 纯 Unicode，聊天 / 终端 / README 代码块 / HTML <pre> 四处通用。
 * 脱敏由 model 决定（m.share），本文件不做任何数据加工。
 */

const W = 32;

/** CJK 全角按 2 列计 */
function dw(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    n += c > 0x2e80 && c < 0xd400 ? 2 : c >= 0xff00 ? 2 : 1;
  }
  return n;
}
function pad(s, w) {
  s = String(s);
  const d = w - dw(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}
function ell(s, w) {
  s = String(s);
  if (dw(s) <= w) return s;
  let out = '';
  for (const ch of s) {
    if (dw(out + ch) > w - 1) break;
    out += ch;
  }
  return out + '…';
}

function bar(coupon, nowMin) {
  const cells = new Array(W).fill('░');
  for (const win of coupon.wins) {
    const a = Math.max(0, Math.floor((win.from / 1440) * W));
    const b = Math.min(W, Math.ceil((win.to / 1440) * W));
    for (let i = a; i < b; i++) {
      const cellMin = (i / W) * 1440;
      cells[i] = coupon.state === 'locked' ? '░' : cellMin <= nowMin ? '█' : '▓';
    }
  }
  if (coupon.state === 'gift') for (let i = 0; i < W; i++) cells[i] = '╌';
  return cells.join('');
}

function axis() {
  // 刻度与 bar() 同一坐标系：cell i 覆盖 [i*45, (i+1)*45) 分钟。
  // 12:00 → cell 16，24:00 是最后 cell 的右边缘 → 标签占末两格。
  const line = new Array(W).fill(' ');
  for (const [h, at] of [[0, 0], [12, 16], [24, W - 2]]) {
    line.splice(at, 2, ...String(h).padStart(2, '0').split(''));
  }
  return line.join('');
}

function nowMark(nowMin) {
  const line = new Array(W).fill(' ');
  line[Math.min(W - 1, Math.round((nowMin / 1440) * (W - 1)))] = '▾';
  return line.join('');
}

export function renderText(m) {
  const share = !!m.share;
  const nowMin = m.nowMin;
  const p = m.points;
  const L = [];

  L.push(`📡 麦门雷达 · ${m.reportName}${share ? '（分享版）' : ''}`);
  L.push(`   ${m.nowText} ${m.weekdayLabel} · ${ell(m.store.name, 26)} · 券 ${m.coupons.length} 张`);
  if (m.couponsNote) L.push(`   ⚠ ${m.couponsNote}`);
  L.push('');

  L.push('   可用窗口            ' + axis());
  L.push(`                      ${nowMark(nowMin)}`);
  L.push('   ' + '─'.repeat(3 + 22 + W + 2));
  for (const c of m.coupons) {
    L.push(`   ${c.glyph} ${pad(ell(c.displayTitle, 20), 21)}${bar(c, nowMin)} ${share ? c.absoluteDue : c.countdown}`);
    const note = c.reasons[0] || c.scopeTags.join('/');
    if (note) L.push(`      ↳ ${note}${c.couponPrice ? ` · 用券 ¥${c.couponPrice}` : ''}${c.quota ? ` · 今日余 ${c.quota} 次` : ''}`);
  }
  L.push('');

  L.push(`💸 ${p.headline}`);
  L.push(p.showAbsolute
    ? `   已花掉 ${p.used}（${p.usedPct.toFixed(1)}%）· 已作废 ${p.expired}（${p.expiredPct.toFixed(1)}%）· 在手 ${p.available}`
    : `   已花掉 ${p.usedPct.toFixed(1)}% · 已作废 ${p.expiredPct.toFixed(1)}% · 还在手 ${p.heldPct.toFixed(1)}%`);
  if (p.expireThisMonth > 0) {
    L.push(p.showAbsolute ? `   ⚠ 其中 ${p.expireThisMonth} 分本月到期` : '   ⚠ 本月仍有将过期积分');
  }
  L.push('');

  const gold = m.meals.filter((x) => x.tiers.gold && x.tiers.gold < x.tiers.list)
    .map((x) => ({ ...x, save: x.tiers.list - x.tiers.gold }))
    .sort((a, b) => b.save - a.save).slice(0, 3);
  if (gold.length && !share) {
    L.push('💳 麦金卡价差最大（同一商品在菜单里是两条 SKU，按名称归并）');
    for (const g of gold) {
      const t = g.tiers;
      L.push(`   ${pad(ell(g.name, 16), 17)}原价 ¥${pad(t.list, 6)}现价 ¥${pad(t.sale ?? '—', 6)}麦金卡 ¥${t.gold}`);
    }
    L.push('');
  }

  // 上新：引用 tags 精确等于 "上新" 的条目，全量展示（当期一般不超过 10 个）
  const news = m.meals.filter((x) => x.isNew);
  if (news.length) {
    L.push(`🆕 上新 ${news.length} 项`);
    for (const n of news) {
      const t = n.tiers;
      const gold = t.gold ? ` · 麦金卡 ¥${t.gold}` : '';
      L.push(`   ${pad(ell(n.name, 24), 25)}现价 ¥${t.sale ?? t.list}${gold}`);
    }
    L.push('');
  }

  const now = m.coupons.filter((c) => c.state === 'now');
  const gift = m.coupons.filter((c) => c.state === 'gift');
  const locked = m.coupons.filter((c) => c.state === 'locked');
  L.push('→ 现在能吃：' + (now.length ? now.map((c) => `${c.displayTitle}${c.couponPrice ? ` ¥${c.couponPrice}` : ''}`).join('、') : '无'));
  if (gift.length) L.push('→ 用不上就送人：' + gift.map((c) => c.displayTitle).join('、') + '（支持转赠，过期即作废）');
  if (locked.length) L.push('→ 今天别指望：' + locked.map((c) => c.displayTitle).join('、'));
  L.push('');
  L.push(share
    ? `   分享版已脱敏 · 以麦当劳 App 为准`
    : (() => {
        // 引导下一句：与 SKILL.md 的 5 级优先表对齐（渲染层只覆盖数据可判的 2/3/5）
        const next = p.expireThisMonth > 0 ? '「积分能换啥」看看这些分能换什么'
          : m.coupons.some((c) => c.state === 'now') ? '「今天吃啥」看此刻那张怎么用'
          : null;
        return next ? `→ 说${next}　→ 说「生成卡片」出分享版` : '→ 说「生成卡片」出分享版';
      })());
  return L.join('\n');
}
