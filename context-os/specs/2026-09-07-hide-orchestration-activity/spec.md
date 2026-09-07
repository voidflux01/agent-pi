# Hide Orchestration Activity

## Goal

永久关闭 TUI 中的 `ORCHESTRATION ACTIVITY` 展示，降低界面噪声；不削弱编排执行、事件证据、预算、恢复或状态查询。

## User Stories

- 作为用户，我不希望每次 session 自动看到 Activity 运行列表。
- 作为维护者，我仍希望通过 `/orchestration-status` 查询编排记录。

## Requirements

- 删除 Activity 专用扩展和纯渲染器。
- 删除对应 renderer 测试，并清理面向用户文档中的 Activity/dashboard 入口说明。
- 不删除或修改 orchestration run、budget、query、status、evidence、recovery、verifier 代码。
- 不改变 TEAM、CHAIN、PIPELINE、subagent、compose 的执行行为。
- 保持 typecheck、完整测试和 orchestration eval 通过。

## Visual Design

无 Activity widget；其他 TUI widget 不变。状态查询继续通过命令/工具输出。

## Existing Code to Leverage

- 保留 `extensions/lib/orchestration-run.ts`
- 保留 `extensions/lib/orchestration-query.ts`
- 保留 `extensions/orchestration-status.ts`
- 保留 `extensions/lib/evidence-store.ts`
- 删除 `extensions/orchestration-dashboard.ts`
- 删除 `extensions/lib/orchestration-dashboard-render.ts`
- 删除 `extensions/__tests__/orchestration-dashboard-render.test.ts`

## Out of Scope

- 不删除 orchestration 核心。
- 不删除 `/orchestration-status`、`orchestration_status` 或 `orchestration_recover`。
- 不改变运行记录格式、预算逻辑、恢复逻辑或 worker 生命周期。
- 不清理已有 `.pi/agent-sessions/compositions` 历史数据。

## Contract

### Objective

永久移除 TUI Activity 展示层，同时保持编排核心和状态查询可用。

### Scope

只修改 Activity 专用扩展、renderer、对应测试和失效文档引用；核心执行层冻结。

### Acceptance Criteria

- TUI 不再注册或自动创建 `ORCHESTRATION ACTIVITY` widget/timer。
- Activity 专用文件和测试被移除；文档不再宣称该面板存在。
- 编排核心文件仍存在，`orchestration-status` 仍可用。
- TEAM、CHAIN、PIPELINE、subagent、compose、verifier 的核心路径未被改动。
- typecheck、完整测试、provider-free orchestration eval 全部通过。

### Evidence Requirements

- Git diff 只包含 Scope 内文件。
- 验证命令输出 PASS。
- 明确证明核心文件仍存在。
- 不把 Activity 删除误报为编排核心删除。

### Constraints

- 不删除历史运行数据。
- 不弱化或删除测试断言，除 Activity 专用测试外。
- 不使用跳过测试、假结果或 `|| true`。

### Verification Commands

- [cmd] npm run typecheck
- [cmd] npm test
- [cmd] npm run eval:orchestration
- [cmd] node -e "const fs=require('fs'); const gone=['extensions/orchestration-dashboard.ts','extensions/lib/orchestration-dashboard-render.ts','extensions/__tests__/orchestration-dashboard-render.test.ts']; const kept=['extensions/lib/orchestration-run.ts','extensions/lib/orchestration-query.ts','extensions/orchestration-status.ts','extensions/lib/evidence-store.ts']; for(const p of gone) if(fs.existsSync(p)) throw new Error('still present '+p); for(const p of kept) if(!fs.existsSync(p)) throw new Error('missing core '+p); console.log('activity removed; orchestration core present')"
