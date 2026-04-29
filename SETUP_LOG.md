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

## Phase 3 — Infrastructure provisioning ✅ (2026-04-29)

- [x] Vercel project: `joopiter/joopiter-agents` linked via `vercel link --scope=joopiter`. `projectId=prj_oZqMRb7Ei...`. `.vercel/` is gitignored. **Note:** Vercel didn't auto-detect the monorepo; root-directory / build-command settings need adjusting before first deploy.
- [x] Neon Postgres via Vercel Marketplace integration. 16 env vars injected (`POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, etc.) into Production+Preview+Development. Auto-branched preview DBs enabled. `POSTGRES_URL` pulled into local `.env.local` for dev.
- [x] `BETTER_AUTH_SECRET` + `ENCRYPTION_KEY` generated locally (in `.env.local`) and a *different* set generated for Vercel (all 3 envs). All six entries verified present via `vercel env ls`.
- [x] Vercel AI Gateway API key created and saved to `.env.local` (length 60, `vck_` prefix). Used for local dev only — Vercel deploys auth via OIDC.
- [x] Vercel OAuth app: created in Joopiter team Settings → Apps. Localhost callback configured. Client ID + Secret in `.env.local` and pushed to all 3 Vercel envs.
- [x] GitHub App: created at `joopiter-eng` org. **Webhook is currently inactive** (GitHub rejects localhost URLs); will re-enable with prod URL after first deploy. All 6 env vars (App ID, Client ID, Client Secret, Slug, Webhook Secret, base64-encoded Private Key) in `.env.local` and pushed to all 3 Vercel envs. Local `.pem` file at `~/Downloads/joopiter-agents.2026-04-28.private-key.pem` — can be deleted now that the value is stored in env vars.
- [ ] (Optional) Upstash Redis or Vercel KV — skipping for first pass

## Phase 4 — Local validation (in progress)

- [x] `bun run --cwd apps/web db:check` clean (migrations match schema).
- [x] Migrations applied to Neon dev branch (`bun run db:migrate:apply`). 15 public-schema tables created.
- [x] `bun run web` boots — Next 16.2.1 + Turbopack, ready in ~340ms. Workspace-root warning about multiple lockfiles is cosmetic.
- [x] **Bug found and patched in upstream auth config.** `apps/web/lib/auth/config.ts` declared `additionalFields.username = { required: true }` and `users.username NOT NULL` but provided no `mapProfileToUser` or default — fresh OAuth signup failed with `unable_to_create_user` because the insert tried to set username to `DEFAULT`. Patched by adding a `deriveUsername(profile, preferredKeys)` helper and `mapProfileToUser` for both Vercel (`preferred_username` / `username` / `name`) and GitHub (`login` / `name`), with email-localpart fallback and `user_<nanoid>` last-resort. Worth contributing back upstream.
- [x] Vercel OAuth sign-in verified end-to-end. 1 user / 1 account / 1 session in DB. Callback returned 302; `/sessions` page loaded.
- [ ] GitHub App install on a test repo
- [ ] Local agent run (chat session, sandbox boot, simple prompt)

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
