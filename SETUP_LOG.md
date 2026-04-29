# JOOPITER agents-platform — setup log

Running log of how this fork was set up. Resumable: if you stop mid-setup, the next session can pick up from the last completed step here.

Upstream: https://github.com/vercel-labs/open-agents
Fork:     https://github.com/joopiter-eng/joopiter-agents
Local:    ~/code/joopiter/agents-platform

---

## Phase 1 — Reconnaissance ✅ (2026-04-28)

Read upstream README, AGENTS.md, .env.example, drizzle config, auth config, sandbox impl, models, deploy skill.

Key findings:
- Bun-only monorepo (`bun@1.2.14` pinned). pnpm/npm are not used.
- Sandbox is hard-coupled to `@vercel/sandbox` SDK — Vercel deploy is required.
- Auth has migrated to **better-auth**. Env var is `BETTER_AUTH_SECRET`, NOT the README's stale `JWE_SECRET`. Trust the code, not the docs.
- LLMs route through **Vercel AI Gateway** by default. On Vercel, OIDC handles auth automatically. Locally, set `AI_GATEWAY_API_KEY`. A direct Anthropic API key is not the default path.
- Default model in `apps/web/lib/models.ts` is `anthropic/claude-haiku-4.5`. We'll switch to Sonnet 4.6 *after* the base setup is validated.
- `ENCRYPTION_KEY` appears unused at runtime but is in `turbo.json` build env. Set it for forward-compat.
- Postgres uses the standard `postgres-js` driver — any Postgres URL works at the connection level. Upstream relies on **Neon database branching** for preview-deploy DB isolation; switching to Supabase would lose that. **Decision: stay on Neon for this project.**
- Required env-var groups: minimum (Postgres + auth secret), Vercel OAuth (sign-in), GitHub App (repo flows). Optional: Redis/KV, ElevenLabs.

## Phase 2 — Repo setup ✅ (2026-04-28)

- Forked `vercel-labs/open-agents` → `joopiter-eng/joopiter-agents` via `gh repo fork --org joopiter-eng --fork-name joopiter-agents`.
- Cloned to `~/code/joopiter/agents-platform` via `gh repo clone joopiter-eng/joopiter-agents` (HTTPS — no SSH key on this machine).
- Remotes: `origin` → fork, `upstream` → vercel-labs/open-agents.
- `bun install --frozen-lockfile` succeeded (1904 packages, no engine warnings; local bun is 1.3.13, repo pins 1.2.14 — works fine).
- Created `apps/web/.env.local` (gitignored) with placeholder structure. No real secrets yet. Includes `AI_GATEWAY_API_KEY` and `ENCRYPTION_KEY` slots beyond what `.env.example` ships.
- Created `SETUP_LOG.md` (this file).
- Working branch: `setup` (off `main`).

## Phase 3 — Infrastructure provisioning (TODO)

Will create, with confirmation before each:
- [ ] Neon Postgres database (via Vercel integration, once Vercel project exists)
- [ ] Vercel project for the app (links to Neon + AI Gateway via OIDC)
- [ ] Vercel OAuth app (sign-in) — needs prod URL, so this comes *after* first deploy
- [ ] GitHub App — same chicken-and-egg; create with localhost URLs first, update after Vercel deploy
- [ ] (Optional) Upstash Redis or Vercel KV
- [ ] AI Gateway API key for local dev

## Phase 4 — Local validation (TODO)

- [ ] `bun run web` boots
- [ ] Auth (Vercel sign-in) works locally
- [ ] DB migrations applied
- [ ] One agent session starts locally end-to-end

## Phase 5 — Vercel deployment (TODO)

- [ ] `vercel link` from local
- [ ] Push env vars to Vercel project (Production scope first)
- [ ] First deploy to get production URL
- [ ] Update GitHub App callback URLs with production URL, redeploy
- [ ] Confirm prod migrations ran, auth works on prod

## Phase 6 — End-to-end agent run (TODO)

- [ ] One real agent run via deployed UI on a test repo
- [ ] Verify sandbox provisions, agent executes, output streams, branch+commit lands
- [ ] Document any rough edges below

---

## Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| Postgres backend | **Neon** | Matches upstream's Neon branching for preview-deploy DB isolation. |
| GitHub repo | `joopiter-eng/joopiter-agents` | Real org slug is `joopiter-eng` (not `joopiter`); user is admin. |
| Local clone path | `~/code/joopiter/agents-platform` | Avoids clash with existing `~/code/joopiter/joopiter-agents/` Conductor workspace. |
| Default model | Claude Sonnet 4.6 (planned, post-validation) | User preference. Will change `apps/web/lib/models.ts` after base platform works. |

## Divergences from upstream

| File | Change | Why |
|---|---|---|
| `SETUP_LOG.md` (added) | New file | Track setup progress for resumability. |
| `apps/web/.env.local` (added, gitignored) | Placeholder env | Adds `AI_GATEWAY_API_KEY` + `ENCRYPTION_KEY` slots beyond `.env.example` for clarity. |

`.env.example` is intentionally **not** modified to keep upstream merges clean.

## Known rough edges / questions for later

- Local bun is 1.3.13 vs repo's pinned 1.2.14. No issue at install time but could surface in scripts. If anything breaks, use `bunx --bun=1.2.14 ...` or install matching version.
- `gh` token is on `avantgrogg`'s personal account with admin role on `joopiter-eng`. If the org enforces SSO push protection, we may need `gh auth refresh -s admin:org` later.
- Anthropic API key (offered by user) is not used by default — Vercel AI Gateway is the default path. Hold the key unless we explicitly want to bypass the gateway.
