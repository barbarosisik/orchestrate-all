# F. Parallel coding-agent tools, git mechanics, and sandboxing (research notes)

Researcher F, 2026-11-19. Scope: existing tools that run several coding agents in parallel (assignment, isolation, file limits, review/merge, engine driving, Windows, license), git mechanics, sandboxing of coding agents (with emphasis on Windows 11), limiting/observability features, and security incidents.

Labels: [SOURCE url] = project source/README; [DOCS url] = official docs; [SECONDARY url] = third-party article/aggregator; [UNCLEAR] = not verified. "Inference" marks my own reasoning.

---

## 0. Headline findings (read this first)

1. **No shipping tool found plans file ownership up front and enforces it at merge.** All of the 25+ tools surveyed isolate work with worktrees, branches or containers, then rely on review, sequential merging or conflict routing. File partitioning is advisory everywhere (e.g. Claude Code agent teams: "Break the work so each teammate owns a different set of files" [DOCS https://code.claude.com/docs/en/agent-teams.md]). The closest prior art is a research preprint (ATM, arXiv 2607.00041, 2026-06-29) and a guard hook in an unrelated project that is **also called "Orchestra"** (lcsmas/orchestra, Apache-2.0) — see section 7.
2. **"Orchestrator AI splits work across different vendors' agents" is no longer novel.** Orca (MIT), Orchestrator.inc (formerly ComposioHQ agent-orchestrator, Apache-2.0), CLITrigger (MIT), uzi (MIT) and Vibe Kanban (Apache-2.0) already do variants of this.
3. **Market churn in 2026:** Conductor joined Meta (announced 2026-11-04; Conductor Cloud read-only 2026-11-13, shut down 2026-11-20; local Mac app until early 2027) [SECONDARY https://alternativeto.net/news/2026/11/conductor-0-93-0-sets-cloud-shutdown-dates-after-meta-move/]. Vibe Kanban announced sunsetting 2026-04-10 (now community-maintained) [SOURCE https://www.vibekanban.com/blog/shutdown]. Crystal deprecated Feb 2026 and replaced by Nimbalyst [SOURCE https://raw.githubusercontent.com/stravu/crystal/main/README.md]. Superset was renamed Paradev [SOURCE https://raw.githubusercontent.com/superset-sh/superset/main/README.md].
4. **Engine risk for the Gemini leg of Orchestra (outside my scope, but blocking):** Gemini CLI stopped serving free, Google AI Pro and Ultra users on 2026-06-18; those users moved to Antigravity CLI (`agy`) [SOURCE https://raw.githubusercontent.com/google-gemini/gemini-cli/main/README.md; DOCS https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/]. The Antigravity FAQ says: "Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans." [DOCS https://antigravity.google/docs/faq.md]
5. **Windows sandboxing changed in 2026.** Microsoft Execution Containers (MXC) reached GA on 2026-10-07: an MIT-licensed SDK (Rust, .NET, **Node**) that wraps AppContainer process isolation, and also offers session, WSL and microVM backends [DOCS https://blogs.windows.com/windowsdeveloper/2026/10/07/microsoft-execution-containers-policy-driven-containment-for-ai-agents/; SOURCE https://raw.githubusercontent.com/microsoft/mxc/main/README.md]. Codex and Copilot CLI already use it. Claude Code is listed as "upcoming", and **Claude Code still runs commands unsandboxed on native Windows** [DOCS https://code.claude.com/docs/en/sandboxing.md].
6. **The dominant 2026 escape class is the "trust handoff":** the agent writes an ordinary file (a git config, a hook config, a venv interpreter, a `.vscode` task) that an *unsandboxed* host component later executes [SECONDARY https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-coding-agent-sandbox-escapes-20260722-c/]. Orchestra's conductor is exactly such a host component: it runs git in worker-written directories. This is the biggest design risk found (section 6, section 8).

---

## 1. Comparison table

Legend: WT = git worktree; Br = branch; "Own" = per-task file limits.

| Tool (status, date) | How tasks are assigned | Isolation | Own (file limits) | Review / merge | How engines are driven | Cross-vendor | Windows | License |
|---|---|---|---|---|---|---|---|---|
| Claude Squad | Human creates sessions in TUI | tmux session + WT/branch per session [SOURCE README] | No | Diff tab; `s` commit+push; `c` checkout/pause [SOURCE] | Runs any CLI in tmux (`-p "codex"`, `gemini`, `aider`); `--autoyes` presses enter [SOURCE] | Yes (one program per session, profiles) | Native binary broken ("unsupported" PTY), issue #275 [SECONDARY]; tmux needed | AGPL-3.0 [SOURCE] |
| Conductor (Melty Labs; joining Meta, 2026-11-04) | Human, one workspace per task (Cmd+N) [DOCS] | WT under `~/conductor/workspaces/<repo>/<ws>`; Cloud = Vercel microVM sandboxes (now shut) [DOCS; SECONDARY] | No; "Workspace isolation is development isolation, not a security boundary" [DOCS] | Diff viewer, PR, merge, archive [DOCS] | Claude Code, Codex, Cursor, OpenCode CLIs [DOCS] | Yes (per workspace) | macOS only [DOCS] | Proprietary |
| Crystal → Nimbalyst (deprecated Feb 2026) | Human | WT isolation [SOURCE] | No | In-app | Claude Code (Crystal) | [UNCLEAR] | [UNCLEAR] | MIT [SOURCE LICENSE] |
| Vibe Kanban (sunsetting 2026-04-10; community) | Kanban issues → workspaces | WT/branch + terminal + dev server per workspace [SOURCE README] | No | Inline diff comments → agent; PR + merge [SOURCE] | Headless: `claude -p --output-format=stream-json --input-format=stream-json --permission-prompt-tool=stdio`; Gemini via `--experimental-acp`; Codex via app-server-style protocol [SOURCE crates/executors/*.rs] | Yes (10+ agents) | Mentions Windows in env-var notes (`MCP_HOST` on Windows) [SOURCE]; [UNCLEAR] level | Apache-2.0 [SOURCE] |
| container-use (Dagger), "experimental" | Agent calls MCP tools | Container per env **+** git branch per env [SOURCE README] | No (container boundary only) | `cu diff/log/checkout`; `cu merge` or `cu apply` [DOCS https://container-use.com/environment-workflow.md] | MCP server (`container-use stdio`) added to any MCP agent [SOURCE] | Agent-agnostic | [UNCLEAR] (bash installer; Docker) | Apache-2.0 [SOURCE] |
| uzi (Devflow) | `uzi prompt --agents claude:3,codex:2 "<task>"`: same prompt to N agents [SOURCE] | tmux + WT; port range per agent [SOURCE] | No | `uzi checkpoint <agent>` = commit + rebase into current branch [SOURCE] | Drives TUIs in tmux; `uzi auto` presses Enter on prompts [SOURCE] | Yes | No (tmux) [inference] | MIT [SOURCE] |
| Sculptor (Imbue) | Human workspaces; several agents per workspace | WT per workspace; Docker/remote backend experimental [SOURCE README] | No | Changes view, commit, PR [SOURCE] | Claude Code + Pi harness integrated; any terminal agent [SOURCE] | Partly | Mac + Linux downloads only [SOURCE] | MIT [SOURCE] |
| Emdash (YC W26) | Human / issue import (Linear, GitHub, Jira…) | WT + branch per task; SSH remotes [SOURCE] | No | Diffs, PRs, CI checks, merge [SOURCE] | Detects provider CLIs; **installs marker-tagged hooks into each agent's user-level config** for status [SOURCE] | Yes | Yes (MSI/portable) [SOURCE] | Apache-2.0 [SOURCE] |
| CLITrigger (HyperAITeam) | Task queue; deps chain (child starts with parent branch squash-merged in); auto-delegate ("when Claude finishes, Codex reviews"); fallback chain Claude→Antigravity→Codex on context/quota exhaustion [SOURCE] | WT per task under `.worktrees/`; per-project concurrency limit [SOURCE] | "Sandbox mode": writes the CLI's permission file to confine to WT [SOURCE] | Review queue (m=merge, d=discard), risk tag by diff size, conflict resolver [SOURCE] | node-pty CLIs behind one adapter [SOURCE] | Yes | Yes (Windows .exe) [SOURCE] | MIT [SOURCE] |
| Superset → Paradev | Human; built-in `superset:*` skills to orchestrate parallel agents [SOURCE] | WT + branch per task; "Worktrees separate working files; they do not sandbox processes or prevent merge conflicts" [SOURCE] | No | Changes pane, PR pane, merge [SOURCE] | Any CLI agent in terminals; "does not proxy model calls" [SOURCE] | Yes | **Not available** (macOS; Linux experimental) [SOURCE] | MIT [SOURCE] |
| webmux (Windmill) | Human / Linear label auto-create | WT + tmux; optional Docker sandbox profile [SOURCE README] | No | PR/CI badges; merge/remove from dashboard [SOURCE] | Agents in tmux panes [SOURCE] | Claude, Codex | No (tmux, bun) [inference] | MIT [SECONDARY https://www.windmill.dev/blog/webmux] |
| Claude Command Center (CCC) | On-call queue (WatchTower) → worker agents; attaches to existing sessions [SOURCE] | WT spawning [SECONDARY]; optional **shared-clone guard** hook blocks `reset --hard`, `clean -f`, `add -A` etc. in shared checkouts [SOURCE docs/shared-clone-guard.md] | No | Commit or PR; "You decide what deploys" [SOURCE] | Reads each agent's session files; 9 engines [SOURCE] | Yes | Native Windows foreground; WSL2 for service [SOURCE] | FSL-1.1-MIT [SOURCE] |
| Orca (Stably AI) | **Coordinator agent** creates tasks/gates and starts workers: `worker-start --task <id> --agent <claude/codex/antigravity/…> --worktree new-child` [DOCS https://orca.dev/docs/cli/orchestration] | WT per worker; SSH/cloud VM [SOURCE] | **No**: workers self-report `--files-modified` [DOCS] | Diff notes → agent; commit/PR [SOURCE] | Any CLI agent; chat UI or raw CLI; usage/limit tracking & account switch [SOURCE] | **Yes** (`@claude`, `@codex` group addresses) | Yes [SOURCE] | MIT [SOURCE] |
| Orchestrator.inc (ex-ComposioHQ agent-orchestrator) | Main agent "plans the work, starts a worker for each piece in its own worktree" with per-role agents [SOURCE] | WT + branch + PR per worker [SOURCE] | No; "PR ownership" only [DOCS llms-full] | CI failures, review comments, **merge conflicts routed back to owning worker** [SOURCE] | Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Aider… [SOURCE] | **Yes** | Yes [SOURCE] | Apache-2.0 [SOURCE] |
| Gas Town (Yegge) | Mayor → "polecat" workers; scheduler caps (`scheduler.max_polecats`) [SOURCE] | WT/branches; Docker compose option [SOURCE] | No | **Refinery: Bors-style bisecting merge queue with verification gates** [SOURCE] | tmux-driven CLIs [SOURCE] | [UNCLEAR] | Minimal native; WSL for tmux [SOURCE] | MIT [SOURCE] |
| ClaudeMix | Human named sessions | WT + branch + tmux [SOURCE] | No | **Merge queue**: merges selected branches sequentially into one branch, runs validation, skips & reports conflicting ones, one PR [SOURCE] | Claude Code only | No | No (WSL2) [SOURCE] | MIT [SOURCE] |
| Paperclip | "Company" org chart, goals, tickets, heartbeats [SOURCE] | Runtime-dependent | No | Approval stages [SOURCE] | Any agent that "can receive a heartbeat" [SOURCE] | Yes | [UNCLEAR] | MIT [SOURCE] |
| lcsmas/**orchestra** (name clash!) | Agents spawn agents (`orchestra spawn`); orchestrator agents delegate [SOURCE] | WT per workspace [SOURCE] | Partial: "a guard hook blocks [orchestrators] from editing children's files" [SOURCE] | Diff-first review, PR tracking [SOURCE] | Claude Code [SOURCE] | No | Built from source [SOURCE] | Apache-2.0 [SOURCE] |
| Claude Code (official) | Subagents (`isolation: worktree`), agent view (`claude agents`), agent teams (lead + shared task list; experimental), dynamic workflows, `/batch` (5–30 WT subagents), Projects (cloud threads) [DOCS https://code.claude.com/docs/en/agents.md] | WT for subagents/agent-view; **agent teams do not use WT** [DOCS] | Advisory only ("partition the work") [DOCS] | Human; TaskCompleted/TeammateIdle hooks as quality gates [DOCS] | Claude only; "To involve a different tool, expose it to Claude as an MCP server" [DOCS] | No | Yes (sandbox needs WSL2) | Proprietary |
| Codex (CLI/app/cloud) | Parallel chats; `codex exec --worktree`; Codex Cloud tasks [DOCS] | WT in `$CODEX_HOME/worktrees`, **detached HEAD** by default [DOCS https://learn.chatgpt.com/docs/environments/git-worktrees.md]; cloud containers | No | Diff pane, Handoff Local↔Worktree, PR [DOCS] | Codex only | No | Yes, native sandbox (MXC) [DOCS] | Apache-2.0 (CLI) [UNCLEAR for 2026] |
| GitHub Copilot Agents tab / "Agent HQ" | Issues, prompts, `@agent` mentions; Copilot + Anthropic Claude (Agent SDK) + OpenAI Codex (Codex SDK), billed to Copilot sub [DOCS about-third-party-agents] | Cloud sandbox or Actions runner; single branch per agent [DOCS risks-and-mitigations] | Branch-level only | Draft PR; human must approve; workflows need approval [DOCS] | Vendor SDKs in GitHub cloud | **Yes** (Copilot, Claude, Codex) | Cloud; local Copilot CLI sandbox via MXC [DOCS] | Proprietary |
| Cursor 3.x | Agents Window; `/worktree`, `/best-of-n` (same task across models) [DOCS https://cursor.com/docs/configuration/worktrees.md] | WT; `.cursor/worktrees.json` setup; default cap 25 WTs/machine with auto-cleanup [DOCS] | No | `/best-of-n` "compares runs only"; `/apply-worktree` [DOCS] | Cursor agent, many models | Models, not vendors' agents | Yes | Proprietary |
| Antigravity (Agent Manager / CLI) | Manager view; reported up to 5 parallel agents [SECONDARY]; site banner mentions an "Orchestrator" [UNCLEAR] | Per-agent worktrees in 2.0 [SECONDARY, single source] | No | In-app | Antigravity harness | No | Yes; sandbox needs Win11 24H2 + Aug 2026 update [DOCS] | Proprietary |
| OpenHands | Conversations; remote runtimes for parallelism [SECONDARY docs] | Docker sandbox (recommended); "process" sandbox labelled unsafe [SECONDARY] | No | PRs | Own agent, any LLM API key | n/a | Docker | MIT [SOURCE LICENSE] |

Helpers (not orchestrators): workmux (MIT; WT + tmux windows) [SOURCE], Worktrunk (MIT OR Apache-2.0; `wt merge`, hooks, copy-on-write caches; Windows via `git-wt`) [SOURCE], SwarmGit (merges finished agent branches sequentially into main) [SOURCE https://raw.githubusercontent.com/rjben/swarm-git/master/README.md], agent-traffic-control (124 Claude Code skills + hooks for parallel sessions) [SOURCE].

**Which orchestrate across different vendors' agents?** Claude Squad, Conductor, Vibe Kanban, uzi, Emdash, CLITrigger, Paradev, webmux, CCC, Orca, Orchestrator.inc, Paperclip, and GitHub's Agents tab (Copilot + Claude + Codex). Only **Orca** and **Orchestrator.inc** have an AI coordinator that splits one task into worker subtasks across vendors. CLITrigger does cross-vendor fallback and cross-vendor review delegation. uzi sends the *same* prompt to several vendors.

---

## 2. Per-tool notes (key facts only)

### Claude Code official multi-agent modes (docs fetched 2026-11-19)
- Five approaches: subagents, agent view (research preview), agent teams (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), dynamic workflows, projects. `/batch` splits one change into 5–30 worktree-isolated subagents [DOCS https://code.claude.com/docs/en/agents.md].
- Agent teams: lead plus teammates with a shared task list; "Task claiming uses file locking to prevent race conditions" (this locks task claims, **not** files) [DOCS agent-teams.md]. Note: Addy Osmani's 2026-03-26 post says Agent Teams has "file locking [that] prevents two teammates from editing the same file" [SECONDARY https://addyosmani.com/blog/code-agent-orchestra/]. The official docs contradict this: "Two teammates editing the same file leads to overwrites" [DOCS].
- Limits of agent teams: no resumption of in-process teammates, task status can lag, one team per session, no nested teams, no per-teammate permission modes at spawn, and teammates inherit `bypassPermissions` [DOCS].
- Worktrees: default `.claude/worktrees/<name>/`, branch `worktree-<name>`; `.worktreeinclude` copies gitignored files such as `.env`; a periodic sweep removes old subagent worktrees; Claude Code "holds a `git worktree lock`" while an agent runs and writes a marker into the worktree's git metadata so the sweep only removes its own [DOCS https://code.claude.com/docs/en/worktrees.md].
- Security fix: "Before v2.1.212, if the repository already contained a committed symlink at one of those paths, worktree creation followed it and could create files outside the repository." [DOCS worktrees.md]
- Windows: "removing a worktree doesn't delete files outside it. If a folder inside the worktree is a link … NTFS junction or a directory symlink, Claude Code deletes only the link." [DOCS]
- Hooks in worktree sessions keep `${CLAUDE_PROJECT_DIR}` at the main checkout; hook `cwd` follows the worktree [DOCS].

### Codex
- App worktrees live in `$CODEX_HOME/worktrees`, in detached HEAD "to create several worktrees without polluting your branches"; `.worktreeinclude` supported; setup scripts per OS in the `.codex` folder [DOCS https://learn.chatgpt.com/docs/environments/git-worktrees.md, https://learn.chatgpt.com/docs/environments/local-environment.md].
- `codex exec --worktree`, `--json` (NDJSON events), `--output-last-message`, `--ephemeral`, `--ignore-user-config` [DOCS https://learn.chatgpt.com/docs/developer-commands.md?surface=cli].

### GitHub Copilot ("Agent HQ" / Agents tab)
- Third-party agents (public preview): Anthropic Claude via the Claude Agent SDK and OpenAI Codex via the Codex SDK, "powered by your existing Copilot subscription" [DOCS https://docs.github.com/en/copilot/concepts/agents/about-third-party-agents].
- Mitigations worth copying [DOCS https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations]:
  - The agent can push only to one branch (`copilot/…`).
  - "It cannot directly run `git push` or other Git commands": the harness does the git work.
  - Draft PRs need human review, and the requester cannot approve them.
  - Workflows don't run until approved.
  - Hidden characters (e.g. HTML comments) are filtered from issue input.
  - Commits are signed, and each commit message links to the session log.

### Cursor 3.x
- Setup via `.cursor/worktrees.json`, with OS-specific keys (`setup-worktree-windows`). Cursor looks for the file "In the worktree path" first [DOCS]. Inference: that means repo-controlled setup code runs when a worktree is created.
- Cleanup keeps at most `cursor.worktreeMaxCount` (default 25) per machine, and "worktrees created outside the manager (for example … `git worktree add`) are eligible for deletion" [DOCS]. **Pitfall: other tools may delete Orchestra's worktrees.**
- "We do not recommend symlinking dependencies into the worktree." [DOCS]

### Orca
- Orchestration CLI: a run is a "durable namespace" that "Never schedules or places workers". The coordinator uses `task-create`, `gate-create` and `worker-start --agent … --worktree new-child`. Workers can nest up to depth 4 (default). Heartbeat runs every 1–60 min. `--timeout-ms` waits are available. No token/cost budgets are documented [DOCS https://orca.dev/docs/cli/orchestration].

### Orchestrator.inc (ex-Composio AO)
- Desktop app on Windows, macOS and Linux, Apache-2.0. It routes "Failed checks, review comments, and merge conflicts … back to the worker that owns the branch" [SOURCE https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/README.md].
- Has a migration guide from Conductor [DOCS https://docs.orchestrator.inc/llms-full.txt].

### CLITrigger (features worth copying)
- Loop rules: a verification command (exit 0 = done), max rounds, "a cost cap in USD", and a "stop if a round makes no commits" guard.
- Rate-limit parking: "run when the rate limit resets", with the reset time read from CLI output.
- Logs: live logs over WebSocket; raw bytes stored for replay.
- Analytics: cost/tokens per project and CLI.
- Review queue: risk auto-tagging ("failed or over 300 lines is high, over 50 is medium").
- Sandbox: strict mode writes the CLI's permission file [SOURCE https://raw.githubusercontent.com/HyperAITeam/CLITrigger/main/README.md].

### agent-traffic-control (catalogue of real parallel-session failures)
- Pitfall skills include:
  - "worktree-write-abs-path-lands-in-parent-checkout"
  - "git-stash-pop-pulls-unrelated-stash" (stash is global across worktrees)
  - "worktree-index-corrupt-async-post-commit-hook"
  - "git-auto-maintenance-recurring-worktree-index-lock"
  - "verify-pytest-imports-worktree-not-primary-checkout" (editable installs)
  - "worktree-does-not-isolate-shared-installed-artefacts"
  - "pr-hijack-via-stale-worktree-branch-ref" [SOURCE https://raw.githubusercontent.com/wan-huiyan/agent-traffic-control/main/README.md]
- Its `leg-guard` hook allows only one heavy test suite machine-wide, because "A rule that costs nothing to skip is not a rule" [SOURCE]. That supports Orchestra's enforce-in-code stance.

---

## 3. Git mechanics

### 3.1 Worktree pitfalls (with sources)
- **Gitignored files are absent** (`.env`, `node_modules`, certificates). Conductor, Claude Code and Codex all converged on `.worktreeinclude`-style copying of ignored files, plus setup scripts for dependency installs [DOCS Conductor git-worktrees; Claude worktrees.md; Codex git-worktrees.md]. Cursor advises against symlinking dependencies [DOCS]. Copying `.env` hands secrets to the worker (inference).
- **One branch per worktree**: "Git only allows a branch to be checked out in one worktree at a time" [DOCS Conductor; Codex]. Codex avoids the problem with detached HEAD [DOCS].
- **Shared refs/objects**: "Worktrees share the same Git repository data. Commits, pushes, and branch renames in one workspace affect the shared repository" [DOCS Conductor]. The stash is global [SOURCE agent-traffic-control].
- **Hooks run on worktree creation**: `post-checkout` runs on `git worktree add` "unless `--no-checkout` is used" [DOCS https://raw.githubusercontent.com/git/git/master/Documentation/githooks.adoc]. `reference-transaction` runs for "any Git command that performs reference updates", which includes `update-ref` [DOCS githooks]. `commit-tree` and `merge-tree` are plumbing and don't run commit/merge hooks (inference from githooks, which lists no such hooks).
- **Async post-commit hooks** corrupt sibling worktree indexes or hold locks [SOURCE agent-traffic-control].
- **Absolute-path writes escape the worktree** into the parent checkout [SOURCE agent-traffic-control]. Inference: a scope check that only diffs the worker's worktree misses this.
- **Windows long paths**: MAX_PATH 260 needs `core.longpaths=true` plus the OS long-path policy [SECONDARY https://gitforwindows.org/git-cannot-create-a-file-or-directory-with-a-long-path.html]. Deep `node_modules` paths are the usual trigger. Worktrees under a long base path make it worse [SECONDARY].
- **Windows removal failures**: live processes (MCP servers, agent subprocesses, Defender, Search Indexer) hold handles. Reports also say `git worktree remove` can strip the `.git` link first, so a retry no longer finds a repo [SECONDARY claudeissues.com mirror of anthropics/claude-code issues #32747, #41740, #68799; not fetchable here].
- **Windows parallel checkout races**: reports of `checkout.workers=8` racing with `core.fscache` and corrupting worktree checkout in Claude Desktop (issues #92085/#92086/#92019) [SECONDARY, titles only via search].
- **Mixing WSL git and Windows git**: worktree links are absolute paths by default. Git 2.48 added `worktree.useRelativePaths`, which enables `extensions.relativeWorktrees` and makes the repo incompatible with older Git [DOCS https://raw.githubusercontent.com/git/git/master/Documentation/config/worktree.adoc; RelNotes 2.48.0].
- **Other tools' cleanup** (Cursor max 25) can delete worktrees they did not create [DOCS Cursor]. Claude Code mitigates this with `git worktree lock` [DOCS].
- **Committed symlinks / junctions** at worktree paths have led to writes outside the repo (Claude Code pre-2.1.212) [DOCS].
- **Shared installed artefacts** (editable installs, simulator installs, DerivedData) are not isolated by worktrees [SOURCE agent-traffic-control].

### 3.2 Merge strategies seen
- **Per-task branch → human PR review** (most tools; Copilot requires human approval) [DOCS].
- **Rebase onto current branch**: `uzi checkpoint` [SOURCE].
- **Sequential merge queue with validation, skip conflicting**: ClaudeMix [SOURCE]; SwarmGit [SOURCE].
- **Bors-style bisecting batched merge queue**: Gas Town Refinery [SOURCE].
- **Route conflicts back to the owning agent to rebase/resolve**: Orchestrator.inc ("Merge conflict | Asks the eligible session to rebase and resolve it") [DOCS llms-full].
- **Apply as staged changes vs merge preserving history**: container-use `apply` vs `merge` [DOCS].
- Research and practice (2026):
  - arXiv 2607.04697 (Xu et al., 2026-07-06) studied 33,596 agent PRs. Textual conflict rate was 19.8% for same-agent pairs and **41.7% for cross-agent pairs**. Recommended defences: file ownership plus sequential merge with rebase [SECONDARY summary https://codex.danielvaughan.com/2026/07/28/agent-pr-merge-conflicts-concurrent-coding-agents-codex-cli-worktree-isolation-coordination-defence/; title verified on arXiv].
  - The same post suggests running `git merge-tree` in PostToolUse hooks to catch conflicts early [SECONDARY].

### 3.3 `git merge-tree --write-tree` facts
- Added in Git 2.38. `--stdin` arrived in 2.39, `--merge-base` in 2.40, and tree-only inputs in 2.45 [DOCS git RelNotes].
- Exit codes: 0 = clean, 1 = conflicts, other = error. With `--stdin` it returns 0 for both clean and conflicted merges [DOCS git-merge-tree.adoc].
- "MISTAKES TO AVOID" in the official docs:
  - "Do NOT interpret an empty Conflicted file info list as a clean merge; check the exit status."
  - Don't parse the tree to find conflicts.
  - Show conflicts from the conflicted toplevel tree (it has annotated markers) rather than re-merging stage OIDs [DOCS].
- The docs' own example ends with `git update-ref $BRANCH1 $NEWCOMMIT` without an old value. Orchestra's CAS form (`update-ref <ref> <new> <old>`) is stricter (inference).
- **In the wild:** GitLab Gitaly calls `merge-tree --write-tree` (with `--merge-base` and `--allow-unrelated-histories`) and parses the conflicted-file info [SOURCE https://gitlab.com/gitlab-org/gitaly/-/raw/master/internal/git/localrepo/merge.go]. It was designed for "server side merges" by Elijah Newren [SECONDARY lore.kernel.org thread].
- Inference: merge-tree honours `.gitattributes` merge drivers that are defined in config. Config-defined drivers are code execution, so config must be trusted.

---

## 4. Sandboxing coding agents

### 4.1 Per-engine sandboxes (state on 2026-11-19)

**Claude Code** [DOCS https://code.claude.com/docs/en/sandboxing.md]
- Off by default. macOS uses Seatbelt; Linux/WSL2 use bubblewrap + socat. "On native Windows, Claude Code runs commands unsandboxed."
- Writes are limited to the cwd, temp and added dirs. **Reads cover "Most of the machine, including credential files such as `~/.ssh`"** unless `denyRead` is set.
- Network goes through a proxy with an allowlist that starts empty. Env vars are inherited.
- Covers shell commands only. Read/Edit/Write tools, hooks, MCP servers and LSP run outside the sandbox.
- **Protected paths** (write-denied even inside writable dirs):
  - `.claude` settings/skills/agents/commands/hooks and `.mcp.json`
  - `.bashrc`, `.gitconfig`, `.vscode`, `.idea`
  - **`hooks` and `config` inside `.git`**
  - files that would make cwd a bare repo (`HEAD`, `objects`, `refs`)
  - `~/.claude`
- In a linked worktree, writes to the main repo's shared `.git` are allowed "so commands such as `git commit` can update refs", but `hooks/` and `config` stay denied.
- The whole process can be wrapped with `@anthropic-ai/sandbox-runtime` (`srt claude`; beta; no native Windows) [DOCS https://code.claude.com/docs/en/sandbox-environments.md].
- Native Windows guidance: "use a container or VM, or run the Bash sandbox inside WSL2" [DOCS].
- MXC support for Claude Code is "announced as upcoming" [DOCS Windows blog 2026-10-07].

**Codex** [DOCS https://learn.chatgpt.com/docs/agent-approvals-security.md; https://learn.chatgpt.com/docs/windows/windows-sandbox.md; https://learn.chatgpt.com/docs/permissions.md]
- Modes: `read-only`, `workspace-write` (no network by default), `danger-full-access` (`--yolo`).
- macOS uses Seatbelt (`sandbox-exec`). Linux uses **bwrap + seccomp** (Landlock is legacy; moved in 0.115, which dropped WSL1).
- Windows offers `mxc` (recommended; no admin, no extra accounts; needs Win11 24H2/25H2 build ≥ 26100.9278 / 26200.9278), with legacy fallbacks:
  - `elevated`: admin setup, dedicated low-privilege sandbox users, firewall rules.
  - `unelevated`: restricted token + ACLs; weaker network; no deny-read.
- **Protected paths in workspace-write:** `.git` is read-only, "If `<writable_root>/.git` is a pointer file (`gitdir: ...`), the resolved Git directory path is also protected". `.agents`, `.codex` and `.aws` are read-only too. Inference: Codex workers in worktrees generally cannot commit, so the conductor must create commits itself, which fits Orchestra.
- MXC caveats: deny-read globs are a start-time snapshot; "Remaining child processes stop when the foreground command exits"; loopback allowed.

**Gemini CLI** [SOURCE https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/sandbox.md]
- Backends: `-s` / `GEMINI_SANDBOX=docker|podman|sandbox-exec|runsc|lxc`.
- The Seatbelt default profile `permissive-open` restricts writes and allows network.
- The Docker image mounts the project at the same path.
- **Windows Native** sandbox uses `icacls` to set "Low Mandatory Level"; the label changes are **persistent** on files.
- gVisor `runsc` and LXC are Linux-only.
- Folder trust is off by default [SOURCE trusted-folders.md].
- Now enterprise-only for subscriptions (see 0.4).

**Antigravity CLI (`agy`)** [DOCS https://antigravity.google/docs/sandbox.md]
- Mechanisms: Linux namespaces; macOS `sandbox-exec`; Windows "Commands run in an AppContainer inside a process security environment … Requires Windows 11 24H2 or later with the August 2026 update".
- What it blocks: `~/.ssh` and `.env` are blocked, and network is off except approved domains. On Windows, folders outside the user profile are readable but not writable.
- The sandbox is silently unavailable on older Windows: `--sandbox` "has no effect".
- Headless mode: `agy -p`, `--output-format json|stream-json` (includes tool calls and token usage), `--json-schema` [DOCS https://antigravity.google/docs/cli/headless.md].
- Pillar (2026-07-20) reported Antigravity's Seatbelt profile was allow-default and a `.vscode` task bypass; Google did not patch [SECONDARY CSA note].

**GitHub Copilot CLI** [DOCS https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/about-cloud-and-local-sandboxes]
- The local sandbox is "powered by Microsoft eXecution Container (MXC)": Seatbelt on macOS, bubblewrap on Linux, recent Win11 builds on Windows. Credentials are masked by a proxy.
- Key admission: "The CLI's built-in file tools … run in-process … the operating-system sandbox never sees the file operations these tools perform".
- On Windows, the proxy and host rules "rely on programs honoring the proxy settings".

### 4.2 Generic Windows options
- **MXC** (GA 2026-10-07) [DOCS blog; SOURCE https://github.com/microsoft/mxc]
  - Backends: `processcontainer` (AppContainer; default on Win11), `isolation_session` (separate Windows account/session; build ≥ 26100.9550), `wslc`, plus experimental `windows_sandbox`, `microvm` (x64), `hyperlight`.
  - JSON policy: FS read-only / read-write / deny lists, network egress default deny with proxy, UI policy, `timeoutMs`.
  - **Learning mode** records denials into a JSON activity report (process containers only).
  - SDKs: Rust (`mxc-sdk`), .NET (`Microsoft.Mxc.Sdk`), **Node (`@microsoft/mxc-sdk`)**; MIT.
  - **Required telemetry events cannot be disabled** on Windows release builds [SOURCE README].
  - Min builds: 24H2 26100.9278 (KB5120998, Aug 2026) [SOURCE docs/backends/process-container/os-version-support.md].
- **AppContainer (raw)**
  - Provides file/registry, network (Internet/intranet/server capabilities), process and window isolation. "Read-write access can be granted to specific persistent files … Read-only access is less restricted." [DOCS https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation]
  - MXC wraps this.
- **Low integrity level**
  - By default the system labels objects `NO_WRITE_UP` only, so a low-IL process **can still read** medium-integrity user files (secrets) [DOCS https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control].
  - No network control. This is what Gemini CLI's Windows sandbox uses.
- **Windows Sandbox (WSB)**
  - Hyper-V disposable VM; Pro/Enterprise/Education editions; network on by default [DOCS https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/].
  - The 24H2 `wsb` CLI has start/exec/stop, but "there is no support for process I/O", and `exec` as the user needs an active session (connect first) [DOCS windows-sandbox-cli].
  - Poor fit for headless workers.
- **WSL2**
  - Gives Linux bubblewrap sandboxes to Claude Code, Codex and `srt` [DOCS].
  - Costs: cross-filesystem performance and git path issues (3.1). The CLIs must be installed and logged in inside the distro (inference).
- **Docker Desktop / dev containers**
  - Claude, Codex and Gemini all document container options [DOCS].
  - **Docker socket = escape**: Pillar showed escapes from Codex, Cursor and Gemini CLI via the Docker socket (2026-07) [SECONDARY CSA note].
  - Docker Desktop licence terms for larger companies [UNCLEAR, not re-verified].

### 4.3 What each layer protects against (summary)
| Mechanism | FS writes | Reads of secrets | Network | Covers agent's in-process file tools? |
|---|---|---|---|---|
| Claude Code Bash sandbox | Yes (cwd + protected paths) | Only with denyRead | Yes (proxy allowlist) | **No** |
| `srt` / container / VM around whole CLI | Yes | Yes if configured | Yes | Yes |
| Codex workspace-write (MXC/bwrap/Seatbelt) | Yes (+ `.git` read-only) | Deny-read lists (not in `unelevated`) | Off by default | Codex applies to commands [DOCS]; [UNCLEAR] for patch tool |
| agy sandbox | Yes | Blocks `.ssh`, `.env`; Windows: outside-profile readable | Allowlist | [UNCLEAR] |
| Gemini Windows low-IL | Yes (to medium objects) | **No** | **No** | [UNCLEAR] |
| MXC process container (whole worker) | Yes | Yes (deny/RO lists) | Egress policy | Yes (wraps whole process) |
| Windows Sandbox VM | Yes | Yes (only mapped folders) | On/off | Yes |
| Worktree alone | **No** ("not a security boundary") | No | No | No |

---

## 5. Limiting and observability features worth copying

- **Per-run budget and turn caps:**
  - Claude `--max-budget-usd` (print mode, client-side estimate, includes subagents) and `--max-turns` [DOCS https://code.claude.com/docs/en/cli-reference.md].
  - JSON output includes `total_cost_usd` and per-model cost [DOCS headless.md].
  - Inference: on a subscription this is an estimate, not a bill, but still a useful cap.
- **Loop rules:** max rounds, a USD cap, a verify command, and stop if no commits [SOURCE CLITrigger].
- **Budgets with thresholds:** company/agent/project budgets with threshold alerts and pause at limits [SOURCE Paperclip]. Osmani suggests "At 85% of budget, auto-pause", per-agent token budgets, and `MAX_ITERATIONS=8` [SECONDARY].
- **Concurrency caps:** Gas Town `scheduler.max_polecats` [SOURCE]; CLITrigger per-project limit [SOURCE]; Cursor `worktreeMaxCount` [DOCS]; a machine-wide one-test-suite guard [SOURCE agent-traffic-control].
- **Timeouts:** MXC `timeoutMs` [SOURCE]; Orca `--timeout-ms` and heartbeats [DOCS]; Claude `BASH_DEFAULT_TIMEOUT_MS` [DOCS headless].
- **Structured live streams:** `claude -p --output-format stream-json --verbose --include-partial-messages`; `codex exec --json`; `agy -p --output-format stream-json` (tool calls and token usage) [DOCS]. Vibe Kanban already drives Claude this way [SOURCE].
- **Raw log persistence with replay** [SOURCE CLITrigger]. Copilot session logs, plus a commit-message link to the session log [DOCS].
- **Kill switches:** `x` stops a teammate; `/tasks` [DOCS Claude]; `uzi kill` [SOURCE]; CLITrigger's fallback chain kills a process on quota exhaustion [SOURCE]. Inference: on Windows, kill whole process trees (Job Objects) before worktree removal (see 3.1).
- **Audit logs:** MXC learning-mode activity report (JSON) [SOURCE]; Copilot audit log events and signed commits [DOCS]; Paperclip audit logs [SOURCE].
- **Risk triage:** diff-size tagging [SOURCE CLITrigger]; Copilot's CodeQL, secret scanning and advisory-DB scan on agent output [DOCS].
- **Rate-limit awareness:** parse reset times and schedule on reset [SOURCE CLITrigger]; usage/limit view per account [SOURCE Orca].

---

## 6. Security incidents and analyses (lessons)

| Date | Incident | Mechanism | Lesson for Orchestra |
|---|---|---|---|
| 2025-05-26 | Invariant Labs: GitHub MCP "toxic agent flow" [SECONDARY https://invariantlabs.ai/blog/mcp-github-vulnerability] | Malicious public issue made the agent leak private-repo data into a public PR | Task text from issues is untrusted. Least-privilege tokens; workers get no GitHub write. |
| 2025-08 (Aug Patch Tuesday) | CVE-2025-53773 Copilot/VS Code [SECONDARY https://embracethered.com/blog/posts/2025/github-copilot-remote-code-execution-via-prompt-injection] | Prompt injection wrote `"chat.tools.autoApprove": true` into `.vscode/settings.json` → YOLO → RCE | Agents editing their own config files = privilege escalation. Protect `.vscode/`, agent configs. |
| 2025-08 (fixed v0.2.111 / v1.0.20) | Cymulate "InversePrompt" CVE-2025-54794/54795, Claude Code [SECONDARY https://cymulate.com/blog/cve-2025-547954-54795-claude-inverseprompt/] | Path check by **string prefix** (`/project` vs `/project_malicious`); command allowlist injection | Ownership checks must use canonicalized path comparison, never prefixes. |
| 2025-08-26 | Nx "s1ngularity" supply chain [SECONDARY https://www.wiz.io/blog/s1ngularity-supply-chain-attack] | Malicious postinstall ran `claude --dangerously-skip-permissions`, `gemini --yolo`, `q --trust-all-tools` to hunt secrets | Installed agent CLIs and their logins are an attack asset. `npm install` in a worktree runs untrusted code. |
| 2025-09/10 (Cursor 1.7) | CVE-2025-59944 Cursor (Lakera) [SECONDARY https://www.lakera.ai/blog/cursor-vulnerability-cve-2025-59944] | Case-sensitive guard on `.cursor/mcp.json` bypassed on case-insensitive FS (Windows, macOS) | **On Windows, normalize and compare paths case-insensitively.** |
| 2026-02 | Check Point: CVE-2025-59536 (hooks/MCP in `.claude/settings.json`, `.mcp.json`) and CVE-2026-21852 (`ANTHROPIC_BASE_URL` in project settings sends API key before trust) [SECONDARY https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files/] | Repo-supplied config executed or redirected traffic | Repo config is code. Run workers so they don't load project settings, and never let a task "own" agent config. |
| 2026-02-09 / 02-17 | "Clinejection" [SECONDARY https://labs.cloudsecurityalliance.org/research/csa-research-note-clinejection-prompt-injection-cicd-cache-p/] | Issue title interpolated into a claude-code-action triage prompt → cache poisoning → npm token theft → malicious cline@2.3.0 | Never interpolate untrusted text into privileged agent runs. Scope credentials. |
| 2026-02-06 | CVE-2026-25725 Claude Code (Cymulate) [SECONDARY https://cymulate.com/blog/the-race-to-ship-ai-tools-left-security-behind-part-1-sandbox-escape/] | Sandboxed agent writes `.claude/settings.json` with a hook; it runs on host at next launch | Classic trust handoff. Check config files for tampering *between* worker runs. |
| 2026-02 → 06 | Cato "DuneSlide" CVE-2026-50548/50549 Cursor (CVSS 9.8) [SECONDARY CSA note] | Broke Cursor sandbox enforcement logic | Don't rely on one vendor's sandbox. |
| 2026-07-20 | **Pillar "Week of Sandbox Escapes"** (7 issues; Cursor, Codex CLI, Gemini CLI, Antigravity) [SECONDARY https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-coding-agent-sandbox-escapes-20260722-c/; SOURCE posts at pillar.security] | Trust handoff: agent writes a file, an unsandboxed host component executes it | See the details below this table. |

Details of the Pillar series:
- **GitPwned (Codex):** `git show --output=./.git/config --format=…` plants `[diff] external=…`, which runs on the next `git diff`. Patched in Codex 0.95.0 (2026-02-04). "Commands aren't inherently safe or dangerous; invocations are." [SOURCE https://www.pillar.security/blog/gitpwned-allowlist-to-rce]
- **"Git directories do not have to be called .git" (Cursor):** `git init --separate-git-dir=.git-alt` plus `core.fsmonitor` = script. Cursor's unsandboxed git extension auto-ran `git status` → code execution. "The sandbox tried to protect a path spelling. Git was operating on a repository abstraction." [SOURCE https://www.pillar.security/blog/git-directories-do-not-have-to-be-called-git]
- **Others:** a venv interpreter replaced and later run by an IDE extension; a `.claude/settings.local.json` Stop hook run by Cursor (CVE-2026-48124); a `.vscode` task; the Docker socket.

Cross-cutting lessons:
1. **Any process that later reads agent-written files is part of the attack surface.** Orchestra's conductor runs `git status/diff/merge-tree` on worker output, so it is such a process. Git config keys like `core.fsmonitor`, `core.hooksPath`, `diff.external`, `core.sshCommand`, filter and merge drivers, and `include.path` are code-execution vectors (Pillar; inference for the list).
2. Allowlists must model arguments, not command names (GitPwned).
3. Path protections must follow git's repository model (gitdir pointers, separate git dirs, bare-repo layouts). Claude Code's sandbox already denies bare-repo layouts in cwd [DOCS]. Codex resolves `gitdir:` pointers [DOCS].
4. Path checks must be canonical and case-insensitive (InversePrompt, CVE-2025-59944).
5. Repo-supplied agent config (`.claude/`, `.mcp.json`, `.codex/`, `.gemini/`, `.agents/`, `.cursor/`, `.vscode/`) is executable.
   - Headless `claude -p` "shows no workspace trust dialog" and runs project hooks and `.mcp.json` servers "even in a folder you've never trusted" unless you pass `--setting-sources user`, `--bare` (which disables subscription OAuth: "bare mode doesn't use your subscription login"), or `--settings '{"disableAllHooks": true}'` [DOCS https://code.claude.com/docs/en/headless.md, https://code.claude.com/docs/en/permissions.md].
6. Model refusal is "probabilistic, not deterministic". Containment must assume compliance with injected instructions (Pillar).

---

## 7. Is Orchestra's ownership-enforcement idea novel?

- **As a shipped product feature: apparently yes.** None of the tools in section 1 plan per-task file ownership up front and enforce it in code at merge.
  - Claude Code agent teams: advisory [DOCS].
  - Orca: workers self-report `--files-modified` [DOCS].
  - Copilot: branch-level confinement only [DOCS].
  - CCC / agent-traffic-control: guard hooks against destructive git commands, and issue-claim protocols [SOURCE].
  - lcsmas/orchestra: a guard hook stopping *orchestrator* agents editing *children's* files. This is role-based, not a per-task ownership manifest checked at merge [SOURCE].
  - Practitioners do it by hand: "comparing each agent's declared scope vs its actual diff … before merging" [SECONDARY forum.cursor.com via search]. DZone proposes a `git diff --name-only` gate [SECONDARY].
- **As an idea: not new.** ATM (arXiv 2607.00041, 2026-06-29, single author) "binds task intent, repository scope, write admission, validation, and evidence obligations into one governance chain … Governed shared writes are ultimately applied by a neutral steward rather than directly by proposing agents" [SOURCE arXiv abstract]. That is close to Orchestra's conductor-as-steward. Cite it and differentiate: Orchestra works at file level, is cross-vendor, runs on subscription CLIs on Windows, and has user-approved start/finalize.
- **Name clash:** an "Orchestra" parallel-agent app already exists (lcsmas/orchestra, Apache-2.0, Electron, Linux-first) [SOURCE https://raw.githubusercontent.com/lcsmas/orchestra/master/README.md].
- Inference, a stronger variant only Orchestra could ship: use OS sandboxes to enforce ownership **at write time**. With MXC/AppContainer, grant read-write only on owned paths plus build-cache dirs and read-only elsewhere. Then post-hoc scope checks become a second layer instead of the only layer. New files need directory-level grants (a design wrinkle).

---

## 8. Implications for Orchestra

### 8.1 Copy
1. **Conductor does all git; workers never need to commit.** This mirrors Copilot ("cannot directly run `git push` or other Git commands") and fits Codex's read-only `.git` [DOCS]. Create worktrees in **detached HEAD** (Codex) to avoid branch-in-use errors. The conductor builds commits with `commit-tree` and publishes with CAS `update-ref`.
2. **`git worktree lock`** each worktree while a worker runs, plus a marker in worktree metadata (Claude Code) [DOCS]. Place worktrees outside other tools' managed roots (Cursor deletes anything under its root) and on a **short Windows path** (e.g. `C:\o\<id>`), with `core.longpaths=true`.
3. **`.worktreeinclude`-compatible** opt-in copying of ignored files (Claude, Codex, Conductor use it). Default to *not* copying secrets; show the list in the start dialog.
4. **Per-worker caps:** `--max-budget-usd` / `--max-turns` for Claude, wall-clock timeouts for all engines, a global concurrency cap, and a "no progress" guard (CLITrigger).
5. **Structured streams for live logs and token/cost:** Claude `stream-json`, `codex exec --json`, `agy --output-format stream-json`. Persist raw bytes for replay (CLITrigger). Keep an append-only audit log of conductor decisions (scope verdicts, merge CAS results).
6. **Merge queue discipline:** one-at-a-time CAS merges (Orchestra's plan), with optional validation on the merged tree before `update-ref` (ClaudeMix / Gas Town). Present conflicts from the conflicted toplevel tree as git docs advise. Optionally route a conflict back to the owning task's engine (Orchestrator.inc).
7. **Risk tagging** by diff size and out-of-scope attempts in the finalize dialog (CLITrigger, Copilot).
8. **Pre-merge security scan** of task output: secret scanning and new-dependency advisory checks (Copilot) [DOCS].

### 8.2 Pitfalls to avoid (concrete)
1. **Never let git execute worker-controlled config.** For every conductor git call:
   - Use explicit `--git-dir`/`--work-tree` (or `-C` to the main repo only).
   - Add `-c core.hooksPath=<empty dir>`, `-c core.fsmonitor=false`, `--no-ext-diff`, `--no-textconv`, `-c diff.external=`.
   - Run `merge-tree`/`commit-tree` against the main repo, not inside the worktree.
   - Verify each worktree's `.git` pointer file and `.git/worktrees/<id>/` contents are unchanged, and that no `config.worktree` was added.
   - Scan the worktree for any nested git metadata (`.git` files/dirs, `HEAD`+`objects`+`refs` trios, `--separate-git-dir` targets) before running any git in it (Pillar day 4, GitPwned).
   - `worktree add` runs `post-checkout` and `update-ref` runs `reference-transaction` [DOCS githooks], so decide explicitly whether user hooks run.
2. **Protected path set no task can own** (validated up front):
   - `.git*`, `.gitmodules`, `.gitattributes`
   - `.claude/`, `.mcp.json`, `.codex/`, `.agents/`, `.gemini/`, `.cursor/`, `.vscode/`, `.idea/`
   - `.worktreeinclude`, `.cursor/worktrees.json`, `.husky/`, `.github/workflows/`
   - venv interpreters, `.envrc`, `.npmrc`
   - Changes there need explicit user approval in the finalize dialog.
3. **Path comparison must be canonical and case-insensitive on Windows.** Reject symlinks/junctions in owned paths, compare full normalized paths (not prefixes), and handle `..` and `.` segments (CVE-2025-59944, CVE-2025-54794). [UNCLEAR, general Windows knowledge not verified here: also reject 8.3 short names, trailing dots/spaces and `::$DATA` alternate data streams.]
4. **Scope check beyond the worktree diff:**
   - Diff the main checkout, other worktrees, `~/.claude`, `~/.codex`, `~/.gemini` and global git config before and after each worker.
   - Reasons: absolute-path writes land in the parent checkout [SOURCE agent-traffic-control]; user-level settings hooks persist to the next run (CVE-2026-25725).
5. **Headless trust gap:** start Claude workers with `--setting-sources user --strict-mcp-config --settings '{"disableAllHooks":true}'` instead of `--bare`, because `--bare` drops subscription OAuth [DOCS]. Find equivalents for Codex (`--ignore-user-config` is about *user* config; [UNCLEAR] for project `.codex/`) and agy.
6. **Windows process lifetime:** run each worker in a Job Object, kill the tree before `git worktree remove`, retry removal, and don't delete the `.git` link first [SECONDARY]. Consider `-c checkout.workers=1` on Windows [SECONDARY reports].
7. **Don't share a Docker socket** with any worker (Pillar).
8. **Don't mix WSL git and Windows git** on the same worktrees, unless using `worktree.useRelativePaths` (Git ≥ 2.48, breaks older Git) [DOCS].
9. **Disable background git maintenance** during conductor runs (`-c gc.auto=0`, `maintenance.auto=false`) to avoid `index.lock` contention [SOURCE agent-traffic-control; config names are inference].
10. **Cross-vendor pairs conflict ~2x more** (41.7% vs 19.8%) [SECONDARY on arXiv 2607.04697]. This supports Orchestra's ownership plan; also make the planner avoid co-editing hot files such as lockfiles.
11. **Gemini engine on consumer subscriptions** is blocked or unsupported (section 0.4). Raise with the team owning engine/ToS research.

### 8.3 Windows sandbox options ranked (for wrapping a whole headless worker on Win11)
1. **MXC process container via `@microsoft/mxc-sdk` (Node).**
   - Pros: native AppContainer; no admin; FS read-only/read-write/deny and egress policy; learning mode to author policies; MIT; already used by Codex and Copilot CLI.
   - Requires: Win11 24H2/25H2 ≥ build 26100.9278 / 26200.9278 (Aug 2026 update).
   - Risks: very new (GA 2026-10-07); Required telemetry; Windows proxy enforcement relies on programs honouring proxy settings (Copilot doc); nesting with Codex's own MXC sandbox [UNCLEAR]. Each CLI needs RO access to its install, RW to its state dir (`~/.claude`, `~/.codex`) and egress to vendor APIs, which conflicts with protecting those config dirs. That needs testing.
2. **Each engine's own native sandbox as an inner layer.** Codex `mxc`/`elevated`; agy AppContainer (same OS requirement); Gemini low-IL (weak). Uneven, and Claude Code has **none** on native Windows. Use as defence in depth, not as the boundary.
3. **WSL2 + bubblewrap** (Claude sandbox / `srt claude`, Codex bwrap). Mature primitives, but CLIs must be installed and logged in inside WSL, there are cross-FS performance costs, and git path and line-ending mixing risks.
4. **MXC session container / dedicated low-privilege Windows user** (like Codex `elevated`). Strong ACL and firewall separation; needs admin setup and a newer build (≥ 26100.9550); the user profile must be logged into each CLI.
5. **Docker Desktop / dev container.** Strong, but heavy; Linux toolchain only; credential mounting; never mount the docker socket; licence terms [UNCLEAR].
6. **Windows Sandbox (Hyper-V VM).** Strongest boundary but impractical: Pro+ only, no process I/O from `wsb exec`, fresh install each launch.
7. **Low-integrity process (icacls Low IL).** Blocks writes only; secrets stay readable; no network control; persistent labels.

---

## 9. Open questions
1. Can an MXC process container wrap `claude.exe`/`codex.exe`/`agy.exe` end-to-end on a subscription login? Credential storage locations on Windows (file vs Credential Manager) and vendor API egress through MXC's proxy are untested [UNCLEAR].
2. Does Codex's own MXC sandbox work when Codex itself runs inside an MXC/AppContainer (nested containment)? [UNCLEAR]
3. For Codex `workspace-write` inside a linked worktree: do `git status`/`git diff` still work with a read-only gitdir (index refresh lock)? Inference says the conductor should do all git, but worker-side git reads need a test [UNCLEAR].
4. Which project-local config does `codex exec` and `agy -p` load in an untrusted worktree, and how is it disabled (Claude equivalent: `--setting-sources user`)? [UNCLEAR]
5. Is per-file read-write granting in MXC practical for write-time ownership enforcement? Concerns: new files, build caches, policy size limits [UNCLEAR].
6. Claude Code native Windows sandbox via MXC is "upcoming": timeline unknown [UNCLEAR].
7. Exact behaviour of Git for Windows `checkout.workers` vs `core.fscache` races (issues only seen as mirrored titles) [UNCLEAR].
8. Antigravity/Gemini consumer-plan policy: the FAQ says wrapping is "not supported"; is it a ToS violation or just unsupported? (Another FAQ entry calls third-party access to Antigravity login a ToS violation.) [DOCS https://antigravity.google/docs/faq.md; interpretation UNCLEAR]
9. Whether Antigravity 2.0 auto-provisions per-subagent worktrees (single secondary source) [UNCLEAR].
10. Licence and Windows status for container-use, Vibe Kanban (community edition), Nimbalyst and webmux were only partly verified.
