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
| Step 3: worktree manager (one locked worktree and branch per task, outside the repo; no links in Orchestra's folders; safe removal) | `src/worktree/`, `src/git/context.ts`, `src/run/names.ts`, `src/config/home.ts` |
| Step 4: tamper checks (worktree folder, links, HEAD, task branch, lock, own config, nested git; the user's refs, checkouts, hidden index entries, worktrees, repo and submodule config/hooks/info, every git config or attributes file git reads) | `src/integrity/` |
| Step 5: scope check and the conductor's commit (re-hashed trees, private index, path rules, compare-and-swap, post-commit re-check) | `src/scope/`, `src/git/objects.ts` |
| Git calls: git found by full path in PATH (never the current folder), no replacement objects or commit-graph, hooks folder always named | `src/git/run.ts`, `src/git/context.ts` |
| Tests: 451 passing on macOS; CI runs Windows + Linux (Node 22 and 24) | `test/`, `.github/workflows/ci.yml` |

**CI:** the last five runs on `main` passed (Windows and Linux). Steps 3–5 are on branch `feat/worktrees-integrity-scope`
and have not run on CI yet; Windows is only covered once that branch is pushed.

**Review:** an independent review of steps 3–5 found 9 problems (a `git.exe` planted in a worktree, task branches turned
into links to the user's branch, rewritten git objects, unwatched included config, links in Orchestra's folders, a
relative hooks path, per-worktree config copied by git, a split git-folder layout, hidden index entries). All are fixed
and each has a test. Reftable repositories also work now (HEADs are read through git).

### How steps 3–5 fit together (for the run manager later)

1. `createTaskWorktree(ctx, { runId, taskId, startSha })`: `startSha` comes from `startCommitFor(task, baseSha, integrationTip)`.
2. `takeBaseline(ctx)` before the worker starts.
3. Worker runs (step 10).
4. `checkIntegrity(ctx, wt, baseline, expectedTip)`: any violation stops the task.
5. `checkScope(ctx, wt, task, { fromCommit: expectedTip })`, then `commitTask(...)` with `taskCommitMessage(runId, task)`.
6. After acceptance commands (step 6): `checkIntegrity` with the previous report's `baseline` and the new tip, then
   `checkScope` from the task commit; any change there means a command touched tracked files.
7. `removeTaskWorktree(ctx, wt, { deleteBranchAt })` when the run is finished or discarded.

`ctx` comes from `repoContext(readyPlan)`. All git goes through `src/git/run.ts` via `repoGit`/`worktreeGit`, which name
the git folder explicitly and turn hooks off unless the user allows them.

## Next: step 6, the acceptance runner and review state

Run each task's acceptance commands in its worktree and record the results for review. The conductor runs them itself
and never trusts a worker's "it passed".

- **What:**
  - Run every `acceptance.commands` entry (an argument array from the approved plan) in the task's worktree:
    no shell, a timeout, output captured with a size cap.
  - Record exit code, time and output per command; a task's result is pass/fail per command, not a model's summary.
  - Keep a review state per task (pending, accepted, rejected, needs revision) with a bounded number of revision rounds.
  - Before the commands: integrity and scope checks pass and the task is committed. After: run both again (see step 6 in
    "How steps 3–5 fit together").
- **Watch out:**
  - On Windows, `npm`, `npx` and similar are `.cmd` files. Node refuses to spawn `.cmd`/`.bat` without a shell
    (the CVE-2024-27980 fix), and a shell would let arguments inject commands. Needs a safe design, for example
    resolving the real script and running it with `node`, or carefully quoted `cmd.exe /d /s /c`.
  - Decide which environment variables the commands get (secrets such as API keys should not reach test commands).
- **Tests:** throwaway repos, with commands written as `node -e ...` (`process.execPath`) so they work on every OS.

After that, one line each (details in PLAN.md):

7. **Merging:** merge accepted tasks one at a time into the integration branch with `merge-tree`, `commit-tree` and compare-and-swap `update-ref`.
8. **Finalize checks:** before merging into the user's branch, make sure nothing of theirs would be overwritten.
9. **Run store:** save plan, prompts, logs, diffs, timings and tokens per run (run ids already exist: `src/run/names.ts`).
10. **Engines:** detect which of Claude, Codex and Antigravity are ready, and drive each one locked down (fake engines in tests).
11. **Rules and briefs:** find each project's rule files and write each worker's brief from a fixed template.
12. **Background service:** one local service, so a run started from Claude is visible from Codex.
13. **Approval:** the start/finalize confirmation (see open decisions).
14. **Front doors:** the `/orchestrate-all` skill plus the MCP connection for Claude Code and Codex, and an installer.
15. **Real-world test:** on the owner's machine, then a full demo.

## Not covered yet by steps 3–5

- **Checks beyond the repository.** Research §7.5 also asks to compare the user's main checkout files and the agents'
  own config folders (`~/.claude`, `~/.codex`, `~/.gemini`) before and after each worker. Only git's own config and
  attributes files are watched so far. The agent folders belong with the engine adapters (step 10), which know which
  files matter.
- **The object store.** A worker that can write to the repository's `.git/objects` can damage it. The scope check
  re-hashes every tree it relies on, so this can't hide an out-of-scope change, but file contents (blobs) are not
  re-hashed. For step 10: sandbox workers so they can write only their own worktree folder. The conductor commits for
  them, so they don't need to write to `.git` at all, and most tamper checks then become a second line of defence.
- **The user's index:** only entries hidden from `git status` (skip-worktree, assume-unchanged) are watched. Ordinary
  staging is not reported, so the user can keep working during a run.
- **Sparse checkouts** are refused with a clear message (the scope check needs every file in the worktree).
  **Submodules** are not initialized in task worktrees.
- **Concurrency:** the run manager should not take integrity baselines while it is creating or removing a worktree
  (noted in `src/integrity/check.ts`). Checks run after a worker stops; a worker still running in parallel (another
  task) could change things between a check and the commit. The empty hooks folder in Orchestra's home is checked
  before every git call; only a process outside any sandbox can write there, and such a process already has the user's
  full rights.
- **Integrity before scope:** `checkScope` trusts the repository's config (filters run during its `git add`), so it must
  only run after `checkIntegrity` passed.

## Open decisions

Ask the owner only when the work needs the answer, one question at a time.

- **Git hooks** on Orchestra's internal steps (worktree creation, branch moves, internal commits on `orchestra/*`): off
  by default for now (`DEFAULT_HOOK_POLICY` in `src/config/defaults.ts`). Confirm with the owner.
- **Approval pop-up:** the owner said the user allows whatever they want. Confirm whether they still want a start/finalize confirmation before building step 13.
- **Even split:** hard (current: each engine gets ⌊N/K⌋ or ⌈N/K⌉) or soft.
- **Replanning:** may the orchestrator change the plan alone when a worker is blocked?
- **Claude CLI:** the owner's CLI is 2.1.97. Upgrading to ≥ 2.1.325 fixes several bugs that matter ([research §5.1](research.md#51-claude-code-worker)).
- **macOS:** this clone is on the owner's Mac, while the docs and CI target Windows first. Should CI also run on macOS
  (macOS runner minutes cost more on private repositories)?

## What changed vs the original onboarding prompt

- **No project allowlist.** It was removed at the owner's request.
- **Google:** the Antigravity CLI with an API key, not the Gemini CLI. The engine id is `antigravity`.
- **Local folder:** `Desktop/orchestrate_all` (on Windows `Desktop\orchestrate_all`; the 2026-11-20 session used the
  owner's Mac). The repo is `barbarosisik/orchestrate-all`.

## Working with the owner

- **Answers:** short and plain. One decision at a time, no walls of text.
- **Commits** go under the owner's own git identity (the clone's local `user.name`/`user.email` match the earlier
  commits). Never add `Co-Authored-By`, "Generated with" or any AI attribution to commits or pull requests.
- **Logos:** no real vendor logos (trademarks). The robots in the header are original characters.
