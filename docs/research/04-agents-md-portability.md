# D: AGENTS.md, Agent Skills, and making one set of project rules work across Claude Code, Codex, Gemini CLI and Antigravity

Researcher D. All pages fetched on 2026-11-19 unless a date is given.
Labels: [DOCS url] official docs; [SOURCE url] source code or repo content; [PAPER url] arXiv paper; [SECONDARY url] blog/news; [UNCLEAR] not verified, or my inference. Quotes are short and exact.

---

## 1. The AGENTS.md standard

### 1.1 What the "spec" is
- No versioned specification document exists. The "spec" is the agents.md website plus its FAQ. The `agentsmd/agents.md` repo holds the Next.js site, a README, and (since 2026-09-10) a Technical Charter PDF. The 2026 commits only add tools to the compatibility list, update logos, and add the charter. There were no format changes. [SOURCE https://github.com/agentsmd/agents.md, git log checked 2026-11-19]
- Format: "AGENTS.md is just standard Markdown. Use any headings you like; the agent simply parses the text you provide." There are no required fields and no frontmatter. [DOCS https://agents.md]
- Purpose: "a README for agents: a dedicated, predictable place to provide the context and instructions to help AI coding agents work on your project." [DOCS https://agents.md]
- Recommended sections ("Popular choices"): Project overview; Build and test commands; Code style guidelines; Testing instructions; Security considerations. Also: "Commit messages or pull request guidelines, security gotchas, large datasets, deployment steps: anything you'd tell a new teammate belongs here too." [DOCS https://agents.md]
- Nesting and precedence (from the site):
  - "Large monorepo? Use nested AGENTS.md files for subprojects ... Agents automatically read the nearest file in the directory tree, so the closest one takes precedence ... the main OpenAI repo has 88 AGENTS.md files."
  - FAQ: "What if instructions conflict? The closest AGENTS.md to the edited file wins; explicit user chat prompts override everything."
  - [DOCS https://agents.md]
- Commands: "Will the agent run testing commands found in AGENTS.md automatically? Yes—if you list them." [DOCS https://agents.md]
- Migration advice on the site: "Rename existing files to AGENTS.md and create symbolic links for backward compatibility: `mv AGENT.md AGENTS.md && ln -s AGENTS.md AGENT.md`". Symlinks break on Windows; see §2.5. [DOCS https://agents.md]
- Adoption claim: "used by over 60k open-source projects". [DOCS https://agents.md]
- The most precise operational statement of scope and precedence is in Codex's base system prompt, not on the website [SOURCE https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md]:
  - "The scope of an AGENTS.md file is the entire directory tree rooted at the folder that contains it."
  - "For every file you touch in the final patch, you must obey instructions in any AGENTS.md file whose scope includes that file."
  - "More-deeply-nested AGENTS.md files take precedence in the case of conflicting instructions."
  - "Direct system/developer/user instructions (as part of a prompt) take precedence over AGENTS.md instructions."
  - "The contents of the AGENTS.md file at the root of the repo and any directories from the CWD up to the root are included with the developer message ... When working in a subdirectory of CWD, or a directory outside the CWD, check for any AGENTS.md files that may be applicable."

### 1.2 Governance
- 2025-08: OpenAI released AGENTS.md. The site says it "emerged from collaborative efforts across the AI software development ecosystem, including OpenAI Codex, Amp, Jules from Google, Cursor, and Factory." [DOCS https://agents.md] [SECONDARY https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation]
- 2025-12-09: The Linux Foundation formed the **Agentic AI Foundation (AAIF)**. Its founding contributions were "Anthropic's Model Context Protocol (MCP), Block's goose, and OpenAI's AGENTS.md". [DOCS https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation]
- The site footer reads: "AGENTS.md is now stewarded by the Agentic AI Foundation under the Linux Foundation." and "Copyright © AGENTS.md a Series of LF Projects, LLC". [DOCS https://agents.md]
- Technical Charter "Adopted December 8, 2025", committed to the repo 2026-09-10. It defines a TSC of Core Maintainers plus a Lead Core Maintainer. Membership is "held by individuals, not companies". Mission: "develop a simple, open format for guiding AI coding agents." [SOURCE https://github.com/agentsmd/agents.md/blob/main/Technical_Charter.pdf]
- The AAIF projects page (2026-11-19) lists Agent Router, **Agent Skills**, Agent2Agent, **AGENTS.md**, agentgateway, Goose, MCP, Open Responses, OpenEnv and OpenSandbox. [DOCS https://aaif.io/]
- 2026 updates relevant to us:
  - (a) Compatibility-list additions: Augment Code and Junie (2026-03-10), plus a Gemini CLI instructions update (2026-03-10). [SOURCE agentsmd repo git log]
  - (b) The charter was published (2026-09-10). [SOURCE agentsmd repo git log]
  - (c) An AAIF blog post on writing an effective AGENTS.md (2026-08-13). [DOCS https://aaif.io/blog/writing-an-effective-agents-md]
  - (d) Claude Code added native AGENTS.md reading (v2.1.277+; see §2.1). [DOCS https://code.claude.com/docs/en/memory]
  - (e) Agent Skills moved to the AAIF / LF Projects. "AAIF welcomed Agent Skills in October" 2026, and its GOVERNANCE.md was "Adopted November 4, 2026". [DOCS https://aaif.io/blog/how-to-move-a-skill-from-one-coding-agent-to-another] [SOURCE https://github.com/agentskills/agentskills/blob/main/GOVERNANCE.md]

### 1.3 Which tools support it (evidence)
The agents.md compatibility list (`components/CompatibilitySection.tsx`, 2026-11-19) names: Codex, Amp, Jules, Cursor, Factory, RooCode, Aider, Gemini CLI, goose, Kilo Code, opencode, Phoenix, Zed, Semgrep, Warp, GitHub Copilot coding agent, VS Code, Ona, Devin, Windsurf, UiPath Autopilot & Coded Agents, Augment Code and Junie. **Claude Code and Antigravity are not on the list**, although both now read AGENTS.md (see below). [SOURCE https://github.com/agentsmd/agents.md/blob/main/components/CompatibilitySection.tsx]

Per-tool evidence (details in the matrix in §2.7):
- **Codex**: native. Reads one file per directory, `AGENTS.override.md` > `AGENTS.md` > fallbacks, walking from the project root down to cwd. [DOCS https://developers.openai.com/codex/guides/agents-md]
- **Claude Code**: native since **v2.1.277**, through a built-in plugin `cc-plugin-agents-md@builtin` (named `agents-md@builtin` before v2.1.285). By default it reads AGENTS.md **only when there is no CLAUDE.md / .claude/CLAUDE.md / CLAUDE.local.md in cwd or above**. [DOCS https://code.claude.com/docs/en/memory#agents-md]
- **Gemini CLI**: not by default. `DEFAULT_CONTEXT_FILENAME = 'GEMINI.md'` [SOURCE https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/memoryTool.ts, HEAD acfb42d 2026-11-19]. Configure `"context": {"fileName": ["AGENTS.md", ...]}`. [DOCS https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md] [DOCS https://agents.md FAQ]
- **Antigravity** (App, CLI `agy`, IDE): native. "You can place an `AGENTS.md` or `GEMINI.md` file—or a `.agents/rules/` directory—in your workspace folder and in any parent folder up to the repository root." [DOCS https://antigravity.google/docs/rules]
- **GitHub Copilot** (cloud/coding agent): "You can create one or more `AGENTS.md` files ... the nearest `AGENTS.md` file in the directory tree will take precedence ... Alternatively, you can use a single `CLAUDE.md` or `GEMINI.md` file stored in the root of the repository." [DOCS https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions]
- **Cursor**: "Cursor supports AGENTS.md in the project root and subdirectories ... Nested AGENTS.md support". [DOCS https://cursor.com/docs/context/rules]
- **Jules**: "Jules now automatically looks for a file named AGENTS.md in the root of your repository". [DOCS https://jules.google/docs/]
- **Amp**: AGENTS.md "in cwd, parent dirs, & subtrees". "Subtree `AGENTS.md` files are included when the agent reads a file in the subtree." Fallback: "If no `AGENTS.md` exists in a directory, but a file named `AGENT.md` ... or `CLAUDE.md` does exist, that file will be included." Globals: `$HOME/.config/amp/AGENTS.md`, `$HOME/.config/AGENTS.md`, `%ProgramData%\ampcode\AGENTS.md`. [DOCS https://ampcode.com/docs/markdown/customize/agents-md]
- **Aider**: not automatic. Use `.aider.conf.yml` `read: AGENTS.md`. [DOCS https://agents.md FAQ] [DOCS https://aider.chat/docs/usage/conventions.html]
- **Zed** (built-in Zed Agent): "Zed supports AGENTS.md as the primary instruction file". The project uses "the first matching file in this list": `.rules`, ... `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`. "Project instructions override personal `AGENTS.md` when they conflict." Personal file: `~/.config/zed/AGENTS.md` (Windows `%APPDATA%\Zed\AGENTS.md`). External agents read their own files. [DOCS https://zed.dev/docs/ai/instructions]
- **Windsurf** (Cognition): "The simplest way to add rules is an AGENTS.md file at your project root ... The agent reads them at the workspace root and in each directory between the workspace root and the directory it is working in". [DOCS https://docs.windsurf.com/windsurf/cascade/agents-md]
- **OpenCode**: "OpenCode loads the global file followed by every AGENTS.md from the current workspace directory toward the home directory". It has a CLAUDE.md fallback. [DOCS https://opencode.ai/docs/rules/]
- **VS Code, Junie, Devin, Factory, goose, Warp, etc.**: only on the agents.md compatibility list; I did not verify each vendor page. [SOURCE agentsmd CompatibilitySection.tsx]

---

## 2. Native filename per tool, and making one file serve all

### 2.1 Claude Code
- Native files are CLAUDE.md files, loaded in this order (broad to specific): managed policy (`C:\Program Files\ClaudeCode\CLAUDE.md` on Windows), `~/.claude/CLAUDE.md`, `./CLAUDE.md` or `./.claude/CLAUDE.md`, then `./CLAUDE.local.md` (personal, should be gitignored). [DOCS https://code.claude.com/docs/en/memory]
- Ancestor walk: "Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from your current working directory and every directory above it." "All discovered files are concatenated into context rather than overriding each other." Subdirectory files load on demand when Claude reads, writes or edits a file there. [DOCS https://code.claude.com/docs/en/memory]
  - [UNCLEAR, inferred] The walk does not stop at the git root (the SDK docs say "`<cwd>` and every parent directory for CLAUDE.md"). A worker started in a worktree nested inside the main checkout would therefore also load the main checkout's CLAUDE.md and CLAUDE.local.md. [DOCS https://code.claude.com/docs/en/agent-sdk/claude-code-features]
- AGENTS.md (native since v2.1.277) [DOCS https://code.claude.com/docs/en/memory#agents-md]:
  - Default `claude-md-or-agents-md`: "Claude reads `AGENTS.md` only when you have no `CLAUDE.md` in your working directory or above it."
    - "Count, so Claude reads them instead of `AGENTS.md`: a `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md`". Files that don't count: `~/.claude/CLAUDE.md`, managed CLAUDE.md, `.claude/rules/`.
  - **Pitfall**: "Because `CLAUDE.local.md` counts, adding one ... in a project that relies on `AGENTS.md` stops Claude from reading `AGENTS.md` for you."
  - Other modes: `claude-md-and-agents-md` (both; "skips an `AGENTS.md` it has already loaded"), `claude-md`, `managed-only`.
  - Setting it: `/config` ("Project instructions"), or `pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles`. "Claude Code reads the entry from `~/.claude/settings.json`, a `--settings` file, or managed settings, and ignores it in project and local settings files."
  - Not read: "`AGENTS.local.md`, `AGENTS.override.md`, or anything under a `.agents/` directory".
  - Subdirectory AGENTS.md loads "when Claude opens a file there with the Read tool and that subdirectory has none of the three CLAUDE.md files of its own".
  - Native AGENTS.md is unavailable before v2.1.277, if the built-in plugin is disabled, or "In some cases, it's your first session after you upgrade from v2.1.276 or earlier". Before v2.1.281 it was also unavailable on Bedrock or with telemetry disabled.
  - Differences from CLAUDE.md: `InstructionsLoaded` hooks don't fire; not loaded from `--add-dir` dirs; external `@` imports load only if already approved.
- Recommended one-file pattern from Anthropic: a `CLAUDE.md` that starts with `@AGENTS.md`, with Claude-only notes below it. "Keeping the import never makes Claude read `AGENTS.md` twice". The symlink `ln -s AGENTS.md CLAUDE.md` "also works", but for Windows: "use the `@AGENTS.md` import instead. Creating a symlink there needs Administrator privileges or Developer Mode, and Git checks a committed symlink out as a plain text file unless `core.symlinks` is enabled, which leaves that clone with a one-line `CLAUDE.md` in place of your instructions". [DOCS https://code.claude.com/docs/en/memory#share-one-file-with-other-coding-tools]
- A CLAUDE.md that tells Claude in words to read AGENTS.md is weak: "Claude sees `AGENTS.md` only if it decides to open the file." [DOCS same page]
- Imports: `@path` works with relative or absolute paths and a maximum depth of four hops. Imports inside code spans are skipped. External imports trigger a one-time approval dialog. [DOCS same page]

### 2.2 Codex
- Global: `~/.codex/AGENTS.override.md`, otherwise `~/.codex/AGENTS.md` ("Codex uses only the first non-empty file at this level"). The home can be changed with `CODEX_HOME`. [DOCS https://developers.openai.com/codex/guides/agents-md]
- Project: "Starting at the project root (typically the Git root), Codex walks down to your current working directory ... In each directory along the path, it checks for `AGENTS.override.md`, then `AGENTS.md`, then any fallback names in `project_doc_fallback_filenames`. Codex includes at most one file per directory." Merge order is root first, so later files win. [DOCS same]
- Cap: `project_doc_max_bytes` defaults to **32 KiB combined**: "stops adding files once the combined size reaches the limit". [DOCS same] [SOURCE codex-rs/core/src/config/mod.rs `AGENTS_MD_MAX_BYTES ... // 32 KiB`]
- Fallbacks: `project_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md"]` in `~/.codex/config.toml`. Per-run override works too: the docs show `codex -c log_dir=...`, so `-c project_doc_fallback_filenames=[...]` should work. [DOCS same] [UNCLEAR: not tested with `codex exec`]
  - The default fallback list is empty, so **Codex does not read CLAUDE.md by default**. [SOURCE codex-rs/core/src/config/mod.rs `.unwrap_or_default()`]
- Project root markers: default `.git`; "We do **not** walk past the project root". [SOURCE https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs]
  - A worktree's `.git` is a file. [UNCLEAR] Whether the marker check accepts a file needs a test. Gemini's equivalent explicitly accepts "File or directory names".
- Nested files **below cwd** are not auto-loaded. The system prompt tells the model to "check for any AGENTS.md files that may be applicable". [SOURCE base_instructions/default.md]
- Codex source contains an `external-agent-migration` crate that rewrites Claude-style docs to `AGENTS.md` and imports commands, marketplaces and hooks. I found no user docs for it. [SOURCE https://github.com/openai/codex/tree/main/codex-rs/external-agent-migration] [UNCLEAR how it is exposed]

### 2.3 Gemini CLI
- Default file `GEMINI.md`. Hierarchy: global `~/.gemini/<configured-context-filename>`; then cwd and parents "up to either the project root (identified by a `.git` folder) or your home directory"; then subdirectories (≤200 dirs, `context.discoveryMaxDirs`); plus JIT loading "When a tool accesses a file or directory". [DOCS https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md] [DOCS https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md]
- `context.memoryBoundaryMarkers` default `[".git"]`: "File or directory names that mark the boundary". A worktree's `.git` file therefore should stop the walk. [DOCS configuration.md]
- Point it at AGENTS.md: `{"context": {"fileName": ["AGENTS.md", "CONTEXT.md", "GEMINI.md"]}}`. Precedence of settings files: system-defaults < user `~/.gemini/settings.json` < project `.gemini/settings.json` < system settings. Two env vars move the system files: `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` and `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. `GEMINI_CLI_HOME` moves the user config root. [DOCS configuration.md]
- Concatenation: "Content from files lower in this list (more specific) typically overrides or supplements content from files higher up". [DOCS configuration.md]
- Trust: when folder trust is enabled, an untrusted folder ignores `.gemini/settings.json`. Headless runs then exit with `FatalUntrustedWorkspaceError` unless `--skip-trust` or `GEMINI_CLI_TRUST_WORKSPACE=true` is set. Every fresh worktree path is a new folder. Folder trust is "disabled by default". [DOCS https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/trusted-folders.md]

### 2.4 Antigravity (App, CLI `agy`, IDE)
- Reads **both AGENTS.md and GEMINI.md** natively. At each level it reads `<dir>/AGENTS.md` or `<dir>/GEMINI.md`, `<dir>/.agents/AGENTS.md|GEMINI.md`, and `<dir>/.agents/rules/*.md` (legacy `.agent/rules/`), for the workspace folder and its parents up to the repo root. [DOCS https://antigravity.google/docs/rules]
- **Does not load subfolders**: "Antigravity doesn't load rules from subfolders below the workspace folder, even when the agent reads or edits files there." This differs from "closest file wins". [DOCS same] [DOCS https://antigravity.google/docs/customization-discovery]
- Rules are cumulative: "Rules don't replace each other: Antigravity loads every rule it finds." [DOCS customization-discovery]
- Globals: `~/.gemini/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.gemini/config/AGENTS.md|GEMINI.md`, and `~/.gemini/config/rules/*.md` (frontmatter required). [DOCS rules]
  - `~/.gemini/GEMINI.md` is shared with Gemini CLI's global file.
- Limits: a "24 KB (24,000 bytes) per-file limit" (truncates) and a "20,000-token aggregate rules budget" (demotes the largest files to pointers). [DOCS rules]
- Does not read CLAUDE.md, according to the docs. [DOCS rules; absence]
- Includes: `@[label](path)` inlines a file; `@filename` only rewrites it to an absolute reference. [DOCS rules]

### 2.5 Windows caveats for symlinks
- Git for Windows: "the closest thing is unavailable for non-admins by default unless Developer Mode is enabled ... symlink emulation support is only turned on by default when that scenario is detected." Creating symlinks needs `SeCreateSymbolicLinkPrivilege` (Administrators plus UAC). Developer Mode (Win10 1703+) removes the elevation need. NTFS/ReFS only, not FAT/exFAT. "By default, the `ln -s` command in Git Bash does **not** create symbolic links. Instead, it creates copies." Directory junctions (`mklink /j`) need no admin rights but apply to directories only. [DOCS https://gitforwindows.org/symbolic-links]
- `core.symlinks`: "If false, symbolic links are checked out as small plain files that contain the link text ... git-clone or git-init will probe and set core.symlinks false if appropriate". [DOCS https://git-scm.com/docs/git-config#Documentation/git-config.txt-coresymlinks]
- Real effect: `apache/airflow`, `pydantic/pydantic-ai` and `openai/openai-agents-python` commit `CLAUDE.md` as mode `120000` (symlink) pointing to `AGENTS.md`; the blob is the 9 bytes `AGENTS.md`. [SOURCE `git ls-tree HEAD` on each repo, 2026-11-19]
  - On a Windows clone with `core.symlinks=false`, `CLAUDE.md` becomes a 9-byte text file. Claude Code then (a) sees a CLAUDE.md, so it **does not** natively read AGENTS.md, and (b) gets only the word "AGENTS.md". The rules are silently lost. Anthropic's docs confirm this outcome ("a one-line `CLAUDE.md` in place of your instructions"). [DOCS memory]
  - Git worktrees use the repo's `core.symlinks` setting, so every Orchestra worktree has the same problem. [UNCLEAR: standard git behaviour, not tested here]

### 2.6 What real multi-tool repos do (sample of well-known repos, 2026-11-19)
| Pattern | Examples |
|---|---|
| AGENTS.md only | microsoft/vscode (485 B, points to Copilot instructions), cloudflare/agents, vercel/ai, langchain-ai/langchain, astral-sh/uv, rails/rails, ipfs/kubo (31,369 B), Azure/azure-sdk-for-go, temporalio/sdk-java |
| CLAUDE.md symlink → AGENTS.md | apache/airflow (AGENTS.md 24,390 B), pydantic/pydantic-ai, openai/openai-agents-python |
| CLAUDE.md = `@AGENTS.md` | getsentry/sentry, WordPress/gutenberg |
| GEMINI.md only | google-gemini/gemini-cli |

[SOURCE raw.githubusercontent.com fetches]

- Census of 22,854 repos: "where both files exist, 'CLAUDE.md' usually points to 'AGENTS.md'". Agent instructions appear in 26.3% of repos (59.6% of the most-starred). [PAPER https://arxiv.org/abs/2610.31715]
- In 1,000 repos, "42.2% of instruction-bearing repositories in the higher-popularity cohort maintain multiple formats". Of 386 matched section pairs, "16.1% provide divergent guidance". **Multi-file drift is real.** [PAPER https://arxiv.org/abs/2611.02383]
- Generator tools exist that emit per-tool files from one source: ruler (`@intellectronica/ruler`), rulesync. [SOURCE https://github.com/intellectronica/ruler] [SOURCE https://github.com/dyoshikawa/rulesync]
- Size cross-check: kubo's 31,369-byte AGENTS.md and airflow's 24,390-byte one both exceed Antigravity's 24,000-byte per-file truncation. Kubo's is also close to Codex's 32 KiB combined cap. **The same file is truncated differently per engine.** [inference from the sizes above plus [DOCS] limits]

### 2.7 Support matrix (as of 2026-11-19)

| Tool | Native instruction file(s) | Reads AGENTS.md? | How to point it at AGENTS.md | Nested / precedence | Agent Skills support and locations | Evidence |
|---|---|---|---|---|---|---|
| **Claude Code** | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/*.md`; user `~/.claude/CLAUDE.md` | **Yes, since v2.1.277**, but only if no CLAUDE.md or CLAUDE.local.md exists in cwd or above (default mode) | Commit `CLAUDE.md` containing `@AGENTS.md` (Windows-safe). Or per-run `--settings` with `pluginConfigs."cc-plugin-agents-md@builtin".options.instructionFiles="claude-md-and-agents-md"`. Or `--append-system-prompt-file`. Avoid committed symlinks on Windows | Concatenates; ancestors at launch; subdirs on demand; "no hard precedence rule between levels" | Yes (spec + extensions). `~/.claude/skills/<n>/SKILL.md`, `.claude/skills/`, nested, plugins. **Does not scan `.agents/skills`**. `/name` slash command | [DOCS code.claude.com/docs/en/memory], [DOCS code.claude.com/docs/en/skills] |
| **Codex CLI** | `AGENTS.md`, `AGENTS.override.md`; global `~/.codex/AGENTS(.override).md` | **Yes** (native) | Native. For CLAUDE.md-only repos: `project_doc_fallback_filenames=["CLAUDE.md"]` (config or `-c`). Raise `project_doc_max_bytes` if the chain is over 32 KiB | Root→cwd, one file per dir, later wins; below-cwd files only if the model opens them; prompt > AGENTS.md | Yes. `.agents/skills` from cwd up to repo root, `~/.agents/skills`, `/etc/codex/skills`, system. Source also scans `$CODEX_HOME/skills` (`~/.codex/skills`). Invoke `$name` or `/skills`; implicit by description | [DOCS developers.openai.com/codex/guides/agents-md], [DOCS learn.chatgpt.com/docs/build-skills], [SOURCE codex-rs/exec-server/src/discoverV2/capability_locations.rs] |
| **Gemini CLI** | `GEMINI.md` (global `~/.gemini/GEMINI.md`) | **Not by default** | `context.fileName: ["AGENTS.md","GEMINI.md"]` in user/project/system settings, or a per-process `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` file | Global → ancestors to `.git` → subdirs (≤200) → JIT; concatenated, more specific "typically overrides" | Yes. `~/.gemini/skills`, `~/.agents/skills`, `.gemini/skills`, `.agents/skills` (`.agents` wins in the same tier). Activation via `activate_skill` with a consent prompt. Custom slash commands are `.toml` in `~/.gemini/commands/` | [SOURCE memoryTool.ts], [DOCS gemini-cli docs/cli/gemini-md.md, skills.md, custom-commands.md] |
| **Antigravity** (App/CLI/IDE) | `AGENTS.md`, `GEMINI.md`, `.agents/rules/*.md` (frontmatter `trigger`); globals `~/.gemini/{AGENTS,GEMINI}.md`, `~/.gemini/config/...` | **Yes** (native) | Native. Does not read CLAUDE.md | Workspace and parents to repo root; **no subfolders below workspace**; cumulative; 24 KB/file, 20k-token budget | Yes ("open standard"). `.agents/skills/` (also in parents to repo root), `~/.gemini/config/skills/`. CLI also reads `~/.gemini/skills/` and `~/.gemini/antigravity-cli/skills/`. Skills become `/name` | [DOCS antigravity.google/docs/rules, /skills, /customization-discovery] |
| **GitHub Copilot** (cloud agent) | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` | **Yes**, nearest AGENTS.md wins; or a single root CLAUDE.md / GEMINI.md | Native | Nearest wins | Yes (showcase). Docs: about-agent-skills | [DOCS docs.github.com add-repository-instructions], [SOURCE agentskills clients.jsx] |
| **Cursor** | `.cursor/rules` | **Yes**, root and nested | Native | Nested applies to the dir subtree | Yes (showcase; cursor.com/docs/context/skills) | [DOCS cursor.com/docs/context/rules] |
| **Jules** | AGENTS.md | Yes (root) | Native | Root only (documented) | Not in showcase | [DOCS jules.google/docs] |
| **Amp** | AGENTS.md (fallback AGENT.md, CLAUDE.md) | Yes | Native | cwd + parents + subtrees on read | Yes (showcase) | [DOCS ampcode.com/docs/markdown/customize/agents-md] |
| **Aider** | conventions file via `--read` | Only if configured | `.aider.conf.yml`: `read: AGENTS.md` | n/a | Not in showcase | [DOCS agents.md FAQ, aider.chat conventions] |
| **Zed** (Zed Agent) | first match: `.rules` ... `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`; personal `~/.config/zed/AGENTS.md` | Yes | Native (but `.rules` etc. shadow it) | Project overrides personal | Not verified | [DOCS zed.dev/docs/ai/instructions] |
| **Windsurf** | AGENTS.md + rule files | Yes | Native | root + dirs between root and working dir | Docs have a Skills section (locations not verified) | [DOCS docs.windsurf.com/windsurf/cascade/agents-md] |
| **OpenCode** | AGENTS.md (CLAUDE.md fallback) | Yes | Native | global, then cwd up to home | Yes (showcase) | [DOCS opencode.ai/docs/rules] |

---

## 3. Evidence on what makes instruction files effective

### 3.1 Empirical studies (arXiv, 2025–2026)
**Do they help task success? The results are mixed, leaning to "not much, and they cost tokens".**
- Gloaguen et al., "Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?" (2026-02-12, v3 2026-09-29; ICLR 2026). "providing context files does not generally improve task success rates, while increasing inference cost by over 20% on average ... while instructions in the context files are well followed by coding agents, repository overviews ... are not helpful." Context files are "useful for specifying non-standard coding practices". [PAPER https://arxiv.org/abs/2602.11988]
  - The AAIF summary adds: developer-written files significantly outperform LLM-generated ones. In repos stripped of other documentation, LLM-generated files improved success by 2.7%. [SECONDARY https://aaif.io/blog/writing-an-effective-agents-md]
- Lulla et al. (2026-01-28): with AGENTS.md, "lower median runtime (Δ28.64%) and reduced output token consumption (Δ16.58%), while maintaining a comparable task completion behavior". 10 repos, 124 PRs. [PAPER https://arxiv.org/abs/2601.20404]
- "Do Context Files Help Coding Agents? A Two-Agent Ablation" (2026-07-28). Claude Code and Codex, 288 runs: "Context strategy does not measurably move correctness on either agent (bounded to <=10-15pp)". Agents fail on implementation skill rather than missing repo knowledge. [PAPER https://arxiv.org/abs/2607.27250]
- "Probe-and-Refine Tuning of Repository Guidance" (2026-06-18). How guidance is produced is decisive: tuned guidance reached 33.0% vs 28.3% (static) vs 25.5% (none) on SWE-bench Verified with a small open model. The gain comes from coverage (reaching the right file), not patch precision. [PAPER https://arxiv.org/abs/2606.20512]
- "Guardrails Beat Guidance" (2026-04-13; 679 rule files, 5,000+ Claude Code runs). "every individually beneficial rule is a negative constraint ('do not refactor unrelated code'), while every individually harmful one is a positive directive ('follow code style')". Gains are "largely content-independent" (context priming). Pass rates stay stable from 0 to 50 rules. [PAPER https://arxiv.org/abs/2604.11088]

**Do agents follow them?**
- "Do They Do as They Are Told?" (2026-11-10): agents follow guidance "more often than not, but adherence splits sharply between instructions followed consistently and those never respected". [PAPER https://arxiv.org/abs/2611.13709]
- "Do Coding Agents Follow AGENTS.md? The Effect of Policy Wording" (2026-11-03): "Conditional phrasing was followed less often than Prescriptive and Explanatory." [PAPER https://arxiv.org/abs/2611.04367]
- Factorial study (2026-05-11; 1,650 Claude Code sessions): file size, instruction position, file architecture and adjacent-file contradictions showed **no detectable effect**. Compliance drops within a session, "approximately 5.6% lower odds of compliance per step". [PAPER https://arxiv.org/abs/2605.10039]
- ContextCov (2026-02-28): turning AGENTS.md constraints into executable checks (AST queries, shell shims, architecture validators) gave 88.3% compliance vs 67.0% prompt-only. [PAPER https://arxiv.org/abs/2603.00822]

**How developers write and maintain them**
- 253 CLAUDE.md files: shallow hierarchy, mostly "operational commands, technical implementation notes, and high-level architecture". [PAPER https://arxiv.org/abs/2509.14744]
- 2,303 files: "evolve like configuration code through frequent, small additions". Test procedures 75.9%, implementation 70.8%, architecture 68.1%, security 14.8%, performance 14.5%. [PAPER https://arxiv.org/abs/2511.12884]
- 466 OSS projects: "no established content structure yet"; styles vary (descriptive, prescriptive, prohibitive, explanatory, conditional). [PAPER https://arxiv.org/abs/2510.21413]
- Census, 341,852 statements: "74.0% of directives give no reason". A third show generator signatures. [PAPER https://arxiv.org/abs/2610.31715]
- "Why Does CLAUDE.md Keep Growing?": files grow "+226%" over their lifetime, "+4.9 net instructions every commit". Old instructions are rarely deleted. [PAPER https://arxiv.org/abs/2608.11095]
- Cursor rules taxonomy: Conventions, Guidelines, Project Information, LLM Directives, Examples. [PAPER https://arxiv.org/abs/2512.18925]
- Evidence-based template (1,000 repos, 3,387 files): 40.4% of files were modified only once; 16.1% of cross-format section pairs diverge. [PAPER https://arxiv.org/abs/2611.02383]

### 3.2 Vendor guidance
- **Anthropic** [DOCS https://code.claude.com/docs/en/memory] [DOCS https://code.claude.com/docs/en/best-practices]:
  - "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence."
  - Write instructions "concrete enough to verify", e.g. "Run `npm test` before committing".
  - Structure with headers and bullets.
  - "if two instructions contradict each other, Claude may pick one arbitrarily".
  - Imports "don't reduce its context cost".
  - Keep only what Claude couldn't work out from the code: exact test, typecheck and lint commands; misleading places; decisions not in the repo; "Anything you've had to correct twice already".
  - "If something has to happen every time, make it a hook, a deny rule, or a managed setting. `CLAUDE.md` is for guidelines".
  - `/doctor prompt-audit` finds stale or conflicting instructions (v2.1.283+).
  - Multi-step procedures belong in skills or path-scoped rules.
- **AAIF** "Writing an effective AGENTS.md" (2026-08-13) [DOCS https://aaif.io/blog/writing-an-effective-agents-md]:
  - "For each instruction, ask whether knowing it would change what the agent does."
  - Name exact commands and protected paths; define "done" (which validation scales with which change).
  - Avoid repository overviews and generic advice.
  - "avoid creating two sources of repository guidance that can quietly disagree".
  - Enforce with formatters and static checks; no secrets.
  - Nested files are useful at real boundaries. "test the behavior of the agents it relies on rather than assume every tool handles the hierarchy identically."
- **OpenAI**: layer a global file plus repo root plus nested overrides; keep code-review rules "concise"; raise the byte cap or split files when truncated. [DOCS https://developers.openai.com/codex/guides/agents-md]
- **GitHub** analysis of 2,500+ agents.md files: specifics, executable commands, examples and clear boundaries work. [SECONDARY https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/] [UNCLEAR: full article not read]
- **Antigravity**: rule = "constraints and invariants"; skill = "multi-step workflows". [DOCS https://antigravity.google/docs/rules]

### 3.3 Known failure modes
- **Bloat / context rot**:
  - "Context Bloat" in 42% of 100 popular repos. "Lint Leakage" (style rules a linter should enforce) in 62%. "Skill Leakage" in 35%. Bloat, Skill Leakage and Conflicting Instructions often co-occur. [PAPER https://arxiv.org/abs/2606.15828]
  - Unbounded growth. [PAPER 2608.11095]
- **Stale commands and paths**:
  - A README/wiki checker found stale code references in 23.0% of 356 repos. [PAPER https://arxiv.org/abs/2606.09090]
  - "agents follow stale guidance when it is relevant ... none repaired the underlying instruction file". [PAPER https://arxiv.org/abs/2611.09802]
  - "Without the sentence, 90.1% of the agents' choices followed the stale file". One sentence in the user-level file giving existing code precedence raised code-following from 4.2% to 91.4%. Codex rewrote existing code to match the stale file in 20/80 runs, and tests failed in 17. [PAPER https://arxiv.org/abs/2610.30571]
  - Drift was the largest failure class (48/118) in a six-week case study. Rules outlive the failures they were written for. [PAPER https://arxiv.org/abs/2610.32578]
- **Conflicting instructions**: Claude "may pick one arbitrarily" [DOCS memory]. 16.1% cross-format divergence [PAPER 2611.02383].
- **Unreviewed changes**: ">70% of instruction-file changes receive no substantive review". AI reviewers recovered only 1.3–3.9% of the concerns humans raised. [PAPER https://arxiv.org/abs/2611.18582]
- **"Do not" is not deny**: only ~4–16% of security rules in 481 CLAUDE.md files had a matching built-in control. "CLAUDE.md is a write-only channel." [PAPER https://arxiv.org/abs/2608.23550]
- **Prompt injection through repo files**:
  - Pillar "Rules File Backdoor" (2025-03): hidden Unicode in rule files steers Copilot and Cursor. [SECONDARY https://pillar.security/blog/new-vulnerability-in-github-copilot-and-cursor-how-hackers-can-weaponize-code-agents]
  - PackHallu: injected rule-file prompts make agents swap dependencies for attacker packages, "high attack success rates and strong transferability". [PAPER https://arxiv.org/abs/2610.09264]
  - Malicious memory files changed secure-completion rates by −8 to +6 pp, with no consistent pattern. Claude Code names the file in about two thirds of final messages; OpenCode mostly does not. [PAPER https://arxiv.org/abs/2610.38521]
  - Vendor mitigations: Claude Code's approval dialog for external imports [DOCS memory]; Gemini CLI trusted folders [DOCS trusted-folders.md]; Agent Skills guidance to gate project-level skills on folder trust [DOCS https://agentskills.io/client-implementation/adding-skills-support].
- **Skills-specific**:
  - Injecting a matched skill lowered Pass@2 by 1.3–4.2% and raised tokens 72–394% on a web-dev benchmark. [PAPER https://arxiv.org/abs/2608.23067]
  - Co-installed similar skills take over about one in five runs. "Install location decides which skill runs". [PAPER https://arxiv.org/abs/2610.11647]
  - 91.8% of 138K public SKILL.md files have at least one defect, mostly weak routing metadata. [PAPER https://arxiv.org/abs/2608.08453]

---

## 4. Agent Skills (SKILL.md)

### 4.1 Standard and governance
- Home: https://agentskills.io; repo https://github.com/agentskills/agentskills. "originally developed by Anthropic, released as an open standard". [DOCS https://agentskills.io/home]
- Now "Agent Skills a Series of LF Projects, LLC" under AAIF. GOVERNANCE.md was "Adopted November 4, 2026" and names a TSC Representative to the AAIF. Spec is Apache-2.0, docs CC-BY-4.0. [SOURCE https://github.com/agentskills/agentskills/blob/main/GOVERNANCE.md] [DOCS https://aaif.io/]

### 4.2 Format [DOCS https://agentskills.io/specification]
- A skill is a directory with `SKILL.md`, plus optional `scripts/`, `references/` and `assets/`.
- Frontmatter:
  - `name` (required): ≤64 chars, `a-z0-9-`, no leading, trailing or double hyphen, "Must match the parent directory name".
  - `description` (required): ≤1024 chars, "what the skill does and when to use it".
  - Optional: `license`, `compatibility` (≤500 chars), `metadata` (string→string map), `allowed-tools` ("Experimental").
- Progressive disclosure: metadata (~100 tokens) at startup → body (<5000 tokens recommended, "Keep your main SKILL.md under 500 lines") on activation → resources as needed. Keep file references one level deep.
- Validator: `skills-ref validate ./my-skill`.
- Cross-client convention (client implementation guide): scan `<project>/.agents/skills/` and `~/.agents/skills/` for "cross-client interoperability". "project-level skills override user-level skills". "Some implementations also scan `.claude/skills/`". Gate project-level skills on folder trust. [DOCS https://agentskills.io/client-implementation/adding-skills-support]

### 4.3 Support and locations per tool
- **Claude Code**: follows the standard and adds extensions (`disable-model-invocation`, `argument-hint`, `arguments`, `context: fork`, `paths`, `` !`cmd` `` injection, `$ARGUMENTS`, `${CLAUDE_SKILL_DIR}`). [DOCS https://code.claude.com/docs/en/skills]
  - Locations: enterprise; `~/.claude/skills/<n>/SKILL.md`; `.claude/skills/` (cwd up to repo root; nested on demand); `--add-dir`; plugins (`/plugin:skill`); claude.ai-synced.
  - Precedence: "Enterprise over personal, and personal over project".
  - In a linked git worktree with no `.claude/skills` at its root, the main checkout's project skills load (v2.1.277+).
  - **Does not scan `.agents/skills`** (no mention in the docs, 2026-11-19).
  - Uploads to claude.ai or the Skills API reject non-spec keys ("Unexpected key(s) in SKILL.md frontmatter"). Claude Code itself accepts them.
  - Command-name derivation: the folder name or `name` gives `/name`.
  - Old `.claude/commands/*.md` still work ("Custom commands have been merged into skills").
- **Codex**: "Skills build on the open agent skills standard". [DOCS https://learn.chatgpt.com/docs/build-skills]
  - Locations: `.agents/skills` in each dir from cwd up to repo root (REPO); `$HOME/.agents/skills` (USER); `/etc/codex/skills` (ADMIN); bundled (SYSTEM). The source also scans `codex_home.join("skills")`, i.e. `~/.codex/skills`. [SOURCE capability_locations.rs]
  - "If two skills share the same name, Codex doesn't merge them; both can appear in skill selectors."
  - Symlinked skill folders are followed.
  - Invocation: "run `/skills` or type `$` to mention a skill", or implicit by description. The skills list budget is 2% of the context window (8,000 chars fallback), adjustable with `skills.max_context_tokens`.
  - Optional `agents/openai.yaml` with `policy.allow_implicit_invocation: false`.
  - Unknown frontmatter keys are tolerated: no `deny_unknown_fields`, and `name` defaults to the folder name. [SOURCE codex-rs/skills/src/parser.rs]
  - Codex skills have no argument substitution documented. [DOCS absence]
  - Custom prompts (`~/.codex/prompts/*.md` → `/prompts:name`, with `$1..$9`, `$ARGUMENTS`, named `$FILE`) are **"deprecated. Use skills"**. [DOCS https://learn.chatgpt.com/docs/custom-prompts]
- **Gemini CLI**: based on the standard. Tiers, lowest to highest: built-in < extension < user (`~/.gemini/skills/` or `~/.agents/skills/`) < workspace (`.gemini/skills/` or `.agents/skills/`). "`.agents/skills/` alias takes precedence over the `.gemini/skills/` directory". Activation goes through the `activate_skill` tool with a user consent prompt. Custom slash commands are separate `.toml` files in `~/.gemini/commands/` or `.gemini/commands/`. [DOCS gemini-cli docs/cli/skills.md, custom-commands.md]
- **Antigravity**: "Skills are an open standard". `name` is optional (defaults to the folder). Locations: `.agents/skills/` (and parents to repo root; legacy `.agent/skills`); global `~/.gemini/config/skills/`. The CLI also reads `~/.gemini/skills/` and `~/.gemini/antigravity-cli/skills/`, which take top priority. Plugins via `agy plugin install`. "the CLI automatically converts it into a slash command"; the App supports `/<skill-name>`. Folders are scanned one level deep. [DOCS https://antigravity.google/docs/skills] [DOCS https://antigravity.google/docs/customization-discovery]
- **Others in the official showcase** (`docs/snippets/clients.jsx`, 2026-11-19): Junie, Gemini CLI, OpenCode, OpenHands, Cursor, Amp, Goose, GitHub Copilot, VS Code, Claude Code, Claude, ChatGPT & Codex, Factory, Roo Code, Mistral Vibe, Kiro, Tabnine, Databricks, Snowflake Cortex Code, and others. Antigravity is **not** in the showcase, though its docs claim support. [SOURCE https://github.com/agentskills/agentskills/blob/main/docs/snippets/clients.jsx]

### 4.4 One `orchestrate-all` skill for both front doors
- Format compatibility: **yes**. A SKILL.md with spec-only frontmatter loads in Claude Code ("frontmatter that follows the spec loads in Claude Code without changes") and in Codex. Codex also tolerates Claude-only keys. [DOCS skills] [SOURCE parser.rs]
- Install location compatibility: **no single folder covers both** today.
  - Claude Code: `~/.claude/skills/` (not `.agents/skills`).
  - Codex: `~/.agents/skills/` (and per source `~/.codex/skills/`, though not `.claude/skills`).
  - Gemini CLI: `~/.agents/skills/` or `~/.gemini/skills/`.
  - Antigravity: `~/.gemini/config/skills/` (App+CLI) or `~/.gemini/skills/` (CLI only).
  - An installer must therefore copy (or symlink) the folder into **at least two roots**: `~/.claude/skills/orchestrate-all/` and `~/.agents/skills/orchestrate-all/`. Add `~/.gemini/config/skills/orchestrate-all/` for Antigravity.
  - Do not also put it in `~/.codex/skills`, or Codex lists it twice ("both can appear").
  - Do not put it in both `~/.agents/skills` and `~/.gemini/skills`; Gemini CLI resolves by precedence, but the duplication is pointless.
- Invocation differs:
  - Claude Code: `/orchestrate-all <task>`. The text reaches the body via `$ARGUMENTS`, or is appended as `ARGUMENTS: ...`.
  - Codex: `$orchestrate-all <task>` or the `/skills` picker. There is **no `/orchestrate-all` slash**. The deprecated alternative is `~/.codex/prompts/orchestrate-all.md` → `/prompts:orchestrate-all`.
  - Antigravity: `/orchestrate-all`.
  - Gemini CLI: model-activated with consent, or via a separate `.toml` custom command.
- Packaging later:
  - Claude Code plugins use `.claude-plugin/plugin.json`. Plugin skills are namespaced `/plugin:skill`, which changes the command name. [DOCS skills]
  - Codex plugins: "For a portable Agent Plugins package, add `plugin.json` at the plugin root ... Existing `.codex-plugin/plugin.json` files remain supported". Marketplace via `codex plugin marketplace add owner/repo`. [DOCS https://developers.openai.com/plugins/build/plugins]
  - "Agent Plugins 1.0" (2026-08) is a separate multi-vendor packaging spec, reportedly not an AAIF project. Claude Code support is unconfirmed. [SECONDARY https://aaif.io/blog/from-skills-and-tools-to-portable-agent-plugins] [SECONDARY https://developers.googleblog.com/agent-plugins-package-your-skills-tools-and-more/] [UNCLEAR]

---

## 5. How an orchestrator should pass project rules to workers on different engines

### 5.1 Options compared
| Option | Pros | Cons |
|---|---|---|
| **A. Rely on native loading** in the worktree | No extra tokens; keeps each engine's nesting and JIT semantics (Claude on-demand subdirs, Gemini JIT, Amp subtrees); the "closest file wins" behaviour stays intact; the files are read from the committed state of the worktree | **Coverage gaps by engine**: Codex ignores CLAUDE.md; Gemini CLI ignores AGENTS.md by default; Antigravity ignores CLAUDE.md and subfolders; Claude ignores AGENTS.md when a CLAUDE.md exists or on old versions. Truncation differs (Codex 32 KiB combined, Antigravity 24 KB/file). Gitignored or uncommitted files (`CLAUDE.local.md`, local edits) are missing from a fresh worktree [DOCS memory: "a gitignored `CLAUDE.local.md` only exists in the worktree where you created it"]. Windows symlink-as-text breaks Claude. User globals differ per engine |
| **B. Inject file contents into the brief** | Same text for every engine; can carry files absent from the worktree; deterministic and auditable | Duplicates what native loading already adds (tokens; context files already cost >20% [PAPER 2602.11988]). In the prompt channel it **outranks** AGENTS.md ("Direct system/developer/user instructions ... take precedence"), which flattens nested precedence and makes repo text more authoritative. Stale if a worker edits the file mid-run. Elevates possibly malicious repo text. Long briefs lower adherence over long sessions [PAPER 2605.10039] |
| **C. Point workers at file paths** ("read X and any AGENTS.md in dirs you touch") | Cheap; keeps scope semantics; can point outside the worktree (absolute path to the user's main checkout); matches Codex's own instruction for below-cwd files | Non-deterministic: "Claude sees `AGENTS.md` only if it decides to open the file" [DOCS memory]. Paths outside the worktree may need extra permissions (Gemini adds dirs; Claude `--add-dir`) |
| **D. Generate a temp engine-specific file in the worktree** (e.g. GEMINI.md, CLAUDE.md) | Uses each engine's strongest channel | Appears as an untracked change; can be committed by the worker or tripped by the conductor's file-scope check. A temp CLAUDE.md also **switches off** Claude's native AGENTS.md reading. Mutates the user's repo state. (Exception: copying a file whose name the repo **already gitignores**, such as `CLAUDE.local.md`, is invisible to git. Claude's `.worktreeinclude` does exactly this for gitignored files [DOCS worktrees].) |
| **E. Engine flags/env pointing at the repo's own files** (no files in the worktree) | Native-strength loading with no repo mutation | Engine- and version-specific; needs tests. Claude: `--settings` (pluginConfigs instructionFiles; `claudeMdExcludes`) or `--append-system-prompt-file`. Codex: `-c project_doc_fallback_filenames=[...]`, `-c project_doc_max_bytes=...`. Gemini: `GEMINI_CLI_SYSTEM_DEFAULTS_PATH=<tmp settings outside worktree>` with `context.fileName` |

### 5.2 Gitignored, uncommitted and global files
- A worktree contains only committed content. Missing from it are `CLAUDE.local.md`, `.claude/settings.local.json`, any uncommitted edits to AGENTS.md, and possibly gitignored `.claude/skills`. Claude Code has partial read-through for skills, agents and commands, but **not for instruction files**. [DOCS worktrees, memory]
- Claude Code's walk to every parent dir: if Orchestra put worktrees *inside* the main checkout, Claude workers would also load the main checkout's CLAUDE.md and CLAUDE.local.md (duplicated, possibly different versions). Codex, Gemini and Antigravity stop at the worktree's own `.git`. [UNCLEAR, inferred from DOCS; test it] Mitigation: place worktrees outside the repo tree, or pass `claudeMdExcludes` through `--settings` [DOCS memory: patterns are absolute-path globs].
- Personal globals and precedence per engine:
  - Claude: "All levels are additive ... There is no hard precedence rule between levels; if instructions conflict, the outcome depends on how Claude interprets them. Write non-conflicting rules, or state precedence explicitly in the more specific file". [DOCS https://code.claude.com/docs/en/agent-sdk/claude-code-features]
  - Codex: global first, project later, "Files closer to your current directory override earlier guidance because they appear later". [DOCS codex agents-md]
  - Gemini: more specific "typically overrides or supplements". [DOCS configuration.md]
  - Antigravity: cumulative; global and workspace both load. [DOCS]
  - Zed: "Project instructions override personal `AGENTS.md`". [DOCS]
  - AGENTS.md site: closest file wins; the chat prompt overrides all. [DOCS]
- Suppressing globals is costly:
  - Claude `--setting-sources project,local` also drops user settings and skills. `--bare` drops all CLAUDE.md files. [DOCS cli-reference]
  - Codex `CODEX_HOME` swap and Gemini `GEMINI_CLI_HOME` swap move auth and config too. [DOCS]
- Evidence that one explicit precedence sentence works: adding a code-precedence sentence to the user-level file moved code-following from 4.2% to 91.4%. [PAPER 2610.30571]

---

## Implications for Orchestra

### A. Recommended strategy for project rules across engines ("native first, close gaps with flags, inject only the delta, enforce mechanically")

1. **Conductor builds a rules manifest (plain code, before planning).** For the base commit (`git ls-tree`) and for the user's working checkout (`git status --ignored`), list:
   - Repo files: every `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/**`, `GEMINI.md`, `.agents/rules/*`, `.github/copilot-instructions.md` (optional), with path, size, sha, git mode (`120000`), and tracked/modified/ignored/untracked status.
   - Each file's `@imports`.
   - The engine globals: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS(.override).md`, `~/.gemini/GEMINI.md`, `~/.gemini/AGENTS.md`.
   - Flags to set:
     - **Windows symlink-as-text**: CLAUDE.md is mode 120000 in git, but the checkout is a small regular file whose content equals the link target.
     - **CLAUDE.md is only a pointer**: `@AGENTS.md`, or its content is just "AGENTS.md".
     - **Size over engine caps**: Codex 32 KiB combined; Antigravity 24,000 B/file.
     - **Uncommitted or ignored rule files.**
     - **Divergent CLAUDE.md vs AGENTS.md content.**
     - **Hidden Unicode / bidi characters**: rules-file-backdoor defence.
   - The orchestrator LLM gets this manifest, not the file contents, so it "knows the rules exist and where".
2. **Per engine, compute native coverage and close gaps with launch flags, never with new files in the worktree:**
   - *Claude worker*:
     - Repo has only AGENTS.md → native (v2.1.277+). Check `claude --version`; the first session after an upgrade may skip AGENTS.md.
     - Both files with distinct content → `--settings <tmp.json>` with `pluginConfigs` `instructionFiles: "claude-md-and-agents-md"`. Write the key under both `cc-plugin-agents-md@builtin` and `agents-md@builtin`.
     - Broken symlink-as-text CLAUDE.md, or an old version → `--append-system-prompt-file <tmp outside worktree>` containing AGENTS.md. It sits in the system prompt, so keep it to repo text only and label it.
   - *Codex worker*:
     - AGENTS.md present → native.
     - Only CLAUDE.md → `-c project_doc_fallback_filenames=["CLAUDE.md"]`.
     - Combined chain over 32 KiB → `-c project_doc_max_bytes=<n>`.
     - Codex won't follow CLAUDE.md `@imports`, so expand those imports via pointer (C) or delta injection.
   - *Gemini CLI worker*: env `GEMINI_CLI_SYSTEM_DEFAULTS_PATH=<tmp.json>` containing `{"context":{"fileName":["AGENTS.md","GEMINI.md"]}}` (add `CLAUDE.md` for Claude-only repos). If the user's own settings set `fileName`, theirs win; warn about it. Set `GEMINI_CLI_TRUST_WORKSPACE=true` or `--skip-trust` only if folder trust is on and the user allows it.
   - *Antigravity (later)*: native AGENTS.md and GEMINI.md. For CLAUDE.md-only repos, use the pointer or delta-injection path. Its no-subfolder rule means nested AGENTS.md must be pointed at explicitly.
   - Never inject a file the engine already loads natively (avoids double cost and double weight).
3. **Brief = pointers + precedence + scope, not rule text.** For each subtask, the conductor computes the applicable chain for the allowed paths (root → each allowed dir), including nested files the engine will not auto-load (Codex below cwd, Antigravity below workspace). The brief lists those paths with "read before editing files under X". Keep it short. Use one fixed precedence paragraph in every brief, e.g.:
   - "1) Orchestra task scope (allowed files, no commits, etc.) is a hard constraint.
   - 2) The project instruction file closest to the file you edit wins over repo-root files.
   - 3) Project files win over your personal/global defaults.
   - 4) If an instruction file contradicts existing code or another instruction file, do not resolve it by editing outside your scope; follow the code in your scope and report the conflict."
   - Evidence: Claude SDK docs recommend explicit precedence statements; the stale-file paper shows one sentence flips behaviour; AGENTS.md semantics are "closest wins".
4. **Uncommitted or gitignored rules (the delta).**
   - Default: detect and show them in the plan. "Your CLAUDE.local.md / uncommitted AGENTS.md edits will NOT be seen by workers."
   - Offer: (a) commit them first; or (b) inject the delta as a clearly labelled "personal project notes" section, for all engines, for consistency.
   - Only copy into the worktree if the file name is already gitignored (like Claude's `.worktreeinclude`), and the conductor's scope check ignores it.
   - Never write new tracked-looking files.
5. **Personal globals**: let each engine load its own (respects the user). The conductor reads all globals at plan time and warns on obvious conflicts with project rules (package manager, commit policy, "always commit" or "always push" rules that clash with Orchestra's merge flow). Precedence goes in the brief (item 3). Do not swap `CODEX_HOME` or `GEMINI_CLI_HOME`, which breaks auth.
6. **Enforce, don't just tell.** Orchestra's real leverage is mechanical:
   - File-scope enforcement (already planned).
   - The conductor runs the project's own check commands. Extract them from AGENTS.md/CLAUDE.md "commands" sections at plan time, show them to the user, then run them after each worker and after merge.
   - Treat any worker edit to an instruction file (AGENTS.md, CLAUDE.md, GEMINI.md, `.agents/`, `.claude/`) as high-risk, needing explicit user approval at merge. Those edits change every later agent session, and review of them is weak (>70% unreviewed [PAPER 2611.18582]).
   - Evidence: "Guardrails beat guidance" [PAPER 2604.11088]; ContextCov 88% vs 67% [PAPER 2603.00822]; Anthropic "If something has to happen every time, make it a hook" [DOCS best-practices].
7. **Place worktrees outside the user's checkout** (e.g. a sibling dir or `%LOCALAPPDATA%`), so Claude workers don't inherit the main checkout's CLAUDE.md and CLAUDE.local.md through the ancestor walk. Keep paths short (Windows).
8. **Don't add rule text of your own.** This matches the user's position and the evidence: extra context costs tokens without reliable gains [PAPER 2602.11988, 2607.27250], and LLM-written summaries of rules underperform developer-written files.

### B. Shipping `/orchestrate-all` to both front doors
1. **One skill folder `orchestrate-all/`**:
   - `SKILL.md` frontmatter restricted to spec keys: `name: orchestrate-all`, a `description` with clear trigger words and a clear "only when the user explicitly asks to orchestrate" boundary, `compatibility`, and `metadata.version`.
   - Optional Claude-only keys `disable-model-invocation: true` and `argument-hint`. Codex ignores unknown keys; claude.ai upload would reject them, which doesn't matter here.
   - Add `agents/openai.yaml` with `policy.allow_implicit_invocation: false` so Codex never starts an expensive orchestration on its own.
2. **Engine-neutral body**:
   - The heavy lifting lives in the conductor CLI on PATH (`orchestra plan|run|status`). Do not rely on `${CLAUDE_SKILL_DIR}` or `` !`cmd` `` injection (Claude-only).
   - Describe the user's task as "the text the user gave after invoking this skill", not `$ARGUMENTS`. Codex has no substitution; Claude appends `ARGUMENTS:` when no placeholder is present.
   - Refer to "your shell tool" and "your file-reading tool", not tool names [DOCS https://aaif.io/blog/how-to-move-a-skill-from-one-coding-agent-to-another].
   - Keep the body under 500 lines / ~5k tokens; put details in `references/`.
3. **Installer `orchestra install`** copies, not symlinks (Windows):
   - `~/.claude/skills/orchestrate-all/` gives Claude Code `/orchestrate-all`.
   - `~/.agents/skills/orchestrate-all/` gives Codex `$orchestrate-all` (and Gemini CLI skills).
   - Optional `~/.gemini/config/skills/orchestrate-all/` gives Antigravity `/orchestrate-all`.
   - Never also install into `~/.codex/skills` (Codex would list two). Keep the copies identical with a version stamp, and add `orchestra doctor` to detect drift between copies.
   - User-level only: Orchestra must not add `.claude/skills` or `.agents/skills` to the user's projects.
4. **Document the UX difference**: Claude `/orchestrate-all`, Codex `$orchestrate-all` (or `/skills`), Antigravity `/orchestrate-all`. Don't ship the deprecated Codex custom prompt unless users insist on a `/prompts:` slash.
5. **Later**: plugins for distribution. Claude: `.claude-plugin/plugin.json`, skill becomes `/orchestra:orchestrate-all`. Codex: root `plugin.json` or `.codex-plugin/plugin.json`. Both can live in one repo. Track Agent Plugins 1.0 adoption.
6. **Validate with `skills-ref validate`**, and test discovery, explicit invocation and implicit non-invocation in each engine, as the AAIF porting guide suggests.

---

## Open questions
1. Does a headless `claude -p` started in a worktree *nested inside* the main checkout load the parent checkout's CLAUDE.md and CLAUDE.local.md? Docs imply yes; test on Windows.
2. Does Claude's `--settings` file with `pluginConfigs` `instructionFiles` take effect in `-p` mode? What about the "first session after upgrade" gap: does it apply to every fresh headless process after an upgrade, or once per machine?
3. Codex: does the `.git` *file* in a linked worktree satisfy `project_root_markers`? Does `-c project_doc_fallback_filenames=[...]` work with `codex exec` on Windows (TOML array quoting in PowerShell)?
4. Gemini CLI: does `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` cleanly supply `context.fileName` without masking user settings? Does JIT loading use the configured names?
5. Antigravity CLI: is there a reliable headless mode for workers, and how do its "workspace folder only" rules interact with worktrees? (Other researcher.)
6. Case sensitivity on Windows (`Agents.md` vs `AGENTS.md`) and CRLF/BOM handling in instruction files across engines: not documented anywhere I found. [UNCLEAR]
7. Will Claude Code adopt `.agents/skills` (the cross-client convention)? That would collapse the install to one user folder for Claude, Codex and Gemini. Will AGENTS.md get a formal versioned spec under AAIF (e.g. defining `AGENTS.override.md`, imports, local files)? None of this exists as of 2026-11-19.
8. Evidence conflict: context files help efficiency [PAPER 2601.20404] vs add cost with no success gain [PAPER 2602.11988, 2607.27250]. Orchestra should measure per-repo rather than assume. Possible metric: worker token cost and check-pass rate with vs without the pointer brief.
9. How should Orchestra treat `AGENTS.override.md`? Codex-only. It silently gives Codex different rules than other engines. Inject it for others, or warn?
