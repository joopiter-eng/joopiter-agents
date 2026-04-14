Summary: Add first-class automations as saved producers of normal sessions/chats, using the existing agent and sandbox runtime rather than introducing a second execution stack.

Context:
- `docs/automations-feature-research.md` recommends modeling automations as config + trigger + run history, with each execution producing a normal `session` and `chat`.
- `apps/web/app/api/chat/route.ts` currently owns workflow startup and assumes an already-usable sandbox.
- `apps/web/app/api/sandbox/route.ts` currently owns sandbox provisioning/resume logic and is still biased toward browser-initiated session usage.
- `apps/web/app/workflows/chat.ts` and `apps/web/app/workflows/chat-post-finish.ts` already provide the durable agent execution, workflow run persistence, and post-finish git automation that automation runs should reuse.
- `apps/web/app/workflows/sandbox-lifecycle.ts` and `apps/web/lib/sandbox/lifecycle-kick.ts` show the repo’s preferred pattern for durable sleep-loop workflows and lease-based coordination.
- `apps/web/lib/db/schema.ts` and `apps/web/lib/db/sessions.ts` already define sessions/chats as the durable unit of work, so automation runs should link into those tables instead of creating a parallel artifact model.

System Impact:
- Source of truth expands from `sessions`/`chats` alone to `automations` + `automation_runs`, while `sessions` remain the runtime artifact users inspect, resume, diff, and publish from.
- Workflow startup moves from route-only logic to shared server-side helpers so manual chat requests and unattended automation runs use the same orchestration path.
- Unattended execution introduces new invariants: automation runs cannot depend on browser-only setup, cannot expose interactive tools by default, and must degrade into `needs_attention` instead of silently stalling.
- Scheduler ownership becomes explicit: one durable scheduler workflow per automation should own `nextRunAt` progression and duplicate-run avoidance via leases/claims.

Approach:
- Implement automations as a thin orchestration layer above the existing session/chat/agent stack.
- Extract shared server helpers first (`ensureSessionSandbox(...)`, `startSessionChatWorkflow(...)`) so all later automation work is built on reusable runtime seams.
- Ship the automation runner before the scheduler by adding `Run now`; this gives a deterministic end-to-end path to validate unattended behavior before adding recurring triggers.
- Keep external side effects server-owned by introducing automation-scoped tool policy/config instead of relying on ad hoc shell/API behavior from the agent.
- Scope v1 around cron triggers, `Run now`, run history, unattended execution semantics, and one GitHub-backed publish action (`Open Pull Request`); defer webhook triggers and off-app notifications until the foundation is stable.

Changes:
- `apps/web/lib/db/schema.ts`
  Add `automations`, `automation_triggers`, `automation_tools`, `automation_connections`, and `automation_runs`, plus `sessions.automationId` and `sessions.runSource`.
- `apps/web/lib/db/migrations/*`
  Commit the generated Drizzle migration for the schema changes.
- `apps/web/lib/db/automations.ts`
  Add CRUD/query/state-transition helpers for automation definitions, triggers, tools, connections, and runs.
- `apps/web/lib/automations/*.ts`
  Add Zod-backed config schemas, schedule utilities, run orchestration helpers, summary builders, and trigger/tool policy helpers.
- `apps/web/lib/sandbox/ensure-session-sandbox.ts`
  Extract server-owned sandbox ensure/resume logic from `apps/web/app/api/sandbox/route.ts`.
- `apps/web/lib/chat/start-session-chat-workflow.ts`
  Extract workflow startup and model/runtime resolution from `apps/web/app/api/chat/route.ts`.
- `apps/web/app/api/automations/**`
  Add list/create/update/run-now endpoints and any run-history/detail endpoints needed by the UI.
- `apps/web/app/workflows/automation-scheduler.ts`
  Add the per-automation durable scheduler workflow using the existing sleep/lease pattern.
- `apps/web/app/workflows/chat.ts`
  Accept automation run context so unattended runs can disable interactive tools and report `needs_attention`.
- `packages/agent/open-harness-agent.ts`
  Allow the runtime to supply an automation-scoped tool set / policy rather than always exposing the same static tool registry.
- `apps/web/app/automations/**`
  Add list/detail/create-edit UI, run history, schedule preview, and `Run now` affordances.
- `apps/web/components/**` and `apps/web/app/sessions/**`
  Surface automation badges, parent-automation links, and `needs_attention` outcomes in existing session views.
- `apps/web/lib/chat/auto-pr-direct.ts`, `apps/web/app/api/generate-pr/route.ts`, `apps/web/app/api/pr/route.ts`
  Converge PR publication behind shared server helpers so the first automation external action uses hardened GitHub code paths.

## Milestone 1: Persistence And Shared Runtime Helpers

Goal: land the schema, CRUD surface, and reusable server-side orchestration seams that later milestones depend on.

Scope:
- Add the automation tables and session linkage fields in `apps/web/lib/db/schema.ts` and the generated migration.
- Add `apps/web/lib/db/automations.ts` plus Zod-backed config parsing under `apps/web/lib/automations/`.
- Extract `ensureSessionSandbox(...)` from `apps/web/app/api/sandbox/route.ts` into a shared server helper.
- Extract `startSessionChatWorkflow(...)` from `apps/web/app/api/chat/route.ts` into a shared server helper that manual chat and automation runs can both call.
- Add initial authenticated CRUD endpoints in `apps/web/app/api/automations/route.ts` and `apps/web/app/api/automations/[automationId]/route.ts`.

Why this milestone exists:
- This is the smallest coherent backend foundation.
- It removes the current browser-only assumption from sandbox/workflow startup before unattended execution is introduced.

Automated tests:
- Add DB helper tests for automation create/update/read/list behavior and run-source/session linkage in `apps/web/lib/db/automations.test.ts`.
- Update `apps/web/app/api/chat/route.test.ts` and `apps/web/app/api/sandbox/route.test.ts` to prove the extracted helpers preserve existing behavior.
- Add API route tests for automation CRUD, auth enforcement, and config validation under `apps/web/app/api/automations/**/*.test.ts`.

Manual tests:
- Create, update, list, and pause an automation through the API and verify the stored trigger/tool/config payloads round-trip correctly.
- Create a normal session and send a message to confirm chat startup still works after the helper extraction.
- Create or resume a sandbox through the existing sandbox entry point and confirm the extracted helper still provisions exactly one session sandbox.

Exit criteria:
- Automation definitions can be persisted and retrieved.
- Session/chat startup no longer depends on route-local sandbox/workflow code.
- Existing manual session behavior remains unchanged.

## Milestone 2: Single-Run Automation Execution

Goal: make one automation run work end-to-end with `Run now`, before recurring scheduling is introduced.

Scope:
- Add `apps/web/lib/automations/run-automation.ts` to create an `automation_run`, create a fresh `session` + initial `chat`, ensure the sandbox, persist the synthetic first user message, and start the existing chat workflow.
- Add `apps/web/app/api/automations/[automationId]/run/route.ts` for `Run now`.
- Extend `apps/web/app/workflows/chat.ts` and related runtime code so automation runs carry execution context (`automationRunId`, unattended mode, tool policy).
- Add unattended-run semantics: do not expose interactive tools like `ask_user_question`, and translate blocked/disallowed paths into `automation_runs.status = needs_attention` instead of hanging the run.
- Record result summaries, linked session/chat/workflow IDs, and failure reasons in `automation_runs`.

Why this milestone exists:
- It validates the core product claim that automations are just a new way to start sessions.
- It derisks scheduler work by proving the underlying run path first.

Automated tests:
- Add runner tests in `apps/web/lib/automations/run-automation.test.ts` for session/chat/run creation, status transitions, and idempotent failure handling.
- Extend `apps/web/app/workflows/chat.test.ts` to cover unattended mode, disabled interactive tools, and `needs_attention` transitions.
- Add route tests for `Run now`, including auth, missing automation, and paused automation behavior.

Manual tests:
- Trigger `Run now` on a repo-backed automation and verify it creates a new session/chat, runs the agent, and links back to the automation.
- Trigger `Run now` on an automation that would normally call `ask_user_question`; verify the run lands in `Needs attention` and the session can be resumed manually.
- Run the same automation twice and verify each run creates a fresh session artifact and does not reuse the prior chat/session.

Exit criteria:
- A user can execute an automation once without the browser orchestrating the runtime.
- Blocked unattended paths degrade cleanly into resumable sessions.
- Run history shows enough metadata to debug failures before any scheduler UI exists.

## Milestone 3: Durable Cron Scheduler

Goal: turn the single-run path into recurring automation via one durable workflow per automation.

Scope:
- Add schedule parsing and next-run calculation utilities in `apps/web/lib/automations/cron.ts` (or equivalent), including timezone-aware summaries and `nextRunAt` calculation.
- Add scheduler claim/lease helpers in `apps/web/lib/db/automations.ts`.
- Add `apps/web/app/workflows/automation-scheduler.ts` following the `apps/web/app/workflows/sandbox-lifecycle.ts` sleep-loop pattern.
- Start/replace/stop the scheduler when an automation is enabled, edited, paused, or deleted from the API layer.
- Ensure each due trigger creates exactly one `automation_run`, advances `nextRunAt`, and leaves the parent automation scheduled even if a single run becomes `needs_attention`.

Why this milestone exists:
- The repo already favors durable workflow loops over a separate cron dispatcher; this milestone applies that pattern directly.

Automated tests:
- Add scheduler tests for next-run calculation, timezone handling, pause/resume, and duplicate-claim prevention.
- Add workflow tests for sleep-loop behavior, stale lease replacement, and “keep scheduling after a failed or needs-attention run”.
- Add API tests proving enable/edit/pause operations update scheduler state and `nextRunAt` consistently.

Manual tests:
- Create an automation with a short cron schedule, enable it, and verify `nextRunAt` and the plain-English schedule preview are correct in the user’s timezone.
- Wait for or simulate a due time and confirm exactly one run fires, even if multiple requests or tabs touch the automation.
- Pause the automation, confirm future runs stop, then resume and confirm scheduling restarts with the next correct fire time.

Exit criteria:
- Cron-backed automations can run repeatedly without duplicate firing.
- Scheduler ownership is explicit and resilient to edits, pauses, and failures.
- `Run now` remains available and bypasses the sleep loop without breaking scheduled state.

## Milestone 4: Automations UI And Session Integration

Goal: make automations a first-class product surface rather than an API-only backend feature.

Scope:
- Add `apps/web/app/automations/page.tsx` and `apps/web/app/automations/[automationId]/page.tsx` with list/detail shells.
- Add creation/editing components under `apps/web/app/automations/` or `apps/web/components/automation-*` for name, instructions, repo/base branch, model, triggers, execution environment, enabled tools, and paused/enabled state.
- Add run history, last result, next run, and `Run now` affordances to the detail page.
- Add top-level navigation to Automations and integrate automation-created sessions into existing session surfaces with badges/back-links in `apps/web/components/inbox-sidebar.tsx`, `apps/web/components/session-list.tsx`, and `apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-content.tsx`.

Why this milestone exists:
- Until this point the feature is backend-capable but not discoverable or operable from the app.
- The UI needs to reinforce the mental model that Automations create Sessions rather than replacing them.

Automated tests:
- Add component tests for form serialization, schedule preview rendering, paused/enabled state, and run-history formatting.
- Add route/page tests for automation list/detail loading states and empty/error states.
- Add UI tests around session badges/back-links so automation-created sessions are distinguishable from manual sessions.

Manual tests:
- Create an automation from the UI, edit it, pause/resume it, and run it manually from the detail page.
- Confirm the list page shows last result, next run, and recent activity accurately after multiple runs.
- Open an automation-created session and verify the badge, parent link, and run metadata are visible alongside the normal diff/PR/chat surfaces.

Exit criteria:
- A user can fully manage a cron automation from the app UI.
- Automation-created runs are visible both in Automations and Sessions without duplicated concepts.

## Milestone 5: Hardened External Actions And Needs-Attention UX

Goal: ship the first safe external side effect and make permission failures actionable.

Scope:
- Add automation-scoped tool policy/config in `apps/web/lib/automations/tool-policy.ts` and runtime integration in `packages/agent/open-harness-agent.ts`.
- Introduce a first server-owned automation action tool for GitHub PR creation, backed by shared logic extracted from `apps/web/lib/chat/auto-pr-direct.ts`, `apps/web/app/api/generate-pr/route.ts`, and `apps/web/app/api/pr/route.ts`.
- Default automation-created PRs to draft in v1 when the tool is enabled.
- Record actionable result details on `automation_runs` (`prUrl`, `compareUrl`, permission failure reason, attempted action summary).
- Improve UI/status messaging so `needs_attention` clearly tells the user whether the run was blocked by a disallowed tool, GitHub permission issue, or publish fallback.

Why this milestone exists:
- The feature is not complete until it can perform at least one safe external action without relying on raw shell improvisation.
- GitHub publish failures are already nuanced in this codebase; the automation UX needs to preserve that fidelity.

Automated tests:
- Add tool-policy tests proving only explicitly enabled automation tools are exposed in unattended runs.
- Add PR action tests covering draft PR creation, fork/compare fallback, missing OAuth token, and permission-denied behavior.
- Add runner tests ensuring failed external actions land in `needs_attention` with actionable run metadata rather than generic failure.

Manual tests:
- Run an automation that edits a repo and opens a draft PR; verify the PR is created through the shared server path and linked back into the run/session.
- Disconnect or restrict GitHub auth and rerun; verify the run lands in `Needs attention` with a clear message and compare URL or remediation path.
- Open the blocked session manually, continue the work, and confirm the user can recover from the same session artifact rather than starting over.

Exit criteria:
- Enabled automation tools are explicit, server-owned, and non-interactive.
- PR publication uses a single hardened backend path with clear outcomes.
- Users can understand and recover from blocked automation runs without losing context.

Verification:
- Automated verification should be run milestone-by-milestone with targeted tests first, then the repo-wide checks once a vertical slice is complete.
- Final pre-merge verification should include `bun run check`, `./node_modules/.bin/turbo typecheck`, and the relevant Bun test suites for touched files.
- Manual verification should confirm the full lifecycle for each milestone: create/edit, trigger/run, in-progress behavior, completion, failure, retry/resume, and session/PR visibility.
