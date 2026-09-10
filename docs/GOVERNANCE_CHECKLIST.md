# 治理检查清单（Governance Checklist）

> 状态：v1 · 2026-09-08 · S6 交付物。两份清单：**改动前**与**发布前**。AI 协作者与人共同遵守。
> 依据：design-charter §4/§7、POSITIONING §6/§8、system-map。

## A. 改动前清单（每次改代码前过一遍）

1. **归属**：这次改动属于哪个层（L0-L5）哪个模块？写得出吗？写不出 = 先查 system-map，别硬写。
2. **单一事实源**：涉及 §3 canonical 概念（协调状态/dispatcher/验证/安全…）？是 → 改 canonical，不造第二实现。
3. **符号改动**：改名/删导出前跑过 `lsp references` + grep，列全调用点了吗？不遗留别名/兼容 shim（§4.2）。
4. **门触达**：是否触碰任一强制点？是 → 更新 design-charter §7 门清单对应行 + 跑对应 gate 测试。
5. **删除**：本次改淘汰的旧路径/注释"退休"代码/`TODO: remove`，是否同 commit 删（§4.5）？"retired" ≠ 保留。
6. **词汇**：是否引入新名词？先查 system-map §6 词汇表；一词多义先修表再写码（§4.6）。
7. **行为变化**：是否改变已完成/验证/安全语义？是 → 属 load-bearing，需 plan 级确认（POSITIONING §6.9 + mode-semantics §7 红线），不得静默。
8. **测试**：新逻辑带最小可复现检查；测试断言可观察行为，不钉实现文本（删钉死已删实现的断言，保留 wire/transport 不变量）。

## B. 发布/收尾清单（verify:release 前人工过一遍）

1. `npm run verify:release`（doctor:strict + strict tsc + 全测试 + audit + package-smoke）绿。
2. **无漂移**：system-map 模块清单/层/档与代码一致（新增模块入表；删除模块出表）。
3. **文档即时**：涉及的模式语义/验证设计有变化 → 同步 mode-semantics / verification-design；aspirational 只进 iteration-roadmap。
4. **门清单同步**：design-charter §7 与实际 gate 无出入。
5. **死代码**：grep 无 `__removed_*`、无注释"retired/unreachable"仍留树（延后项在 mode-semantics §8 有登记则不在此列）。
6. **定位合规**：新增能力是否落在 POSITIONING §5 核心负载内？在外且无真实任务 = 不进主干（§6.2）。

## C. 红线（永不妥协，来自各文档）

- 不造第二完成门；agent 自报 RESULT 永不是完成（verification-design §5）。
- `[cmd]` 断言已移除（无命令执行路径，遗留标记降级为 advisory）；`[eval]` 绑定是显式确定性门的唯一入口（verification-design §5）。
- 所有自动化写/外联/部署过人工门（POSITIONING §6.6）。
- load-bearing monolith 死代码清理 = 功能性触碰时顺带删，不为美容开膛（mode-semantics §8）。
