/**
 * 响应来源解析：优先本地真实抓取（out/，不入库），退回脱敏样例（fixtures/，入库）。
 * 这样 `node src/demo.mjs` 在刚 clone 的机器上也能出图。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// MCD_DATA=fixtures 可强制只用脱敏样例（验证 fixtures 自身是否可用）
const DIRS = process.env.MCD_DATA ? [process.env.MCD_DATA] : ['out', 'fixtures'];

export function sourceDir() {
  for (const d of DIRS) if (existsSync(join(d, 'query-my-coupons.json'))) return d;
  return null;
}

export function load(file) {
  for (const d of DIRS) {
    const p = join(d, file);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error(`找不到 ${file}。跑 node tools/probe-mcp.mjs 取真实数据，或 node tools/make-fixtures.mjs 生成样例。`);
}

export const isLive = () => sourceDir() === 'out';

/**
 * 门店级响应只能按 code 键取。
 *
 * `query-meals` 与 `query-store-coupons` 的入参都**必须**带 storeCode（实测 required 含 storeCode），
 * 但响应里没有任何门店身份字段（顶层只有 success/code/message/datetime/traceId/data）——
 * 也就是说门店来源只在请求参数里，落盘即丢失，只能由**文件名**承载。
 *
 * 所以这里拒绝一切回退：缺这家店的快照就报错，绝不拿「手边那份菜单」凑。
 * 曾经 `query-meals.json` 是无 key 的，实测两店菜单 17 个价差 / 20 个店独占单品，
 * 于是 A 店的券配 B 店的价——算错的是钱，不是图。
 */
const SCOPED = { meals: 'query-meals', 'store-coupons': 'query-store-coupons' };

export function loadScoped(tool, code) {
  const c = String(code).trim();
  const file = `${tool}.${c}.json`;
  for (const d of DIRS) {
    const p = join(d, file);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error(`门店 ${c} 没有 ${tool} 快照（找过 ${DIRS.map((x) => `${x}/${file}`).join('、')}）。`
    + `先抓：node tools/probe-mcp.mjs ${SCOPED[tool] ?? tool} --args '{"storeCode":"${c}",...}'`);
}
