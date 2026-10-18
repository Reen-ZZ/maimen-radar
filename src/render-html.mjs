/**
 * HTML 渲染器 —— 只吃 buildModel 的输出，不碰原始数据
 * 设计系统：HSL token 先行，组件只引用变量；单一红金强调 + 中性色阶
 * 自包含：无外链字体、无外部资源、无 JS
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STATE_LABEL = { now: '现在能用', later: '今天晚些', locked: '今天用不了', gift: '可转赠' };

function segs(c, nowMin) {
  return c.wins.map((w) => {
    const left = (w.from / 1440) * 100;
    const width = Math.max(0, ((w.to - w.from) / 1440) * 100);
    const cls = c.state === 'locked' ? 'off'
      : c.state === 'gift' ? 'gift'
      : nowMin >= w.to ? 'past'
      : nowMin < w.from ? 'future'
      : 'live';
    return `<span class="seg ${cls}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></span>`;
  }).join('');
}

function row(c, nowMin) {
  const meta = [
    c.reasons[0],
    c.scopeTags.join('/'),
    c.couponPrice ? `用券 ¥${c.couponPrice}` : '',
    c.quota ? `今日余 ${c.quota} 次` : '',
  ].filter(Boolean).join('<span class="dot-sep">·</span>');

  return `<li class="row s-${c.state}">
      <div class="row-top">
        <span class="pill">${esc(STATE_LABEL[c.state])}</span>
        <span class="ttl">${esc(c.displayTitle)}</span>
        <span class="due">${esc(c.absoluteDue)}</span>
      </div>
      <div class="track">${segs(c, nowMin)}<span class="needle" style="left:${((nowMin / 1440) * 100).toFixed(2)}%"></span></div>
      ${meta ? `<div class="row-meta">${meta}</div>` : ''}
    </li>`;
}

export function renderHTML(m) {
  const p = m.points;
  const nowMin = m.nowMin;
  const nowPct = ((nowMin / 1440) * 100).toFixed(2);
  const nowClock = `${String(m.now.getHours()).padStart(2, '0')}:${String(m.now.getMinutes()).padStart(2, '0')}`;

  const ruler = [0, 6, 12, 18, 24]
    .map((h) => ({ h, pos: (h / 24) * 100 }))
    .filter(({ pos }) => Math.abs(pos - Number(nowPct)) > 9)
    .map(({ h, pos }) => `<span class="tick" style="left:${pos.toFixed(2)}%">${String(h).padStart(2, '0')}:00</span>`).join('');

  const rows = m.coupons.map((c) => row(c, nowMin)).join('');

  const summary = ['now', 'later', 'gift', 'locked']
    .filter((k) => m.counts[k])
    .map((k) => `<span class="chip s-${k}"><i></i>${m.counts[k]} ${STATE_LABEL[k]}</span>`).join('');

  const acts = [
    ...m.coupons.filter((c) => c.state === 'now').map((c) =>
      `<li class="s-now"><span class="pill">现在能吃</span><span class="ttl">${esc(c.displayTitle)}</span>${c.couponPrice ? `<span class="price">¥${c.couponPrice}</span>` : ''}</li>`),
    ...m.coupons.filter((c) => c.state === 'gift').map((c) =>
      `<li class="s-gift"><span class="pill">送人止损</span><span class="ttl">${esc(c.displayTitle)}</span><span class="hint">今日作废 · 支持转赠</span></li>`),
    ...m.coupons.filter((c) => c.state === 'locked').map((c) =>
      `<li class="s-locked"><span class="pill">今天别去</span><span class="ttl">${esc(c.displayTitle)}</span><span class="hint">${esc(c.reasons[0] || '')}</span></li>`),
  ].join('');

  const foot = [
    m.share
      ? '分享版已脱敏：门店、券名、积分数值均为品类级信息'
      : `数据拉取 ${esc(m.trace.serverDatetime)} · 券码已脱敏`,
    '参赛者独立开发，非麦当劳官方产品 · 价格与有效期以麦当劳 App 实时结果为准',
  ].map((t) => `<p>${esc(t)}</p>`).join('');

  return `<style>
.mr{
  /* ── 色板：单一红金强调 + 中性色阶 ── */
  --red:hsl(4 76% 51%); --red-ink:hsl(4 70% 38%); --red-wash:hsl(4 80% 97%);
  --gold:hsl(44 100% 53%); --gold-deep:hsl(40 92% 44%); --gold-wash:hsl(46 100% 95%); --gold-line:hsl(43 90% 82%);
  --green:hsl(150 62% 34%); --green-wash:hsl(150 55% 95%);
  --ink:hsl(220 12% 12%); --ink-2:hsl(220 8% 32%); --muted:hsl(220 6% 48%);
  --line:hsl(220 12% 91%); --surface:hsl(0 0% 100%); --surface-2:hsl(40 26% 98%); --surface-3:hsl(220 14% 95%);
  --neutral-4:hsl(220 10% 82%);

  /* ── 复合 token ── */
  --gradient-brand:linear-gradient(90deg,var(--red) 0%,var(--gold) 100%);
  --fill-live:linear-gradient(180deg,hsl(46 100% 66%),var(--gold));
  --fill-future:repeating-linear-gradient(135deg,var(--gold-wash) 0 5px,hsl(46 100% 91%) 5px 10px);
  --fill-gift:repeating-linear-gradient(90deg,var(--green-wash) 0 4px,hsl(150 45% 90%) 4px 8px);
  --shadow-card:0 1px 2px hsl(220 12% 12% / .05),0 18px 44px -16px hsl(220 12% 12% / .18);

  /* ── 排版 ── */
  --font:"PingFang SC","HarmonyOS Sans SC","Source Han Sans SC","Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;
  --fs-hero:42px; --fs-sec:13px; --fs-body:13.5px; --fs-meta:11.5px; --fs-tick:10px;
  --lh-body:1.5;

  /* ── 间距阶梯 6/10/16/22/28 ── */
  --s1:6px; --s2:10px; --s3:16px; --s4:22px; --s5:28px;

  width:560px;max-width:100%;margin:0 auto;font-family:var(--font);color:var(--ink);
  background:var(--surface);border:1px solid var(--line);border-radius:18px;overflow:hidden;
  box-shadow:var(--shadow-card);line-height:var(--lh-body);-webkit-font-smoothing:antialiased;
}
.mr *,.mr *::before,.mr *::after{box-sizing:border-box;font-variant-numeric:tabular-nums}
.mr .top-rule{height:3px;background:var(--gradient-brand)}

/* 头部 */
.mr header{padding:var(--s4) var(--s5) var(--s3);display:flex;align-items:flex-start;justify-content:space-between;gap:var(--s3)}
.mr .brand{font-size:var(--fs-sec);font-weight:700;letter-spacing:.06em;color:var(--ink)}
.mr .brand em{font-style:normal;color:var(--muted);font-weight:500;letter-spacing:0;margin-left:8px}
.mr .stamp{font-size:var(--fs-meta);color:var(--muted);text-align:right;line-height:1.45}
.mr .stamp b{color:var(--ink-2);font-weight:600}

/* 主数字区 */
.mr .hero{padding:0 var(--s5) var(--s4)}
.mr .hero-grid{display:flex;align-items:flex-end;gap:var(--s3);border-bottom:1px solid var(--line);padding-bottom:var(--s3)}
.mr .hero-num{font-size:var(--fs-hero);font-weight:800;letter-spacing:-.03em;color:var(--red);line-height:.9}
.mr .hero-num span{font-size:18px;font-weight:700;margin-left:1px}
.mr .hero-lbl{flex:1;padding-bottom:4px}
.mr .hero-lbl p{margin:0;font-size:var(--fs-body);font-weight:600;color:var(--ink)}
.mr .hero-lbl small{display:block;margin-top:3px;font-size:var(--fs-meta);color:var(--muted);font-weight:400}
.mr .meter{display:flex;gap:3px;height:8px;margin-top:var(--s3)}
.mr .meter i{display:block;border-radius:2px}
.mr .meter .m-used{background:var(--green)}
.mr .meter .m-exp{background:var(--red)}
.mr .meter .m-held{background:var(--gold)}
.mr .legend{display:flex;justify-content:space-between;margin-top:var(--s2);font-size:var(--fs-tick);color:var(--muted)}
.mr .legend b{font-weight:600;color:var(--ink-2)}
.mr .warn{margin:var(--s2) 0 0;font-size:var(--fs-meta);color:var(--red-ink);font-weight:500}
.mr .warn b{font-weight:700}

/* 时间轴 */
.mr .sec{padding:var(--s4) var(--s5) 0}
.mr .sec-h{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:var(--s3)}
.mr .sec-h h2{margin:0;font-size:var(--fs-sec);font-weight:700;letter-spacing:.04em}
.mr .chips{display:flex;gap:var(--s2);flex-wrap:wrap}
.mr .chip{font-size:var(--fs-tick);color:var(--ink-2);display:inline-flex;align-items:center;gap:4px}
.mr .chip i{width:6px;height:6px;border-radius:2px;background:var(--neutral-4)}
.mr .chip.s-now i{background:var(--green)}
.mr .chip.s-later i{background:var(--gold)}
.mr .chip.s-gift i{background:var(--green);opacity:.55}
.mr .chip.s-locked i{background:var(--neutral-4)}

.mr .ruler{position:relative;height:14px;margin-bottom:var(--s2)}
.mr .tick{position:absolute;transform:translateX(-50%);font-size:var(--fs-tick);color:var(--muted);letter-spacing:.02em}
.mr .tick:first-child{transform:none}
.mr .tick:last-child{transform:translateX(-100%)}
.mr .now-chip{position:absolute;top:0;transform:translateX(-50%);background:var(--red);color:#fff;
  font-size:var(--fs-tick);font-weight:600;padding:1px 6px;border-radius:4px;white-space:nowrap}
.mr .now-chip::after{content:"";position:absolute;left:50%;bottom:-3px;transform:translateX(-50%);
  border:3px solid transparent;border-top-color:var(--red);border-bottom:0}

.mr ul{list-style:none;margin:0;padding:0}
.mr .row{padding:var(--s2) 0 var(--s3);border-top:1px solid var(--surface-3)}
.mr .row:first-child{border-top:0}
.mr .row-top{display:flex;align-items:center;gap:var(--s2);margin-bottom:var(--s1)}
.mr .ttl{flex:1;font-size:var(--fs-body);font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mr .due{font-size:var(--fs-meta);color:var(--muted);white-space:nowrap}
.mr .pill{font-size:var(--fs-tick);font-weight:600;padding:2px 7px;border-radius:5px;white-space:nowrap;
  background:var(--surface-3);color:var(--ink-2)}
.mr .s-now .pill{background:var(--green-wash);color:var(--green)}
.mr .s-later .pill{background:var(--gold-wash);color:var(--gold-deep)}
.mr .s-gift .pill{background:var(--green-wash);color:var(--green)}
.mr .s-locked .pill{background:var(--surface-3);color:var(--muted)}
.mr .s-locked .ttl{color:var(--ink-2);font-weight:500}

.mr .track{position:relative;height:18px;border-radius:5px;background:var(--surface-3);overflow:hidden}
.mr .seg{position:absolute;top:3px;bottom:3px;border-radius:3px}
.mr .seg.live{background:var(--fill-live);box-shadow:inset 0 1px 0 hsl(48 100% 78% / .8)}
.mr .seg.future{background:var(--fill-future);border:1px solid var(--gold-line)}
.mr .seg.past{background:var(--neutral-4)}
.mr .seg.gift{background:var(--fill-gift);border:1px solid hsl(150 40% 82%)}
.mr .seg.off{background:repeating-linear-gradient(90deg,var(--line) 0 2px,transparent 2px 6px)}
.mr .needle{position:absolute;top:0;bottom:0;width:2px;background:var(--red);z-index:2;
  box-shadow:0 0 0 1.5px hsl(0 0% 100% / .85)}
.mr .row-meta{margin-top:var(--s1);font-size:var(--fs-meta);color:var(--muted)}
.mr .dot-sep{margin:0 5px;opacity:.5}

/* 行动区 */
.mr .acts{padding:var(--s4) var(--s5) 0}
.mr .acts h2{margin:0 0 var(--s2);font-size:var(--fs-sec);font-weight:700;letter-spacing:.04em}
.mr .acts li{display:flex;align-items:center;gap:var(--s2);padding:7px 0;border-bottom:1px solid var(--surface-3)}
.mr .acts li:last-child{border-bottom:0}
.mr .price{margin-left:auto;font-size:var(--fs-body);font-weight:700;color:var(--red-ink)}
.mr .hint{margin-left:auto;font-size:var(--fs-meta);color:var(--muted);white-space:nowrap}

/* 页脚 */
.mr footer{margin-top:var(--s4);padding:var(--s3) var(--s5) var(--s4);background:var(--surface-2);border-top:1px solid var(--line)}
.mr footer p{margin:0;font-size:var(--fs-tick);color:var(--muted);line-height:1.7}
.mr footer p+p{margin-top:3px}
</style>
<div class="mr">
  <div class="top-rule"></div>
  <header>
    <div class="brand">麦门雷达<em>${esc(m.reportName)}</em></div>
    <div class="stamp"><b>${esc(m.nowText)} ${esc(m.weekdayLabel)}</b><br>${esc(m.store.name)}</div>
  </header>

  <section class="hero">
    <div class="hero-grid">
      <div class="hero-num">${p.expiredPct.toFixed(1)}<span>%</span></div>
      <div class="hero-lbl">
        <p>累计赚到的积分已经作废</p>
        <small>${p.showAbsolute
          ? `共 ${p.accumulated} ${esc(p.currency)} · 花掉 ${p.used} · 作废 ${p.expired} · 在手 ${p.available}`
          : '分享版已隐去具体数值'}</small>
      </div>
    </div>
    ${p.expireThisMonth > 0 ? `<p class="warn">⚠ ${p.showAbsolute ? `本月将过期 <b>${p.expireThisMonth} 分</b>` : '本月<b>仍有积分将过期</b>'}</p>` : ''}
    <div class="meter">
      <i class="m-used" style="width:${p.usedPct.toFixed(2)}%"></i>
      <i class="m-exp" style="width:${p.expiredPct.toFixed(2)}%"></i>
      <i class="m-held" style="width:${p.heldPct.toFixed(2)}%"></i>
    </div>
    <div class="legend">
      <span>已花掉 <b>${p.usedPct.toFixed(1)}%</b></span>
      <span>已作废 <b>${p.expiredPct.toFixed(1)}%</b></span>
      <span>还在手 <b>${p.heldPct.toFixed(1)}%</b></span>
    </div>
  </section>

  <section class="sec">
    <div class="sec-h"><h2>可用窗口</h2><div class="chips">${summary}</div></div>
    <div class="ruler">${ruler}<span class="now-chip" style="left:${nowPct}%">现在 ${nowClock}</span></div>
    <ul>${rows}</ul>
  </section>

  <section class="acts"><h2>接下来</h2><ul>${acts}</ul></section>

  <footer>${foot}</footer>
</div>`;
}
