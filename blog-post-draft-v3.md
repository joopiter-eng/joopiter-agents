# [Template Name]

**Published:** [Date] | **Authors:** [Authors] | **Category:** Templates

*An open-source template for building background agents on Vercel.*

---

Most AI-assisted workflows today are synchronous. You prompt, you wait, you review, you prompt again. The model works while you watch. If you close your laptop, the work stops.

Background agents work differently. You assign a task, the agent spins up an isolated cloud environment, and it works independently until the task is done. You can assign multiple tasks in parallel. You can close your laptop. The agent commits its work, opens a pull request, and you review the output the same way you'd review a colleague's.

This is a genuinely hard infrastructure problem. The agent needs an isolated compute environment that persists across interruptions. The workflow needs to survive restarts, scale beyond any single request timeout, and recover from failures. The agent needs access to models from multiple providers with automatic failover so your platform isn't tied to any single provider's uptime. And the agent logic itself needs to be portable across frameworks and runtimes.

Ramp [built this from scratch](https://builders.ramp.com/post/why-we-built-our-background-agent) for their engineering team. So have several other companies we work with. Each invested months solving the same set of infrastructure problems.

Today we're open-sourcing a template that solves them using Vercel's infrastructure primitives. It ships as a coding agent because that's the most immediate use case, but the patterns it demonstrates (long-running compute, durable workflows, multi-model orchestration, isolated execution) apply to any background agent: data analysis, code review, testing, compliance, or whatever your team needs agents to do independently.

## The infrastructure layer

Building a reliable background agent requires four things, and each maps to a Vercel primitive.

### Sandboxes: the agent's computer

Each agent session runs in its own [Vercel Sandbox](https://vercel.com/docs/sandboxes) with a full runtime environment: Node.js, Bun, git, and package managers. The sandbox provides filesystem operations, process execution with timeout controls, and network endpoint mapping so agents can start servers and interact with them.

The sandbox is the agent's computer. It can do anything a developer can do in a terminal: install dependencies, run builds, execute tests, start dev servers, and inspect the results. And because each session gets its own sandbox, agents run in complete isolation from each other.

The sandbox abstraction is provider-based. The current implementation runs on Vercel's infrastructure, but the interface is defined separately from the implementation. If you want to run sandboxes on your own infrastructure, you implement the same contract: file I/O, shell execution, snapshotting, and lifecycle management.

Lifecycle management handles the operational complexity that makes long-running agents hard. Sandboxes move through defined states (provisioning, active, hibernating, hibernated, restoring, archived, failed). Inactivity timeouts trigger hibernation automatically, and the system takes a snapshot before hibernating so the sandbox can be restored exactly where it left off. Snapshot operations are idempotent so concurrent lifecycle events don't cause conflicts.

### Workflow: durability and infinite compute

The agent loop runs as a durable workflow using Vercel's [Workflow DevKit](https://useworkflow.dev). Each agent step (model call, tool execution, result processing) is a discrete workflow step that can be retried independently on failure.

This is what makes background agents actually reliable. A normal HTTP request has a timeout. A workflow doesn't. The agent can run for minutes or hours, surviving infrastructure restarts, recovering from transient failures, and picking up exactly where it left off. You get effectively infinite compute for agent tasks without building your own job queue, retry logic, or state persistence.

The workflow also handles the complexity around streaming: the agent streams results to the UI in real time while the durable workflow ensures that if the connection drops, no work is lost. When you reconnect, the stream picks up from where it left off.

### AI Gateway: model access and resilience

The template routes all model calls through [AI Gateway](https://ai-sdk.dev/docs/ai-sdk-core/ai-gateway), which provides access to hundreds of models from every major provider through a single endpoint. Swap between OpenAI, Anthropic, Google, and others by changing a model ID string.

More importantly for production agents, AI Gateway provides automatic failover. If a provider is down or rate-limited, requests can fall over to an alternative. Your agent platform isn't coupled to any single provider's availability. This matters when you're running agents in the background where there's no human watching to retry a failed request.

The template configures provider-specific defaults automatically (Anthropic thinking parameters, OpenAI reasoning settings, response storage policies) so each model runs with optimal settings out of the box.

### AI SDK: portable agent logic

The agent runtime is built on the [AI SDK](https://ai-sdk.dev), which provides the tool-calling loop, streaming, structured output, and framework integrations. The AI SDK runs on Node.js, Bun, Deno, and serverless runtimes, so the agent logic isn't locked to any specific deployment target.

The template uses the AI SDK's agent abstraction with a structured tool layer: file read/write, shell execution, code search, web fetch, and task management. The system prompt encodes engineering best practices as hard constraints: always read before editing, run the project's own scripts instead of generic commands, detect the package manager from lockfiles, re-run verification after every change until checks pass.

## What the template adds

The primitives provide the infrastructure. The template shows how to compose them into a complete system, and adds the application-level patterns that make background agents useful.

### Multi-agent delegation

A single agent trying to handle every aspect of a complex task tends to lose focus. The template uses a delegation model where the primary agent can spawn specialized subagents: an **explorer** for read-only analysis, an **executor** for scoped implementation work, and a **designer** for frontend interfaces. Each subagent runs autonomously for up to 100 tool steps, then returns a summary to the primary agent.

This is a pattern that generalizes well beyond coding. Any background agent dealing with multi-faceted tasks benefits from decomposing work across specialists rather than holding everything in a single context.

### Git automation

The agent can commit and push its work automatically. The auto-commit flow detects dirty files, generates a conventional commit message using a lightweight model (constrained to one line, 72 characters max, with the diff truncated to 8,000 characters as input), sets the git author from the linked GitHub account, and pushes to the branch.

Auto-PR creation has guardrails: it rejects detached HEAD states, validates branch names against a safety pattern, checks that the local branch is fully pushed before creating the PR, reuses existing PRs for the same branch, and handles creation race conditions gracefully. PR titles and descriptions are generated from the diff.

### Context management

Background agents run longer than interactive sessions, which means they hit context window limits. The template includes a context management layer with cache control policies and aggressive compaction, trimming and summarizing earlier parts of the conversation to keep the working context within the model's token budget.

This is one of the harder problems in building reliable background agents. An agent that forgets the original task requirements halfway through produces bad work. The context management layer is designed to prevent that.

### Skills

The agent supports a skills system for adding capabilities without modifying the core runtime. Skills are discoverable modules with metadata that declare whether they can be invoked by the model, the user, or both.

This is the extension point. Add domain-specific behavior (internal API integrations, custom workflows, compliance checks) as skills rather than modifying the agent runtime.

## Getting started

Clone the repo, run `bun install`, link your Vercel project, and start the dev server. The setup script pulls environment variables and configures OAuth for Vercel and GitHub. Once running, you can create a session, point it at a repo, give it a task, and review the output as commits and pull requests.

The template is designed to be forked. Swap model providers through AI Gateway. Add tools for your internal systems. Change the system prompt to match your workflows. Replace the sandbox provider. Use it as a coding agent out of the box, or as the foundation for whatever background agent your team needs to build.

The entire codebase is MIT-licensed.

[Deploy on Vercel →](#) | [View on GitHub →](#)
