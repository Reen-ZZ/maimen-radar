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
for (const f of readdirSync(OUT).filter((x) => x.startsWith('meals.'))) {
  const j = read(f);
  j.traceId = hex(f);
  const old = f.match(/^meals\.(\d+)\.json$/)[1];
  write(`meals.${STORE_MAP[old] ?? old}.json`, j);
}
// 5. 两家门店的可用券
for (const f of readdirSync(OUT).filter((x) => x.startsWith('store-coupons.'))) {
  const j = read(f);
  for (const c of j.data ?? []) {
    c.couponCode = fakeCode(c.title);
    c.couponId = hex(c.title);
    if (Array.isArray(c.products)) for (const p of c.products) delete p.productUrl;
  }
  j.traceId = hex(f);
  const old = f.match(/(\d+)\.json$/)[1];
  write(`store-coupons.${STORE_MAP[old] ?? old}.json`, remapStores(j));
}
// 6. 其余只读接口
for (const f of ['now-time-info.json', 'available-coupons.json', 'campaign-calendar.json', 'mall-points-products.json']) {
  if (!existsSync(join(OUT, f))) continue;
  const j = read(f);
  j.traceId = hex(f);
  write(f, j);
}

console.log('\n生成完毕。跑 node src/preflight.mjs 确认 fixtures 里没有真实敏感值。');
