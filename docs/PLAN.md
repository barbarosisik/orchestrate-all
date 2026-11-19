# Orchestra plan

**Status:** Phase 1, steps 1–2 done; step 3 next (2026-11-19). This file is the single planning document: goal, rules, decisions,
defaults and build order. The design reasoning lives in the [README](../README.md) and [research](research.md).

## 1. Goal

You describe a coding task once in Claude Code or Codex. An orchestrator model:
- splits it into subtasks;
- spreads them evenly across the coding engines that are ready;
- has each run in its own git worktree, under rules enforced by plain code.

You approve before anything reaches your branch.

## 2. Requirements

| # | Requirement |
|---|---|
| R1 | No file clashes, ever. Ownership is planned up front and enforced in code: at validation, after each worker, and at merge. |
| R2 | Works the same from Claude Code and Codex. Every rule lives in the conductor, not in a prompt. |
| R3 | Claude and Codex run on your own subscriptions through their official CLIs. Google runs on your Gemini API key: a deliberate, opt-in exception. Orchestra never reads, copies or proxies credentials. |
| R4 | Full visibility: engine, model, status, time, tokens, logs and exact files changed per task, saved to a run folder. |
| R5 | You approve start, finalize and discard yourself. No model and no HTTP call can approve. |
| R6 | Minimal footprint: Orchestra's data stays outside your repo. It only creates `orchestra/<runId>/*` branches and worktrees, and never touches your branch until you approve. |
| R7 | **Works with any set of ready engines (one or more).** Engines are detected at the start of every run (installed and signed in, or key present). The plan may only use ready engines, and the even split is computed over them. If Antigravity isn't there, Claude and Codex share the work; if only one engine is ready, it does everything. |

## 3. Decisions made

| Topic | Decision |
|---|---|
| Stack | TypeScript (strict) on Node, zod, vitest, MCP SDK, plain `git` via `spawn` (no shell) |
| Coding rules | Orchestra adds none. Each project's own `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` carry the rules ([research §4](research.md#4-project-rules-across-engines-agentsmd--claudemd--geminimd)) |
| Engines | Claude Code, Codex and Antigravity (`agy`), split evenly across the ones that are ready |
| Google lane | Antigravity CLI with a Gemini API key (`modelProvider: "gemini"`); Neon is `gemini-4-neon` ([research §3](research.md#3-vendor-terms-may-orchestra-drive-each-cli-on-your-subscription)) |

## 4. Defaults for the open questions

These are the defaults the code uses until you say otherwise. Each is a config value, not a hard-coded choice.

| Topic | Default |
|---|---|
| Even split | Hard: every ready engine gets ⌊N/K⌋ or ⌈N/K⌉ of the N tasks. Tasks are never invented to fill a quota. |
| Overlapping ownership | Allowed only when one task depends on the other, directly or transitively ("ordered" mode). A "strict" mode allows no overlap at all. |
| Reserved files | Manifests, lockfiles, root config, CI, `.env*`, agent config folders and instruction files. Only a separate "reserved" run (one task, its own approval) may change them. `.git` can never be owned. |
| Task cap | 8 tasks per run |
| Replanning | Needs your re-approval whenever ownership widens or tasks are added |
| Worktrees | Outside the repo, under a short Orchestra folder |
| Claude workers | Project rules only (`--setting-sources project`). No project hooks, no MCP servers, no shell unless the task opts in. |
| Claude CLI | Upgrade recommended (≥ 2.1.325); the adapter gates features on the detected version |
| Internal commits on `orchestra/*` | "Orchestra" identity, signing off. **Whether your git hooks run on them is still your call.** |
| Review | Deterministic checks first, then the orchestrator's review; no auto-accept |
| Finalize | Merge commit into your branch, with your identity and hooks |
| Limits | 3 parallel workers; 30 minutes per task |
| Approval | A native Windows dialog shown by the conductor |
| `.env` copying | Never, unless you opt in per repo |

## 5. Build order

Built test-first, with at least 80% coverage. Steps marked ☁ can be built and tested in the cloud; 🖥 needs your PC.

| # | Step | Where | Status |
|---|---|---|---|
| 1 | Plan schema + validator: ids, paths, normalization, overlap, reserved files, dependencies, engines, even split; plus the plan hash | ☁ | done |
| 2 | Repo checks: allowlist, target branch, base commit, dirty owned paths | ☁ | done |
| 3 | Worktree manager with explicit git-dir and hardened git calls | ☁ | |
| 4 | Integrity checks (`.git` pointer, refs, `HEAD`, nested git metadata) | ☁ | |
| 5 | Scope checker (`-z`, `--no-renames`, ignored files, post-commit re-check) | ☁ | |
| 6 | Acceptance runner + review state | ☁ | |
| 7 | Merge plumbing (`merge-tree --write-tree`, `commit-tree`, compare-and-swap `update-ref`) | ☁ | |
| 8 | Finalize checks | ☁ | |
| 9 | Run store (run folder layout) | ☁ | |
| 10 | Engine detection + adapters for Claude, Codex and `agy`, tested against fake engines | ☁ then 🖥 | |
| 11 | Rules manifest + brief builder | ☁ | |
| 12 | Daemon (lazy start, token, allowlist, crash recovery) | ☁ | |
| 13 | Approval dialog | 🖥 | |
| 14 | MCP shim + `orchestrate-all` skill + installer for both front doors | ☁ then 🖥 | |
| 15 | Phase 0 checks on your PC ([research §10](research.md#10-must-verify-on-your-machine-phase-0-checklist)) and the end-to-end demo | 🖥 | |

Later phases: a live dashboard (Phase 2), then re-routing and side-by-side compare (Phase 3).
