# Handoff

**Last updated:** 2026-11-21. Read this first, then [PLAN.md](PLAN.md). If you have the original onboarding prompt,
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
| Step 6: acceptance runner (no shell, PATH-only programs, safe Windows `.cmd` handling, allowlisted environment, time limits that stop the whole process tree, capped output), the gate (commands, then integrity and scope again) and the review state (threshold and revision rounds in code) | `src/accept/`, `src/review/`, `src/os/` |
| Step 7: merging (accepted tasks one at a time into `orchestra/<runId>/integration`: re-hashed inputs, scope re-checked, overlap refused, `merge-tree` without rename detection, exactly tip plus the task's changes, compare-and-swap, re-check) | `src/merge/` |
| Step 8: finalize checks (the integration branch's history against the recorded merges; a preview of the merge into the user's branch at its current tip; nothing of the user's overwritten; every merged task's acceptance commands re-run on exactly what the branch would hold, in a check worktree; a report) | `src/finalize/`, check worktrees in `src/worktree/manager.ts` |
| Tests: 584 passing on macOS (2 more run only on Windows); CI runs Windows + Linux (Node 22 and 24) | `test/`, `.github/workflows/ci.yml` |

**CI** runs on pull requests and on pushes to `main`. Steps 3–5 went into `dev` through PR #1, step 6 through PR #2 and
step 7 through PR #3, all green on Windows and Linux (the first runs found test-only problems: git's `C:/` paths,
hidden `.git` files, Linux running a script without `#!` through `sh`, a Windows folder held by a test's process).
Step 8 is on `feat/finalize-checks`, with its PR into `dev`.

**Review:** an independent review of steps 3–5 found 9 problems (a `git.exe` planted in a worktree, task branches turned
into links to the user's branch, rewritten git objects, unwatched included config, links in Orchestra's folders, a
relative hooks path, per-worktree config copied by git, a split git-folder layout, hidden index entries). All are fixed
and each has a test. Reftable repositories also work now (HEADs are read through git).

### How steps 3–8 fit together (for the run manager later)

1. `createTaskWorktree(ctx, { runId, taskId, startSha })`: `startSha` comes from `startCommitFor(task, baseSha, integrationTip)`.
2. `takeBaseline(ctx)` before the worker starts.
3. Worker runs (step 10).
4. `checkIntegrity(ctx, wt, baseline, expectedTip)`: any violation stops the task.
5. `checkScope(ctx, wt, task, { fromCommit: expectedTip })`, then `commitTask(...)` with `taskCommitMessage(runId, task)`.
6. `runAcceptanceGate(ctx, wt, task, { baseline: <the passing report's baseline>, commit })`: runs the acceptance
   commands, then the integrity check and (only if that passed) the scope check from the task commit. A command that
   changed a tracked file fails the gate; files it added are listed and never committed.
7. Review: `newTaskReview(task, { maxRevisionRounds })`, `recordGate(state, gate)`, then `recordReview(state, json)` with
   the orchestrator's review. On "needs-revision": `startRevision(state)`, give the worker `revisionRequest(state)` and
   go back to step 2 (new baseline; the expected tip is now the task commit).
8. Merging: `startIntegration(ctx, runId, baseSha)` once per run; then, for each id from
   `readyToMerge(tasks, accepted, merged)`, `mergeTask(ctx, { runId, task, start: wt.startSha, commit, expectedTip })`.
   A refused merge (overlap, conflict) changes nothing; the task goes back to review (revise or replan).
   Optionally after each merge, to find the merge that broke things: `checkCombined(ctx, { runId, name:
   'integration', tip, tasks })` runs the merged tasks' acceptance commands on the integration tip, in a new check
   worktree that is removed afterwards.
9. Before asking the user: `finalizeChecks(ctx, { runId, targetBranch, baseSha, integrationTip, merged })`, where
   `merged` lists every accepted task in merge order with its commit and its merge commit (null when it changed
   nothing). It returns a `FinalizeReport`; `formatFinalizeReport(report)` is the text the user reads. `ready` is true
   only with no problems. The real finalize (step 13) must find the branch still at `report.target.tip`
   (compare-and-swap) and produce exactly `report.target.tree`, merging with the same settings (`NO_RENAMES`,
   `--merge-base=<baseSha>`, `mergeTrees` in `src/merge/integration.ts`).
10. `removeTaskWorktree(ctx, wt, { deleteBranchAt })` when the run is finished or discarded; `removeIntegration` to
   discard the run's integration branch.

`ctx` comes from `repoContext(readyPlan)`. All git goes through `src/git/run.ts` via `repoGit`/`worktreeGit`, which name
the git folder explicitly and turn hooks off unless the user allows them.

## Next: step 9, run store

Everything a run produces, saved where the user (and a restarted conductor) can find it. R4 asks for engine, model,
status, time, tokens, logs and the exact files changed per task.

- **What:**
  - A run folder `<home>/runs/<runId>/` (outside the repository, like the worktrees): the approved plan and its hash,
    the run's state (each task's status, start commit, task commit, review state, merge commit; the integration tip;
    the last finalize report), and an append-only log of the conductor's decisions (integrity and scope results,
    gates, reviews, merges, finalize checks).
  - Per task: the worker's raw output stream (step 10 fills it), acceptance output, the diff of its commit, timings,
    and tokens where the engine reports them.
  - Enough to rebuild `FinalizeInput` and the review states after a crash (step 12 recovers from it).
- **Watch out:** writes are atomic (temporary file, then rename) and the folder holds no links (as `<home>/wt`); file
  names come from validated ids only; output is capped in size; no secrets (commands already get an allowlisted
  environment); short paths for Windows.
- **Tests:** round trips, an interrupted write leaves the previous state, links and odd names refused, log size caps.

After that, one line each (details in PLAN.md):

10. **Engines:** detect which of Claude, Codex and Antigravity are ready, and drive each one locked down (fake engines in tests).
11. **Rules and briefs:** find each project's rule files and write each worker's brief from a fixed template.
12. **Background service:** one local service, so a run started from Claude is visible from Codex.
13. **Approval:** the start/finalize confirmation (see open decisions).
14. **Front doors:** the `/orchestrate-all` skill plus the MCP connection for Claude Code and Codex, and an installer.
15. **Real-world test:** on the owner's machine, then a full demo.

## Not covered yet by steps 3–8

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
- **Acceptance commands run the worker's code** (its tests) with the user's rights. On timeout their whole process tree
  is stopped; on Linux and macOS, processes they leave running are stopped too, but on Windows those need a Job
  Object. Both belong with the sandbox in step 10.
- **Fresh worktrees have no installed dependencies.** Task and check worktrees hold the committed files only, so
  acceptance commands must set up what they need (for example `npm ci` before `npm test`) until opt-in copying of
  ignored files exists (research §7.4; it belongs with the engines and briefs, steps 10–11).
- **Finalizing itself** (step 13): the real merge must use the tree the finalize checks tested, move the branch with
  compare-and-swap from the tip in the report, and update each checkout of the branch without touching unsaved work
  elsewhere (a two-way `read-tree -m -u`, which refuses rather than overwrites, and carries staged changes over;
  `git merge` would refuse any staged change, which the finalize checks allow away from the run's paths). The checks
  of step 8 run again just before it, since time passes while the user decides.
- **Re-running acceptance after every merge** works (`checkCombined` on the integration branch) but costs a fresh
  checkout each time; the run manager decides whether to do it after every merge or only at finalize.

## Open decisions

Ask the owner only when the work needs the answer, one question at a time.

- **Git hooks** on Orchestra's internal steps (worktree creation, branch moves, internal commits on `orchestra/*`): off
  by default for now (`DEFAULT_HOOK_POLICY` in `src/config/defaults.ts`). Confirm with the owner.
- **Approval pop-up:** the owner said the user allows whatever they want. Confirm whether they still want a start/finalize confirmation before building step 13.
- **Even split:** hard (current: each engine gets ⌊N/K⌋ or ⌈N/K⌉) or soft.
- **Replanning:** may the orchestrator change the plan alone when a worker is blocked?
- **Claude CLI:** the owner's CLI is 2.1.97. Upgrading to ≥ 2.1.325 fixes several bugs that matter ([research §5.1](research.md#51-claude-code-worker)).
- **Files changed both by the user and by the run** (on the user's branch while the run was going): finalize checks
  currently allow them when git merges them cleanly and the tests pass on the merged result, and list them in the
  report. The stricter option refuses any such file. Confirm with the owner.
- **macOS:** this clone is on the owner's Mac, while the docs and CI target Windows first. Should CI also run on macOS
  (macOS runner minutes cost more on private repositories)?

## What changed vs the original onboarding prompt

- **No project allowlist.** It was removed at the owner's request.
- **Google:** the Antigravity CLI with an API key, not the Gemini CLI. The engine id is `antigravity`.
- **Local folder:** `Desktop/orchestrate_all` (on Windows `Desktop\orchestrate_all`; the 2026-11-20 session used the
  owner's Mac). The repo is `barbarosisik/orchestrate-all`.

## Working with the owner

- **Answers:** short and plain. One decision at a time, no walls of text.
- **Branches:** every piece of work on its own branch from `dev`, with a pull request into `dev` (that is what runs
  CI), then `dev` is moved to it right away. `main` is never pushed to; it waits for the owner.
- **Commits** go under the owner's own git identity (the clone's local `user.name`/`user.email` match the earlier
  commits). Never add `Co-Authored-By`, "Generated with" or any AI attribution to commits or pull requests.
- **Logos:** no real vendor logos (trademarks). The robots in the header are original characters.
