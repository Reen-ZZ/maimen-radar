#!/usr/bin/env node
/**
 * 一致性断言：模型判为「现在能用」的集合，必须等于官方 query-store-coupons 的返回集合。
 * 这是 SKILL.md 第二步的完成判据 —— 跑不过就不许把结果念给用户。
 *
 *   node src/check.mjs
 *
 * 门店对从数据目录自动发现（out/ 或 fixtures/），不硬编码 storeCode。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { load, loadScoped, sourceDir } from './data.mjs';
import { buildModel, pickTop1, pickThree, peripherySignal, isPeriphery } from './model.mjs';
import { renderText } from './render-text.mjs';

const DIR = sourceDir();
if (!DIR) { console.error('✗ 没有 out/ 或 fixtures/'); process.exit(1); }
// 闸门要按名字读源码与文档（T20 三处理由、【出口】起子进程），根路径必须先定义
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const own = load('query-my-coupons.json');
const accountRaw = load('query-my-account.json');
// 菜单不再全局取一份：它是门店级响应，每家店必须用**自己**的那份，否则算的是别家的价
const stores = load('query-nearby-stores.json');
const storeFiles = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.startsWith('store-coupons.')) : [];

if (!storeFiles.length) {
  console.error(`✗ ${DIR}/ 下没有 store-coupons.*.json，无法做一致性校验`);
  process.exit(1);
}

let fail = 0;
const built = [];
console.log(`数据来源：${DIR}/\n`);

const setDiff = (a, b) => [...a].filter((x) => !b.has(x));

for (const f of storeFiles) {
  const code = f.match(/store-coupons\.(.+)\.json$/)[1];
  const official = load(f).data ?? [];
  const meta = (stores.data ?? []).find((s) => String(s.storeCode) === code);

  // 菜单必须按店取：这一家没有自己的快照就判红，绝不退回手边别家的价目表
  let meals;
  try { meals = loadScoped('meals', code); } catch (e) {
    console.log(`✗ ${code} 一致性无从判起 —— ${e.message}`);
    fail++;
    continue;
  }

  const model = buildModel({ couponsRaw: own, accountRaw, mealsRaw: meals, sceneBeType: 1,
    storeCouponsRaw: load(f),
    store: meta ? { code, name: meta.storeName } : { code, name: '(未知门店)' } });
  built.push({ code, name: meta?.storeName ?? '(未知门店)', meals, model });

  // 主口径：key（券包 id）vs couponId。两者同源性未经真实调用交叉验证（fixtures 里
  // 两者都被替换成同一哈希，必然对得上），所以用券名做回退比对兜底：
  //   键集合不相交但券名一致 → 降级为警告（同源性待真实数据验证）
  //   券名也不一致 → 真失败
  const mineKeys = new Set(model.coupons.filter((x) => x.state === 'now').map((x) => x.key));
  const theirKeys = new Set(official.map((x) => x.couponId));
  const mineTitles = new Set(model.coupons.filter((x) => x.state === 'now').map((x) => x.title));
  const theirTitles = new Set(official.map((x) => x.title).filter(Boolean));
  const keySpaceShared = mineKeys.size === 0 || theirKeys.size === 0
    || setDiff(mineKeys, theirKeys).length < mineKeys.size || setDiff(theirKeys, mineKeys).length < theirKeys.size;

  const onlyMineTitles = setDiff(mineTitles, theirTitles);
  const onlyTheirsTitles = setDiff(theirTitles, mineTitles);
  const ok = !onlyMineTitles.length && !onlyTheirsTitles.length;
  console.log(`${ok ? '✓' : '✗'} ${code} ${meta?.storeName ?? ''}  官方放行 ${theirKeys.size} 张 / 模型判 now ${mineKeys.size} 张`);
  if (ok && !keySpaceShared) {
    console.log('    ⚠ 键空间不相交：id 与 couponId 同源性未经验证，本次按券名比对一致（真实数据下需复核）');
  }
  if (onlyMineTitles.length) console.log(`    模型多判（官方滤掉了，我们说能用）: ${onlyMineTitles.join(', ')}`);
  if (onlyTheirsTitles.length) console.log(`    模型漏判（官方说能用，我们说不能）: ${onlyTheirsTitles.join(', ')}`);
  if (!ok) fail++;

  // C5：top1 必须 ∈ 官方放行集合（docs/plans/2026-10-19-eat-this.md §8.1）
  const top = pickTop1(model);
  if (top.top1) {
    const inSet = theirKeys.has(top.top1.coupon.key);
    console.log(`  ${inSet ? '✓' : '✗'} top1 ∈ 官方放行集合：${top.top1.coupon.title}（省 ¥${top.top1.gain?.toFixed(1)}）`);
    if (!inSet) fail++;
  } else if (keySpaceShared) {
    console.log(`  · top1 未产出（${top.fallback}${top.fallback === 'no_price' ? '：' + (top.outcast ?? []).join('、') : ''}）`);
  }
}

/**
 * 【三轨】② ③ 两条轨的候选集合与不变量（docs/plans/2026-10-20-eat-three-tracks.md T5）。
 * **每家店都必须跑**：周边漏判（`521955 麦当劳联名徽章`）只在 1420370 出现，
 * 只测一家店时，删掉名字表或 tag 表都不会报错，漏判要等官方改名那天才暴露。
 */
console.log('\n【三轨】候选集合与轨道不变量');
for (const { code, meals, model } of built) {
  const say = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${code} ${msg}`); if (!cond) fail++; };
  const cat = meals?.data?.categories ?? [];
  const dict = meals?.data?.meals ?? {};

  // ② 轨候选 == 「分类名（去换行）含 1+1」那一档的商品集合 —— 实体名里没有「1+1」，只能这么认
  const inComboCat = new Set(cat.filter((c) => /1\+1/.test(String(c.name ?? '').replace(/\n/g, '')))
    .flatMap((c) => c.meals ?? []).map((r) => r.code).filter((x) => dict[x]));
  const listed = new Set(model.comboOffers.map((o) => o.code));
  say(inComboCat.size === listed.size && [...inComboCat].every((x) => listed.has(x)),
    `1+1 候选 == 分类名含「1+1」那档的商品集合（${[...listed].join('、') || '该时段没有这一档'}）`);
  say(model.comboOffers.every((o) => Number.isFinite(o.base) && o.base > 0),
    '每个 1+1 候选都带自己的基准价（断链的项不产出，更不许编价）');

  // ③ 轨候选 == tag 精确「上新」；近似 tag（新升级/清爽上新/韩式芝士风味酱上新）语义不纯，不许误计
  const tagged = new Set();
  for (const c of cat) for (const r of c.meals ?? []) if ((r.tags ?? []).includes('上新') && dict[r.code]) tagged.add(r.code);
  const news = new Set(model.newItems.map((x) => x.code));
  say(tagged.size === news.size && [...tagged].every((x) => news.has(x)),
    `上新清单 == tag 精确「上新」的商品集合（${news.size} 条）`);

  const three = pickThree(model);
  if (three.item) {
    const it = three.item;
    say(!it.periphery && !it.goldPriced && it.discounted,
      `③ 选出的「${it.name}」同时过了三道闸（非周边 / 非麦金卡价 / 现价<原价）`);
    say(it.save === +((it.orig - it.cur).toFixed(1)) && !/\.\d{3,}/.test(String(it.save)),
      `③ 省额按实体自己的 code 算并 toFixed（¥${it.save}，不留浮点尾巴）`);
  } else {
    console.log(`· ${code} 上新 ${news.size} 条里没有「能吃的且有折扣」的（③ 轨整条不出，不留空行）`);
  }
  if (three.coupon && three.combo) {
    say(three.combo.save === three.coupon.gain,
      `② 的券省 == ① 的真省（¥${three.combo.save}）—— 1+1 那 ¥${three.combo.base} 分文不参与减法`);
    if (three.combo.total != null) {
      say(three.combo.total === +(three.combo.base + three.coupon.couponPrice).toFixed(1),
        `② 合计 == 该款自己的基准价 + 券价（¥${three.combo.total}）`);
    } else {
      console.log(`· ${code} ② 轨读到 (a) 读法（1+1 里那件能用券）→ 合计从未取证，只报单品价`);
    }
    // D13=②：先跟 frequent，锚点不命中才按到手价升序
    if (three.combo.via === 'priceAsc') {
      say(three.combo.base === Math.min(...model.comboOffers.map((o) => o.base)),
        '② 走兜底分支时选的确实是到手价最低那款（frequent 缺失是常态，不是备胎）');
    } else {
      say(three.combo.code === model.frequent?.code, '② 跟的是官方 frequent 指向的那款');
    }
  }
}

// 两条周边信号线各自都命中过（合着看：单店可能天然缺一种，缺到哪条表就白名单失效）
{
  const sigs = built.flatMap(({ model }) => model.newItems.map((x) => peripherySignal(x.name, x.tags)));
  const byName = sigs.filter((s) => s === 'name').length;
  const byTag = sigs.filter((s) => s === 'tag').length;
  const okBoth = byName > 0 && byTag > 0;
  console.log(`${okBoth ? '✓' : '✗'} 周边两条信号线独立命中过：只靠名字的 ${byName} 件 / 只靠 tag 的 ${byTag} 件`);
  if (!okBoth) fail++;
  else console.log('    · 删掉任一条表都会漏判：521955 徽章只靠名字、521946 星愿贴只靠 tag');
}

/**
 * 【D15=②】账单给全量、今天吃啥只给能吃的 —— 这处分叉必须**被跑出来**，不能只写在文档里。
 * 判据取自账单的**真实产物**（`renderText` 的 🆕 段），不是再算一遍模型字段：
 * 否则"账单其实也滤掉了周边"这种回归，模型层看不出来。
 */
console.log('\n【周边分叉】账单全量 vs 今天吃啥只给能吃的（D15=②）');
const BADGE_CODE = '521955';
for (const { code, meals, model } of built) {
  const say = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${code} ${msg}`); if (!cond) fail++; };
  const lines = renderText(model).split('\n');
  const hi = lines.findIndex((l) => l.startsWith('🆕 上新'));
  const seg = hi < 0 ? [] : lines.slice(hi + 1, lines.indexOf('', hi + 1) < 0 ? undefined : lines.indexOf('', hi + 1));
  const claimed = hi < 0 ? null : Number((lines[hi].match(/(\d+)\s*项/) ?? [])[1]);
  const rows = model.newItems;
  const peris = rows.filter((x) => x.periphery);
  const three = pickThree(model);
  // 用 pickThree **真正选出来的池子**，不在闸门里重算一遍"正确答案"
  const poolCodes = new Set(three.newPool.map((x) => x.code));

  if (!rows.length) { console.log(`· ${code} 这一代菜单里没有「上新」，本段跳过`); continue; }
  say(hi >= 0 && claimed === rows.length,
    `账单 🆕 段印了 ${claimed ?? '∅'} 项 == 菜单上新全量 ${rows.length}（**周边照印**，账单答「这期有什么」）`);
  say(peris.length > 0 && peris.every((p) => seg.some((l) => l.includes(p.name.slice(0, 4)))),
    `账单段里数得到 ${peris.length} 件周边（${peris.map((p) => p.name.slice(0, 6)).join('、')}）—— 名称按前 4 字比对，账单会把长名截断`);
  if (peris.length) {
    say(three.newPool.length < rows.length,
      `今天吃啥只留 ${three.newPool.length} 条能吃的（账单 ${rows.length} 条）→ **两处条数确实不同**（裁的是②，不许被"统一"掉）`);
    say(peris.every((p) => !poolCodes.has(p.code)),
      `没有一件周边漏进「今天吃啥」的新品轨候选池${peris.some((p) => poolCodes.has(p.code)) ? ` → 漏进：${peris.filter((p) => poolCodes.has(p.code)).map((p) => p.name).join('、')}` : ''}`);
  }
  // 按 code 钉死那件"名字与 tag 都没有信号就漏判"的样本：它只在其中一家店出现
  const badge = rows.find((x) => x.code === BADGE_CODE);
  if (badge) {
    say(badge.periphery && !poolCodes.has(badge.code),
      `★ ${BADGE_CODE} ${badge.name} 必须被排除（二轮复查前它带着「省 ¥5」混进新品轨）`);
    say(peripherySignal(badge.name, ['上新']) === 'name',
      '★ 它只靠名字表里的「徽章」命中——官方给的 tag 就只有 ["上新"]，tag 表帮不上');
  } else {
    console.log(`· ${code} 菜单里没有 ${BADGE_CODE}（那件只在 1420370 出现过）`);
  }
}
// 把"这是易碎启发式"钉成一条可跑的断言，而不是只在注释里提醒
{
  const renamed = isPeriphery('旋旋纪念册', ['上新']);
  console.log(`${!renamed ? '✓' : '✗'} 官方一旦把周边改名到两张表都不命中（试算「旋旋纪念册」+ tag 仅 ["上新"]），规则就会漏判 —— 所以这条闸门的存在比规则本身重要`);
  if (renamed) fail++;
}
/*
  T20：D15 裁的是"两处筛法不同"，而**读代码的人看不出这是有意的**——上一轮就差点被当成
  bug 统一掉。所以理由必须写在三处（排除逻辑的注释、SKILL.md、fields.md），且缺任何一处就判红。
  这是"文档也进闸门"的第二例（第一例是 check-store.mjs 的【口径路由表】）。
*/
{
  const where = [
    ['src/model.mjs', /这期有什么|账单答/],
    ['SKILL.md', /筛法不同|两处的筛法不同|是有意/],
    ['references/fields.md', /筛法不同|两处.{0,20}不同/],
  ];
  for (const [f, re] of where) {
    let hit = false;
    try { hit = re.test(readFileSync(join(ROOT, f), 'utf8')); } catch { hit = false; }
    console.log(`${hit ? '✓' : '✗'} T20：${f} 写明了「账单不排除周边」是有意分叉`);
    if (!hit) fail++;
  }
}

/**
 * 【出口】eat.mjs 真跑一遍。用户看到的只有这段产物，模型层对了不代表话术对了：
 *   5 行上限 / 三条轨的编号 / 不贴官方图 / 末行归属与在场轨道一致 / 券码不得出现在任何输出里。
 * 最后这条是缺陷⑧ 的守卫：旧 --json 直接展开模型结果，把原始响应里的**可核销券码明文**
 * 打到 stdout（preflight 的形状正则只认 MCD6C… 前缀，抓不到），所以这里拿真实券码逐个比对。
 */
console.log('\n【出口】eat.mjs 的产物');
const realCodes = (own?.data?.coupons ?? []).map((c) => c?.code).filter(Boolean);
for (const { code, name } of built) {
  const run = (args) => {
    try {
      return execFileSync(process.execPath, ['src/eat.mjs', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    } catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? ''); }
  };
  const text = run(['--store', code]);
  const json = run(['--store', code, '--json']);
  const body = (text.includes('\n\n') ? text.slice(0, text.indexOf('\n\n')) : text).split('\n').filter(Boolean);
  const say = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${code} ${msg}`); if (!cond) fail++; };
  const leaked = realCodes.filter((c) => text.includes(c) || json.includes(c));
  say(!leaked.length, `正文与 --json 里都没有可核销券码（比对 ${realCodes.length} 张券的真实 code，不靠形状正则）${leaked.length ? ` → 泄漏 ${leaked.length} 处` : ''}`);
  say(body.length <= 5, `正文 ${body.length} 行，未超输出纪律 ≤5 行`);
  say(!/^\s*门店：/m.test(text), '没有独立的「门店：」行（D12=④：店名在标题行里）');
  say(!/https?:/.test(text), `正文里没有图链（官方 image 只进 --json）`);
  const lineOf = (m) => body.find((l) => l.startsWith(`   ${m}`));
  say(!!lineOf('①'), `① 券轨在，且报的是「真省」：${(lineOf('①') ?? '').replace(/^\s*① /, '')}`.slice(0, 110));
  say(!lineOf('②') || lineOf('②').includes('随心配'), '② 轨用「1+1随心配」措辞，不承诺具体构成');
  const tail = body.at(-1) ?? '';
  if (lineOf('②')) say(/①② 用的那张券/.test(tail), '末行归属点名给带券的两条轨（③ 新品没券，不受它约束）');
  else if (body.length > 1) say(/① 用的那张券/.test(tail), '② 缺席时末行编号跟着变成「①」（不写死 ①②）');
  console.log(`    ${name} → ${body[0] ?? ''}`);
}

// 缺陷报告 MCD-DEF-001 离线断言：out/quote.*.json 检查券码掩码 + 样本有效性
// （不打网络，用现成样本；out/ 不入库，本断言只在有真实数据的机器上有意义）
if (existsSync('out')) {
  const quoteFiles = readdirSync('out').filter((f) => f.startsWith('quote.'));
  for (const f of quoteFiles) {
    try {
      const q = JSON.parse(readFileSync(join('out', f), 'utf8'));
      const d = Number(q?.data?.discount);
      const text = readFileSync(join('out', f), 'utf8');
      const leakedCodes = realCodes.filter((c) => text.includes(c));
      if (leakedCodes.length) { console.log(`✗ quote 样本 ${f}: 落盘里含 ${leakedCodes.length} 处真实券码（掩码失效）`); fail++; continue; }
      const masked = !/MCD[0-9A-Z]{10,}/.test(JSON.stringify(q));
      if (!masked) { console.log(`✗ quote 样本 ${f}: 券码明文泄漏`); fail++; continue; }
      if (q?.success !== true) {
        console.log(`✗ quote 样本 ${f}: 是失败响应（code=${q?.code}），属缺陷 B 化石，应删除该文件（失败样本现在落 quote-error.*）`);
        fail++; continue;
      }
      if (!(d > 0)) {
        console.log(`✗ quote 样本 ${f}: discount=0（无券基线或券未生效）——基线请移出 quote. 前缀，未生效样本不该落盘`);
        fail++; continue;
      }
      console.log(`✓ quote 样本 ${f}: success=true discount=${(d / 100).toFixed(1)}元 券码掩码=✓`);
    } catch { /* 样本损坏不阻塞其它断言 */ }
  }
  /**
   * 失败样本（缺陷⑥ 修完才会有）。它们不参与上面"成功样本"的口径校验——
   * 排障要看的恰恰是服务端拒了什麼，而前缀 `quote-error.` 与 `quote.` 一眼分得开。
   * 这里只验两件事：掩码没失守、以及它确实是一次失败（不是被误命名的成功）。
   */
  const errFiles = readdirSync('out').filter((f) => f.startsWith('quote-error.'));
  for (const f of errFiles) {
    try {
      const text = readFileSync(join('out', f), 'utf8');
      const q = JSON.parse(text);
      const leakedCodes = realCodes.filter((c) => text.includes(c));
      const body = q?.response ?? q;
      const isFail = q?._failed === true || body?.success === false || (body?.code != null && Number(body.code) !== 200);
      const good = !leakedCodes.length && isFail;
      console.log(`${good ? '✓' : '✗'} 失败样本 ${f}: ${isFail ? `code=${body?.code ?? '（我方闸门拦下）'}` : '不是失败响应，该改名成 quote.*'}${leakedCodes.length ? ` → 含 ${leakedCodes.length} 处真实券码` : ' 券码掩码=✓'}`);
      if (!good) fail++;
    } catch { /* 样本损坏不阻塞其它断言 */ }
  }
  if (errFiles.length) console.log(`  · 失败样本 ${errFiles.length} 份（缺陷⑥ 之前 catch 分支根本不落盘）`);
}

const p = accountRaw.data;
const sum = Number(p.usedPoint) + Number(p.expiredPoint) + Number(p.availablePoint);
const closed = Math.abs(sum - Number(p.accumulativePoint)) < 0.01;
console.log(`${closed ? '✓' : '✗'} 积分三向闭合  ${p.usedPoint} + ${p.expiredPoint} + ${p.availablePoint} = ${sum.toFixed(1)} vs accumulative ${p.accumulativePoint}`);
if (!closed) fail++;

console.log(fail ? `\n${fail} 项不通过` : '\n全部通过');
process.exit(fail ? 1 : 0);
