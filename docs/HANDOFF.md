# Handoff

**Last updated:** 2026-11-22. Read this first, then [PLAN.md](PLAN.md). If you have the original onboarding prompt,
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
- **Windows containment (decided 2026-11-22):** the Job Object uses the `koffi` FFI library (an optional dependency,
  pinned). Microsoft's MXC SDK is not used (its telemetry can't be turned off), so Windows has no sandbox around a
  whole worker for now: Codex and `agy` sandbox their own commands there, Claude Code doesn't.

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
| Step 9: run store (the run folder `<home>/runs/<runId>`: approved plan and hash, the run's state, the last finalize report, a capped JSON Lines log of decisions, and per task and round the worker's output, the gate and the commit's diff; atomic writes, no links, everything read back checked against its schema and the plan; enough to carry on after a crash) | `src/store/` |
| Step 10, part 1: engines (detection at the start of a run: installed, version, signed in or on the API key, through each CLI's own status command; one adapter per engine: command line, worker environment without billing variables, brief on stdin, event stream read into tokens, refusals, final result and violations; worker runs saved into the run folder, with a time limit and cancellation that stop the whole process tree; the agents' own config folders compared before and after each worker) | `src/engines/`, `src/os/process-tree.ts` |
| Step 10, part 2, first piece: Job Objects (every process Orchestra starts on Windows, workers, acceptance commands and detection probes, runs in a Job Object of its own, so everything it starts is stopped at a time limit, on cancel, when it exits and when Orchestra stops or crashes, also processes whose parent already exited; the job is made before the start, so without one nothing starts, and a process that can't be put in it is stopped at once and never gets its input; Linux and macOS keep the process group, behind the same interface) | `src/os/job.ts`, `src/os/process-tree.ts` |
| Tests: 923 passing on macOS (9 more run only on Windows); CI runs Windows + Linux (Node 22 and 24); engines are tested against fake engines only | `test/`, `.github/workflows/ci.yml` |

**CI** runs on pull requests and on pushes to `main`. Steps 3–5 went into `dev` through PR #1, step 6 through PR #2,
step 7 through PR #3, step 8 through PR #4, step 9 through PR #5, step 10's first part through PR #6 and the Job
Object through PR #7, all green on Windows and Linux (the first runs found test-only problems: git's `C:/` paths,
hidden `.git` files, Linux running a script without `#!` through `sh`, a Windows folder held by a test's process, in
step 8 a test that assumed letter case is ignored, as on Windows and macOS but not Linux, in step 10 a test program
without a Windows extension, and for the Job Object a test expecting a detached process to outlive its command on
Windows, which the job now stops).

**Review:** an independent review of steps 3–5 found 9 problems (a `git.exe` planted in a worktree, task branches turned
into links to the user's branch, rewritten git objects, unwatched included config, links in Orchestra's folders, a
relative hooks path, per-worktree config copied by git, a split git-folder layout, hidden index entries). All are fixed
and each has a test. Reftable repositories also work now (HEADs are read through git). An independent review of step 9
found 12 problems (a run setup that could be edited without breaking a hash, review limits and thresholds read from the
stored state itself, states the steps can't produce, a log repair that failed on a damaged byte or near the cap, worker
output held in memory after a failed write, `close()` releasing the run while writes were still going, reports too large
to save, log records over the line limit, and smaller ones). All are fixed and each has a test. An independent review of
step 10's first part found 13 problems (Claude's settings file in the temp folder, which Codex's sandbox may write, so
a concurrent worker could plant hooks; Claude's billing and mode checks passing when its init event or a field was
missing; a cancel during preparation lost; a late time limit relabelling a clean run; time limits too long for a
timer; edits behind linked dotfiles and skill folders unseen; Claude's automatic memory, Codex's bundled skills and the
scripts settings run left unwatched; same-size edits to files named like sign-ins; MCP calls in Codex runs; Claude's
subscription token refused; pre-release order). All are fixed and each has a test; so are five of its smaller
points (the worktree checked again just before the start, the `Monitor` tool, briefs starting with "/", one program
path per engine, and `mayStillBeRunning`). An independent review of the Job Object found 4 problems (a Windows test
whose leftover Node itself stops; the job made only after the start, with koffi loaded then, which left up to about
100 ms for an acceptance command's code to start something outside it; the docs calling it containment; a `taskkill`
fallback by process id, which could reach another process). All are fixed, and so are its smaller points (a pid file
read as 0 in tests, koffi type names declared twice, a test that checked nothing).

### How steps 3–10 fit together (for the run manager later)

Before planning: `detectEngines()` (step 10, `src/engines/detect.ts`) says which engines are ready. The plan may only
use those (`defaultValidationContext(detection.ready)`); show the user each engine's `problems` and `warnings`.

0. Once the plan is approved: `createRun(home, { runId: newRunId(), ready, hooks: ctx.hooks, caseInsensitivePaths:
   ctx.caseInsensitivePaths, review: { maxRevisionRounds, threshold } })` makes the run folder and returns its
   `RunStore` (step 9, `src/store/run.ts`); the review settings default to `DEFAULT_LIMITS` and
   `DEFAULT_REVIEW_THRESHOLD`, and every task's review must use them. Every step
   below records what happened there: state changes with `store.updateTask(id, change)` or `store.update(fn)` (refused,
   with nothing written, unless the new state fits the plan), and each decision with `store.appendLog(entry)`, built from
   the step's result by `integrityEntry`, `scopeEntry`, `commitEntry`, `gateEntry`, `reviewEntry`, `mergeEntry` and
   `finalizeEntry` (`src/store/entries.ts`). Save the state first, then log: the state is what a restart carries on
   from, the log is the history.
1. `createTaskWorktree(ctx, { runId, taskId, startSha })`: `startSha` comes from `startCommitFor(task, baseSha, integrationTip)`.
   Record it (`startSha`, status "working").
2. `takeBaseline(ctx)` and `snapshotAgentConfig({ home: os.homedir(), env: process.env })` before the worker starts.
3. `runWorker({ store, worktree: wt, round, brief, shell, signal })` (step 10, `src/engines/worker.ts`) runs the task's
   engine and model from the plan, in this task's worktree only (on Windows inside a Job Object, or not at all). It
   records the worker run in the task's `workers` before the start (so a crash shows it never ended) and at the end
   (exit code, error, tokens), logs `worker` started/finished, and saves the raw output with `store.openOutput`. `outcome.status` is "completed" only when the
   engine exited with 0, said it finished, and broke none of the conditions it was started under (API billing,
   another permission mode, MCP servers, a shell that should be off). Steps 4–6 run in every case before anything
   is committed, but not while `outcome.mayStillBeRunning` (something the engine started may still write).
   Before each worker, run `detectEngines({ engines: [task.engine] })` again (cheap): it catches a sign-in changed
   during the run. Before a revision round, the worktree must hold exactly the expected tip again: a file left in it
   (a planted `.claude/settings.json`, say) would be loaded as project settings by the next Claude worker.
4. `checkIntegrity(ctx, wt, baseline, expectedTip)`, and `compareAgentConfig(before, await snapshotAgentConfig(...))`
   logged with `agentConfigEntry`: any violation or change stops the task.
5. `checkScope(ctx, wt, task, { fromCommit: expectedTip })`, then `commitTask(...)` with `taskCommitMessage(runId, task)`.
   Then `store.saveDiff(ctx, taskId, round, expectedTip, commit)` keeps the diff for the user.
6. `runAcceptanceGate(ctx, wt, task, { baseline: <the passing report's baseline>, commit })`: runs the acceptance
   commands, then the integrity check and (only if that passed) the scope check from the task commit. A command that
   changed a tracked file fails the gate; files it added are listed and never committed. `store.saveGate(taskId, round,
   gate)` keeps each command's output.
7. Review: `newTaskReview(task, reviewSettingsOf(store.record))`, `recordGate(state, gate)`, then `recordReview(state, json)` with
   the orchestrator's review. On "needs-revision": `startRevision(state)`, give the worker `revisionRequest(state)` and
   go back to step 2 (new baseline; the expected tip is now the task commit). Store the `TaskReview` in the task's
   `review` after every transition: the store replays it through these same transitions when reading it back.
8. Merging: `startIntegration(ctx, runId, baseSha)` once per run; then, for each id from
   `readyToMerge(tasks, accepted, merged)`, `mergeTask(ctx, { runId, task, start: wt.startSha, commit, expectedTip })`.
   A refused merge (overlap, conflict) changes nothing; the task goes back to review (revise or replan).
   Optionally after each merge, to find the merge that broke things: `checkCombined(ctx, { runId, name:
   'integration', tip, tasks })` runs the merged tasks' acceptance commands on the integration tip, in a new check
   worktree that is removed afterwards. Record each merge in one `store.update`: the task "merged" with its
   `mergeCommit` (null when it changed nothing), appended to `mergeOrder`, and `integrationTip` moved.
9. Before asking the user: `finalizeChecks(ctx, { runId, targetBranch, baseSha, integrationTip, merged })`, where
   `merged` lists every accepted task in merge order with its commit and its merge commit (null when it changed
   nothing). It returns a `FinalizeReport`; `formatFinalizeReport(report)` is the text the user reads. `ready` is true
   only with no problems. The real finalize (step 13) must find the branch still at `report.target.tip`
   (compare-and-swap) and produce exactly `report.target.tree`, merging with the same settings (`NO_RENAMES`,
   `--merge-base=<baseSha>`, `mergeTrees` in `src/merge/integration.ts`). `store.saveFinalizeReport(report)` keeps the
   report.
10. `removeTaskWorktree(ctx, wt, { deleteBranchAt })` when the run is finished or discarded; `removeIntegration` to
   discard the run's integration branch. `await store.close()` finishes queued writes and open output files and
   releases the run; `removeRun(home, runId)` deletes the run folder (never through a link).
11. After a crash (step 12): `openRun(home, runId)` checks everything, removes leftover temporary files and a partial
   last log line, and reopens the run for writing. `contextOf(store.record, home)` gives the `RepoContext`,
   `taskReviewOf(store.state, id)` each review state, and `finalizeInputOf(store.record, store.state)` the finalize
   input (`src/store/state.ts`; `test/store/recovery.test.ts` does exactly this). Compare with git before carrying
   on: a crash between a git step and its state write leaves git one step ahead (see "Not covered yet").

`ctx` comes from `repoContext(readyPlan)`. All git goes through `src/git/run.ts` via `repoGit`/`worktreeGit`, which name
the git folder explicitly and turn hooks off unless the user allows them.

## Next: step 10, part 2: containment (the rest)

Part 1 built detection, the adapters and worker runs (tested against fake engines). Part 2's first piece, the Windows
Job Object, is done (`src/os/job.ts`). What is left needs the owner's machine:

- **An OS sandbox around each whole worker**, so it can write only its own worktree (plus the CLI's own state folder),
  not the run folder, the repository's object store or Orchestra's folders. Today: Codex sandboxes its own commands
  and edits (`workspace-write`); `agy --sandbox` sandboxes its commands where it can; Claude Code's file tools are never
  sandboxed, and on native Windows neither are its commands. Options: macOS `sandbox-exec`, Linux bubblewrap; on
  Windows none for now (MXC was not allowed, see the decision above). Each CLI must keep its sign-in (macOS Keychain,
  `~/.claude/.credentials.json` on Linux, `~/.codex/auth.json`) and its network access to its vendor.
  Found on the owner's Mac (macOS 26): in a `sandbox-exec` profile the later rule wins, and a sandbox can't be applied
  inside another one that restricts anything ("sandbox_apply: Operation not permitted"). So wrapping Codex or `agy` in
  an outer sandbox on macOS breaks their own command sandboxes; only Claude workers (which have none) can be wrapped
  there as they are. What Claude Code writes outside its worktree (`~/.claude.json`, `~/.claude/`, caches, temp
  folders, the Keychain, a self-update) must be known first: none of the engines is installed on that Mac.
- **The engines on the owner's machine** (research §10): the flags and event shapes the adapters use (`agy`'s come
  from docs only), the answers of `claude auth status`, `codex login status` and `agy -p /usage`, whether
  `codex exec` finds a Windows sandbox, and for Claude: whether `--settings` takes inline JSON on the owner's version,
  whether `--disallowedTools Bash Monitor` is accepted and leaves both out of the init event's `tools` (the adapter
  fails a run whose init lists a shell tool that should be off), whether the init event always has `apiKeySource`,
  `permissionMode`, `mcp_servers`, `tools` and `cwd` (missing ones fail the run), and whether Claude Code's npm
  package still has `cli.js` for the Windows shim (otherwise its arguments would need cmd.exe, which Orchestra
  refuses for them). For `agy`: whether closing stdin ends the session before the turn finishes, and its oldest
  usable version. On Windows, inside the Job Object (no breakaway): whether browser tests in acceptance commands
  (Playwright, Puppeteer: Chromium's sandbox uses jobs of its own) still work, and that build daemons (Gradle, MSBuild
  node reuse) are now stopped when the command that started them exits, as on Linux and macOS when they stay in the
  process group.
- **Tests:** the sandbox gets fake-engine tests that try to write outside the worktree; CI runs them on Linux. (The
  Job Object's tests leave processes behind, also detached ones, and run on Windows CI.)

After that, one line each (details in PLAN.md):

11. **Rules and briefs:** find each project's rule files and write each worker's brief from a fixed template.
12. **Background service:** one local service, so a run started from Claude is visible from Codex.
13. **Approval:** the start/finalize confirmation (see open decisions).
14. **Front doors:** the `/orchestrate-all` skill plus the MCP connection for Claude Code and Codex, and an installer.
15. **Real-world test:** on the owner's machine, then a full demo.

## Not covered yet by steps 3–10

- **Checks beyond the repository.** The agents' own config folders are compared before and after each worker (step
  10). The user's main checkout files are not (research §7.5): only git's own config and attributes files and the
  user's refs and checkouts are watched there.
- **Agent config folders, limits:** `~/.claude.json` (it can hold an API key, and changes on every run) and plugin code
  under `~/.claude/plugins/marketplaces` and `cache` are not watched (the installed-plugins lists are). Scripts are
  watched at the top of the agent folders and in the watched folders, not wherever a setting points. A folder with
  more than 5000 entries can't be compared in full and is reported every time. With workers running in parallel, or
  the user's own agent sessions writing (Claude's memory), a change is reported by every worker that ran while it
  happened. The first `agy` run may rewrite (normalize) `~/.gemini/antigravity-cli/settings.json`. A worker can plant
  a file there and remove it again between two snapshots, and a worker running meanwhile loads it (the sandbox, part
  2, closes this).
- **Detection sees a little more than workers:** `codex login status` reads the user's `config.toml`, which workers
  ignore (a keyring sign-in setting there could make detection say ready while workers can't sign in), and
  `claude auth status` reads the user's settings (a personal API key helper there refuses Claude, although workers
  would use the subscription).
- **A project's own `.claude/settings.json`** can set environment variables (`env`) for Claude, such as a provider
  switch or a base URL, that the worker environment leaves out; whether Claude then still reports
  `apiKeySource: "none"` must be checked on the owner's machine (step 10 part 2).
- **Processes:** on Linux and macOS, a process the engine started in a session of its own is not stopped and can keep
  its output open (`mayStillBeRunning`), and after a conductor crash a worker can outlive it (worker runs don't record
  a process id; step 12). On Windows the Job Object stops all of these, also when Orchestra crashes. It cleans up; it
  is not a wall: a process that tries to get out can (through WMI, Task Scheduler, a COM server or Explorer, by naming
  another process as its parent, or by taking the job's handle from Orchestra's process, same user, and changing its
  limits). Only a sandbox closes that, and Windows has none in Orchestra for now. If Orchestra itself runs in a job
  that sets UI limits, no job can be nested in it, and nothing runs (the error says so). Detection probes and acceptance commands have no deadline if stopping them fails (workers do).
- **What a worker may do besides editing its worktree.** Claude workers run in `acceptEdits` mode on project settings
  only; a repository the user trusted in Claude Code can widen this with its own `.claude/settings.json` (allow rules,
  extra directories; an API key helper makes the run fail on API billing). Workers can read anything the user can,
  and use the network as their engine allows (Codex: off in its sandbox). The conductor's checks after the worker stay
  the final word.
- **`agy`:** its flags, its events and the `/usage` check for API-key mode come from Antigravity's docs and changelog,
  not from runs (research §10).
- **Claude Code's version** is read once per run by detection; a CLI that updates itself during a run is not checked
  again.
- **Briefs** are step 11: `runWorker` takes the brief as text.
- **The object store.** A worker that can write to the repository's `.git/objects` can damage it. The scope check
  re-hashes every tree it relies on, so this can't hide an out-of-scope change, but file contents (blobs) are not
  re-hashed. For step 10 part 2: sandbox workers so they can write only their own worktree folder. The conductor
  commits for them, so they don't need to write to `.git` at all, and most tamper checks then become a second line of
  defence.
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
  is stopped, and so is whatever they leave running when they exit (a Job Object on Windows). Running them inside the
  sandbox belongs with the rest of step 10 part 2.
- **Fresh worktrees have no installed dependencies.** Task and check worktrees hold the committed files only, so
  acceptance commands must set up what they need (for example `npm ci` before `npm test`) until opt-in copying of
  ignored files exists (research §7.4; it belongs with the engines and briefs, steps 10–11).
- **Finalizing itself** (step 13): the real merge must use the tree the finalize checks tested, move the branch with
  compare-and-swap from the tip in the report, and update each checkout of the branch without touching unsaved work
  elsewhere (a two-way `read-tree -m -u`, which refuses rather than overwrites, and carries staged changes over;
  `git merge` would refuse any staged change, which the finalize checks allow away from the run's paths). The checks
  of step 8 run again just before it, since time passes while the user decides.
- **The run folder is only as safe as the user's account** until workers are sandboxed (step 10 part 2). The store
  refuses links, damaged files and any state its own steps could not have produced (the plan's hash and a setup hash
  over the whole of `plan.json`, repeated in `state.json`; each review replayed through the review rules with the run's
  own settings; each task's status against its record; merge order against dependencies; the integration tip), but a
  worker that rewrites `plan.json` and `state.json` consistently is not detected: the hashes are not secrets. Every
  later git step checks the repository again for itself, and the finalize approval (step 13) must compare the plan hash
  with the one the user approved, held outside the run folder.
- **Races on Orchestra's own folders:** the store checks every folder with lstat before writing and never deletes
  through a link, but a process that swaps a folder for a link between that check and the write is not stopped (Node
  has no `openat`). The worktree manager has the same limit. The sandbox (step 10 part 2) closes it.
- **Secrets a worker prints** are stored as printed in its output file (`worker-<round>.out`/`.err`). Acceptance
  commands get an allowlisted environment, and the store never reads environment variables or credentials.
- **One writer per run:** the store refuses to open a run twice in one process. A lock between processes belongs to
  step 12's service, which knows when it is running and can tell a stale lock from a live one.
- **Git one step ahead after a crash:** a crash between a git step (a task commit, a merge) and the state write that
  records it leaves the stored state one step behind git. Step 12 must compare the stored state with the run's
  branches before carrying on (for example: the integration branch's tip is a merge of the stored tip and an accepted
  task's commit, so record that merge).
- **A stored finalize report is for showing.** Approving re-runs the checks (step 13), since time passes while the user
  decides.
- **A worker restarted in the same review round** replaces that round's output file; step 12 decides whether a restart
  is a new round.
- **A program holding a worker's output file open** on Windows (a viewer without delete sharing) can make the
  rewrite that caps it fail after its retries. Output then stops being saved for that file (memory stays bounded) and
  the output's `problem` says why; the worker itself is not affected.
- **Re-running acceptance after every merge** works (`checkCombined` on the integration branch) but costs a fresh
  checkout each time; the run manager decides whether to do it after every merge or only at finalize.

## Open decisions

Ask the owner only when the work needs the answer, one question at a time.

- **Git hooks** on Orchestra's internal steps (worktree creation, branch moves, internal commits on `orchestra/*`): off
  by default for now (`DEFAULT_HOOK_POLICY` in `src/config/defaults.ts`). Confirm with the owner.
- **Approval pop-up:** the owner said the user allows whatever they want. Confirm whether they still want a start/finalize confirmation before building step 13.
- **Even split:** hard (current: each engine gets ⌊N/K⌋ or ⌈N/K⌉) or soft.
- **Replanning:** may the orchestrator change the plan alone when a worker is blocked?
- **Claude CLI:** the owner's CLI is 2.1.97. Detection refuses Claude Code older than 2.1.101 (before it, the flag
  workers start with could delete conversation history older than 30 days), so Claude workers need an update, or a
  lower floor in the config at that risk. 2.1.325 or later is recommended ([research §5.1](research.md#51-claude-code-worker)).
- **Worker tools:** Claude workers have no shell by default (PLAN §4), while the owner said the user decides what
  agents may do. Keep the shell off unless a run allows it (`shell`), or allow it by default? On native Windows a
  Claude worker's commands are not sandboxed until step 10 part 2.
- **Files changed both by the user and by the run** (on the user's branch while the run was going): finalize checks
  currently allow them when git merges them cleanly and the tests pass on the merged result, and list them in the
  report. The stricter option refuses any such file. Confirm with the owner.
- **Old runs:** run folders (and their worker output) are kept until removed (`removeRun`). Should Orchestra remove
  finished runs after some time, or keep them all?
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
