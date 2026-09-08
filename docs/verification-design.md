# 验证层设计说明（Verification Design Notes）

> 状态：v1 · 2026-09-08 · S5 交付物。记录验证层的**刻意设计决策**与**已核实缺口**，防止未来改动误把设计当 bug 修，或把缺口当已存在能力。

## 1. 结论：完成判定=可解释的独立评审，不是命令门

- 完成唯一出口 = verifier 收据：`verify_execution` → `lib/isolated-verifier.ts runAcceptanceVerifier` → `VerifierReceipt`；`completeDecision`/`canComplete`（execution-gate + verifier-runtime）。
- **Objective 评审拥有 PASS/FAIL/BLOCKED**（execution-contract.ts isMandatory 注释原文）。这是 roadmap "命令不再是全局强制门禁" 的刻意落地。

## 2. 确定性腿在哪里（已核实，2026-09-08 修正版）

| 断言类型 | 解析于 | 完成路径(runAcceptanceVerifier) | legacy(runIsolatedVerifier) | 是否门 |
|---|---|---|---|---|
| `[cmd]` | execution-contract `parseAssertion` → `assertions` | **不执行**（`runDeterministicVerification` 只遍历 `mandatory`，恒空） | **执行**（过滤 `assertions` 中 cmd → 真 PASS/FAIL/BLOCKED） | legacy 内是门；完成路径否 |
| `[eval]` | → `requiredEval` | 是（sha256 + 24h 新鲜度，`eval-sets checkRequiredEvalBinding`） | — | **是**（绑定即真门） |
| `advisory` | → `assertions` | 否 | 否 | 否 |

关键事实（此前文档与侦察有误，已修正）：
- **完成路径的确定性证据恒为空**：`runAcceptanceVerifier` 调 `runDeterministicVerification(input.contract)`，TS 结构上只读 `contract.mandatory`（恒 `[]`），cmd 断言在完成路径**从不执行**。
- **`runIsolatedVerifier`（legacy）真执行 cmd**：过滤 `contract.assertions` 中 `kind==="cmd"` 跑 execFile；失败 cmd → FAIL 收据 → `canComplete=false`（workspace-manifest.test.ts:101-114 实证）。但**零生产调用者**——仅测试使用（execution-gate.test.ts:155 还断言完成报告源不引用它）。
- 确定性执行器 `lib/deterministic-verifier.ts`（execFile 无 shell；ENOENT/timeout→BLOCKED 不猜）存在、已测、双路径可用。

## 3. 已核实缺口（设计态，待真实需求触发再补）

**完成路径无任何确定性证据**：cmd 断言只在零生产调用的 legacy `runIsolatedVerifier` 里执行；`runAcceptanceVerifier` 的确定性结果恒空 → verifier subagent 收不到确定性证据，全靠 Objective 评审 + 可选 `[eval]`。若某 spec 声明了可复现命令检查，完成路径不会自动验证它。
- **为何不改**：把 cmd 接进完成路径 = 把 `[cmd]` 从"证据"升级为门，与 §1 刻意设计（命令非全局门）冲突。
- **若未来出现真实任务需要**：两个安全选项——(a) 让 `runAcceptanceVerifier` 把 `assertions` 中 cmd 经 `deterministic-verifier` 执行，结果作为 **untrusted evidence**（非门）进 verifier prompt；(b) 或生产调用者显式走 `runIsolatedVerifier` 得确定性收据再叠 Objective 评审。两者都零 gate 语义变化，且 `deterministic-verifier.test.ts` 可扩展。**当前无真实任务用 → defer。**

## 4. INCONCLUSIVE 策略（已明确，勿重复实现）

INCONCLUSIVE（无法判定）→ 归为 **BLOCKED** → 升级人工（`lib/verification-policy.ts`），**不自动重试吞掉**。不把不可判定当 PASS。若未来要自动化，须有人工门禁 + 记录 judge 模型/rubric 版本（roadmap A3 诉求），不做成静默 PASS。

## 5. 防回归红线（未来 AI/人在此层必须遵守）

1. 不把 `[cmd]` 改成静默全局完成门（违背 §1）。
2. `isMandatory` 恒 false 是**意图**不是缺陷——若真要给某契约类型开确定性门，走显式 `[eval]` 绑定，不复活 mandatory。
3. verifier 必须只读、逐 REQ 给证据；workspace manifest 变更 = BLOCKED（reward-hacking 防线，勿放松）。
4. agent 自报 RESULT 永不是完成门。
5. 确定性执行只用 `execFile`（无 shell），ENOENT/timeout = BLOCKED 不猜。
