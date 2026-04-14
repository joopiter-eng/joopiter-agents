# Automations Feature Research

This document is the go-to implementation brief for an "Automations" feature in Open Agents.

Goal:
- Let a user save an automation with one or more triggers, instructions, execution context, and enabled tools/connections.
- On trigger, run those instructions with the existing coding agent against the target repo or workspace context.
- Allow the agent to take selected external actions, such as opening a GitHub PR, once those tools are explicitly enabled from the automation UI.

This write-up focuses on:
- the current feature set that already exists in the repo,
- how the new feature should fit the current architecture,
- what gaps have to be closed,
- and what the product UX should look like.

## TL;DR

The cleanest way to build Automations in this codebase is:

1. Treat an automation as a top-level config object made of triggers, instructions, execution context, and tool policy.
2. Treat each scheduled execution as a normal `session` + `chat` run.
3. Reuse the existing agent workflow, sandbox, GitHub auth, PR, diff, preview, and webhook flows.
4. Add a trigger layer plus a small set of extracted server-side helpers so runs do not depend on a browser being open.
5. Make side effects agent-invoked through enabled tools, while keeping the tool implementations server-owned and hardened.

The most important architectural point is this:

- Automations should be "a new way to start sessions", not a second agent runtime.

That keeps the feature aligned with the current product model and reuses the most mature paths in the app.

The second important product point is this:

- Automations should be broader than "cron + prompt + auto-PR".

The right long-term shape is closer to:
- triggers,
- instructions,
- enabled tools / MCPs / connections,
- and execution context.

That keeps the initial cron use case compatible with future webhook triggers and future external systems like Notion and Linear.

## Current Feature Set Relevant To Automations

### 1. Durable agent execution already exists

The app already runs the coding agent as a durable Workflow SDK job rather than inline inside a request.

Relevant files:
- `README.md`
- `apps/web/next.config.ts`
- `apps/web/app/api/chat/route.ts`
- `apps/web/app/workflows/chat.ts`
- `apps/web/lib/db/workflow-runs.ts`

What already works:
- A chat request starts `runAgentWorkflow(...)` through `workflow/api`.
- Workflow runs stream progress, can be resumed, and are recorded in `workflow_runs` / `workflow_run_steps`.
- The app already uses durable workflow sleep/lease patterns elsewhere for sandbox lifecycle management.

Why this matters:
- The repo already has a proven background execution primitive.
- Automations do not need a new agent execution engine.
- What is missing is scheduling and unattended run orchestration.

### 2. Sessions are already the durable unit of work

The product centers on `sessions` and `chats`.

Relevant files:
- `apps/web/lib/db/schema.ts`
- `apps/web/lib/db/sessions.ts`
- `apps/web/app/api/sessions/route.ts`

A session already stores:
- repo owner/name,
- branch,
- clone URL,
- sandbox state,
- lifecycle state,
- PR metadata,
- cached diff,
- Vercel project linkage,
- per-session auto-commit / auto-PR overrides.

Why this matters:
- A scheduled run already has a natural home in the current model.
- If an automation run creates a session, the rest of the product can "just work" around it.

### 3. Sandbox lifecycle and repo setup already exist

The repo already knows how to create or reconnect a named persistent Vercel sandbox for a session, optionally cloning a GitHub repo and creating a new branch.

Relevant files:
- `apps/web/app/api/sandbox/route.ts`
- `apps/web/lib/sandbox/config.ts`
- `apps/web/lib/sandbox/utils.ts`
- `packages/sandbox/factory.ts`
- `packages/sandbox/vercel/config.ts`

What already works:
- Session sandboxes are named and durable.
- Repo cloning + branch creation can happen at sandbox creation time.
- GitHub tokens are brokered into sandbox git operations without exposing raw tokens to the model.
- Lifecycle hibernation/resume is already workflow-managed.

Important constraint:
- Session creation is lightweight and does not create a live sandbox by itself.
- Today the chat page auto-creates the sandbox client-side when a user opens the session.

Why this matters:
- An unattended automation cannot rely on UI-driven sandbox creation.
- The automation runner needs a shared server-side `ensureSessionSandbox(...)` path.

Related doc:
- `docs/plans/lazy-sandbox-session-creation.md`

### 4. The coding agent is already repo-capable, but its toolset is static

The model-facing toolset already gives the agent strong repo editing capability.

Relevant files:
- `packages/agent/open-harness-agent.ts`
- `packages/agent/tools/index.ts`
- `packages/agent/tools/bash.ts`
- `packages/agent/system-prompt.ts`
- `apps/web/app/api/chat/_lib/runtime.ts`

What the agent can do today:
- read, write, edit, grep, glob, bash, web fetch, task delegation, skill use,
- run git commands in the sandbox,
- potentially push via git because the runtime connects the sandbox with a GitHub token.

What the agent does not have today:
- a first-class GitHub tool,
- a first-class "create PR" tool,
- a first-class Notion / Linear / webhook action tool,
- an automation-scoped tool allowlist,
- an automation-scoped connection binding model,
- a first-class scheduled/unattended execution mode.

Why this matters:
- The current agent can edit a repo well, but the automation product cannot stop at "whatever tools the chat agent always has".
- To support future connectors cleanly, automations need their own enabled-tools and enabled-connections layer.

### 5. Post-finish git automation already exists, but it is not yet a general tool-action model

This is the closest existing precursor to the requested feature.

Relevant files:
- `apps/web/app/api/chat/route.ts`
- `apps/web/app/workflows/chat.ts`
- `apps/web/app/workflows/chat-post-finish.ts`
- `apps/web/lib/chat/auto-commit-direct.ts`
- `apps/web/lib/chat/auto-pr-direct.ts`
- `apps/web/app/settings/preferences-section.tsx`

Current behavior:
- A session can opt into `autoCommitPush`.
- A session can opt into `autoCreatePr`.
- After a chat workflow finishes naturally, the server-side post-finish path can:
  - detect changed files,
  - commit them,
  - push them,
  - then create or sync a PR.

Important nuance:
- This only runs after a natural finish.
- If the workflow pauses for `ask_user_question` or approval, post-finish git automation does not run.

Why this matters:
- The repo already has a server-side "after the agent stops, publish git results" pattern.
- Scheduled automations can build on that, but they should not be modeled only as hardcoded post-run behavior if we want future connector actions.

### 6. GitHub auth, installation, PR, and webhook flows are already strong

Relevant files:
- `apps/web/app/api/github/app/install/route.ts`
- `apps/web/lib/github/user-token.ts`
- `apps/web/lib/github/client.ts`
- `apps/web/app/api/pr/route.ts`
- `apps/web/app/api/github/webhook/route.ts`
- `docs/agents/lessons-learned.md`

What already works:
- GitHub App install and user-token linking.
- Token refresh.
- PR creation via Octokit.
- Merge readiness checks.
- Auto-merge enablement.
- GitHub webhook updates for PR close / merge.
- Session auto-archive on PR close/merge.

Important nuance:
- There are two PR-related stacks today:
  - a lighter auto-PR path in `auto-pr-direct.ts`,
  - a richer interactive flow split across `/api/generate-pr` and `/api/pr`.
- The richer flow already handles more real-world edge cases like fork fallback and manual compare-path fallbacks.

Why this matters:
- The automation feature should converge these paths instead of adding a third one.

### 7. The current UX already has reusable Git and review surfaces

Relevant files:
- `apps/web/components/session-starter.tsx`
- `apps/web/components/create-pr-dialog.tsx`
- `apps/web/app/sessions/[sessionId]/chats/[chatId]/git-panel.tsx`
- `apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-content.tsx`
- `apps/web/app/api/sessions/[sessionId]/checks/fix/route.ts`

Current UX building blocks:
- Start a session from a repo or empty sandbox.
- Choose branch behavior.
- Toggle auto commit and auto PR defaults.
- Generate PR content.
- Create ready or draft PRs.
- See merge readiness.
- Fix failing CI checks by generating a prompt plus log snippets.
- Track preview deployment URLs after a PR / branch push.

Why this matters:
- Automations should feel like a scheduled version of the existing session/git workflow, not a disconnected subsystem.

## What Does Not Exist Yet

There is no first-class automation layer in the repo today.

Missing pieces:
- no `automations` table,
- no `automation_runs` table,
- no first-class trigger model beyond what we could build ad hoc,
- no schedule parser / timezone-aware next-run calculator,
- no recurring workflow or cron dispatcher,
- no automation list/detail/create UI,
- no unattended run state like `needs_attention`,
- no automation-scoped tool allowlist / tool config,
- no automation-scoped connection binding model,
- no server-side "start chat workflow for a session" helper that is decoupled from the browser request path,
- no shared `ensureSessionSandbox(...)` helper for unattended starts,
- no durable out-of-app notifications.

Also important:
- There is no `vercel.json` cron configuration in the repo right now.
- `workflow_runs` only tracks chat workflow executions, not recurring automation definitions.
- The current agent tool registry is global/static, not selected per automation run.

## Recommended Product Shape

## Core Product Model

Recommended mental model:

- `Automation` = saved configuration.
- `Automation trigger` = why a run starts.
- `Automation run` = one execution caused by a trigger.
- `Session` = the actual durable work artifact for that execution.

Recommended automation shape:
- triggers
- instructions
- execution context
- enabled tools / MCPs / connections
- run history

This means an automation run should create:
- a new `session`,
- a new initial `chat`,
- a sandbox for that session,
- and then start the existing chat workflow with the saved instructions plus automation-specific runtime context.

Why this is the right fit:
- Sessions already own repo, branch, sandbox, PR, diff, preview, and lifecycle state.
- Users already know how to inspect a session when something needs attention.
- It keeps all git/PR work visible in the existing UI.

## Recommended Data Model

Add a new `automations` table, roughly containing:
- `id`
- `userId`
- `name`
- `instructions`
- `repoOwner`
- `repoName`
- `baseBranch`
- `modelId`
- `enabled`
- `executionEnvironment`
- `visibility`
- `defaultToolPolicy`
- `defaultConnectionPolicy`
- `lastRunAt`
- `nextRunAt`
- `schedulerLeaseId`
- `schedulerState`
- `createdAt`
- `updatedAt`

Add an `automation_triggers` table, roughly containing:
- `id`
- `automationId`
- `type`
- `config`
- `enabled`
- `createdAt`
- `updatedAt`

For v1, `type = cron` and `config` can hold:
- `scheduleCron`
- `timezone`

This is intentionally broader than storing cron directly on the automation row, so webhook and event triggers can fit later without rethinking the model.

Add an `automation_tools` table, roughly containing:
- `id`
- `automationId`
- `toolType`
- `config`
- `enabled`
- `createdAt`
- `updatedAt`

Examples later:
- `open_pull_request`
- `comment_on_pull_request`
- `send_to_slack`
- `update_notion_page`
- `create_linear_ticket`

Add an `automation_connections` table, roughly containing:
- `id`
- `automationId`
- `provider`
- `connectionRef`
- `config`
- `enabled`
- `createdAt`
- `updatedAt`

Add a new `automation_runs` table, roughly containing:
- `id`
- `automationId`
- `userId`
- `sessionId`
- `chatId`
- `workflowRunId`
- `status`
- `triggeredAt`
- `startedAt`
- `finishedAt`
- `resultSummary`
- `prNumber`
- `prUrl`
- `compareUrl`
- `error`
- `needsAttentionReason`
- `createdAt`
- `updatedAt`

Recommended status set for `automation_runs`:
- `queued`
- `running`
- `completed`
- `failed`
- `needs_attention`
- `cancelled`

Recommended session linkage:
- add `sessions.automationId`
- add `sessions.runSource` with values like `manual` / `automation`

That keeps session UX reusable while still allowing filtering and grouping.

## Recommended Backend Architecture

## 1. Extract shared server-side helpers first

Before building the scheduler, extract two helpers from existing routes:

1. `ensureSessionSandbox(...)`
   - Source today: `apps/web/app/api/sandbox/route.ts`
   - Needed because automation runs cannot depend on `session-chat-content.tsx` auto-starting the sandbox.

2. `startSessionChatWorkflow(...)`
   - Source today: `apps/web/app/api/chat/route.ts`
   - Needed because automation runs should start the same workflow without pretending to be a browser chat request.

The new shared helper should:
- validate session ownership / repo context,
- ensure sandbox availability,
- build the runtime with `createChatRuntime(...)`,
- resolve model selection and preferences,
- set the chat `activeStreamId`,
- start `runAgentWorkflow(...)`.

## 2. Reuse the existing chat workflow

Do not create a separate "automation agent workflow".

Instead:
- create a synthetic first user message from the automation instructions,
- persist it like a normal chat message,
- start the same `runAgentWorkflow(...)`.

Benefits:
- the existing tool/runtime behavior stays consistent,
- diffs, assistant messages, usage tracking, and git post-finish behavior all remain unified,
- session pages stay debuggable.

## 3. Add automation-scoped tool policy

This is the key change needed to support future connectors cleanly.

Recommended rule:
- let the automation decide which tools and connections are available,
- let the agent decide whether to use an enabled tool,
- keep the actual side-effect implementation inside server-owned tool handlers.
- give automated runs a non-interactive toolset by default.

For example, an automation could enable:
- `open_pull_request`
- `comment_on_pull_request`
- `send_to_slack`
- `update_notion_page`
- `create_linear_ticket`

This gives us the Cursor-style product model without relying on raw shell improvisation for external side effects.

Recommended implementation direction:
- keep the existing repo-editing agent flow,
- add automation-scoped tool enablement at workflow start,
- wire each external-action tool to shared server logic,
- and let the agent call those tools when appropriate.
- omit interactive tools like `ask_user_question` from unattended runs,
- and treat explicitly enabled automation tools as pre-authorized for that run instead of prompting again mid-execution.

For GitHub PR creation specifically:
- do not make automatic PR creation the only default publication path,
- do not rely on the model creating a PR through ad hoc shell/API improvisation,
- expose PR creation as an automation-enabled tool,
- and back that tool with the hardened GitHub logic already present in `/api/generate-pr`, `/api/pr`, and `apps/web/lib/github/client.ts`.

This is the best hybrid:
- product-wise, the agent "chooses" to open the PR,
- system-wise, the PR still flows through reliable server-owned code paths.

## 4. Add a trigger layer

The initial trigger can be cron, but the abstraction should be broader.

Recommended trigger types over time:
- `cron`
- `manual`
- `webhook`
- future provider-native triggers like GitHub / Notion / Linear events

For v1:
- implement cron first,
- but store triggers as rows/config objects rather than baking cron directly into the automation model.

Why:
- webhook triggers will need their own config, secrets, idempotency, and signature validation,
- and a first-class trigger abstraction avoids repainting the whole system later.

## 5. Add a scheduler layer for cron triggers

There are two viable scheduling shapes.

### Option A: one durable workflow per automation

This fits the repo's current patterns best.

Why:
- the codebase already uses Workflow SDK sleep loops for sandbox lifecycle,
- the repo already understands lease-based workflow coordination,
- no separate cron dispatcher is currently present.

Shape:
- creating or enabling an automation starts a durable scheduler workflow,
- that workflow computes `nextRunAt`,
- sleeps until the next due time,
- claims a lease,
- creates an `automation_run`,
- creates a session/chat,
- starts the normal chat workflow,
- computes the following `nextRunAt`,
- repeats until paused/deleted/replaced.

### Option B: cron-driven dispatcher

Alternative shape:
- add a platform cron that wakes every minute or five minutes,
- query `automations where enabled = true and nextRunAt <= now`,
- claim due rows,
- dispatch runs.

This is also valid, but it introduces a separate scheduling control plane that the repo does not currently have.

Recommendation:
- prefer Option A first because it matches the existing Workflow SDK usage and lifecycle-lease patterns already in the codebase.

Decision:
- use Option A for v1.

## 6. Add explicit unattended-run semantics

This is the biggest behavior gap.

Current problem:
- the agent can pause for `ask_user_question`,
- the agent can pause for approval-required tool states,
- some future automation-enabled tools may not be unattended-safe in all configurations.

For automations, define this clearly:

- If the run finishes naturally:
  - persist normal run/session/workflow state,
  - and allow any agent-invoked external actions that already succeeded to stand as the outcome.
- Do not expose interactive tools like `ask_user_question` in unattended automation runs.
- Do not require an extra approval prompt for tools that were explicitly enabled in the automation config.
- If the run still reaches an interactive, disabled, or attention-requiring path:
  - end that run as `needs_attention`,
  - preserve the session,
  - notify the user,
  - let the user open the session and continue manually,
  - and keep the parent automation itself scheduled for future runs.

- If the run reaches a disabled, misconfigured, or attention-requiring external action:
  - do not silently drop the action,
  - record the attempted action in run state,
  - and move the run to `needs_attention` when user intervention is required.

This gives a clean product contract:
- automations are autonomous until they are not,
- and when they are blocked, they degrade into a normal session the user can resume.

## UX Proposal

## Primary navigation

Add a top-level `Automations` surface separate from `Sessions`.

Why:
- sessions are individual runs,
- automations are saved recurring configs.

Recommended top-level views:
- `Automations list`
- `Automation detail`
- `Automation run history`

## Create / edit flow

Recommended create form fields:
- Name
- Trigger(s)
- Instructions
- Repository
- Base branch
- Model
- Enabled tools / MCPs / connections
- Execution environment
- "Pause on creation" or enabled toggle

Recommended reuse:
- reuse repo selection patterns from `SessionStarter` / `RepoSelectorCompact`
- reuse branch selection patterns from current session flows
- reuse settings language from current session and GitHub flows where it helps

Recommended trigger UX:
- support cron under the hood first,
- but structure the UI as "Add Trigger",
- and leave room for webhook and provider-native triggers later.

For the cron trigger specifically:
- present human-friendly presets first,
- with an "advanced cron" field for power users.

Examples:
- Every weekday at 9:00
- Every Monday at 10:00
- Daily at 18:00
- Custom cron

Always show:
- the user's timezone,
- the next scheduled run time,
- and a plain-English schedule summary.

Recommended tools/connections UX:
- show a "Tools" section in automation creation,
- allow adding enabled tools / MCPs / future connector-backed actions,
- clearly distinguish between repo-editing tools that are always part of the coding runtime and optional side-effect tools configured per automation.
- model MCP servers as first-class automation bindings,
- let each automation filter which tools from that MCP server are exposed,
- and start with remote MCP transports (`HTTP` / `SSE`) for v1 rather than local `stdio` servers.

For GitHub specifically, a good first tool shape would be:
- `Open Pull Request`
- optional config like draft vs ready, target branch strategy, and maybe title/body guidance
- default to draft in v1

That keeps PR creation aligned with the agent while preserving implementation control.

## Automation detail page

Each automation detail page should show:
- repo + base branch
- instructions
- configured triggers
- configured tools / connections
- enabled / paused state
- next run time
- last run result
- recent run history
- most recent PR
- "Run now" action

Useful actions:
- Edit
- Pause / Resume
- Run now
- Open latest session
- Open latest PR

Decision:
- `Run now` should bypass the scheduler sleep path and start the run directly.

## Run history UX

Each run should show:
- status
- start / finish times
- linked session
- linked PR or compare URL
- short result summary

Recommended statuses:
- Running
- Completed
- Failed
- Needs attention

For `needs_attention`, surface the reason explicitly:
- Agent attempted an interactive or disallowed action
- Tool requires manual attention
- GitHub permissions/fork setup blocked publish

## Session UX integration

Automation-created sessions should stay visible in the existing session system, but with source labeling.

Recommended session affordances:
- badge: `Automation`
- link back to parent automation
- session title derived from automation name + scheduled timestamp

Why:
- users can inspect diffs, previews, PR state, and the full transcript in the existing UI,
- blocked runs can be resumed using familiar chat flows.

## How This Feature Fits The Current UX

The best product story is:

- manual work starts from `Sessions`,
- recurring work starts from `Automations`,
- both produce normal session artifacts.

That creates a coherent model:
- Sessions are runs.
- Automations are saved producers of runs.

This fits current UX patterns well because the app already expects users to:
- choose a repo,
- inspect a live or completed session,
- review diffs,
- create or inspect PRs,
- fix checks,
- and track deployment previews.

## Key Risks And Constraints

## 1. Sandbox creation is still UI-biased today

Automation runs will fail or stall if they rely on the current "open session page and auto-create sandbox" behavior.

Mitigation:
- extract `ensureSessionSandbox(...)` before building scheduling.

## 2. PR creation logic is split today

Interactive and automatic PR flows are not yet unified.

Mitigation:
- converge on shared server-side git/PR publish helpers before or during automation-tool work.

## 3. Unattended runs can block on interaction

The current agent runtime can legitimately pause.

Mitigation:
- remove interactive tools from unattended runs,
- pre-authorize explicitly enabled automation tools,
- and treat anything still needing human intervention as `needs_attention`.

## 4. Automation-scoped tools do not exist yet

The current tool registry is effectively global for the coding agent.

Mitigation:
- introduce an automation-scoped allowlist/config layer before adding many external actions,
- so cron, webhook, Notion, Linear, and GitHub actions all fit the same model.

## 5. Browser toasts are not real background notifications

Current alerts are browser-session polling plus toast/sound behavior.

Relevant file:
- `apps/web/hooks/use-background-chat-notifications.tsx`

Implication:
- v1 can still feel good inside the app,
- but true off-app notifications are a separate problem.

## 6. Permission edge cases are real

The existing lessons learned around GitHub installs, fork creation, push denials, and compare fallbacks apply directly to automation runs.

Implication:
- automation runs must capture actionable outcomes like `compareUrl` or `needs_attention`,
- not just generic "PR failed".

## Recommended Implementation Phases

## Phase 1: backend foundations

- Add `automations` and `automation_runs` schema.
- Add trigger/tool/connection schema.
- Extract `ensureSessionSandbox(...)`.
- Extract `startSessionChatWorkflow(...)`.
- Add shared server-side helpers for automation-enabled external action tools.
- Add session source metadata (`manual` vs `automation`).

## Phase 2: trigger and scheduler runtime

- Add durable automation scheduler workflow.
- Add lease/claim logic to avoid duplicate firing.
- Add `Run now`.
- Add run record creation and state transitions.
- Add cron trigger execution.

## Phase 3: UI

- Add Automations list page.
- Add create/edit dialog or page.
- Add trigger editor.
- Add tools/connections editor.
- Add run history UI.
- Add automation badges / links inside sessions.

## Phase 4: blocked-run and permission UX

- Add `needs_attention` state and messaging.
- Surface compare URLs and fork/permission problems clearly.
- Let users jump directly into the generated session to resume manually.

## Phase 5: connector expansion

- Add webhook trigger type.
- Add first external connector-backed tools.
- Add tool-level run summaries and auditability.

## Phase 6: polish

- Add better schedule presets and previews.
- Add filtering/grouping for automation sessions.
- Add richer summaries and analytics.

## Decision Summary

- Use one durable workflow per automation for v1 scheduling.
- Default automation-created PRs to draft when the `Open Pull Request` tool is enabled.
- Use a fresh branch for each automation run.
- If a run hits a blocked or attention-requiring path, mark only that run as `needs_attention`; keep the automation scheduled for future runs.
- Follow the existing merge behavior and auto-archive automation sessions on merge.
- Snapshot user global skills at automation creation time, the same way sessions do today.
- Let `Run now` bypass the scheduler sleep path and launch the run directly.
- Treat tools that were explicitly enabled in the automation as pre-authorized during that automation run.
- Model future connectors as first-class connection bindings, especially MCP server bindings, while still letting each binding expose a filtered set of tool actions.
- For MCP in v1, support remote bindings (`HTTP` / `SSE`) and per-automation allowed-tool filters.

## Recommended Answer To The Original Question

If we implement this feature in a way that fits the current codebase, it should look like this:

- The user creates an automation from triggers, instructions, repo/execution context, and enabled tools/connections.
- On each trigger fire, the system creates a normal session and chat for that run.
- A server-side automation runner ensures the sandbox and starts the existing chat workflow with automation-scoped tool policy.
- The agent can then choose to call enabled tools like `Open Pull Request`, with those tools backed by reliable server-owned implementations.
- The user reviews results through the existing session UI, with an automation dashboard sitting above it for configuration and run history.

That gives us the smallest conceptual jump and the highest reuse of code that already exists.

## Relevant Code Map

Core workflow:
- `apps/web/app/api/chat/route.ts`
- `apps/web/app/workflows/chat.ts`
- `apps/web/app/workflows/chat-post-finish.ts`

Session and persistence:
- `apps/web/app/api/sessions/route.ts`
- `apps/web/lib/db/schema.ts`
- `apps/web/lib/db/sessions.ts`
- `apps/web/lib/db/workflow-runs.ts`

Sandbox:
- `apps/web/app/api/sandbox/route.ts`
- `apps/web/lib/sandbox/config.ts`
- `apps/web/lib/sandbox/utils.ts`
- `apps/web/SANDBOX-LIFECYCLE.md`

Agent runtime:
- `apps/web/app/api/chat/_lib/runtime.ts`
- `packages/agent/open-harness-agent.ts`
- `packages/agent/tools/index.ts`
- `packages/agent/tools/bash.ts`
- `packages/agent/tools/ask-user-question.ts`

GitHub and PR:
- `apps/web/lib/github/user-token.ts`
- `apps/web/lib/github/client.ts`
- `apps/web/lib/chat/auto-commit-direct.ts`
- `apps/web/lib/chat/auto-pr-direct.ts`
- `apps/web/app/api/generate-pr/route.ts`
- `apps/web/app/api/pr/route.ts`
- `apps/web/app/api/github/webhook/route.ts`

Current UX:
- `apps/web/components/session-starter.tsx`
- `apps/web/app/settings/preferences-section.tsx`
- `apps/web/components/create-pr-dialog.tsx`
- `apps/web/app/sessions/[sessionId]/chats/[chatId]/git-panel.tsx`
- `apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-content.tsx`

Related prior planning:
- `docs/plans/lazy-sandbox-session-creation.md`
- `docs/agents/lessons-learned.md`
