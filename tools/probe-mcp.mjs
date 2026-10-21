#!/usr/bin/env node
/**
 * 麦当劳 MCP 只读探针
 * 用途：实测 query-my-coupons 返回的有效期字段精度，决定「剩 22.5 小时」能不能算准。
 *
 *   node tools/probe-mcp.mjs                       # 默认探 query-my-coupons
 *   node tools/probe-mcp.mjs query-my-account      # 探别的工具
 *   node tools/probe-mcp.mjs query-meals --args '{"storeCode":"1234"}'
 *   node tools/probe-mcp.mjs --list                # 只列 tools 清单
 *
 * Token 只从环境变量 MCD_MCP_TOKEN 或本地 .env 读取，绝不打印、绝不写入输出文件。
 * 全程只调用只读工具，不做任何写操作。
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = process.env.MCD_MCP_URL || 'https://mcp.mcd.cn';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'out');
const PROBE_VERSION = '2025-06-18';

/**
 * 门店级工具的落盘文件名 —— 必须带 storeCode。
 * 这些响应的内容按门店变（实测两店菜单 17 个价差 / 20 个店独占单品），
 * 但响应体里不自报门店，所以门店来源只能写在文件名里。无 key 落盘等于把来源丢掉。
 */
/**
 * 门店级响应必须按 key 落盘（响应体里不自报门店/商品，来源只存在于入参）。
 * key 函数收的是**整个 args 对象**：`query-meal-detail` 的身份证是 `code`（商品），
 * 不是 storeCode —— 它此前落在无 key 的 `query-meal-detail.json` 上，
 * 结果换一家店、换一个套餐再跑就**覆盖掉上一份证据**（2026-10-20 真的冲掉过一次）。
 */
const SCOPED_OUTPUT = {
  'query-meals': (a) => `meals.${a.storeCode}`,
  'query-store-coupons': (a) => `store-coupons.${a.storeCode}`,
  'query-meal-detail': (a) => `meal-detail.${a.code}`,
};
/** 落盘文件名用的是入参里的哪几个字段（打印出来，好让人核对这份证据是谁家的） */
const SCOPED_KEYS = {
  'query-meals': ['storeCode'],
  'query-store-coupons': ['storeCode'],
  'query-meal-detail': ['code'],
};

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
  console.error('✗ 未找到 MCD_MCP_TOKEN。请把 Token 写进项目根目录的 .env 文件：');
  console.error('    MCD_MCP_TOKEN=你的Token');
  console.error('  （不要把 Token 粘贴进任何 AI 对话或提交到 Git —— MCP 服务规则第五条 2 款）');
  process.exit(1);
}

class McpClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.sessionId = null;
    this.nextId = 1;
  }

  async post(payload, expectResponse = true) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000), // 30s 超时：悬挂连接比失败更耽误排障
    });

    const newSession = res.headers.get('mcp-session-id');
    if (newSession) this.sessionId = newSession;

    if (res.status === 401) throw new Error('401 Token 无效/已过期/未提供');
    if (res.status === 429) throw new Error('429 触发限流（上限 600 次/分钟）');
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    if (!expectResponse) return null;

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      const text = await res.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const dataLine = block.split(/\r?\n/).find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const msg = JSON.parse(dataLine.slice(5).trim());
        if (msg.id !== undefined) return msg;
      }
      throw new Error('SSE 流中未找到带 id 的响应');
    }
    return res.json();
  }

  async rpc(method, params) {
    const msg = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params });
    if (msg.error) throw new Error(`${method} 失败: ${JSON.stringify(msg.error)}`);
    return msg.result;
  }

  async connect(clientName) {
    const r = await this.rpc('initialize', {
      protocolVersion: PROBE_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: '0.1.0' },
    });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
    return r;
  }

  listTools() {
    return this.rpc('tools/list', {});
  }

  callTool(name, args) {
    return this.rpc('tools/call', { name, arguments: args });
  }
}

/** 把任意日期时间值归类，判断其精度 */
function classifyValue(v) {
  if (v === null || v === undefined || v === '') return null;

  if (typeof v === 'number' || (typeof v === 'string' && /^\d{10,13}$/.test(v))) {
    const n = Number(v);
    if (String(Math.trunc(n)).length >= 13) return { kind: 'unix_ms', precision: '毫秒', parsed: new Date(n) };
    if (String(Math.trunc(n)).length === 10) return { kind: 'unix_s', precision: '秒', parsed: new Date(n * 1000) };
    return { kind: 'unix_?', precision: '未知', parsed: null };
  }

  if (typeof v === 'string') {
    const s = v.trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?/)))
      return { kind: 'datetime', precision: m[7] ? '毫秒' : '秒', parsed: new Date(s.replace(' ', 'T')) };
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/)))
      return { kind: 'datetime', precision: '分钟', parsed: new Date(s.replace(' ', 'T') + ':00') };
    if (/^\d{4}-\d{2}-\d{2}$/.test(s))
      return { kind: 'date_only', precision: '天（仅日期，无时刻）', parsed: new Date(s + 'T00:00:00') };
    if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s))
      return { kind: 'date_only', precision: '天（仅日期，无时刻）', parsed: new Date(s.replace(/\//g, '-') + 'T00:00:00') };
    if (/^\d{4}\/\d{1,2}\/\d{1,2}[ ]?\d{1,2}:\d{2}(:\d{2})?/.test(s))
      return { kind: 'datetime', precision: s.length > 17 ? '秒' : '分钟', parsed: new Date(s.replace(/\//g, '-').replace(' ', 'T')) };
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return { kind: 'time_only', precision: '时刻', parsed: null };
  }
  return null;
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function walk(obj, path = '', hits = []) {
  if (obj === null || obj === undefined) return hits;
  if (Array.isArray(obj)) {
    if (path.endsWith(']')) {
      // 只取第 0 个元素做字段普查，避免输出爆炸
    }
    obj.slice(0, 1).forEach((v, i) => walk(v, `${path}[${i}]`, hits));
    return hits;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (v && typeof v === 'object') walk(v, p, hits);
      else if (/time|date|expire|expiry|valid|end|start|deadline|过期|有效期|截止/i.test(k))
        hits.push({ path: p, key: k, value: v });
    }
  }
  return hits;
}

function unwrapToolResult(result) {
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { _rawText: text };
  }
}

function report(toolName, data) {
  console.log('\n' + '='.repeat(72));
  console.log(`字段精度报告 — ${toolName}`);
  console.log('='.repeat(72));

  const hits = walk(data);
  if (!hits.length) {
    console.log('⚠ 未在任何字段名中匹配到 时间/有效期/expire 等关键词。');
    console.log('  该工具可能不返回有效期，或用了未预期的字段名。原始结构：');
    console.log(JSON.stringify(data, null, 2).slice(0, 3000));
    return;
  }

  let dateOnlySeen = false;
  for (const h of hits) {
    const c = classifyValue(h.value);
    const verdict = c ? `${c.precision}` : '非时间格式';
    if (c?.kind === 'date_only') dateOnlySeen = true;
    console.log(`  ${h.path.padEnd(46)} = ${String(h.value).padEnd(24)} → ${verdict}`);
  }

  console.log('-'.repeat(72));
  const now = new Date();
  console.log(`探针本地时间: ${fmtDate(now)}  (调用 now-time-info 可核对服务端时钟差)`);
  console.log('-'.repeat(72));

  if (dateOnlySeen) {
    console.log('🔴 结论：存在「仅到日期」的有效期字段。');
    console.log('   → 「剩 22.5 小时」这种小数小时表述无法由该字段精确算出。');
    console.log('   → 卡片文案需降级为「今日到期 / 剩 N 天」，或明确标注 00:00 兜底假设。');
  } else {
    console.log('🟢 结论：有效期精度至少到分钟级。');
    console.log('   → 「剩 22.5 小时」可精确计算。');
    console.log('   → 但仍需按 MCP 规则第四条 2 款标注「以麦当劳 App 展示为准」+ 拉取时间戳。');
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes('--list');
  const pos = argv.filter((a) => !a.startsWith('--'));
  const toolName = pos[0] || 'query-my-coupons';
  const argsIdx = argv.indexOf('--args');
  const toolArgs = argsIdx >= 0 ? JSON.parse(argv[argsIdx + 1]) : {};

  mkdirSync(OUT_DIR, { recursive: true });
  const client = new McpClient(ENDPOINT, TOKEN);

  console.log(`连接 ${ENDPOINT} ...`);
  const info = await client.connect('mcd-probe');
  console.log(`✓ 已连接  server=${info?.serverInfo?.name ?? '?'} ${info?.serverInfo?.version ?? ''}  session=${client.sessionId ?? '(none)'}`);

  const { tools } = await client.listTools();
  writeFileSync(join(OUT_DIR, 'tools.json'), JSON.stringify(tools, null, 2));
  console.log(`✓ 工具清单已存 out/tools.json（共 ${tools.length} 个）`);

  if (listOnly) {
    for (const t of tools) console.log(`  ${t.name.padEnd(28)} ${(t.description || '').split('\n')[0].slice(0, 60)}`);
    return;
  }

  const target = tools.find((t) => t.name === toolName);
  if (!target) {
    console.error(`✗ 服务端未提供工具 ${toolName}。可用：\n  ` + tools.map((t) => t.name).join('\n  '));
    process.exit(1);
  }
  console.log(`\n入参 schema (${toolName}):`);
  console.log(JSON.stringify(target.inputSchema, null, 2));

  console.log(`\n调用 ${toolName} ${JSON.stringify(toolArgs)} ...`);
  const result = await client.callTool(toolName, toolArgs);
  const data = unwrapToolResult(result);

  // 门店级响应按 storeCode 键落盘。`query-meals` 的响应里**没有任何门店身份字段**
  // （顶层只有 success/code/message/datetime/traceId/data），门店来源只存在于请求参数里——
  // 不写进文件名就等于丢掉，于是 A 店的券能配上 B 店的价目表。
  const scopedFn = SCOPED_OUTPUT[toolName];
  const scoped = scopedFn ? scopedFn(toolArgs ?? {}) : null;
  // 认不出身份证（缺 storeCode / 缺 code）时退回工具名落盘，并**明确警告**会覆盖上一份，
  // 而不是默默写进一个带 "undefined" 的文件名里
  const keyed = scoped && !/undefined|null/.test(scoped);
  const outFile = join(OUT_DIR, `${keyed ? scoped : toolName}.json`);
  writeFileSync(outFile, JSON.stringify(data, null, 2));
  console.log(`✓ 原始响应已存 ${outFile.replace(ROOT + '/', '')}`
    + (keyed ? `（按 ${(SCOPED_KEYS[toolName] ?? ['storeCode']).join('+')} 键）`
      : scopedFn ? `⚠ 本应按键落盘但入参缺身份证（storeCode/code 没传？），现写进 ${toolName}.json，再跑一次会覆盖它` : ''));

  if (result?.isError) console.log('⚠ 服务端标记 isError=true，内容：\n' + JSON.stringify(data).slice(0, 800));

  report(toolName, data);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  if (e.name === 'TimeoutError') console.error('  → 请求 30 秒未响应，检查网络或降低调用频率后重试');
  if (/401/.test(e.message)) console.error('  → 检查 .env 里的 MCD_MCP_TOKEN 是否有效（控制台重新激活）');
  if (/429/.test(e.message)) console.error('  → 降频重试，上限 600 次/分钟');
  process.exit(1);
});
