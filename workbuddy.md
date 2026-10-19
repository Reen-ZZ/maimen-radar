# WorkBuddy 开发上下文（麦门雷达）

> 本文件对应《麦当劳程序员创意开发大赛活动规则》中"参赛项目应包含至少以下文件"里的 **`workbuddy.md`，如参与 WorkBuddy 专项奖励的需提交本文件，WorkBuddy 对话上下文，用于联动活动**。
> 本项目全程在腾讯 WorkBuddy 中开发与调试。以下内容来自真实开发过程，**不含虚构对话**——每个节点都可用 `git log`、`MCP_INTEGRATION.md` 的 traceId 与 `docs/` 下的取证文档对账。

## 1. 项目与 WorkBuddy 的关系

| 项 | 说明 |
|---|---|
| 开发环境 | 腾讯 WorkBuddy（本 Skill 的唯一开发与调试环境） |
| MCP 连接器 | `mcd-mcp` → `https://mcp.mcd.cn`，配置于 WorkBuddy 连接器，Token 只存本地 `.env`（不入仓库、不进对话） |
| 技能安装 | 仓库根目录即技能本体，同步至 `~/.workbuddy/skills/maimen-radar/`，与仓库逐文件 sha256 校验一致 |
| 沙箱执行 | WorkBuddy 内 Node 22 直跑零依赖脚本（`check` / `demo` / `wake` / `eat` / `quote`），Edge headless 截图产出 README 卡片 |
| 自检纪律 | `node src/check.mjs`（真数据一致性断言）与 `node src/preflight.mjs`（提交前自检）全绿才算完成 |

## 2. 开发时间线（真实会话节点）

| 日期 | 会话内容 | 产出（可对账） |
|---|---|---|
| 2026-10-18 | 初始版本开发：真实数据取证（35 个工具探测、9 个只读调用）、四态判定模型、双渲染面、确定性脱敏 fixtures | `SKILL.md`、`src/*`、`fixtures/`、`MCP_INTEGRATION.md`（含全部 traceId） |
| 2026-10-19 上午 | 全量代码评审（产品 + 开发双视角），识别 7 项改进并逐项修复 | `preflight` CRLF 误报、`state/` 入 gitignore、生效起始维度、跨午夜时段、499 语义、check 券名回退、`wake.mjs` 接线 |
| 2026-10-19 | README 面向 WorkBuddy 大众用户重构（对照榜首项目安装模式）×2，双卡片截图入 README | `README.md`、`assets/card*.png` |
| 2026-10-19 | 实测踩坑：`available-coupons` 无券时 `data:null` 触发严格客户端 `-32602` | `fields.md` 错误码节、SKILL 领券路由 |
| 2026-10-19 | 冷启动引导（先盘点后索取）、绑店六步流程、引导优先级表、麦门语气硬规则 | `SKILL.md` 多节、`src/wake.mjs` |
| 2026-10-19 | A1/B/A2：💳三档价格、🆕上新段、券价叠加进账单、`src/eat.mjs` 与 `tools/quote.mjs` 到手价通道 | 分支 `feat/eat-this` 4 commits，12 条验收全绿后合入 main |
| 2026-10-19 | 真实数据验收抓出两处关键错误并修复：`weekdays` 映射（1=周日…7=周六，欠定推断被周一判别证据推翻）、MCD-DEF-001 算价静默陷阱 | `fields.md`、`docs/2026-10-19-calculate-price-silent-trap.md` |

## 3. 对话上下文摘录（真实发生，节选）

以下为 WorkBuddy 会话中的真实指令 → 结果对（完整过程见 git 历史与取证文档）：

- **用户**：「替我领取优惠券」
  **WorkBuddy**：检出 `available-coupons` 报 `-32602`（服务端无券时返回 `data:null`，过不了严格客户端 schema 校验）→ 定性为"无券可领"而非故障 → 写入 SKILL 领券路由，并新增输出纪律防止内部细节漏到用户面前。
- **用户**：「根据 docs/plans/2026-10-19-eat-this.md 设计方案进行优化」
  **WorkBuddy**：按定稿方案在分支上 4 个 commit 落地「今天吃啥」写死链路（`pickTop1` 排序、门店侧时间窗优先、`eat.mjs` 入口、`quote.mjs` 到手价），12 条验收全绿后经确认合入 main。
- **用户**：「需要验证真实数据确认券包的券 ID 和门店券的券 ID 是否对的上」
  **WorkBuddy**：通过 WorkBuddy 内配置的连接器与本地探针双通道取证——券包 `id` 与门店券 `couponId` 3/3 逐字节一致（traceId `b65aa340…`、`c081dcd0…`），A2 前置成立。
- **用户**：「BUG-1（高）：闸③基线自证对所有促销商品必假……」
  **WorkBuddy**：确认三条 bug 成立并当日修复（discount 口径 = 原价 − 到手、券缺 code fail closed、check 断言区分化石/基线/真成功），真数据回归通过。

## 4. 真实使用腾讯 WorkBuddy 智能体的核验指引

| 核验点 | 位置 |
|---|---|
| 全部开发 commit（可追溯） | `git log`（2026-10-18 起，含分支 `feat/eat-this` 的 4 个 commit） |
| 麦当劳 MCP 真实调用记录（含 traceId） | `MCP_INTEGRATION.md` |
| 算价通道缺陷取证（600010/600012/静默无券） | `docs/2026-10-19-calculate-price-silent-trap.md` |
| 实测字段笔记（含踩坑与修正记录） | `references/fields.md` |
| WorkBuddy 技能形态 | `SKILL.md`（装入 `~/.workbuddy/skills/maimen-radar/` 即用） |

## 5. 边界声明

- 本项目为参赛者独立开发，非麦当劳官方产品；WorkBuddy 与麦当劳的合作为大赛官方安排。
- 开发过程遵守《麦当劳 MCP 服务规则》：全程只读调用、写操作先确认、Token 不出本地。
- 本文件不包含任何券码、Token 或可核销凭证。
