# Requirements

- TUI 不再显示 `ORCHESTRATION ACTIVITY`。
- session_start、session switch、shutdown 不再创建或刷新 Activity widget/timer。
- 保留 `orchestration-run.ts`、`orchestration-query.ts`、`orchestration-status.ts`、事件持久化、预算和恢复逻辑。
- 保留 `/orchestration-status` 和 `orchestration_status`，用户仍可按需查询运行记录。
- 删除专用 Activity renderer 及其测试，清理失效文档引用。
- 不改变 TEAM、CHAIN、PIPELINE、subagent、compose、verifier 的执行路径。
