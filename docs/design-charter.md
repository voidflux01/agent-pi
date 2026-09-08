# agent-pi 设计纲领（Design Charter）

> 状态：v1 · 2026-09-08 · 本文是 agent-pi 演进的组织宪法，优先级高于任何单次实现冲动。
> 面向读者：仓库维护者（含未来的 AI 协作者）。修订需人工审阅并在此记录。

## 0. 为什么需要这份纲领

仓库现状（2026-09-08 实测）：

- 56 个顶层扩展入口 + 114 个 `extensions/lib/` 模块，约 9 万行自有 TS；129 个测试文件。
- 大量代码由 AI 在无人值守节奏下产生；存在**已确认死代码**（`agent-team.dispatchAgent`、
  `agent-chain.runAgent/runChain`、`pipeline-team.spawnAgent/dispatchPhaseAgents` 等）滞留数月。
- 平行词汇与平行实现并存（见 §5 词汇表治理），文档许诺的能力与实际 ship 状态不总一致。
- 维护者（人）对仓库的熟悉度低于代码生成速度 —— 仓库已"逃离掌控"。

**纲领目标**：让 agent-pi 的演进可解释、可审计、可分片执行。任何新代码都归属明确的层与
模块，任何删除都立即执行，任何文档都只描述已 ship 的事实。

**非目标**：本纲领不冻结功能。六模式、编排、安全、viewer 能力照常演进 —— 但必须在
结构纪律内演进。

## 1. 核心信念（不可妥协）

1. **配置/扩展层，不是 runtime。** 不 patch Pi 内核；能力通过 extension/agents/skills/prompts
   叠加。已有能力缺失依赖时降级为 `unavailable`/`unverified`，不影响 NORMAL 模式。
2. **一个关切只有一条主路径。** 已有 canonical 实现（如 `subagent-widget` 单一 dispatcher、
   `CoordinationState` 单一会话状态）即事实标准；禁止在其旁再造平行实现。
3. **删除与改动同变更完成。** "retired" 等于删除，删除走 git 历史考古，不留死代码在树里。
4. **确定性先于 LLM。** 验证链必须保留可复现的确定性腿；LLM 判定只能做证据约束下的
   结论，不能成为唯一闸门。`INCONCLUSIVE` 不等于 `PASS`。
5. **证据先于结论，文档先于承诺。** 文档只描述已 ship 行为；未实现的能力必须留在
   `iteration-roadmap.md` 并标注 aspirational，不得写成现状。
6. **AI 代码与人工代码同标准。** AI 产出的每一行都要能回答："属于哪层、依赖谁、为什么
   在这里、测试在哪、删了会怎样。"

## 2. 分层架构与依赖方向

代码按依赖方向分层。**上层可依赖下层，下层禁止依赖上层；同层之间禁止环。**

| 层 | 目录/文件 | 职责 | 强制规则 |
|---|---|---|---|
| L0 宿主边界 | `extensions/*.ts` 入口、hook 注册 | 接 Pi API：注册工具/钩子/生命周期 | 入口 ≤300 行，只做注册与转发，无业务逻辑 |
| L1 领域规则 | `extensions/lib/` 纯模块：门决策、状态机、解析器、确定性验证、策略 | 无 Pi 依赖的可测逻辑 | 不 import pi/runtime；每个模块 ≤600 行，超限必须拆并有理由 |
| L2 能力执行 | 传输（herdr/headless）、viewer HTTP、tool executor、env/child runtime、安全执行器 | 真 I/O、进程、网络、文件 | 只经 L0 工具面暴露；自带边界检查，不绕 L1 门 |
| L3 编排语义 | `agent-team.ts` `pipeline-team.ts` `agent-chain.ts` `subagent-widget.ts` 及 workflow-* hook | 模式顺序门、相位推进、委派流程 | 不直接 spawn（唯一 spawn 在 canonical dispatcher）；不重复实现 L1 已有决策 |
| L4 配置/代理定义 | `agents/*.md`、`*.yaml`、`skills/`、`themes/`、`prompts/`、models 路由 | 人可读的契约文本与数据 | md/yaml 只描述，不实现逻辑；强制点一律在代码，禁止用 prompt 假装有门 |
| L5 文档/验收 | `docs/`、`CHANGELOG.md`、`validation-log.md` | 已 ship 事实的唯一记录 | 每处承诺对得上代码与测试；路线图独占 aspirational 内容 |

**依赖方向检查方法**：模块 import 只允许指向本层、下层或已登记的公共 lib；
禁止 `lib` import 顶层入口，禁止 `agents/*.md` 成为行为来源（它只是给 agent 读的提示）。

## 3. 单一事实源（Single Source of Truth）清单

以下概念只允许存在一份实现；新代码必须复用而非重造：

- 会话编排状态 → `lib/coordination-state.ts`
- worker 委派/生成 → `extensions/subagent-widget.ts`（`createSubagentRuntime` 为唯一 spawn 出口）
- 会话运行状态规范化 → `lib/run-state.ts`
- 完成判定 → `lib/execution-gate.ts` + `lib/verifier-runtime.ts`
- 验证收据/流水线 → `lib/isolated-verifier.ts` 及其 verifier-* 组合
- RESULT 契约解析 → `lib/agent-result-contract.ts`
- 安全策略执行 → `security-guard.ts` + `lib/security-engine.ts`
- viewer 鉴权/路径边界 → `lib/local-server-auth.ts` + `lib/path-safety.ts`
- worker 生命周期失效 → `lib/worker-lifecycle.ts`

§3 之外若发现第二实现，按 §5 词汇表流程：合并或删，不许共存。

## 4. 变更协议（AI 协作者与人都遵守）

1. **分片授权**：一次变更只动一个 slice（见 §6 分层拆解计划）。跨层改动必须先在纲领
   或路线图里登记，得到人工确认。
2. **动导出符号先查引用**：任何对外符号改名/删除前，先跑 `lsp references` 与 grep，
   列出全部调用点并逐一更新；禁止留下别名/兼容 shim。
3. **门清单同步**：改动若触碰任一强制点（tool_call 安全门、approval 门、task 门、
   dispatch 门、workflow hook、completion 门），必须同步更新 §7 门清单条目。
4. **每变更带验证**：新逻辑带最小可复现检查（回归测试或冒烟）；全量 `verify:release`
   由人工在收尾时跑，AI 不替跑长尾任务。
5. **删除同 commit**：本次改动淘汰的旧路径、注释掉的"退休"代码、`TODO: remove`，
   一律同 commit 删除。git 历史负责考古。
6. **不新增词汇/概念前查表**：先查 §5 词汇表；表达不清或一词多义，先修词汇表再写码。
7. **文档即时性**：任何 ship 的行为变化当天改 L5 对应文档；aspirational 内容只进
   `iteration-roadmap.md`。
8. **入口瘦身**：新功能逻辑进 `lib/`，入口只留注册。已有入口超 300 行，进 S3 拆解队列。

## 5. 词汇表治理（一词一物）

仓库已出现同义多词（例：`run-state`/`coordination-state` 的 RunStatus；多处
"receipt/evidence/journal" 混用）。规则：

- 每个概念一个 canonical 词，登记在下表（随拆解扩充）；别名只允许存在于代码注释的
  迁移期标注，不允许作为独立模块或导出继续存活。
- 发现新平行词汇/平行实现 = 按严重度进 cleanup（改名/合并/删除），不许"先留着"。

| canonical 概念 | canonical 实现/符号 | 已知别名（待清理） |
|---|---|---|
| 会话编排状态 | `CoordinationState` (lib/coordination-state.ts) | — |
| worker 委派结果契约 | `## RESULT` (lib/agent-result-contract.ts) | 旧 dispatch 直接 spawn 路径 |
| 运行状态 | `RunStatus` (lib/run-state.ts) | 各 monolith 内联 alias |
| 验证收据 | `VerifierReceipt` (lib/verifier-runtime.ts) | 旧全局 cmd gate |
| 完成判定 | `completeDecision`/`canComplete` | 各处历史内联判断 |

## 6. 分层拆解计划（Sweeps）

每一 sweep = 一个可独立验收的分片。顺序理由：先给人和 AI 一张可信地图（恢复掌控），
再廉价清除死重（缩小爆炸半径），再动结构。每 sweep 产出必须可客观验证。

| # | Sweep | 范围 | 产出 | 验收 |
|---|---|---|---|---|
| S1 | 系统地图与词汇审计 | 全部 56 入口 + 114 lib 模块 | `docs/system-map.md`：每文件→层/职责/依赖方向/测试覆盖；依赖违规清单；§5 词汇表初版 | 地图覆盖 100% 自有模块；依赖违规清单为空或已登记 |
| S2 | 死代码与平行实现清除 | 已确认死路径 + §3 第二实现 | 删除 commit（人工确认后）；树内无 "retired/__removed/unreachable" 注释代码 | grep 无 `__removed_*` handler、无孤立 `spawnAgent` 等；`verify:release` 绿 |
| S3 | 入口瘦身与命名收敛 | 全部 `extensions/*.ts` 入口 | 入口统一 ≤300 行注册壳；canonical 命名落地 | 入口均薄；别名模块清零；tsc+测试绿 |
| S4 | 编排层重构 | TEAM/CHAIN/PIPELINE monolith 按需抽取 | 模式语义文档；冗余逻辑下沉 L1/L2 或删除 | 每个 monolith 可被地图解释；无死分支 |
| S5 | 验证层补强 | `execution-contract` 确定性腿、judge 策略 | 完成门不单靠 LLM judge 的确定性回退；`[eval]` 默认绑定策略 | 无 [eval] 绑定时仍存在可复现检查路径；INCONCLUSIVE 处理明确 |
| S6 | 演进制度固化 | 本纲领 + roadmap 对齐 | 变更清单/门清单成为 CI 前人工检查项；roadmap 与地图无漂移 | 新 commit 全部符合 §4 协议 |

## 7. 强制点（Gate）清单 —— 所有"会拦你"的地方

任何"牵一发动全身"的恐惧，都应能被这张表回答。完整表随 S1 扩充，格式：

| 门 | 触发点 | 强制符号 | 拦什么 | 测试位置 |
|---|---|---|---|---|
| 工具调用安全门 | tool_call hook | `security-guard.ts` → `scanCommand/scanFilePath` | 危险命令/越界路径/内容外泄 | security-boundaries.test.ts |
| 嵌套工具重门 | `call_tool` 元工具 | `tool-caller.ts` nested*Block | 绕过 tool_call hook 的嵌套调用 | 同上 |
| 上下文注入/泄露扫描 | context hook | security-guard LAYER2 → stripInjections/leak 指纹 | 注入内容、secret、system-prompt 泄露 | （无直测，S1 补） |
| PLAN/SPEC 批准门 | 写工具/bash/委派 | `lib/approval-gate.ts`（指纹绑定） | 未批准变更、批准后内容漂移 | approval-gate.test.ts |
| task 门 | 委派/bash | `lib/task-gate.ts` | 无 active task 的高仪式模式委派 | tasks-gate.test.ts |
| dispatch 权门 | spawn | `lib/dispatch-gate.ts` | 非显式上下文 spawn / 嵌套 pi | child-runtime/dispatch 测试 |
| 类型并发门 | batch 调度 | `subagent-type-gate.ts` | 同类型 worker 并发 >1 | subagent-type-gate.test.ts |
| 模式顺序 hook | 委派前后 | workflow-dispatch hook | 跳步/乱序相位 | workflow-dispatch.test.ts |
| RESULT 契约门 | worker 返回 | `agent-result-contract.ts` + 修复循环 | 无 RESULT/格式坏/角色不符 | result-contract-check.test.ts |
| reviewer 门 | reviewer 角色 | `reviewer-decision.ts`（fail-closed） | 非 APPROVED 放行 | reviewer-decision.test.ts |
| 完成门 | 各 surface report | `execution-gate.ts`+`verifier-runtime.ts` | 无验证收据/指纹漂移/manifest 变更 | execution-gate/execution-contract 测试 |
| viewer 边界 | viewer HTTP | local-server-auth + path-safety | 无 token/跨源/路径逃逸/超限 | 各 viewer-boundaries 测试 |

## 8. 回掌控路线（给维护者本人）

按此顺序重建熟悉度，不从头读 9 万行：

1. 读本纲领（30 分钟）—— 知道层与规则。
2. S1 完成后读 `docs/system-map.md` 的"核心路径"节（1 小时）—— 知道一次委派/验证/
   完成从入口到收据走哪几个文件。
3. 读 §7 门清单 + 对应测试（1 小时）—— 知道"什么会拦、为什么拦、怎么证明没拦错"。
4. 之后任何新变更，只读该 slice 涉及的文件 + 地图条目，不读全仓。

## 9. 签署

本纲领由维护者（人）审阅后生效；AI 不得单方面修改 §1–§4。修订需在文首状态行登记。
