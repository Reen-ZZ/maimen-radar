#!/usr/bin/env node
/**
 * 提交前自检：报名硬性文件、密钥泄漏、内部链接、敏感数据是否会被提交。
 *   node src/preflight.mjs
 * 退出码非 0 表示不要提交、不要报名。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = ['README.md', 'CONTEST_DECLARATION.md', 'MCP_INTEGRATION.md', 'mcp-config.example.json', 'workbuddy.md'];
const OFFICIAL_DECL_SHA = 'cd28101bcb29cc8fb24b372fe91ce6b42c4a1487a54e01f7ade0c8c6a84241b7';
const IGNORED_DIRS = new Set(['node_modules', '.git', 'out', '.tmp', 'dist', 'docs']);

let fail = 0;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => { console.log(`✗ ${m}`); fail++; };

/** 会被提交的文件 = 不在忽略目录内 */
function tracked(dir = ROOT, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = p.slice(ROOT.length + 1).replace(/\\/g, '/');
    const top = rel.split('/')[0];
    if (IGNORED_DIRS.has(top) || rel === '.env') continue;
    if (statSync(p).isDirectory()) tracked(p, acc);
    else acc.push({ rel, abs: p });
  }
  return acc;
}
const files = tracked();

console.log('【1】报名必备文件');
for (const f of REQUIRED) {
  const p = join(ROOT, f);
  if (!existsSync(p)) bad(`缺少 ${f}`);
  else if (statSync(p).size === 0) bad(`${f} 是空文件`);
  else ok(`${f}（${statSync(p).size} 字节）`);
}
if (!existsSync(join(ROOT, 'src')) && !existsSync(join(ROOT, 'tools'))) bad('缺少源代码目录');
else ok('源代码目录存在');

console.log('\n【2】CONTEST_DECLARATION.md 是否被改动');
// 哈希前归一化换行符：官方原件是 LF，Windows 检出/编辑会变 CRLF，
// 内容没改也会误报 —— 只比较内容，不比较换行风格。
const declText = readFileSync(join(ROOT, 'CONTEST_DECLARATION.md'), 'utf8');
const sha = createHash('sha256').update(declText.replace(/\r\n/g, '\n')).digest('hex');
sha === OFFICIAL_DECL_SHA ? ok('sha256 与官方原件一致') : bad(`内容被改动！${sha}`);

console.log('\n【3】密钥与敏感信息泄漏');
const localToken = existsSync(join(ROOT, '.env'))
  ? (readFileSync(join(ROOT, '.env'), 'utf8').match(/^MCD_MCP_TOKEN\s*=\s*(.+)$/m)?.[1] ?? '').trim()
  : '';
localToken ? ok(`检测到本地 .env 有 Token（长度 ${localToken.length}），将扫描是否泄漏`) : console.log('· 本地无 .env，跳过 Token 比对');

/**
 * 比对真实值，而不是形状匹配 —— 形状匹配会把 traceId 全误报成密钥，
 * 反而让人学会忽略这条检查。
 * 允许公开：traceId（请求关联号，不含凭据）、券的 id 哈希、掩码后的券码。
 * 禁止公开：Token、完整可核销券码 code/couponCode、accountId。
 */
const secrets = new Set();
if (localToken && localToken.length >= 16) secrets.add(localToken);
const OUT = join(ROOT, 'out');
const absorb = (obj, keys) => { for (const k of keys) if (typeof obj?.[k] === 'string' && obj[k].length > 6) secrets.add(obj[k]); };
if (existsSync(OUT)) {
  for (const f of readdirSync(OUT)) {
    let j; try { j = JSON.parse(readFileSync(join(OUT, f), 'utf8')); } catch { continue; }
    for (const c of j?.data?.coupons ?? []) absorb(c, ['code', 'couponCode']);
    for (const c of Array.isArray(j?.data) ? j.data : []) absorb(c, ['couponCode', 'code']);
    if (j?.data && !Array.isArray(j.data)) absorb(j.data, ['accountId']);
  }
}
console.log(`· 待比对敏感值 ${secrets.size} 个（来自本地 .env 与 out/ 真实响应）`);

let leaks = 0;
for (const { rel, abs } of files) {
  if (/\.(png|jpg|jpeg|gif|webp)$/.test(rel)) continue;
  const text = readFileSync(abs, 'utf8');
  for (const s of secrets) {
    if (text.includes(s)) { bad(`${rel}: 含真实敏感值 ${s.slice(0, 6)}…（完整值 ${s.length} 字符）`); leaks++; }
  }
  const bearer = text.match(/Bearer\s+(?!\$|\{|<)[A-Za-z0-9]{20,}/);
  if (bearer) { bad(`${rel}: Authorization 头里疑似真实 Token → ${bearer[0].slice(0, 22)}…`); leaks++; }
  const raw = text.match(/\bMCD6C[0-9A-Z]{12,}\b/);
  if (raw) { bad(`${rel}: 出现未掩码的完整券码 → ${raw[0]}`); leaks++; }
}
if (!leaks) ok('未发现 Token / 完整券码 / accountId 泄漏');

console.log('\n【4】.gitignore 覆盖');
const gi = existsSync(join(ROOT, '.gitignore')) ? readFileSync(join(ROOT, '.gitignore'), 'utf8') : '';
for (const need of ['.env', 'out/', 'node_modules', 'docs/', 'dist/', 'state/']) {
  gi.includes(need) ? ok(`.gitignore 含 ${need}`) : bad(`.gitignore 缺 ${need}`);
}
const outDir = join(ROOT, 'out');
if (existsSync(outDir)) {
  const hasRaw = readdirSync(outDir).some((f) => {
    try { return /MCD6C[0-9A-Z]{12,}/.test(readFileSync(join(outDir, f), 'utf8')); } catch { return false; }
  });
  hasRaw ? (gi.includes('out/') ? ok('out/ 含真实券码，但已被 .gitignore 排除') : bad('out/ 含真实券码且未被忽略！'))
         : ok('out/ 无券码');
}

console.log('\n【5】文档内部链接');
for (const doc of ['README.md', 'MCP_INTEGRATION.md', 'SKILL.md']) {
  const p = join(ROOT, doc);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  for (const m of text.matchAll(/\]\((?!https?:)([^)#\s]+)/g)) {
    const target = m[1].replace(/\\/g, '/');
    existsSync(join(ROOT, target)) ? ok(`${doc} → ${target}`) : bad(`${doc} → ${target} 不存在`);
  }
}

console.log('\n【6】命令与离线可用性（README 承诺的每条命令）');
for (const f of ['tools/probe-mcp.mjs', 'tools/make-fixtures.mjs', 'tools/quote.mjs', 'src/check.mjs', 'src/check-share.mjs', 'src/check-store.mjs', 'src/demo.mjs', 'src/wake.mjs', 'src/eat.mjs', 'src/data.mjs', 'src/state.mjs', 'src/store.mjs', 'src/preflight.mjs']) {
  existsSync(join(ROOT, f)) ? ok(`node ${f}`) : bad(`README 承诺的 ${f} 不存在`);
}
// 刚 clone 的人没有 out/，必须靠 fixtures/ 跑通
for (const f of ['query-my-coupons.json', 'query-my-account.json', 'query-nearby-stores.json']) {
  existsSync(join(ROOT, 'fixtures', f)) ? ok(`fixtures/${f}`) : bad(`缺 fixtures/${f}，clone 后 demo 与 check 会直接失败`);
}
// 菜单是门店级响应，按 code 键存：每家 store-coupons 都得配一份自己的 meals，
// 否则 clone 后 check.mjs 会拿不到该店价目表（实测两店 17 个价差 / 20 个店独占单品）
for (const f of readdirSync(join(ROOT, 'fixtures')).filter((x) => x.startsWith('store-coupons.'))) {
  const code = f.match(/store-coupons\.(.+)\.json$/)[1];
  existsSync(join(ROOT, 'fixtures', `meals.${code}.json`))
    ? ok(`fixtures/meals.${code}.json`)
    : bad(`缺 fixtures/meals.${code}.json —— 门店 ${code} 没有自己的菜单样例`);
}
if (!existsSync(join(ROOT, 'src', 'journey.mjs')) || readFileSync(join(ROOT, '.gitignore'), 'utf8').includes('src/journey.mjs')) {
  ok('src/journey.mjs 未入库（其产物属非公开设计文档）');
} else bad('src/journey.mjs 会被提交，但它生成的 docs/user-journey.md 属非公开文件');

console.log(fail ? `\n✗ ${fail} 项未通过，不要提交、不要报名` : '\n✓ 全部通过，可以提交');
process.exit(fail ? 1 : 0);
