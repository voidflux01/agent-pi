# 驾驶舱命令使用手册 — 遇到什么情况，调哪个 command

按**你遇到的问题/想做的事**反查命令。每个条目给「情况 → 命令 → 一句话示例」。

当前命令集：40 个（`/execution-status` 与 `/model-save` 仍登记，见文末备注）。

---

## 1. 派活与收活（子代理）

| 遇到什么 / 想解决什么 | 命令 | 示例 |
|---|---|---|
| 想开一个临时活，让某角色单独跑 | `/sub` | `/sub 用 scout 审计 extensions 里所有 YAML 解析是否有注入面` |
| 上一个 `/sub` 的结论不够，想就同一个人追问 | `/subcont` | `/subcont 3 展开第 2 条 finding 给最小修复 diff` |
| 活干到一半会话断了/我 `/cycle` 了，想从断点继续 | `/subresume` | `/subresume <journal-id> 把调研收尾输出结论` |
| 派重了 / 跑偏了，想立刻止损杀掉某个子代理 | `/subrm` | `/subrm 4`（杀 SA4 并移除） |
| 一批验证子代理全结束，想清场重开 | `/subclear` | `/subclear`（杀掉仍在 running 的并清 widget） |
| 有子代理跑偏方向，想中途纠正它（不杀） | `/nudge` | `/nudge reviewer 只看本次 build 的 diff` |
| agent 中途向你提问挂起了，想看有哪些问题待答 | `/asks` | `/asks`（列出所有挂起 ask_parent） |
| 回答某个挂起的提问让它继续跑 | `/ask-answer` | `/ask-answer <id> 保留 LEGACY 默认，其余删` |

---

## 2. 团队协作

| 遇到什么 / 想解决什么 | 命令 | 示例 |
|---|---|---|
| 换一套角色组合干活（审代码/写文档/查安全…） | `/agents-team` | `/agents-team code-review` |
| 想确认当前有哪些 agent 可用、什么模型、跑没跑 | `/agents-list` | `/agents-list` |

**团队清单（`agents/teams.yaml`）**：`code-review` `docs` `quality` `research-plan-build` `plan-build` `investigate` `refactor` `team-b-builders` `toolkit` `all` `full`。

---

## 3. Pipeline 流程编排

| 遇到什么 / 想解决什么 | 命令 | 示例 |
|---|---|---|
| 要跑一段分阶段多 agent 流程（研究→计划→实现→审） | `/pipeline` | `/pipeline research-plan-build-review` |
| 想知道现在跑到哪个阶段、哪个 agent 卡住/出错 | `/pipeline-status` | `/pipeline-status` |
| 流程跑一半断/换了会话，想从快照续跑 | `/pipeline-resume` | `/pipeline-resume` |
| 理解错了方向，想回到 phase 1 重来（不重启进程） | `/pipeline-reset` | `/pipeline-reset` |
| 任务完成/要切去干不相关的活，退出流水线态 | `/pipeline-off` | `/pipeline-off` |

**可用流程（`agents/pipeline-team.yaml`）**：`plan-build-review` · `plan-build` · `research-plan-build-review` · `auto-build-report`(D21 自动推进)。

---

## 4. 模式 / 系统 / 会话

| 遇到什么 / 想解决什么 | 命令 | 示例 |
|---|---|---|
| 切运行模式（普通/计划/spec/流程/团队/链式…） | `/mode` | `/mode TEAM` |
| 换一种"大脑"视角（角色 system prompt）来干活 | `/system` | `/system` → 选 pi-orchestrator |
| 超长会话快顶上下文了，想压缩重启且保留记忆 | `/cycle` | `/cycle` |
| 想把当前顺手模型设为以后默认 | `/model-save` | `/model-save`（一次性；唯一入口，见文末） |

**模式**：`NORMAL` `PLAN` `SPEC` `PIPELINE` `TEAM` `CHAIN`。

---

## 5. 治理 / 运行控制

| 遇到什么 / 想解决什么 | 命令 | 示例 |
|---|---|---|
| 模型报鉴权错误（401），先看是哪种来源、token 过没过期 | `/auth-status` | `/auth-status` |
| 想清掉内置 OAuth 凭据换 env var 接管 | `/auth-logout` | `/auth-logout`（有确认弹窗） |
| 跑重批怕烧穿额度，先设 token/花费上限 | `/budget` | `/budget 500000 5.0` |
| 默认几十个工具太臃肿、agent 老选错，想精简成按需查 | `/lean-tools` | `/lean-tools` |
| lean 模式下想确认某能力有没有对应工具可调 | `/tool-search` | `/tool-search viewer` |
| 想知道当前验收契约绑没绑、verifier 收没收据（验收调试） | `/execution-status` | `/execution-status` |

---

## 6. 安全

| 遇到什么 / 想解决什么 | 命令 | 示例 |
|---|---|---|
| 接手不熟仓库，想先扫攻击面再决定怎么处理 | `/secure sweep` | `/secure sweep` |
| 扫出风险想装上运行时保护 | `/secure install` | `/secure install` |
| 想回看某次安全扫描/加固报告 | `/secure report` | `/secure report` |
| 某次 tool 调用被运行时守卫拦了，想查原因 | `/security status` / `/security log` | `/security log` |
| 守卫策略要更新/放行某条 | `/security policy` / `/security reload` | `/security reload` |

> `secure`（仓库漏洞扫描，red-team/network-scout 系）与 `security`（运行时 tool 守卫）是两个子系统，别混。

---

## 7. 仪表 / 看产出

| 遇到什么 / 想解决什么 | 命令 | 示例 |
|---|---|---|
| 多个 agent 并行跑，想看整体进度谁卡住 | `/board` | `/board`（浏览器 kanban，可点 agent 过滤） |
| 不开浏览器，终端快速看分支还剩几个 task | `/tasks` | `/tasks` |
| 刚跑完活想核对这次 git 变更做了什么再决定提交 | `/report` | `/report` |
| 想回看某次历史任务的完成报告 | `/reports` | `/reports`（历史索引） |
| 跑偏了想复盘"哪一步开始错的" | `/replay` | `/replay`（滚动会话时间线） |
| 派活前想让 agent 照既定步骤走，先看 todo 进度 | `/plan` | `/plan` |
| 写 spec 时想开某 spec 目录核对结构 | `/spec` | `/spec context-os/specs/2025-06-25-feature/` |
| reviewer 报了某文件某行，想亲眼看原文件 | `/show-file` | `/show-file extensions/pipeline-team.ts` |
| viewer 开多了想关当前那个 | `/close-viewer` | `/close-viewer` |
| 磁盘满报警，想扫大文件并分级处置 | `/cleanup` | `/cleanup` |

---

## 8. 专项功能

| 遇到什么 / 想解决什么 | 命令 | 示例 |
|---|---|---|
| 任务要当前外部事实（联网溯源带源），先研究再落地 | `/research` | `/research 查各模型 2026 年 API 定价变化` |
| 想知道现在有哪些 workflow 能力 / 存一份 review 草稿 | `/workflow` | `/workflow` 或 `/workflow context` |

---

## 文末备注
- `/model-save`：`persistModel` 无其他调用者，是"存默认模型"唯一入口——删即丢功能，故保守保留待你确认。
- 被删入口（底层功能保留）：`auth-clear`→`/auth-logout` · `show-file-help`→描述内联 · `pipeline-grid`→`/agents-grid`替代已删 · `debug-capture`/`sounds`→同名 tool · `agents-grid`/`agents-clear`/`pipeline-clear`/`theme`→布局/收拢/显隐/换肤，`theme` 用 `ctrl+q` 循环。
