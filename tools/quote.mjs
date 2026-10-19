#!/usr/bin/env node
/**
 * 到手价通道 —— calculate-price（只读算价，非下单）。
 *
 *   node tools/quote.mjs --store 1420721 --coupon 0            # 券包第 0 张，商品取门店券匹配
 *   node tools/quote.mjs --store 1420721 --coupon-id <id> --items 1440x1
 *
 * 硬约束（docs/plans/2026-10-19-eat-this.md §5）：
 *   1. 入参绝不回显 —— 券码可核销，进了对话记录就是泄漏；
 *   2. 券码只在内存 —— 不写 out/ 明文、不进日志/state，结果落盘前 couponCode 掩码；
 *   3. 失败回退 —— 服务端拒（600010 等）时按菜单现价估算，并明说"以 App 结算为准"；
 *   4. 本工具只算价 —— 响应里即使出现可下单的购物车态，也绝不自动 create-order。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

const store = argOf('--store');
const couponIdx = argOf('--coupon');
const couponIdArg = argOf('--coupon-id');
const itemsArg = argOf('--items');

if (!store || (couponIdx == null && !couponIdArg)) {
  console.error('用法: node tools/quote.mjs --store <storeCode> (--coupon <券包序号> | --coupon-id <id>) [--items 1440x1,507411x2]');
  process.exit(2);
}

function loadToken() {
  if (process.env.MCD_MCP_TOKEN) return process.env.MCD_MCP_TOKEN;
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?MCD_MCP_TOKEN\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

const TOKEN = loadToken();
if (!TOKEN) {
  console.error('✗ 未找到 MCD_MCP_TOKEN（.env 或环境变量）。Token 不回显、不进对话。');
  process.exit(1);
}

const read = (f) => existsSync(join(ROOT, f)) ? JSON.parse(readFileSync(join(ROOT, f), 'utf8')) : null;
const mask = (s) => { const t = String(s ?? ''); return t.length <= 8 ? '•'.repeat(t.length) : t.slice(0, 3) + '•'.repeat(t.length - 7) + t.slice(-4); };
const deepMask = (v) => {
  if (typeof v === 'string') return /MCD[0-9A-Z]{8,}/.test(v) ? mask(v) : v;
  if (Array.isArray(v)) return v.map(deepMask);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = /couponCode/i.test(k) ? mask(val) : deepMask(val);
    return o;
  }
  return v;
};

// ── 券：从本地 out/ 解析（券码只在内存）──
const own = read('out/query-my-coupons.json');
if (!own?.data?.coupons?.length) { console.error('✗ 缺 out/query-my-coupons.json —— node tools/probe-mcp.mjs query-my-coupons'); process.exit(1); }
const coupon = couponIdArg
  ? own.data.coupons.find((c) => c.id === couponIdArg)
  : own.data.coupons[Number(couponIdx)] ?? null;
if (!coupon) { console.error('✗ 券包里找不到这张券'); process.exit(1); }

// ── items：显式 --items 优先，否则用门店券匹配的商品（quantity=1）──
let items = [];
// 券必须双码齐（couponId+couponCode，缺一回 600010）——按 item 挂，券码不出内存
const couponRefs = () => ({ couponId: coupon.id, couponCode: coupon.code });
if (itemsArg) {
  items = itemsArg.split(',').map((s) => { const [pc, q] = s.split('x'); return { productCode: pc, quantity: Number(q) || 1, ...couponRefs() }; });
} else {
  const sc = read(`out/store-coupons.${store}.json`);
  const entry = (sc?.data ?? []).find((x) => x.couponId === coupon.id);
  if (!entry?.products?.length) { console.error('✗ 门店券里没有这张券的商品清单，用 --items 手工指定'); process.exit(1); }
  items = entry.products.map((p) => ({ productCode: p.productCode, quantity: 1, ...couponRefs() }));
}

// ── calculate-price 入参（从 out/tools.json 的 schema 取必填项，不猜）──
const tools = read('out/tools.json');
const schema = tools?.find((t) => t.name === 'calculate-price')?.inputSchema;
if (!schema) { console.error('✗ out/tools.json 里没有 calculate-price（先 probe --list）'); process.exit(1); }
const required = schema.required ?? [];
const params = {};
for (const k of required) {
  if (k === 'storeCode') params[k] = store;
  else if (k === 'beType') params[k] = 1;
  else if (k === 'orderType') params[k] = 1;
  else if (k === 'items') params[k] = items;
  else { console.error(`✗ schema 必填项 ${k} 本工具不认识，拒绝猜测（防止错单）`); process.exit(1); }
}
if (!params.items) params.items = items;
if (!params.beType) params.beType = 1;
if (!params.orderType) params.orderType = 1;

// ── MCP 调用（最小客户端，入参不打印）──
class McpClient {
  constructor(url, token) { this.url = url; this.token = token; this.sessionId = null; this.nextId = 1; }
  async post(payload, expectResponse = true) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${this.token}` };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    const ns = res.headers.get('mcp-session-id'); if (ns) this.sessionId = ns;
    if (res.status === 401) throw new Error('401 Token 无效');
    if (res.status === 429) throw new Error('429 限流');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!expectResponse) return null;
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      const text = await res.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const line = block.split(/\r?\n/).find((l) => l.startsWith('data:'));
        if (line) { const msg = JSON.parse(line.slice(5).trim()); if (msg.id !== undefined) return msg; }
      }
      throw new Error('SSE 无响应');
    }
    return res.json();
  }
  async callTool(name, args) {
    const msg = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } });
    if (msg.error) { const e = new Error(msg.error.message ?? 'tool error'); e.code = msg.error.code; e.data = msg.error.data; throw e; }
    return msg.result;
  }
}

const unwrap = (result) => {
  if (result?.structuredContent) return result.structuredContent;
  const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try { return JSON.parse(text); } catch { return { _rawText: text }; }
};

try {
  const client = new McpClient(process.env.MCD_MCP_URL || 'https://mcp.mcd.cn', TOKEN);
  const init = await client.post({ jsonrpc: '2.0', id: client.nextId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcd-quote', version: '0.1.0' } } });
  client.sessionId = init.result ? init.result.sessionId ?? client.sessionId : client.sessionId;
  const sid = init.result?.serverInfo ? null : null; // session id 由响应头带
  await client.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);

  const result = await client.callTool('calculate-price', params);
  const data = unwrap(result);

  // 闸①（缺陷 B）：业务失败放在响应体里（success:false + code），result.isError 恒为 false。
  // 任何走麦当劳 MCP 的代码都不得只靠 isError 判成败。
  const bizFail = data?.success === false || (data?.code != null && Number(data.code) !== 200);
  if (result?.isError || bizFail) throw new Error(`${data?.code ?? 'ERR'} ${data?.message ?? ''}`.trim());

  // 闸②（缺陷 A 防呆）：带券请求必须验证 discount > 0 —— 券生效的唯一可靠信号。
  // 不带券/漏券码是合法输入，服务端会静默返回 200 + discount:0 + 无券价，不得当到手价播报。
  const price = Number(data?.data?.price);
  const orig = Number(data?.data?.productOriginalPrice ?? data?.data?.originalPrice);
  const disc = Number(data?.data?.discount);

  // 闸②（缺陷 A 防呆）：本工具永远带双码，discount 必须 > 0 才算"券生效"。
  const couponApplied = params.items.some((it) => it.couponCode);
  if (couponApplied && !(disc > 0)) throw new Error('DISCOUNT_ZERO 券未生效，服务端返回的是无券价，不得作为到手价播报');

  // 闸③（§5.2 基线自证）：同一次连发"无券 + 带券"两枪，断言无券价 ≥ 带券价且差值 == discount。
  // 不一致 = 数据自相矛盾（静默降级被自动发现），先不播金额。
  const baseParams = JSON.parse(JSON.stringify(params));
  for (const it of baseParams.items) { delete it.couponId; delete it.couponCode; }
  const baseData = unwrap(await client.callTool('calculate-price', baseParams));
  const basePrice = Number(baseData?.data?.price);
  if (!(basePrice >= price) || Math.abs((basePrice - price) - disc) > 1) {
    throw new Error(`数据自相矛盾：无券价 ¥${(basePrice / 100).toFixed(1)} vs 带券价 ¥${(price / 100).toFixed(1)}，discount ¥${(disc / 100).toFixed(1)} —— 先不播金额`);
  }

  // 成功：掩码后落盘 + 到手价播报
  const slug = `${store}-${mask(coupon.id).replace(/•/g, '')}`;
  mkdirSync(join(ROOT, 'out'), { recursive: true });
  writeFileSync(join(ROOT, 'out', `quote.${slug}.json`), JSON.stringify(deepMask(data), null, 2));
  console.log(`✓ 到手 ¥${(price / 100).toFixed(1)}（原价 ¥${(orig / 100).toFixed(1)}，券已生效，省 ¥${(disc / 100).toFixed(1)}），明细存 out/quote.${slug}.json（couponCode 已掩码）`);
} catch (e) {
  // 失败：业务码翻译成人话（不打印 ✓），再走"菜单现价估算"回退
  const raw = String(e.message ?? e).replace(/MCD[0-9A-Z]{8,}/g, (s) => mask(s));
  const HUMAN = {
    '600010': '这张券的核销凭证不完整（couponId/couponCode 需成对），是调用侧漏传',
    '600012': '这张券不能用在指定商品上',
    DISCOUNT_ZERO: '券没生效——服务端返回的是无券价，不能当到手价',
  };
  const key = Object.keys(HUMAN).find((k) => raw.startsWith(k)) ?? (raw.match(/\b(6000\d\d)\b/) ?? [])[1];
  console.log(`⚠ ${key && HUMAN[key] ? HUMAN[key] + `（服务端 ${key.split(' ')[0]}）` : raw.slice(0, 200)}`);

  // 回退估算：按菜单现价 − 券价（缺陷 A 存在时，这是唯一可信的估计，必须标注"以 App 结算为准"）
  const sc = read(`out/store-coupons.${store}.json`);
  const entry = (sc?.data ?? []).find((x) => x.couponId === coupon.id);
  const meals = read('out/query-meals.json');
  let est = null;
  if (entry && meals) {
    for (const p of entry.products ?? []) {
      const m = meals.data.meals[p.productCode];
      if (m?.currentPrice) est = Math.max(est ?? 0, Number(m.currentPrice));
    }
  }
  if (est != null && coupon.discountInfo?.discountValue) {
    const gain = (est - Number(coupon.discountInfo.discountValue)).toFixed(1);
    console.log(`按菜单现价估：现价 ¥${est} − 券价 ¥${coupon.discountInfo.discountValue} = 省 ¥${gain}，最终以麦当劳 App 结算为准。`);
  } else {
    console.log('菜单里也找不到可估的现价——这类组合券只能到 App 结算页看真实到手价。');
  }
}
