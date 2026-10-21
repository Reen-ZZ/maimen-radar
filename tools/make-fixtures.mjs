#!/usr/bin/env node
/**
 * 从本地 out/ 真实响应生成脱敏 fixtures/，供没有 Token 的人 clone 后直接跑 demo。
 *
 *   node tools/make-fixtures.mjs
 *
 * 脱敏规则（只动身份，不动业务事实）：
 *   保留：餐品名、价格、有效期结构、时段窗、星期窗、beTypes、积分口径、商城目录、活动文案
 *   替换：券码 code/couponCode、券 id 哈希、accountId、门店名与 storeCode、门店地址、traceId
 * 替换值全部由标题确定性派生，不含任何真实标识。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const hex = (s, n = 32) => createHash('sha256').update(String(s)).digest('hex').slice(0, n);
// 故意不模仿真实券码格式（MCD6C…）：样例就该一眼看出是样例，
// 否则 preflight 的形状检查要么误报、要么被削弱。
const fakeCode = (s) => `FIXTURE-COUPON-${hex(s, 8).toUpperCase()}`;
const fakeUuid = (s) => { const h = hex(s); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`.toUpperCase(); };

const STORE_MAP = { '1420721': '9000001', '1420370': '9000002' };
const STORE_NAME = { '9000001': '麦当劳（示例）天虹餐厅', '9000002': '麦当劳（示例）龙胜餐厅' };

const OUT = 'out', FIX = 'fixtures';
if (!existsSync(OUT)) { console.error('✗ 没有 out/，先跑 tools/probe-mcp.mjs'); process.exit(1); }
mkdirSync(FIX, { recursive: true });

const read = (f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'));
const write = (f, o) => { writeFileSync(join(FIX, f), JSON.stringify(o, null, 2)); console.log(`  ✓ fixtures/${f}`); };

const remapStores = (data) => JSON.parse(JSON.stringify(data).replace(/1420721|1420370/g, (m) => STORE_MAP[m]));

// 1. 券包
{
  const j = read('query-my-coupons.json');
  for (const c of j.data.coupons) {
    c.code = fakeCode(c.title);
    c.id = hex(c.title);
    c.image = 'https://example.invalid/fixture/coupon.png';
    c.bigImage = 'https://example.invalid/fixture/coupon-big.png';
    c.bindButtonGif = 'https://example.invalid/fixture/bind.gif';
    c.channelIconUrls = [];
  }
  j.traceId = hex('query-my-coupons');
  write('query-my-coupons.json', j);
}
// 2. 积分账户
{
  const j = read('query-my-account.json');
  j.data.accountId = fakeUuid('account');
  j.traceId = hex('query-my-account');
  write('query-my-account.json', j);
}
// 3. 收藏门店
{
  const j = read('query-nearby-stores.json');
  for (const s of j.data) {
    s.storeCode = STORE_MAP[s.storeCode] ?? s.storeCode;
    s.storeName = STORE_NAME[s.storeCode] ?? s.storeName;
    s.address = '示例市示例区示例路 1 号';
    s.longitude = 0; s.latitude = 0;
  }
  j.traceId = hex('query-nearby-stores');
  write('query-nearby-stores.json', j);
}
// 4. 门店级菜单：每家一份，文件名带 storeCode（响应里不自报门店，来源只能写在名字上）
// ⚠ 只认 `meals.<纯数字>.json`。out/ 里还会有按时段另存的那几份
//    （`meals.1420721.breakfast-2026-10-21T0730.json` 等，探针 ④ 的取证），
//    它们是「另一个时段的本店菜单」，不是另一家店，也不是当前样本源 —— 跳过并说明，
//    否则这里会在 `.match(...)[1]` 上抛 TypeError 把整个生成打断（2026-10-21 实测）。
for (const f of readdirSync(OUT).filter((x) => x.startsWith('meals.'))) {
  const hit = f.match(/^meals\.(\d+)\.json$/);
  if (!hit) { console.log(`  · 跳过 out/${f}（按时段/别名另存的证据，不是「这家店当前菜单」的样本源）`); continue; }
  const j = read(f);
  j.traceId = hex(f);
  write(`meals.${STORE_MAP[hit[1]] ?? hit[1]}.json`, j);
}
// 5. 两家门店的可用券
for (const f of readdirSync(OUT).filter((x) => x.startsWith('store-coupons.'))) {
  const hit = f.match(/^store-coupons\.(\d+)\.json$/);
  if (!hit) { console.log(`  · 跳过 out/${f}（命名不是 store-coupons.<门店码>.json）`); continue; }
  const j = read(f);
  for (const c of j.data ?? []) {
    c.couponCode = fakeCode(c.title);
    c.couponId = hex(c.title);
    if (Array.isArray(c.products)) for (const p of c.products) delete p.productUrl;
  }
  j.traceId = hex(f);
  write(`store-coupons.${STORE_MAP[hit[1]] ?? hit[1]}.json`, remapStores(j));
}
// 6. 其余只读接口
for (const f of ['now-time-info.json', 'available-coupons.json', 'campaign-calendar.json', 'mall-points-products.json']) {
  if (!existsSync(join(OUT, f))) continue;
  const j = read(f);
  j.traceId = hex(f);
  write(f, j);
}

console.log('\n生成完毕。跑 node src/preflight.mjs 确认 fixtures 里没有真实敏感值。');
