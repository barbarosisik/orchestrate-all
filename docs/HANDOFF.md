# Handoff

**Last updated:** 2026-11-20. Read this first, then [PLAN.md](PLAN.md). If you have the original onboarding prompt,
treat it as background only: where it disagrees with this file or PLAN.md, these files win (see "What changed" below).

## What Orchestra is (as decided with the owner)

- **The core.** One provider's agent (Claude Code or Codex) hands tasks to other providers' agents (Claude Code, Codex,
  Antigravity) and gets the results back.
- **The owner decides what agents may do.** Orchestra adds no allowlists or permission layers of its own.
- **Orchestra's one rule of its own:** agents never overwrite each other's files. That is the only reason it uses git:
  - each task works in its own git worktree;
  - finished work is merged back one task at a time;
  - file ownership is checked in code.
- **Works with whichever engines are ready** (one or more). Tasks are split evenly across them.
- **Google lane:** the Antigravity CLI (`agy`) with the owner's Gemini API key.
  - The Gemini CLI no longer serves Google AI Pro/Ultra.
  - Google's consumer terms don't allow wrapping `agy` on a subscription login.
  - Neon is `gemini-4-neon`.
- **No coding rules of its own.** Each project's own `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` carry the rules.

## Done

| What | Where |
|---|---|
| README with an animated header | `README.md`, `docs/assets/hero.svg` |
| Research on engines, rules files, orchestration and security | `docs/research.md`, `docs/research/` |
| Plan and build order | `docs/PLAN.md` |
| Step 1: plan schema and validator (ownership, reserved files, dependencies, even split, plan hash) | `src/plan/` |
| Step 2: repository checks (real git repo, branch, base commit, unsaved work under owned paths) | `src/repo/`, `src/git/run.ts` |
| Tests: 236 passing on Linux; CI set up for Windows + Linux | `test/`, `.github/workflows/ci.yml` |

**Not yet confirmed:** the result of the GitHub Actions runs (check them with `gh run list`).

## Next: step 3, the worktree manager

Give each task its own isolated copy of the project, so agents can't touch each other's files.

- **Where:** outside the user's project, under Orchestra's data folder `ORCHESTRA_HOME`.
  - It defaults to `%USERPROFILE%\.orchestra`; tests must point it at a temp folder.
  - Keep paths short for Windows (for example `<home>\wt\<runId>\<taskId>`).
- **What:**
  - Create branch `orchestra/<runId>/<taskId>` from the base commit, or from the integration tip for tasks with dependencies.
  - Lock each worktree while its worker runs.
  - Remove only worktrees and branches Orchestra created.
- **How git runs:**
  - Every call goes through `src/git/run.ts`.
  - Worktree commands use an explicit `--git-dir=<commonDir>/worktrees/<name>` and `--work-tree=<path>`, so a worker that rewrites its `.git` file can't redirect them.
  - Also pass `--no-ext-diff`.
  - `git worktree add` runs the repo's `post-checkout` hook; whether hooks run is an open decision (below).
- **Tests:** real throwaway repos (`test/helpers/tmprepo.ts`), including non-ASCII paths and a worker tampering with `.git`.

After that, one line each (details in PLAN.md):

4. **Tamper checks:** before and after each worker, confirm the `.git` pointer, branches and the user's `HEAD` are unchanged.
5. **Scope check:** list every changed file and reject anything outside the task's owned paths.
6. **Acceptance:** run each task's test commands in its worktree and record pass/fail for review.
7. **Merging:** merge accepted tasks one at a time into the integration branch with `merge-tree`, `commit-tree` and compare-and-swap `update-ref`.
8. **Finalize checks:** before merging into the user's branch, make sure nothing of theirs would be overwritten.
9. **Run store:** save plan, prompts, logs, diffs, timings and tokens per run.
10. **Engines:** detect which of Claude, Codex and Antigravity are ready, and drive each one locked down (fake engines in tests).
11. **Rules and briefs:** find each project's rule files and write each worker's brief from a fixed template.
12. **Background service:** one local service, so a run started from Claude is visible from Codex.
13. **Approval:** the start/finalize confirmation (see open decisions).
14. **Front doors:** the `/orchestrate-all` skill plus the MCP connection for Claude Code and Codex, and an installer.
15. **Real-world test:** on the owner's PC, then a full demo.

## Open decisions

Ask the owner only when the work needs the answer, one question at a time.

- Should the project's git hooks run on Orchestra's internal commits on `orchestra/*` branches?
- **Approval pop-up:** the owner said the user allows whatever they want. Confirm whether they still want a start/finalize confirmation before building step 13.
- **Even split:** hard (current: each engine gets ⌊N/K⌋ or ⌈N/K⌉) or soft.
- **Replanning:** may the orchestrator change the plan alone when a worker is blocked?
- **Claude CLI:** the owner's CLI is 2.1.97. Upgrading to ≥ 2.1.325 fixes several bugs that matter ([research §5.1](research.md#51-claude-code-worker)).

## What changed vs the original onboarding prompt

- **No project allowlist.** It was removed at the owner's request.
- **Google:** the Antigravity CLI with an API key, not the Gemini CLI. The engine id is `antigravity`.
- **Local folder:** `Desktop\orchestrate_all`. The repo is `barbarosisik/orchestrate-all`.

## Working with the owner

- **Answers:** short and plain. One decision at a time, no walls of text.
- **Commits** go under the owner's own git identity. Never add `Co-Authored-By`, "Generated with" or any AI attribution to commits or pull requests.
- **Logos:** no real vendor logos (trademarks). The robots in the header are original characters.
