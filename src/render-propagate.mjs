/**
 * 传播版渲染器 —— 发进群拉新的物料，与 render-html.mjs 的账单版分工不同
 *
 * 账单版是给自己看的：信息密度优先。传播版是给别人看的：3 秒内看清结论、然后馋。
 * 只吃 buildModel 输出，不碰原始响应（与另一张卡同一条架构约束）。
 *
 * 三条由实测决定的设计约束（2026-10-20，见 docs 记录）：
 *   1. 取图优先券自带 couponImage —— 实测 4/4 覆盖、语义精确，且覆盖「任选」类菜单无 SKU 的券
 *   2. 最小字号 14px —— 现状卡 10px 在微信群 300px 显示宽度下实测不可读
 *   3. 金色取官方下发的 tagColors，红色官方不稳定下发故写死（真实数据里只出现过金色）
 */
import { pickTop1 } from './model.mjs';
import { banter, quip } from './tone.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STATE_LABEL = { now: '现在能吃', later: '晚点能', locked: '今天别去', gift: '送人止损' };
const OFFICIAL_GOLD = '#FFBC0D';
const OFFICIAL_RED = '#DB0007';

/** 券名去噪核：去掉价格前缀与「买一送一/任选2」这类后缀，留下可对齐菜单实体的部分 */
const coreOf = (title) => String(title)
  .replace(/^[0-9]+(?:\.[0-9]+)?元/, '').replace(/^人气/, '')
  .replace(/(买一送一|任选\d|两件套|三件套|中杯|大杯|小杯)$/g, '');
const COMBO = /件套|拼盘|任选|全家桶|组合|套餐/;

/**
 * 取图降级链。③ 用券名模糊匹配菜单实体 —— 图配错顶多难看，所以允许模糊；
 * 价格口径绝不许走这条路（券侧名 ≠ 菜单侧名，见 references/fields.md）。
 */
function resolveImg(c, m) {
  if (c.couponImage) return c.couponImage;
  if (c.ladderProduct?.image) return c.ladderProduct.image;
  const mp = (c.matchedProducts ?? []).find((x) => x.image);
  if (mp) return mp.image;
  const core = coreOf(c.displayTitle);
  if (core.length >= 2) {
    const hits = m.meals.filter((x) => x.image && !COMBO.test(x.name) && (x.name.includes(core) || core.includes(x.name.slice(0, 4))));
    if (hits.length) return hits.sort((a, b) => a.name.length - b.name.length)[0].image;
  }
  return null;
}

const short = (t) => String(t).replace(/^[0-9]+(?:\.[0-9]+)?元/, '').replace(/^人气/, '');

const bag = (gold, red) => `<svg viewBox="0 0 64 64" class="bag" aria-label="暂无官方图"><rect x="14" y="20" width="36" height="36" rx="3" fill="${gold}" opacity=".22"/><path d="M22 20l10-9 10 9" fill="none" stroke="${gold}" stroke-width="3"/><text x="32" y="46" font-size="20" text-anchor="middle" fill="${red}" font-weight="700">?</text></svg>`;

const thumb = (url, alt, gold, red) => url
  ? `<img class="thumb" src="${esc(url)}" alt="${esc(alt)}" loading="eager">`
  : `<span class="thumb tile">${bag(gold, red)}</span>`;

function row(c, m, gold, red) {
  const line = quip(c, m.now);
  return `<li class="row s-${c.state}">
    ${thumb(resolveImg(c, m), c.displayTitle, gold, red)}
    <div class="rmain"><p class="rname">${esc(short(c.displayTitle))}</p><p class="rbant">${esc(line)}</p></div>
    <div class="rright">${c.couponPrice ? `<b class="rprice">¥${c.couponPrice}</b>` : '<b class="rprice na">—</b>'}
      <span class="rpill">${STATE_LABEL[c.state]}</span></div>
  </li>`;
}

export function renderPropagate(m) {
  const { top1 } = pickTop1(m);
  const rest = m.coupons.filter((c) => c !== top1?.coupon).slice(0, 3);
  const gold = m.coupons.some((c) => (c.tagColors ?? []).includes(OFFICIAL_GOLD)) ? OFFICIAL_GOLD : 'hsl(44 100% 53%)';
  const red = OFFICIAL_RED;
  // 发群卡写死匿名称谓，不看 m.share —— 这张的结构就不许印店名，少一个开关少一种漏
  const storeLabel = '这家麦当劳';
  const band = top1?.coupon.couponBand ?? null;
  const heroImg = top1 ? resolveImg(top1.coupon, m) : null;

  const pts = m.points.foodEquiv
    ? `<p class="pt">作废积分 ≈ <span class="ptnum">${m.points.foodEquiv.count}</span> ${esc(m.points.foodEquiv.unit)}<em>${'🍔'.repeat(Math.min(8, Math.max(1, m.points.foodEquiv.count)))}</em></p>
       <p class="ptnote">你作废的 ${m.points.expired} ${esc(m.points.currency)}，按「${esc(m.points.foodEquiv.anchor)}」保守折算</p>`
    : `<p class="pt">你赚到的积分里，<span class="ptnum">${m.points.expiredPct.toFixed(1)}%</span> 已经作废</p>
       <p class="ptnote">共 ${m.points.accumulated} ${esc(m.points.currency)} · 花掉 ${m.points.used} · 在手 ${m.points.available}</p>`;

  return `<style>
.mp{
  --red:${red}; --gold:${gold}; --red-wash:${red}14; --gold-wash:${gold}2e;
  --ink:#1a1a1a; --ink-2:#4a4a4a; --muted:#7a7a7a; --line:#e8e6e3;
  --fs-title:23px; --fs-hero:66px; --fs-name:21px; --fs-body:15px; --fs-meta:14px;
  width:560px;max-width:100%;margin:0 auto;font-family:"PingFang SC","HarmonyOS Sans SC","Source Han Sans SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;
  color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:20px;overflow:hidden;line-height:1.5;
  box-shadow:0 2px 4px rgba(0,0,0,.04),0 20px 50px -18px rgba(0,0,0,.22);-webkit-font-smoothing:antialiased;
}
.mp *,.mp *::before,.mp *::after{box-sizing:border-box;font-variant-numeric:tabular-nums}
.mp .rule{height:4px;background:linear-gradient(90deg,var(--red) 0%,var(--gold) 100%)}
.mp .head{padding:20px 26px 0}
.mp .hook{margin:0;font-size:var(--fs-title);font-weight:800;letter-spacing:-.01em}
.mp .hook b{color:var(--red)}
.mp .meta{margin:6px 0 0;font-size:var(--fs-meta);color:var(--muted)}
.mp .hero{margin:18px 26px 0;border-radius:16px;overflow:hidden;border:1px solid var(--gold-wash)}
.mp .hband{display:block;width:100%;height:auto;background:#eef4f8}
.mp .htext{display:flex;align-items:center;gap:14px;padding:16px 18px;
  background:radial-gradient(120% 140% at 88% 20%,var(--gold-wash) 0%,var(--red-wash) 55%,#fff 100%)}
.mp .hleft{flex:1;min-width:0}
.mp .badge{display:inline-block;background:var(--red);color:#fff;font-size:var(--fs-meta);font-weight:700;
  letter-spacing:.06em;padding:4px 12px;border-radius:999px;margin-bottom:8px}
.mp .hname{margin:0 0 2px;font-size:var(--fs-name);font-weight:800}
.mp .hprice{margin:0;font-size:var(--fs-hero);font-weight:900;letter-spacing:-.04em;color:var(--red);line-height:.92}
.mp .hprice span{font-size:26px;margin-right:2px}
.mp .hgain{display:inline-block;margin-top:8px;padding:3px 10px;border-radius:999px;background:#fff;
  border:1px solid var(--line);font-size:var(--fs-meta);font-weight:600;color:var(--ink-2)}
.mp .hban{margin:10px 0 0;font-size:var(--fs-body);color:var(--ink-2);font-weight:600}
.mp .himg,.mp .hero .tile{width:132px;height:132px;flex:none;object-fit:contain;filter:drop-shadow(0 10px 16px rgba(0,0,0,.14))}
.mp .tile{display:inline-flex;border-radius:12px;background:var(--gold-wash)}
.mp .bag{width:100%;height:100%}
.mp .note{margin:0;padding:9px 18px 11px;background:#faf9f8;border-top:1px solid var(--line);
  font-size:var(--fs-meta);color:var(--muted)}
.mp .note b{color:var(--ink-2);font-weight:600}
.mp .sec{padding:22px 26px 0}
.mp .sec-h{margin:0 0 8px;font-size:var(--fs-meta);font-weight:800;letter-spacing:.1em;color:var(--muted)}
.mp ul{list-style:none;margin:0;padding:0}
.mp .row{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid #f2f0ee}
.mp .row:first-of-type{border-top:0}
.mp .thumb{width:56px;height:56px;flex:none;border-radius:12px;background:var(--gold-wash);object-fit:contain}
.mp .rmain{flex:1;min-width:0}
.mp .rname{margin:0;font-size:var(--fs-body);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp .rbant{margin:2px 0 0;font-size:var(--fs-meta);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp .rright{text-align:right;flex:none}
.mp .rprice{display:block;font-size:var(--fs-body);font-weight:800;color:var(--red)}
.mp .rprice.na{color:var(--muted)}
.mp .rpill{font-size:var(--fs-meta);color:var(--ink-2)}
.mp .s-locked .rname,.mp .s-locked .rprice{color:var(--muted)}
.mp .pts{margin:20px 26px 0;padding:16px 18px;border-radius:14px;background:#fffaf0;border:1px dashed var(--gold)}
.mp .pt{margin:0;font-size:var(--fs-body);font-weight:700}
.mp .ptnum{font-size:34px;font-weight:900;color:var(--red);letter-spacing:-.03em;margin:0 4px}
.mp .pt em{font-style:normal;margin-left:8px;font-size:18px}
.mp .ptnote{margin:6px 0 0;font-size:var(--fs-meta);color:var(--muted)}
.mp footer{margin-top:22px;padding:16px 26px 20px;background:#1a1a1a}
.mp .cta{margin:0;font-size:16px;font-weight:800;color:#fff}
.mp .cta b{color:var(--gold)}
.mp .legal{margin:5px 0 0;font-size:var(--fs-meta);color:#b9b6b2}
</style>
<div class="mp">
  <div class="rule"></div>
  <div class="head">
    <p class="hook">${top1 ? '今晚吃<b>这张</b>。' : '今晚<b>全灭</b>。'}</p>
    <p class="meta">麦门雷达 · ${esc(m.reportName)} · ${esc(storeLabel)} · ${esc(m.nowText)} ${esc(m.weekdayLabel)}</p>
  </div>

  <section class="hero">
    ${band ? `<img class="hband" src="${esc(band)}" alt="${esc(top1.coupon.displayTitle)} 官方券面图" loading="eager">` : ''}
    <div class="htext">
      <div class="hleft">
        ${top1 ? '<span class="badge">麦门认证 · 今晚必吃</span>' : ''}
        <p class="hname">${top1 ? esc(short(top1.coupon.displayTitle)) : '此刻没有能刷的券'}</p>
        <p class="hprice">${top1?.coupon.couponPrice ? `<span>¥</span>${top1.coupon.couponPrice}` : '—'}</p>
        ${top1 ? `<span class="hgain">比菜单现价省 ¥${(top1.gain ?? 0).toFixed(1)} · ${esc(top1.coupon.countdown)}</span>` : ''}
        <p class="hban">${esc(top1 ? banter('hero_pick') : banter('all_dead'))}</p>
      </div>
      ${!band && top1 ? (heroImg ? `<img class="himg" src="${esc(heroImg)}" alt="${esc(top1.coupon.displayTitle)}" loading="eager">` : `<span class="himg tile">${bag(gold, red)}</span>`) : ''}
    </div>
    ${band ? `<p class="note"><b>关于这张券面图</b>：${esc(banter('band_note'))}</p>` : ''}
  </section>

  ${rest.length ? `<section class="sec">
    <p class="sec-h">手里还剩 ${m.coupons.length - 1} 张</p>
    <ul>${rest.map((c) => row(c, m, gold, red)).join('')}</ul>
  </section>` : ''}

  <section class="pts">${pts}</section>

  <footer>
    <p class="cta">对着你的 AI 说一句 <b>「权益账单」</b>，就有这张</p>
    <p class="legal">数据来自麦当劳官方接口 · 价格与有效期以 App 实时结果为准 · 门店已匿名</p>
  </footer>
</div>`;
}
