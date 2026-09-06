# agent-pi 迭代路线图：面向 Pi Agent 的工作流增强

> 来源：Andrew Ng，《[AI Engineering Skills Map: Using coding agents](https://x.com/AndrewYNg/status/2095890279865721217)》。
> 本文档是 agent-pi 的方案层路线图，不含具体实现；实现按阶段拆分。
>
> 状态：draft · 修订日期：2026-09 · 前置侦察：`.pi/agent-sessions/outputs/scout-sa1-1-mtoeauch.txt`

## 0. 产品定位与边界

agent-pi 是 Pi Coding Agent 的扩展与配置层，不是独立的 Agent runtime、CI/CD 平台、生产监控平台或外部记忆服务。

它通过 extensions、agents、chains、pipelines、skills、viewers 和安全门禁，为安装了插件的 Pi 增强以下能力：

- 规划和任务分解
- 多 agent 委派、并行和恢复
- 功能验证、行为评估和代码审查
- 跨阶段上下文、会话交接和运行复盘
- 部署前检查、日志分析和修复建议

所有增强能力都应满足：

1. 使用 Pi 原生 extension/session/tool API，不 patch Pi runtime。
2. 高级能力可选启用；缺少可选依赖时降级为 `unavailable` 或 `unverified`，不影响 NORMAL 模式。
3. 安装、升级、禁用和卸载后 Pi 均能正常启动。
4. 任何自动化写入、外部连接、部署或规则更新都必须经过明确的安全与人工门禁。
5. 能力的价值以“安装 agent-pi 后 Pi 的真实工作流是否改善”衡量，而不只以新增文件或工具数量衡量。

## 1. 原文框架与当前仓库映射

Andrew Ng 描述的是三个高度迭代的工作阶段，以及五项使用 coding agents 的能力。三阶段不是严格线性流水线：验证失败可以回到规划或实现，监控发现问题可以重新修复并部署。

| 原文能力 | 当前覆盖 | 判断 | 主要缺口 |
|---|---|---|---|
| Planning | SPEC、PLAN、planner、spec/plan viewer、researcher | 强覆盖 | 需要更明确的假设审查、风险识别和计划质量评估 |
| Execution | builder、tester、subagent、TEAM、CHAIN、PIPELINE | 强覆盖 | 需要把任务级自治策略和结果收益量化 |
| Directing the workflow | mode routing、approval gate、retry、recovery、pipeline phases | 部分覆盖 | 缺少统一的回退策略、人工介入策略和阶段选择指标 |
| Enabling agent autonomy | batch、并行调度、budget、timeout、cancellation、child runtime | 强覆盖但未产品化 | 缺少 autonomy policy、注意力管理和风险分级模型 |
| Reviewing the work | reviewer、red-team、verify_execution、安全/架构审计、浏览器证据 | 强覆盖但缺回归层 | 缺 eval sets、行为回归、judge 校准和 `INCONCLUSIVE` 状态 |
| Customizing agent/environment | agents、skills、models、chains、themes、hooks、CLAUDE.md | 部分覆盖 | 缺 standing context 生成/漂移检测、可选 adapter 和债务清理机制 |
| Coding agent foundations | context budget、tool boundary、message guard、run context、恢复与审计 | 实现较强、文档不足 | 缺面向 Pi 用户的原理文档、失败模式指南和决策准则 |
| Deployment and monitoring | verify gate、sentry 相关 chain、只读安全能力 | 弱覆盖 | 缺日志输入 adapter、issue schema、修复后验证和回滚建议 |

当前仓库已有的编排基础设施继续由 `docs/PI_FABRIC_ADOPTION.md` 负责。本路线图在其上补齐验证、上下文沉淀和部署辅助能力，不另造编排引擎。

## 2. 总体架构原则

### 2.1 能力层，而不是平台层

每项新增能力都应明确它为 Pi 增加什么用户可见能力，以及如何在没有该能力时安全降级。agent-pi 不复制 Pi 的核心 session、context 或 tool runtime。

### 2.2 证据先于结论

测试输出、diff、日志、截图、运行事件和 agent 报告都属于 evidence。LLM 的自述、复盘推断和 judge 结论必须与原始证据分开保存，并标明来源和可信度。

### 2.3 迭代回路优先于线性链

工作流必须支持：

```text
understand → plan → build → verify
                    ↑       ↓
                    └─ fix ←┘

deploy → monitor → triage → approve → fix → verify → redeploy/rollback
```

阶段可以跳过，但每次跳过都应有理由；后阶段反馈应能触发前阶段重做。

### 2.4 插件生命周期优先

每一阶段都要验证：加载、运行、异常、升级、禁用和卸载。插件功能不能只在“所有依赖、所有扩展、所有模型都可用”的理想环境中成立。

## 3. A：验证与评估层（优先级最高）

**对齐原文：Reviewing the work，同时支撑 Directing the workflow。**

目标不是建立一个独立评测平台，而是让 Pi Agent 能以任务级、可复现的方式判断“是否真的完成了用户目标”。

### A1. 统一 evidence 与 eval-set 模型

建议实现 `extensions/eval-runner.ts` 和 `evals/` 目录，作为可选的评估能力。每个评估用例至少包含：

```yaml
id: pipeline-review-regression
version: 1
kind: functional | behavioral | security | workflow
task: <prompt or fixture reference>
workspace: isolated | fixture
model: <resolved model or family>
budget:
  max_tokens: 16000
timeout_ms: 900000
setup: <bounded setup commands>
expect:
  - type: command
    command: npm test
  - type: artifact
    name: verification-receipt
  - type: judge-criteria
    rubric: <versioned rubric>
    threshold: 4
evidence:
  - test-output
  - diff
  - run-events
judge:
  role: evaluator
  model: <independent judge model>
failure_policy: fail | inconclusive
```

评估结果必须记录：用例版本、模型、运行模式、workspace、预算、耗时、证据引用、状态和失败原因。至少区分：`PASS`、`FAIL`、`BLOCKED`、`INCONCLUSIVE`。

### A2. Runner 与现有设施对接

- Runner 调度 Pi/agent-pi 工作流，收集测试输出、diff、截图、报告和 RunContext 事件。
- `verify_execution` 保留确定性 `[cmd]` 断言；eval-set 作为任务级和定性验证的补充，不能绕过 acceptance contract。
- reports-viewer 展示评估结果，`docs/validation-log.md` 记录代表性运行，不把每次运行的完整 transcript 注入父上下文。
- `plan-build-review`、`test-fix`、PIPELINE 的 REVIEW 阶段可选择运行相关 eval-set。
- 评估本身不能自动修改用户项目或工作流规则。

### A3. Judge 一致性与注入防护

- judge 只依据 rubric 和 evidence，不采信被评 agent 的自评或指令。
- evidence 标记为 untrusted；复用 `message-integrity-guard` 的边界思想，但不把消息完整性检查误当成评估正确性。
- 每个行为型 eval-set 包含已知 PASS、已知 FAIL 和边界样例。
- judge 输出使用结构化 schema；理由必须引用 evidence ref。
- 记录 judge 模型、rubric 版本和运行参数；定期重复运行测量评分漂移。
- judge 无法判断时返回 `INCONCLUSIVE`，由人工或确定性检查处理。

### A4. A 层验收标准

- [ ] 至少 2 个真实 eval-set：一个功能型、一个行为/工作流型，覆盖 agent-pi 已有能力。
- [ ] eval runner 可在隔离 workspace 中运行，具有预算、超时和结果归档。
- [ ] judge 输出结构化，并包含证据引用、rubric 版本和可信状态。
- [ ] 已知 FAIL canary 能稳定失败，已知 PASS 样例不会被系统性误判。
- [ ] 评估报告能在 reports-viewer 浏览，且完整 transcript 不进入父上下文。
- [ ] 插件禁用或缺少可选 judge 依赖时，Pi 仍可运行确定性验证。

## 4. B：上下文、记忆与复盘层

**对齐原文：Enabling agent autonomy 与 Customizing the agent and its environment。**

目标是让 Pi 在跨 session、跨阶段和多 agent 协作中保留必要信息，同时不制造第二套不可控的记忆系统。

### B1. 定义 agent-pi memory contract

不要把外部 `agent-memory` CLI 作为 agent-pi 的必需依赖。先定义 agent-pi 自己的接口和边界：

- `handoff`：未完成任务、当前目标、下一步和可恢复 worker。
- `memory-cycle`：上下文压缩前后的短期续接信息。
- `retrospective`：运行结束后沉淀的长期经验。
- `workspace context`：项目级事实、约束和经人工确认的规则。

外部 agent-memory、向量数据库或 embedding 模型只能作为可选 adapter。缺少 adapter 时使用本地、可审计的实现。

所有记忆写入应具备：workspace/session scope、schema version、来源、时间、脱敏状态和删除/清理策略。默认不写入 secrets、完整用户输入、未脱敏日志或未经确认的长期规则。

### B2. Post-run retrospective

新增 `extensions/retrospective.ts` 或并入现有 RunContext lifecycle，触发点包括：subagent batch、CHAIN、PIPELINE 阶段或完整任务结束。不要在每个普通 turn 无条件触发。

建议产物：`.pi/retrospectives/*.jsonl`，示例：

```json
{
  "schema_version": 1,
  "run_id": "...",
  "workspace": "...",
  "mode": "PIPELINE",
  "status": "succeeded",
  "evidence_refs": ["run:event:123", "file:docs/x.md"],
  "what_worked": [],
  "what_failed": [],
  "root_causes": [{"text": "...", "confidence": "hypothesis"}],
  "uncertainties": [],
  "rule_updates": [],
  "privacy": {"redacted": true, "scope": "workspace"}
}
```

`rule_updates` 只能作为草稿，不能直接修改系统提示、CLAUDE.md、AGENTS.md 或 skills。复盘中的 root cause 若不是由确定性证据支持，必须标为 hypothesis。

### B3. Standing context 生成与漂移检测

提供类似 `/ctx:agents-md` 的可选命令：扫描项目结构、构建/测试命令、架构约束、代码风格和数据访问边界，生成草稿和 diff 预览。

必须先定义 `AGENTS.md`、`CLAUDE.md` 与父目录规则的优先级。生成器不得覆盖既有规则，不得把推断当事实，不得自动落盘到用户项目。

维护模式只检查可验证漂移，例如：命令失效、目录不存在、规则引用的文件消失；发现问题后提示用户，而不是自动改写规则。

### B4. B 层验收标准

- [ ] handoff、memory-cycle、retrospective、workspace context 的职责边界有文档和测试。
- [ ] 一次典型 CHAIN 或 PIPELINE 运行后能生成带 evidence refs 的复盘记录。
- [ ] 复盘写入具备脱敏、workspace scope、并发安全和清理策略。
- [ ] 外部 memory adapter 缺失时不影响核心 Pi 工作流。
- [ ] AGENTS/CLAUDE 规则优先级明确，生成器只生成草稿和 diff。
- [ ] agent-pi 自身项目能生成可人工审阅的 standing context 草稿。

## 5. C：部署辅助与监控层

**对齐原文：Deployment and monitoring。**

agent-pi 是 deployment/monitoring workflow adapter，不替代用户已有的 CI/CD、Sentry、Datadog、Docker 或云平台。

### C1. 有界日志输入与 issue schema

先定义平台无关的只读输入接口，再实现最小 adapter。初期优先支持本地日志文件和一种当前平台日志来源；Docker、`journalctl`、macOS `log show` 后续按需求增加。

日志能力必须：

- 只读取明确授权的路径或命令输出
- 限制行数、字节数、时间范围和执行时间
- 复用 path-safety、security-guard 和 approval gate
- 对 secrets、tokens、个人数据做脱敏
- 输出结构化 issue：fingerprint、severity、frequency、first_seen、last_seen、evidence refs、uncertainty
- 不做长驻 daemon，不默认外发网络数据

### C2. Issue → fix → verify 闭环

复用现有 chain/pipeline 机制实现：

```text
log-watch → triage → fix proposal → human approval → builder/tester
           → verification → redeploy or rollback recommendation
```

默认只生成修复提案，不直接部署。修复完成后必须重新运行任务匹配的验证，并记录问题是否消失；不能只依据 agent 的“已修复”自述。

### C3. 部署前 gate

提供可选的部署前检查 skill/prompt，检查项由项目配置决定，可包括：

- 测试和 lint
- 类型检查
- 安全扫描和 secrets 检查
- acceptance contract / eval-set
- 依赖审计
- 回滚方案和变更范围

不假定所有项目都使用同一工具；缺少某项工具时应输出 `unavailable`，不能伪报 PASS。

### C4. C 层验收标准

- [ ] 一个真实本地日志样本能生成脱敏、结构化 issue 摘要。
- [ ] `monitor-triage-fix` 或等价流程能跑通一次，含人工确认门禁。
- [ ] 修复后能执行任务匹配的验证并记录结果。
- [ ] 不启动长驻进程，不默认网络外发，不自动部署。
- [ ] 日志、issue、修复提案和验证结果都有 bounded evidence。

## 6. Directing the workflow：贯穿能力

这是原文五项技能中不能被 A/B/C 吞掉的一项，作为所有阶段的横切能力建设。

agent-pi 应能根据任务风险、复杂度、成本和反馈选择：

- NORMAL、PLAN、SPEC、TEAM、CHAIN 或 PIPELINE
- 交互式执行或委派较大任务
- 串行或并行 agent
- 自动继续、请求人工确认或回退重做
- 只做确定性验证、增加行为评估或触发人工审查

验收重点：

- [ ] 验证失败能明确建议回到 BUILD、PLAN 或 SPEC，而不是只返回失败。
- [ ] 监控问题能形成重新规划、修复和验证的闭环。
- [ ] 高风险动作提升人工门禁，低风险动作保持合理自治。
- [ ] 用户能看到当前阶段、下一步、阻塞原因和需要自己决定的事项。
- [ ] 记录 token、耗时、并行度、重试和人工介入，支持后续评估。

## 7. Coding agent foundations 文档

当前仓库已有大量 foundations 实现，但需要转化为用户可理解的文档，至少覆盖：

- Pi 如何搜索代码、组织上下文和处理 compaction
- 工具调用、子 agent、MCP 和 extension 如何影响上下文与权限
- NORMAL/PLAN/SPEC/TEAM/CHAIN/PIPELINE 的适用边界
- 长 horizon 任务的失败模式和成本风险
- budget、timeout、cancellation、recovery 的语义
- 为什么 verification receipt、untrusted evidence 和 human gate 必要
- 如何根据任务风险决定自治等级

这部分不是“实现完成后的附属文档”，而是后续用户正确使用插件的基础产品能力。

## 8. 实施顺序

| 阶段 | 内容 | 交付目标 |
|---|---|---|
| P0 | 插件兼容性基线、evidence 模型、foundations 文档骨架 | 安装/禁用/缺依赖可降级；建立统一证据和状态语义 |
| P1 | A1+A2 eval-set、judge 护栏、Review 闭环 | Pi 能对真实任务做可复现的功能/行为验证 |
| P2 | Directing the workflow、失败回退和自治策略 | Pi 能根据反馈选择继续、修复、重规划或请求人工 |
| P3 | B1+B2 memory contract、retrospective、handoff 统一 | 跨 session 和跨阶段沉淀信息，不引入第二套不可控记忆 |
| P4 | B3 standing context、C1/C2/C3 部署辅助 | 项目上下文可维护，日志到修复提案形成安全闭环 |

顺序理由：先建立证据、兼容性和原理基础，再实现评估；评估稳定后才能判断 memory 和 monitoring 是否真的改善了 Pi 的工作流。部署辅助最后做，以避免把 agent-pi 过早扩展成监控或 CI 平台。

## 9. 全局验收与非目标

每个阶段都必须同时通过：

1. **Extension contract**：工具、命令、事件、配置和生命周期正确。
2. **Workflow behavior**：真实 Pi 工作流按预期推进、回退和恢复。
3. **User value**：安装插件后，人工协调成本、失败恢复成本或验证不确定性有可观察改善。

全局约束：

- 不 patch Pi runtime。
- 不把 LLM 自述当成验证证据。
- 不自动修改用户项目规则、系统提示或生产环境。
- 不引入必须联网的核心能力。
- 不把外部 memory、judge、Sentry 或部署系统作为必需依赖。
- 所有新增扩展具有禁用路径、边界测试和至少一个真实 workflow smoke。
- 每个阶段结束记录验证结果和人工确认项；retrospective 能力可用后再自动生成复盘。

## 10. 待决策事项

1. eval-set 是否集中放在 `evals/`，还是允许功能旁路存放；建议集中目录加明确 owner。
2. judge 默认使用哪个模型、是否允许用户配置；建议独立于被评 agent，并支持关闭。
3. memory 默认 scope 是 workspace 还是 user；建议 workspace-local、显式 opt-in 跨项目记忆。
4. `AGENTS.md` 与 `CLAUDE.md` 的优先级和冲突策略。
5. 第一阶段日志 adapter：本地文件优先，还是 macOS `log show` 优先。
6. 用户价值指标：任务完成率、验证误判率、人工介入次数、恢复成功率、token/耗时或其他指标。

