# 试驾战役汇总（Dogfood Campaign Summary）

> 2026-09-08 · 司机战役终期整合。范围：jd（/tmp/pi-dojo）+ ssg（/tmp/pi-dojo-ssg）两项目 0→1 真机迭代；agent-pi 六模式/编排/验证/安全组件逐项驾驶。配套：`dogfood-2026-09-08.md`（逐轮日志）、`coverage-matrix.md`（命中/未命中总账）、`slimming-candidates.md`（瘦身候选）、`validation-log.md`（验证记录）。

## 战役数字
- 分支 commits（main..HEAD）：64，全程本地未 push（public 仓守则）
- 真机驱动轮：5 战役轮 + 24 深水区轮；交互/headless pi 会话 30+，子 worker 50+；**TEAM planner→builder→reviewer 全链 + NEEDS CHANGES→fix→APPROVED 闭合 + 跨项目迁移（jd/ssg）全达成**
- agent-pi 缺陷修复：10 项代码级 + 3 文档/纪律类；信任红线逐一真机验证
- 回归终态：`verify:release` GREEN ×3 · vitest 1002/13skip · bun 284 · doctor:strict 13/13

## 代码级缺陷修复清单（真机驱动）
| 缺陷 | 根因 | 修复 |
|---|---|---|
| D11 | SPEC 批准前 bash 门无规划根指引 → 死锁误判 | 5d91f93 指引+测试 |
| D12/D6/D8 | show_report/批准 viewer `await waitForResult()` 永等人工 | d21fff2 + 8ef4de3 bounded wait ×3 |
| D13-real ×3 | reviewer decision 行缺失：md 契约不进提示→代码模板；解析只读首行→全块语义扫描；失败无修复轮→强制字面 APPROVED | 3289abf / a1a3d6a / 5940653（live journal done） |
| D15 | verifier spawn startup 失败吞 attempt → BLOCKED | 9155a3e spawn 重试 |
| D16 | pipeline_status 只列状态不指下一步 → 迷失 | 771ceef Next action |
| D19 | TEAM 协调者提示缺 inprogress 先行 → task 门自拦 | 5998ec6 提示首条规则（重试后三角色全流成功） |
| D2/D5/D9 | skill 缺失/状态源措辞/司机 git 失误 | 512a953 / 文档 / gitignore |

## 驾驶舱结论（POSITIONING 对照）
1. **核心负载 4 条全真机实证**：PLAN→BUILD→verify 收据（FAIL/PASS 两侧）、单次委派+RESULT、batch 并行（PASS/PASS）、门禁项目工具（安全门全程）
2. **底座（§7）成立**：context/run/协调/证据/收据轨迹全落盘验证；"渲染已算的"仪表构想已验证各散件可用
3. **fail-closed 红线实测**：坏代码→FAIL；无 APPROVED 字样 reviewer→UNKNOWN 拦截（三连修后 done）；无人批准 viewer→有界收尾
4. **收敛证据**：CHAIN retired、PIPELINE 全流在此模型窗口内不可靠（expert/手动档）、8 模型 agent 冗余、builder 小任务用 PIPELINE=仪式 —— 全部支持"收敛到被验证路径"

## 无法命中组件（瘦身输入，详见 coverage-matrix B + slimming-candidates）
- 需 GUI 人环：file/board/research/reports/cleanup viewers、sounds 配置 UI
- 需交互多轮父：fleet-mailbox live、ask_parent 真机
- env/外部受限：security_news（网络）、safe_port_scan（nmap）、herdr 状态跟踪
- 模型/时长受限：PIPELINE 4 相位全流 e2e 双模型窗口内未完成
- 装饰/专项：banner/nav/footer/theme/oauth/session-replay 等（个人偏好，保留不堆料）

## 饱和评估与建议（司机诚实结论）
深水区 11-14 轮真机新信号显著衰减：核心/信任/缺陷面全覆盖；残余多为"LLM 路径不可复现"或环境约束定性。**建议下一步交用户定方向**：
1. 瘦身执行轮（按 coverage-matrix B，先易后难，逐项 verify）
2. PIPELINE 全流用更强模型/更长 e2e 窗口复跑
3. 第三项目域（web 服务/前端）0→1
4. 结束战役，将 50 commits 合入主线（先 review）
