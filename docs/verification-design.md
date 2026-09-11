# 验证层设计说明（Verification Design Notes）

> 状态：v2 · 2026-09-10 · `[cmd]` 内联命令执行路径已删除。记录验证层的**刻意设计决策**与**已核实缺口**，防止未来改动误把设计当 bug 修，或把缺口当已存在能力。

## 1. 结论：完成判定=可解释的独立评审，不是命令门

- 完成唯一出口 = verifier 收据：`verify_execution` → `lib/isolated-verifier.ts runAcceptanceVerifier` → `VerifierReceipt`；`completeDecision`/`canComplete`（execution-gate + verifier-runtime）。
- **Objective 评审拥有 PASS/FAIL/BLOCKED**。这是 roadmap "命令不再是全局强制门禁" 的刻意落地：验证路径**不执行任何 workspace 命令**。

## 2. 断言类型现状（2026-09-10 清理后）

| 断言类型 | 解析于 | 行为 | 是否门 |
|---|---|---|---|
| `[eval] <path> sha256:<hex>` | execution-contract `parseAssertion` → `requiredEval` | sha256 内容绑定 + 24h 新鲜度由 `eval-sets checkRequiredEvalBinding` 校验 | **是**（绑定即真门） |
| `advisory`（自然语言，以及 `[cmd]`/`[file]`/`[match]` 等遗留标记） | `parseAssertion` → `assertions` | 仅作为契约上下文进入 verifier prompt | 否 |

- `[cmd]` 解析分支、`lib/deterministic-verifier.ts`（execFile 执行器）、`runIsolatedVerifier`（零生产调用的 legacy API）、`mandatory`/`isMandatory` 兼容字段、verifier 提示词的 `deterministicEvidence` 管道**已全部删除**。遗留 `[cmd]` 标记现在与自然语言同等待遇：解析为 advisory，无执行路径。
- 收据上的 `results` 只承载 advisory 诊断（如 verifier 期间 workspace 变动），永不决定完成；完成由 `status` + `verifier.status/runId` + 契约指纹 + manifest 哈希 + 绑定 eval 共同判定。

## 3. 已核实的缺口（刻意保留，勿当 bug 修）

**完成路径没有命令级确定性证据**。真实任务需要可复现命令证据时，写 `[eval]` 绑定——显式、可审计、带 sha256 与新鲜度；不要复活内联 `[cmd]`。内联命令要进门就必须新增一条确定性门，与 §1 的设计冲突；要作为非门证据又需要重造执行器与证据管道，而 `[eval]` 已经覆盖该需求。

## 4. INCONCLUSIVE 策略（已明确，勿重复实现）

INCONCLUSIVE（无法判定）→ 归为 **BLOCKED** → 升级人工（`lib/verification-policy.ts`），**不自动重试吞掉**。不把不可判定当 PASS。若未来要自动化，须有人工门禁 + 记录 judge 模型/rubric 版本（roadmap A3 诉求），不做成静默 PASS。

## 5. 防回归红线（未来 AI/人在此层必须遵守）

1. 不恢复契约内联命令执行（`[cmd]` 已删）；需要确定性证据走 `[eval]` 绑定。
2. 完成门只有 verifier 收据 + 绑定 eval；不为任何断言类型再开"静默全局门"。
3. verifier 必须只读、逐 REQ 给证据；workspace manifest 变更 = BLOCKED（reward-hacking 防线，勿放松）。
4. agent 自报 RESULT 永不是完成门。
5. 唯一保留的 execFile 命令执行点是用户 eval-set 的 `command` executor（执行规则见 `lib/eval-sets.ts`）：无 shell；ENOENT/timeout = BLOCKED 不猜。

## 6. 多轮验证的定向复核（2026-09 设计，勿退化成每轮全量重审）

同一契约的 REPAIR 重验循环中，第 2+ 轮是**定向复核**而非全量重审：

- **轮次信息**：reVerificationPrompt 携带轮次号 + 上一轮结论（`verifier-subagent.ts`，attempt 从 `isolated-verifier` → `runVerifierSubagent` 透传）。
- **闭合语义**：上一轮的 failing requirements / material findings 逐条确认 RESOLVED/REGRESSED/UNRESOLVED（git diff 回归 + 新证据），已清空且未被动过的高置信区域不重扫。
- **覆盖与残余盲区**：报告含可选 `## Coverage`（实际查过的文件/命令）与 `## Residual Uncertainty`（查不透的区域与原因）。第 2+ 轮必须用定向证据重查上一轮的残余盲区——这是完备性保证；残余盲区无法清除且可能藏实害时，verifier 必须报 BLOCKED 而非 PASS（防止“窄化审计通过”洗白第一轮的漏网）。**代码层强制**：`isolated-verifier.ts` 对第 2+ 轮（存在 previousReport）PASS 但 `residual_uncertainty` 非空的报告降级 BLOCKED；首轮不受限（新审计可带 WARN 级残余）。
- **contractText 仅首轮**：第 2 轮起不附用户确认的契约原文 blob（结构化字段照发），省掉每轮最大的固定 token 成本（`execution-verifier.ts` attempt===1 判定）。
- **repair feedback 紧凑化**：REPAIR 提示词不再 `JSON.stringify` 整份解析报告，改为一行一条 finding（含 behavior/quality/security/contract findings 与 recommendation）+ 证据指针（`.context/evidence/<parentRunId|verifier-<attempt>>/evidence.jsonl`，与 `isolated-verifier.ts` 写入端同构；`autonomous-completion.ts repairBrief`）。
- **已知边界**：delta 预算/截断（severity 优先级、总量封顶）已确认但**尚未实现**；报告增长目前只靠上面的指针原则与契约文本省略约束。
