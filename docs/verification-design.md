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
