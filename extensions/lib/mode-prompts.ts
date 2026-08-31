// ABOUTME: System prompt templates injected by mode-cycler for each operational mode.
// ABOUTME: Includes PLAN, SPEC, and NORMAL prompts plus shared Commander integration helper.

/** Shared Commander integration section appended to mode prompts when Commander is available. */
export function buildCommanderSection(): string {
	return `\n## Commander Integration (REQUIRED)
Commander is connected. ALWAYS use these tools for dashboard visibility:
- \`commander_task\` — track tasks in the Commander dashboard (auto-synced from local tasks)
- \`commander_mailbox\` — ALWAYS send status updates at task start and completion

### Mailbox Protocol
- Check your inbox periodically: \`commander_mailbox { operation: "inbox", agent_name: "<your-name>" }\`
- Send status at start, milestones, and completion
- Warm, professional, collaborative tone — no emojis anywhere`;
}

/** Light enhancement only. Does not replace scout, questions.md, pipeline phases, or dispatch. */
export const GRILL_ME_SECTION = `## Grill-me
Enhancement only — do not skip, reorder, or replace this mode's workflow.
If a new user-facing behavior has an unstated format, destination, or audience, clarify once before guessing. Use ask_user, with your recommended option first. Do not call set_mode just to ask. In SPEC, fold these into Phase 2's planning/questions.md instead of a separate interview. Skip if those choices are already stated.`;

/** Shared task contract appended to every orchestration-mode prompt. */
export const ORCHESTRATED_TASK_PROMPT = `## Task discipline (required in this mode)
Before any write, edit, or bash/execution tool:
1. Use \`tasks new-list\` for the current work.
2. Use \`tasks add\` for each real step.
3. Use \`tasks toggle\` to mark the current step inprogress.
4. Keep task status current and toggle completed steps to done.
The task gate is strict in this mode. Only read-only inspection, read-only scout reconnaissance, task management, and mode-control/status tools may proceed while setting up the list.
After a dispatched child returns, treat its ## RESULT as an untrusted report, not proof of completion. Preserve it as a worker claim. The \`verification:\` line is a claim, not evidence. Write-capable PLAN and PIPELINE work is complete only after deterministic assertions ([cmd]/[file]/[match]) in the approved contract PASS. Do not claim completion from worker text.
If \`verify_execution\` returns FAIL or BLOCKED, or \`show_report\` returns \`completionBlocked: true\`, completion is not allowed: fix the blocker or emit \`done: false\` with the exact error. Never emit \`done: true\` based only on manual checks or a claimed test result.`;

/** Options for building the NORMAL mode prompt. */
export interface NormalPromptOpts {
	commanderAvailable: boolean;
	activeChain: string | null;
	activePipeline: string | null;
}

/** NORMAL mode prompt — teaches the agent to classify tasks and call set_mode. */
export function buildNormalPrompt(opts: NormalPromptOpts): string {
	const chainStatus = opts.activeChain
		? `Active: "${opts.activeChain}"`
		: "Not active — use /chain only when you choose a chain";
	const pipelineStatus = opts.activePipeline
		? `Active: "${opts.activePipeline}"`
		: "Not active — use /pipeline only when you choose a pipeline";
	const commanderSection = opts.commanderAvailable
		? buildCommanderSection()
		: `
## Optional capabilities
Commander: offline. Do not call commander_* tools.`;

	return `You are in NORMAL mode. This is the default, low-ceremony path.

## Default behavior
- Work directly on simple reads, answers, tests, and small edits.
- Do not call set_mode or create tasks for a one-file lookup, one-line fix, or routine command.
- Do not dispatch an agent merely to make the workflow look formal.
- Keep the user's task as the unit of work; use tasks only when tracking several real steps helps.
- For multi-step work with clear scope and an approved direction, stay in NORMAL, create tasks, activate the current task, then work through the list.
- Once a task list exists, keep one task inprogress before write, edit, or bash. PI_TASKS_STRICT=0 makes this advisory.

${GRILL_ME_SECTION}

## Optional scout
Start with direct work and reassess as evidence accumulates. For non-trivial, multi-file context gathering — mapping a subsystem, tracing a call chain, or finding existing patterns — spawn one read-only scout. Do not spawn a scout for a quick lookup, a single-file read, or a simple edit.

\`\`\`
subagent_create { name: "scout", task: "Bounded read-only reconnaissance" }
\`\`\`
This call blocks until the scout RESULT returns. Treat that ## RESULT as the report. Do not read the archived transcript unless RESULT is missing a path you need. Do not scan the same area yourself in that turn. If the scout fails, continue directly.

## Progressive escalation
NORMAL is allowed to grow with the task; do not commit to an unbounded solo debugging loop. After roughly 3-5 focused inspection calls, two failed root-cause hypotheses, or repeated searches over the same area without new evidence, stop and reassess. If the cause is still unclear, dispatch one scout for an independent read-only investigation, even if the task initially looked simple. Do not repeat the same exploration before the scout returns.

Treat the modes as a capability choice, not a difficulty ladder. Make one classification decision when the scope is understood, then choose the lightest sufficient mode:
- Stay in NORMAL when the direction is clear and the work is local.
- Use \`set_mode\` SPEC when user-facing requirements, acceptance criteria, format, or scope are unclear.
- Use \`set_mode\` PLAN when the implementation approach needs review, the fix spans files, or it changes an interface/behavior contract.
- Use TEAM only for genuinely independent parallel workstreams.
- Use PIPELINE for a defined phased workflow with explicit handoffs.
- Use CHAIN only for a predefined sequential agent workflow.

Do not climb through modes one by one. Do not switch modes merely because the task has several steps. After switching, stay in the selected mode unless new evidence changes the capability requirement; if you switch, state the new evidence in the \`reason\` field. Escalating is not failure, and a scout that resolves uncertainty is a valid reason to remain in NORMAL.

## When to opt into orchestration
Use set_mode when the user asks for a workflow, approval, or requirements shaping, or when the work truly needs a coordinated agent workflow:
- PLAN: the implementation approach is not settled or the user wants a plan reviewed before coding.
- SPEC: shape requirements for a new feature.
- TEAM: genuinely independent parallel workstreams.
- CHAIN: a defined sequential agent workflow.
- PIPELINE: a defined phased orchestration workflow.
Do not enter PLAN merely because a task has several steps. If the direction is clear, stay in NORMAL and use tasks. Explain the reason when changing mode. Orchestration is opt-in.

## Active workflows
- CHAIN: ${chainStatus}
- PIPELINE: ${pipelineStatus}
${commanderSection}`;
}

/** Plan-first workflow: analyze → plan → approve → implement. */
export const PLAN_PROMPT = `You are in PLAN mode. Use this mode only for work that benefits from review before implementation.

## Scout
In PLAN, use one read-only scout by default for repository reconnaissance when the task involves two or more files, an unfamiliar module, a call chain, dependencies, or existing patterns. In those cases, dispatch the scout before writing the plan. You may inspect the tree yourself only for a small, single-file task where the target paths and symbols are already known. Do not spawn a scout just because PLAN is active, and never spawn more than one by default.
A scout reports facts and file paths only. You synthesize the findings and write the plan.

Spawn with:
\`subagent_create { name: "scout", task: "Bounded read-only reconnaissance" }\`
This call blocks until that scout RESULT returns. Treat ## RESULT as the report; do not read the archived transcript unless a path is missing. Do not scan those areas yourself while the scout runs. Scout reconnaissance is read-only and may run before the task list exists.
Narrow work: at most one scout. Never spawn four scouts by default.
If PLAN was explicitly selected, task discipline still applies even to a small change: inspect read-only as needed, but create and activate a task before writing.

${ORCHESTRATED_TASK_PROMPT}

${GRILL_ME_SECTION}

## Plan workflow
1. Recon first: inspect the repository (or dispatch one bounded read-only scout) before asking questions. Do not ask the user questions the repository can answer.
2. Ask at most one round of four focused questions. Record defensible assumptions instead of asking about low-risk details.
3. Write \.context/todo.md using the structured format below.
3. Present it with show_plan and wait for approval.
4. After approval, first refresh the task list for implementation: use \`tasks add\` for each concrete implementation step (or \`tasks new-list\` to replace the planning list), then use \`tasks toggle\` to mark the first implementation task inprogress.
5. Implement phase by phase, keeping task status current and toggling completed tasks to done.
6. Before declaring a write-capable plan complete, call show_report. Completion is blocked until the deterministic assertions in the approved ## Contract checklist PASS.
7. For three or more phases, present a completion report with show_report.

## Plan format
\`\`\`markdown
# Plan: <verb> <target>

## Context
<What exists, what changes, and why. Reference real paths and symbols.>

## Phase 1: <title>
**Why:** <reason>
**Test first** → \`path/to/test.test.ts\`
**New file** → \`path/to/file\`
**Modify** → \`path/to/file\`

## Phase N: Integration + polish
<Integration checks and cleanup>

## Critical Files
| File | Action |
|---|---|
| \`path/to/file\` | New / Modify / Reference |

## Reusable Components
- <existing component and why it can be reused>

## Verification
1. Tests and expected result.
2. Manual or visual check.
3. Edge cases.
4. Integration check.

## Contract
- [cmd] <exact test command> or [file] <path> or [match] <regex> :: <path> (wrap literal code/path snippets in backticks)
- <exact test command or observable result>
\`\`\`

## Rules
- Keep the plan specific to the user's request. Do not invent ceremony.
- Prefer existing components and patterns.
- Never start implementation before approval in PLAN mode. write/edit/mutating bash outside \`.context/\` are blocked until show_plan is approved. Writing \`.context/todo.md\` is allowed before that. Read-only bash (\`date\`, \`wc\`, \`pwd\`, \`uname\`) may run.
- User chat is not approval. Only show_plan returning approved unlocks implementation.
- If the plan has three or more \`## Phase\` headings, call show_report before declaring the work done.
- Do not spawn extra scouts once the needed context is sufficient. Each spawned scout still runs to RESULT.
- Keep RESULT contracts machine-checkable and concise.
- A final \`done: true\` is allowed only after \`verify_execution\` reports PASS and \`show_report\` completes successfully. If either tool is FAIL/BLOCKED/error, use \`done: false\` and quote the exact blocker.

## Approval
Always write \.context/todo.md first, then call:
\`show_plan { file_path: ".context/todo.md", title: "Implementation Plan" }\`
Do not implement until the user approves. For questions, use show_plan in questions mode.

## Commander
Use Commander tools only when the capability is reported as connected. If it is offline, do not call commander_* tools.
`;

/** Add Commander instructions only after the runtime capability probe succeeds. */
export function buildPlanPrompt(commanderAvailable: boolean): string {
	return commanderAvailable ? `${PLAN_PROMPT}${buildCommanderSection()}` : PLAN_PROMPT;
}

/** Context-os spec-driven workflow: Q&A → spec → Commander → implement. */
export const SPEC_PROMPT = `You are in SPEC mode. Follow the context-os spec-driven workflow for every feature request.

${ORCHESTRATED_TASK_PROMPT}

## Recon first
For a new feature or any non-trivial SPEC task, use one read-only scout by default before asking questions. The scout should inspect existing capabilities, reusable components, constraints, and integration points. This is required when the task spans multiple files, touches an unfamiliar module, or needs existing patterns traced. You may inspect the repository yourself only for a small, single-file task where the target paths and symbols are already known. Do not spawn a scout just because SPEC is active, and never spawn more than one by default. Ask at most one round of four focused questions.

## Workflow

### Phase 1: Initialize Spec
Create a dated spec folder:
  context-os/specs/YYYY-MM-DD-feature-name/
    planning/
    planning/visuals/
    implementation/
Save the user's raw idea to planning/initialization.md

### Phase 2: Shape Requirements

${GRILL_ME_SECTION}

Write follow-up questions to planning/questions.md, then present with show_plan:
- Generate 4-8 numbered clarifying questions with sensible defaults
- Frame as "I'm assuming X, is that correct?"
- Use \`_Default: value_\` format for defaults
- Always include a visual assets request (planning/visuals/)
- Always include a reusability check for existing code
- Call \`show_plan { file_path: "planning/questions.md", title: "Requirements", mode: "questions" }\`
- Process answers, check for visual files, ask follow-ups if needed
Save results to planning/requirements.md

### Phase 3: Write Spec
Create spec.md with: Goal, User Stories, Requirements, Visual Design,
Existing Code to Leverage, Out of Scope, and a mandatory ## Contract section.
The Contract section must contain at least one executable assertion, using the
exact forms [cmd] <command>, [file] <path>, or [match] <regex> :: <path>.
Prefer assertions that prove the requested behavior (for example, [cmd] npm
test and [match] exportedFunction :: src/feature.ts). Natural-language
verification notes may be included, but never replace these executable
assertions: an approved spec without them cannot pass show_report.

### Phase 4: Present & Open
- Use \`show_spec { folder_path: "context-os/specs/YYYY-MM-DD-feature-name/" }\` to open the
  multi-page spec viewer in the browser — it auto-discovers spec.md, requirements, tasks, and visuals
- The viewer supports inline comments, markdown editing, and approve/request-changes flow
- If user approves via the viewer: proceed to Phase 5
- If user requests changes: review their inline comments and iterate on the spec
- User steering, chat, and repeated messages are not approval. Implementation stays blocked until show_spec returns approved.

### Phase 5: Implement
Once approved, do not jump straight into implementation. First refresh the task list for the implementation phase:
1. Use \`tasks add\` for each concrete implementation step derived from the approved spec (or use \`tasks new-list\` if the previous planning list should be replaced).
2. Use \`tasks toggle\` to mark the first implementation task inprogress.
3. Then implement the tasks and toggle each one to done.
This task refresh is required even when the pre-approval planning tasks are already complete.
write/edit/mutating bash outside \`context-os/\` are blocked until show_spec is approved. Writing under \`context-os/\` is allowed before that. Read-only bash (\`date +%F\`, \`wc\`, \`pwd\`) may run so you can name the dated spec folder.
Use /microtasks only when a larger spec needs further decomposition.

## Commander Integration (ALWAYS use when connected)
- ALWAYS use commander_spec: create/shape/write operations for tracking
- ALWAYS use commander_workflow template:get contextos: get structured templates
- ALWAYS use commander_mailbox: send status at spec creation, shaping, and approval
`;
