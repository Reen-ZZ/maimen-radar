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
