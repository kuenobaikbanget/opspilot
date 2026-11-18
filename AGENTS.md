# Coding-agent Instructions for OpsPilot

This is a Bun workspace monorepo, not a microservices system. Respect module boundaries in `docs/ARCHITECTURE.md`.

1. **Never add a generic remote shell execution tool** to agent or AI orchestration. All diagnostic actions must be enumerated, locally validated, read-only, audited, bounded in time and output.
2. Hub API and Web are separate runnable apps. Keep secrets server-side. Do not expose API keys, agent enrollment secrets or database URLs through Next client components.
3. Changes to agent protocol require updates to `packages/contracts`, Go agent, `docs/API.md` and interoperability tests.
4. Use Bun package manager/runtime for TS; Go for agent; PostgreSQL as single DB until evidence justifies other infrastructure.
5. Update security docs for changes touching auth, log handling, LLM prompts, diagnostics, network exposure or data retention.
6. Add negative tests for every new tool and auth path. Avoid claiming an integration has been tested without actually running it.
7. Maintain UX distinction between measured signals, AI hypotheses, and human-confirmed resolutions.
8. Follow `docs/DEVELOPMENT.md`, `docs/ROADMAP.md`, and code style already in this repository.

## Orca worktree workflow

- Use the `main` workspace for coordination, review, and integration only. Dispatch each implementation task to its own Orca child worktree via `orchestration worker-start --worktree new-child`; do not implement it in `main` if dispatch is unavailable.
- Give each worker a scoped brief and acceptance checks. Run independent tasks in parallel. For dependent tasks, dispatch only once the required changes are available in a base branch or ref.
- Workers implement and verify in their assigned worktree without spawning another child for the same task. Report the branch or commit, verification results, and any blockers through Orca.
- Review the diff and verification evidence from `main`. Integrate through the pull request workflow only when the user asks; do not merge or push directly to `main` automatically.
