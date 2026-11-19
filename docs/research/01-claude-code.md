# A. Claude Code as a headless, tightly limited worker + project instruction files

Researcher A, 2026-11-19. Scope: Claude Code CLI as an Orchestra worker (`claude -p`), how it loads CLAUDE.md/AGENTS.md, and how to limit it.

## Sources and labels

- **[DOCS url]**: official docs at https://code.claude.com/docs/en/*.md, fetched 2026-11-19. They describe the current release, **v2.1.328** (top entry of the docs changelog, dated 2026-11-19). Many statements carry "requires vX" notes; I copied those.
- **[SOURCE url]**: official changelog (https://code.claude.com/docs/en/changelog.md, generated from github.com/anthropics/claude-code CHANGELOG.md). I use it to date features against the user's **v2.1.97** (released 2026-04-08).
- **[HELP v2.1.328]**: `claude --help` in this container.
- **[OBSERVED v2.1.328]**: my own experiments with the real `claude` 2.1.328 binary pointed at a **local mock Messages API** (`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, dummy key, clean `env -i`, fake HOME). The mock returns canned text or scripted `tool_use` blocks and logs every request body. **No model was called and no real credentials were used.** The docs recommend this method for seeing what Claude receives: "point `ANTHROPIC_BASE_URL` at a proxy that logs request bodies" [DOCS agent-sdk/modifying-system-prompts]. Caveat: the mock runs in API-key mode, so a subscription login may differ slightly (for example `apiKeySource` reads `none`).
  - The test scripts and raw outputs stayed in the researcher's throwaway folder and are not committed.
- **[SECONDARY url]**: non-docs sources, such as Anthropic's April 2025 engineering post, now marked "no longer maintained".
- **[UNCLEAR]**: not established.


> **Big caveat for the user's 2.1.97.** The docs and my observations are for 2.1.328. Several key features (native AGENTS.md, `--permission-prompts`, `--restricted`, `omitClaudeMd`, hook `onFailure`, `blockWritesOutsideWorkingDirectories`, Windows hook fail-open fixes) did not exist in 2.1.97. See the version table in §8.

> **Gotcha found while testing [OBSERVED v2.1.328].** Claude Code 2.1.328 refuses to load any CLAUDE.md, rule or AGENTS.md whose path "is in a session's scratchpad or a folder laid out like one (claude/<project>/<session id>/scratchpad). To load it, move it out of that folder." (from the `--debug-file` log). Orchestra must not put worktrees under a path shaped like `.../claude*/<project>/<uuid>/scratchpad/...`.

---

## 1. Instruction / memory files

### 1.1 Locations and load order

The docs list locations "in load order, from broadest scope to most specific, so a project instruction appears in context after a user instruction" [DOCS https://code.claude.com/docs/en/memory.md]:

| Scope | Location |
|---|---|
| Managed policy | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`; Linux/WSL `/etc/claude-code/CLAUDE.md`; **Windows `C:\Program Files\ClaudeCode\CLAUDE.md`**; also the `claudeMd` key in managed-settings.json |
| User | `~/.claude/CLAUDE.md` (+ `~/.claude/rules/*.md`) |
| Project | `./CLAUDE.md` or `./.claude/CLAUDE.md` (+ `.claude/rules/**/*.md`) |
| Local | `./CLAUDE.local.md` (gitignored; personal) |

- **Ancestor directories:** "Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from your current working directory and every directory above it." Content is "ordered from the filesystem root down to your working directory", and "Within each directory, `CLAUDE.local.md` is appended after `CLAUDE.md`." [DOCS memory]
- **Subdirectories:** they load on demand: "Claude Code loads each one once Claude reads, writes, or edits another file in that subdirectory." A single-file `cat`/`head` via Bash also counts. [DOCS memory] On older versions only the Read tool triggered loading. Write/Edit triggering was fixed in 2.1.288 and Bash `cat` in 2.1.293 [SOURCE changelog]. So **on 2.1.97, only Read triggers it** [UNCLEAR, inferred from those fix entries].
- **Files are concatenated, not overridden:** "All discovered files are concatenated into context rather than overriding each other." [DOCS memory] "There is no hard precedence rule between levels" [DOCS agent-sdk/claude-code-features].
- **HTML comments:** "Block-level HTML comments (`<!-- ... -->`) in CLAUDE.md files are stripped before the content is injected" [DOCS memory]. Confirmed: `MARKER_HTML_COMMENT` never reached the request [OBSERVED].
- **Exclusions:** `claudeMdExcludes` (glob on absolute paths) skips files, but never the managed file [DOCS memory].
- **Observed order** in the injected block (one request, everything enabled) [OBSERVED v2.1.328, scenario s01]:
  1. `~/.claude/CLAUDE.md`
  2. `~/.claude/rules/u.md`
  3. `<parent>/CLAUDE.md`
  4. `<repo>/CLAUDE.md`
  5. the file it `@`-imports
  6. `<repo>/.claude/CLAUDE.md`
  7. `<repo>/.claude/rules/r.md`
  8. `<repo>/CLAUDE.local.md`

  Not loaded: the path-scoped rule (no matching file touched), `sub/CLAUDE.md` (no file read there), and `AGENTS.md` (a CLAUDE.md exists).

### 1.2 `@path` imports

- Syntax: `@path/to/file` anywhere in the text. "Relative paths resolve relative to the file containing the import, not the working directory." `@~/...` works. Escape spaces with `\ `. Imports are not parsed inside code spans or fenced blocks. [DOCS memory]
- Depth: "Imported files can recursively import other files, with a maximum depth of four hops." [DOCS memory]
  - **Observed:** a chain CLAUDE.md → i1 → … → i7 loaded markers 0–4 only, so the root plus four import hops [OBSERVED v2.1.328, scenario d1].
  - The 2025 docs said "max-depth of 5 hops" [SECONDARY, from memory of the older docs page]. **The value for 2.1.97 is [UNCLEAR].**
- Imports cost context like inline text: "imported files load together with the CLAUDE.md that imports them" [DOCS memory].
- External imports (outside the working directory) in project files trigger a one-time approval dialog. If declined, they stay disabled [DOCS memory]. **In `-p` there is no dialog**, so behavior for unapproved external imports in a worker is [UNCLEAR]; avoid them.

### 1.3 `.claude/rules/`

- "All `.md` files are discovered recursively." "Rules without `paths` frontmatter are loaded at launch with the same priority as `.claude/CLAUDE.md`." [DOCS memory]
- **Path-scoped rules:**
  ```markdown
  ---
  paths:
    - "src/api/**/*.ts"
  ---
  ```
  "`paths` is the only field Claude Code reads from a rule; any other field is ignored." Brace expansion is supported. Patterns are relative to the directory containing `.claude`. [DOCS memory]
- A path-scoped rule loads "when Claude uses the Read, Write, or Edit tool on a matching file" (Write/Edit since 2.1.288 [SOURCE]).
  - Observed: after a `Read` of `src/a.ts`, the rule arrived as a `<system-reminder>Contents of …/.claude/rules/scoped.md:…</system-reminder>` text block appended to the tool_result user message [OBSERVED, scenario d2]. Nested `sub/CLAUDE.md` arrived the same way.
- `.claude/rules/` exists since 2.0.64. Path-scoped rules and nested CLAUDE.md not loading in `claude -p` was fixed in 2.1.69 [SOURCE]. So they work on 2.1.97, Read-triggered only.
- Per-file size limit for on-demand files: 40,000 chars at a 200K context, 150,000–200,000 chars at 1M. Over the limit, only the start loads. This limit exists since 2.1.309 [DOCS memory].

### 1.4 AGENTS.md

- **Native support exists only in v2.1.277 and later.** "Reading `AGENTS.md` directly requires Claude Code v2.1.277 or later." [DOCS memory]. Changelog 2.1.277: "Added AGENTS.md support: in a project with no CLAUDE.md, Claude Code reads AGENTS.md instead" [SOURCE].
  - **The user's CLI (2.1.97) does NOT read AGENTS.md.**
  - The VS Code extension 2.1.325 would. [UNCLEAR: whether the extension's bundled CLI is the one Orchestra would spawn.]
- Default rule (2.1.277+): AGENTS.md is read only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the cwd or above. `~/.claude/CLAUDE.md`, managed CLAUDE.md and rules don't count. `AGENTS.local.md`, `AGENTS.override.md` and `.agents/` are not read. The "Project instructions" setting (`claude-md-or-agents-md` default, `claude-md-and-agents-md`, `claude-md`, `managed-only`) changes this. [DOCS memory]
  - Observed: a repo with only AGENTS.md got it injected [OBSERVED s06]. With CLAUDE.md present, AGENTS.md was ignored [OBSERVED s01].
- **Documented portable pattern** ("Share one file with other coding tools"):
  ```markdown
  @AGENTS.md

  ## Claude Code
  ...Claude-specific lines...
  ```
  "Keeping the import never makes Claude read `AGENTS.md` twice, whichever **Project instructions** value you use." [DOCS memory]. Observed: the content appeared once [OBSERVED s12].
  - **Windows:** "use the `@AGENTS.md` import instead [of a symlink]" because symlinks need admin or Developer Mode and git checks them out as plain text [DOCS memory].
- `/init` with `CLAUDE_CODE_NEW_INIT=1` and `/import` can migrate AGENTS.md content [DOCS memory]. Not relevant to workers.

### 1.5 How the files reach the model

- "CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself." [DOCS memory]
- "System reminders are messages Claude Code adds to the conversation … such as the contents of your CLAUDE.md files … not in the system prompt, so most reach Claude whether you use the `claude_code` preset or pass your own string" [DOCS agent-sdk/modifying-system-prompts].
- **Exact shape [OBSERVED v2.1.328]:** the first text block of `messages[0]` (role user):
  ```
  <system-reminder>
  Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

  Contents of /…/home/.claude/CLAUDE.md (user's private global instructions for all projects):
  …
  Contents of /…/repo/CLAUDE.md (project instructions, checked into the codebase):
  …
  Contents of /…/repo/CLAUDE.local.md (user's private project instructions, not checked in):
  …
  </system-reminder>
  ```
  - Next come the git-status reminder, an attribution reminder, then the user prompt.
  - SessionStart hook output, the environment block, the skills list and the agents list came as a separate `role: "system"` message (`messages[1]`).
- Auto memory (MEMORY.md) and its instructions go **into the system prompt**: "Auto memory … Loaded into the system prompt at session start" [DOCS agent-sdk/claude-code-features]. Observed: a `# Memory` section in system[2] [OBSERVED].
- `--system-prompt` replaces the system text, but **CLAUDE.md is still injected** (scenario s11). The docs agree: "CLAUDE.md loading is controlled by setting sources, not by the `claude_code` preset" [DOCS agent-sdk/modifying-system-prompts].
- Project-root CLAUDE.md is re-read and re-injected after `/compact` [DOCS memory].

### 1.6 Size limits

- "Claude gets the whole of each CLAUDE.md file that loads at launch, as long as the file is 4 MiB or smaller. Claude Code skips a file over 4 MiB." [DOCS memory]
- Guidance: "target under 200 lines per CLAUDE.md file". There is a startup warning for over-length files and for a combined total [DOCS memory].
- MEMORY.md (auto memory): only the first 200 lines or 25 KB load [DOCS memory].
- On-demand files: see §1.3.
- Version caveat: [UNCLEAR] which limits existed in 2.1.97.

---

## 2. Flags and env vars that control loading in headless mode

### 2.1 `--setting-sources` controls CLAUDE.md, not only settings.json

- CLI docs: "Comma-separated list of setting sources to load (`user`, `project`, `local`)" [DOCS cli-reference].
- The docs say it does gate CLAUDE.md: "`--setting-sources user` to turn off project configuration such as `.claude/settings.json`, `CLAUDE.md`, and `.mcp.json`" [DOCS debug-your-config]; "Project rules are skipped if you exclude `project` from `--setting-sources`" [DOCS memory].
- SDK mapping [DOCS agent-sdk/claude-code-features]:
  - `project`: "Project `settings.json` and hooks; project CLAUDE.md and `.claude/rules/*.md`; project skills, commands, and subagents".
  - `user`: "User `settings.json`; user CLAUDE.md and `~/.claude/rules/*.md`; user skills…".
  - `local`: "CLAUDE.local.md, `.claude/settings.local.json`".
  - "Omitting `settingSources` is equivalent to `["user", "project", "local"]`."
- **Observed matrix [OBSERVED v2.1.328]:**

| Flags | User CLAUDE.md + rules | Project/parent CLAUDE.md, .claude/CLAUDE.md, rules, imports | CLAUDE.local.md | User hook | Project hook | Project `.mcp.json` |
|---|---|---|---|---|---|---|
| (none) | yes | yes | yes | ran | ran | connected (failed) |
| `--setting-sources project` | no | yes | **no** | no | ran | connected |
| `--setting-sources user` | yes | no | no | ran | no | no |
| `--setting-sources ""` | no | no | no | no | no | no |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | no | no | no | ran | ran | connected |
| `--setting-sources project --settings '{"disableAllHooks":true}' --strict-mcp-config` | no | yes | no | no | no | no |

- Not controlled by setting sources: managed policy settings, `~/.claude.json` global config, auto memory, claude.ai MCP connectors, and `sandbox.credentials` entries [DOCS agent-sdk/claude-code-features].
  - "Passing `mcpServers: {}` does not suppress the connectors". Use strict MCP config, `disableClaudeAiConnectors`, or `ENABLE_CLAUDEAI_MCP_SERVERS=false` [DOCS same].
- **2.1.97 hazard:** "Fixed `--setting-sources` without `user` causing background cleanup to ignore `cleanupPeriodDays` and delete conversation history older than 30 days" (fixed in **2.1.101**) [SOURCE changelog]. On 2.1.97, `--setting-sources project` can delete the user's old transcripts if they raised `cleanupPeriodDays`.
- Also fixed in 2.1.314: "a settings file excluded with `--setting-sources` still supplying some settings, such as auto mode rules and saved permission consents" [SOURCE].

### 2.2 Loading project CLAUDE.md but not user settings, permissions, hooks or MCP

There is no single flag. Three options:

- **Option A** (closest to normal project semantics): `--setting-sources project --strict-mcp-config`.
  - Excludes user CLAUDE.md, user settings, user hooks and user permissions, and all MCP.
  - **Still runs project hooks** and reads project `settings.json`.
  - Project `permissions.allow` is applied **only if the repo is trusted**. Observed: untrusted, stderr said "Ignoring 2 permissions.allow entries from .claude/settings.json: this workspace has not been trusted" [OBSERVED t1]. After setting `hasTrustDialogAccepted`, the project's `allow: ["Edit","Write"]` **widened** a `dontAsk` + `--allowedTools "Edit(/src/**)"` worker, so `other/bad.ts` and `CLAUDE.md` got written [OBSERVED t2].
  - Trust for a worktree is keyed on the main checkout's root [DOCS permissions]. So a repo the user trusted interactively also trusts Orchestra's worktrees.
  - `disableAllHooks:true` in `--settings` kills project hooks, but **also Orchestra's own `--settings` hooks** [OBSERVED h3].
- **Option B** (zero settings, root instructions only): `--setting-sources "" --add-dir <worktree>` plus env `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.
  - Loaded `CLAUDE.md`, `.claude/CLAUDE.md`, imports and non-path rules of the worktree. No hooks, no project settings, no MCP [OBSERVED s09].
  - Lost: ancestor (monorepo parent) CLAUDE.md, CLAUDE.local.md, **path-scoped rules and nested subdir CLAUDE.md** (they never loaded even after reading matching files) [OBSERVED d3].
  - Docs: add-dir loads "`CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, and `.claude/rules/*.md` files except rules that set a `paths` field" and AGENTS.md doesn't load via add-dir [DOCS memory].
  - The env var exists since 2.1.20 [SOURCE]. A duplicate-injection bug for add-dir inside the cwd was fixed in 2.1.281 [SOURCE]. Behavior on 2.1.97 is [UNCLEAR].
  - Orchestra's own hooks via `--settings` **do** run with `--setting-sources ""` [OBSERVED h1].
- **Option C:** `--setting-sources ""` and have the conductor read CLAUDE.md/AGENTS.md itself and pass it with `--append-system-prompt-file`.
  - This puts it in the system prompt rather than a reminder, which changes semantics and loses lazy loading. Not recommended, except as an engine-neutral fallback.

### 2.3 Environment variables [DOCS env-vars]

- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`: "prevent loading any CLAUDE.md memory files into context, including user, project, and auto memory files". Observed working (s05). Version on 2.1.97 [UNCLEAR].
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: disables auto memory. `0` forces it on.
- `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`: load CLAUDE.md from `--add-dir` dirs (since 2.1.20).
- `CLAUDE_CODE_SIMPLE=1` is the same as `--bare`.
- `CLAUDE_CODE_SAFE_MODE=1` is the same as `--safe-mode`: no CLAUDE.md, hooks, MCP, plugins or auto memory, but OAuth auth works [DOCS cli-reference]. Added in 2.1.169 [SOURCE], so **not on 2.1.97**.
- `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` / `includeGitInstructions:false`: removes the built-in commit/PR instructions and the git-status snapshot.
- `CLAUDE_CODE_DISABLE_ATTACHMENTS=1`: removes task nudges, file-changed notes and the skill list; `@` mentions become plain text.
- `ENABLE_CLAUDEAI_MCP_SERVERS=false`: no claude.ai connectors.

### 2.4 Agent SDK `settingSources` (as a hint for the CLI)

- "When you omit `settingSources`, `query()` reads the same filesystem settings as the Claude Code CLI … To run without these, pass `settingSources: []`" [DOCS agent-sdk/claude-code-features].
- For multi-tenant use: "set `settingSources: []` plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`" [same].
- It maps to the CLI's `--setting-sources` (my observations match the SDK doc table).

### 2.5 `--settings <file>` with empty `--setting-sources`

- Yes, it still applies. Precedence order: managed > **command line (`--settings`)** > local > project > user [DOCS settings].
- Observed: a PreToolUse hook defined only in `--settings file.json` ran and blocked writes with `--setting-sources ""` [OBSERVED h1, h2].
- The CLI docs confirm `--restricted` "loads only managed settings and `--settings`" (2.1.248+).

---

## 3. System prompt control

- **Flags** [DOCS cli-reference] [HELP]:
  - `--system-prompt <text>` and `--system-prompt-file <path>` replace the prompt.
  - `--append-system-prompt <text>` and `--append-system-prompt-file <path>` append to it.
  - `--system-prompt-snapshot on|off` (2.1.257+).
  - "To replace the default prompt and still append your own text, pass `--append-system-prompt` … together with `--system-prompt`". Combining a flag with its own file form needs 2.1.283+.
  - `--system-prompt-file` exists since 1.0.55. Both file forms work interactively per a 2.1.69 note [SOURCE]. Both available on 2.1.97.
- **Append vs replace guidance** [DOCS cli-reference]:
  - "Appending preserves the default tool guidance, safety instructions, and coding conventions."
  - "Replacing drops all of the default prompt, including tool guidance and safety instructions."
  - "If you replace it, the run also starts without the git status snapshot" [DOCS headless].
- **Where append text lands:** appended text is the tail of system block 2. File content comes first, then the inline text [OBSERVED s10; DOCS cli-reference says the same].
- **Resumes:** "Claude Code builds the system prompt once … and records it in the session … every later request uses that recorded prompt, including after you return with `--resume`" (2.1.265+; earlier versions differ) [DOCS cli-reference].
- **Subagent prompts:** `--append-subagent-system-prompt[-file]` (2.1.205+/2.1.261+, `-p` only) [DOCS cli-reference]. Not on 2.1.97.
- **`--exclude-dynamic-system-prompt-sections`** (2.1.98+): moves cwd, env and memory paths into the first user message for cache reuse [DOCS cli-reference; SOURCE]. **Not on 2.1.97.**
- **Output styles:** a persistent set of instructions changing "role, tone, and response format". Built-ins: Default, Proactive, Concise, Explanatory, Learning. Custom styles live in `~/.claude/output-styles` or `.claude/output-styles` [DOCS output-styles]. Output styles were "deprecated" in 2.0.30 and later revived [SOURCE]. Not useful for workers; prefer `--append-system-prompt-file`.
- **What the default prompt covers (documented):**
  - The `claude_code` preset has "tool usage instructions and security and safety instructions" [DOCS agent-sdk/modifying-system-prompts].
  - "Claude Code's prompt assumes a human is in the loop with access to a full toolset"; "most of Claude Code's prompt is coding guidance" [same].
  - "`claude -p` … uses the Claude Code system prompt by default" [same].
  - Reminders added outside the prompt [same]: project instructions, output style, commit/PR attribution, hook output, available skills, available subagents, task-list nudges, file-changed notes.
- **What I saw in `-p` on 2.1.328 [OBSERVED, not documentation; may differ under OAuth and in 2.1.97]:**
  - system[0] is a billing header line.
  - system[1] is "You are a Claude agent, built on Anthropic's Claude Agent SDK."
  - system[2] is about 7 KB with these sections: intro, a security-scope IMPORTANT paragraph, `# Harness` (markdown output, permission modes, system turns/hooks, pasted content, prefer dedicated tools, `file:line` refs), pronoun guidance, confirm-before-irreversible-actions, privacy, `# Session-specific guidance`, `# Memory` (auto-memory instructions and path), `# Environment` (model IDs, product surfaces), `# Context management` (auto-summarization; act, don't re-derive), and a games/IP note.
  - With `--bare`, the system prompt was just `CWD: …\nDate: …` (117 chars) and the tools were only `Bash, Edit, Read` [OBSERVED q5].

---

## 4. Headless output

- **`-p` / `--print`:** "Claude Code exits with code 0 on success and a non-zero code when the run fails … When a failure happens inside the run, such as missing authentication, Claude Code prints the failure as the result on stdout." Piped stdin is capped at 10 MB [DOCS headless].
- **`--output-format text|json|stream-json`** [HELP][DOCS cli-reference]. **stream-json requires `--verbose`:** observed `Error: When using --print, --output-format=stream-json requires --verbose`, exit 1 [OBSERVED q1]. `json` does not need it.
- **`--input-format stream-json`** (with `--output-format stream-json --verbose`). Observed input line: `{"type":"user","message":{"role":"user","content":"first message"}}` gave init, assistant, then result [OBSERVED q4]. `--replay-user-messages` echoes inputs.
- **`--include-partial-messages`** adds `stream_event` token deltas. **`--include-hook-events`** adds hook lifecycle events. SessionStart hook events are always included [DOCS cli-reference]; observed `hook_started` / `hook_response` events before `init` [OBSERVED s01].
- **Event shapes.** TS types: `SDKSystemMessage`, `SDKAssistantMessage`, `SDKUserMessage`, `SDKResultMessage`, `SDKPermissionDenial` [DOCS agent-sdk/typescript]. Observed lines, trimmed [OBSERVED v2.1.328]:
  ```json
  {"type":"system","subtype":"init","cwd":"/…/repo","session_id":"b379…","tools":["Task","Bash","Edit","Read","Write","…"],"mcp_servers":[{"name":"projsrv","status":"failed","source":"project"}],"model":"<model>","permissionMode":"dontAsk","apiKeySource":"ANTHROPIC_API_KEY","claude_code_version":"2.1.328","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":["…"],"plugins":[{"name":"cc-plugin-agents-md","path":"builtin"}],"slash_commands":["…"],"capabilities":["interrupt_receipt_v1","…"],"uuid":"…"}
  {"type":"assistant","message":{"id":"msg_…","role":"assistant","model":"<model>","content":[{"type":"tool_use","id":"toolu_01","name":"Write","input":{"file_path":"/…/src/ok.ts","content":"ok\n"}}],"stop_reason":null,"usage":{…}},"parent_tool_use_id":null,"session_id":"…","uuid":"…","timestamp":"…"}
  {"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01","type":"tool_result","content":"File created successfully at: /…/src/ok.ts …"}]},"parent_tool_use_id":null,"tool_use_result":{"type":"create","filePath":"/…/src/ok.ts",…},"tool_result_meta":[{"id":"toolu_01","permission_decision":{"decision":"accept","source":"config","reason_type":"rule"}}]}
  {"type":"system","subtype":"permission_denied","tool_name":"Write","tool_use_id":"toolu_02","decision_reason_type":"mode","message":"Permission to use Write has been denied because Claude Code is running in don't ask mode. …"}
  {"type":"result","subtype":"success","is_error":false,"num_turns":5,"result":"DONE","stop_reason":"end_turn","session_id":"…","duration_ms":…,"duration_api_ms":…,"total_cost_usd":0.0019,"usage":{"input_tokens":60,"output_tokens":83,"cache_read_input_tokens":0,…},"modelUsage":{"<model>":{"inputTokens":60,"outputTokens":83,"costUSD":0.0019,"contextWindow":1000000,…}},"permission_denials":[{"tool_name":"Write","tool_use_id":"toolu_02","tool_input":{…}}],"terminal_reason":"completed","subagent_stats":{…}}
  {"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":3,"result":null,"errors":["Reached maximum number of turns (2)"],"terminal_reason":"max_turns","stop_reason":"tool_use",…}   (process exit code 1)
  ```
  - Note: init `tools` lists **`Task`** while the API tool definition is named **`Agent`** [OBSERVED]. Docs say the Task tool was "renamed to Agent" in 2.1.63 and "`Task(...)` references … still work as aliases" [DOCS sub-agents].
  - Unknown event types appear (e.g. `system/ui_invalidate`), so consumers must ignore types they don't know.
  - Other documented events: `system/api_retry`, `system/compact_boundary`, `system/plugin_install`, `stream_event` [DOCS headless, agent-sdk].
- **Result subtypes:** `success | error_max_turns | error_max_budget_usd | error_during_execution | error_max_structured_output_retries`. "All result subtypes carry `total_cost_usd`, `usage`, `num_turns`, and `session_id`". `result` is only on success [DOCS agent-sdk/agent-loop].
  - **A `success` result can carry permission denials:** `permission_denials` was non-empty while `subtype=success`, `is_error=false` [OBSERVED p1, h1].
  - `total_cost_usd` is a "client-side estimate" [DOCS headless]. On a subscription it is not a bill.
- **`--max-turns N`** (print mode; "No limit by default"; env `CLAUDE_CODE_MAX_TURNS`). Hitting it gives `error_max_turns` and exit 1 [OBSERVED p5]. **`--max-budget-usd`** (2.0.28+) [SOURCE].
- **Structured output:** `--json-schema '<schema>'` with `--output-format json` puts the result in `structured_output` [DOCS headless].
  - Mechanism observed: an extra `StructuredOutput` tool is added: "Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once…" [OBSERVED q2].
  - "If a run ends without valid structured output … the response has no `structured_output` field" [DOCS headless].
  - Present well before 2.1.97 (fix entries at 2.1.22 and 2.1.84) [SOURCE].
- **`--no-session-persistence`:** "sessions are not saved to disk and cannot be resumed. Print mode only" [DOCS cli-reference]. Observed: no transcript file [OBSERVED q3]. Presence on 2.1.97 is [UNCLEAR]; the earliest changelog mention is 2.1.323, but the flag is older. Alternative: `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`.
- **SIGTERM:** exit 143, no result for the in-flight turn. Send SIGINT to end the turn [DOCS headless].
- **Background work:** `-p` may wait up to 10 min after the turn for background tasks (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`) [DOCS headless]. Consider `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for workers.

---

## 5. Limiting a worker

### 5.1 `--tools` vs `--allowedTools` vs `--disallowedTools` [DOCS cli-reference] [HELP]

- **`--tools "Read,Edit,Write,Glob,Grep"`** sets which **built-in tools exist** ("" for none, "default" for all). It "doesn't affect MCP tools; to deny those too, use `--disallowedTools "mcp__*"`."
  - Observed: request tools became `Edit, Glob, Grep, Read, DeferredToolPlaceholder, Write`. A Bash call got `<tool_use_error>Error: No such tool available: Bash. Bash is disabled for this session, in subagents as well as here.</tool_use_error>` [OBSERVED p4].
  - Since 2.1.0 [SOURCE].
- **`--allowedTools`** lists tools that "execute without prompting". It does **not** restrict which tools exist.
- **`--disallowedTools`** holds deny rules. "A bare tool name removes the matching tools from Claude's context … A scoped rule such as `Bash(rm *)` leaves the tool available and denies only calls that match." Observed: `Agent`, `WebFetch` and `WebSearch` were removed from the request [OBSERVED p6].
- **Order:** "Rules are evaluated in order: deny, then ask, then allow … An allow rule can't carve an exception out of a deny rule" [DOCS permissions]. A deny at any level wins, including over `--allowedTools`.
- **Gotcha:** list options are variadic (`<tools...>`, `<directories...>`, `<configs...>`). 2.1.326 fixed "a prompt typed after `--add-dir`, `--allowedTools` or another list option being dropped without a message" [SOURCE]. **On 2.1.97, put the prompt on stdin** (or before list flags).

### 5.2 Permission modes in `-p` [DOCS permission-modes]

- **`default` (Manual):** in `-p`, anything needing approval is denied unless an allow rule, hook or `--permission-prompt-tool` approves it. Observed: all writes and Bash denied with a `permission_denied` event each [OBSERVED p3].
  - "In Claude Code v2.1.302 or later, `claude -p` … with no permission mode set start in Manual mode."
  - "Before v2.1.302, these runs could start in auto mode if they didn't fetch feature flags (third-party provider or `DISABLE_TELEMETRY`)."
  - **Always pass `--permission-mode` explicitly.**
- **`acceptEdits`:** auto-approves edits and `mkdir, touch, rm, rmdir, mv, cp, sed` inside the working directories. Other Bash still needs allow rules. Protected paths still prompt.
  - Observed: Write outside `src/`, a Bash `mkdir -p other && echo > other/x`, and **an edit of CLAUDE.md** all ran [OBSERVED p2]. **Do not use alone for scoped workers.**
- **`plan`:** read-only. In `-p` "Plan mode keeps its blocks". Useful for a planning or review worker.
- **`dontAsk`:** "auto-denies every call that would otherwise prompt". Reads in the working directory, read-only Bash and allow-listed calls still run. "Locked-down CI and scripts".
  - Observed with `--allowedTools "Edit(/src/**)" Read`: `src/ok.ts` written; `other/bad.ts`, Bash and the CLAUDE.md edit denied; the run continued to `success` [OBSERVED p1].
  - **Availability on 2.1.97 is [UNCLEAR]:** the changelog never mentions its introduction. Verify that `claude --help` lists it.
- **`auto`:** a classifier model reviews actions. It needs a supported model/plan, and its classifier calls cost usage [DOCS permission-modes]. Not deterministic; not recommended as the boundary.
- **`bypassPermissions`** / `--dangerously-skip-permissions`: "Only use this mode in isolated environments". Deny rules and hooks still apply; allow rules have no effect [DOCS permission-modes].
- **Protected paths:** `.git`, `.claude`, `.vscode`, `.husky`, `.mcp.json`, `.npmrc`, `.bashrc`, etc. They are "Denied" in dontAsk and "Prompted" in default/acceptEdits [DOCS permission-modes].
- **Newer than 2.1.97:** `--permission-prompts none` (2.1.259) and `permissions.denyInsteadOfPrompting` (2.1.319).

### 5.3 Rule syntax; can Edit/Write be restricted to paths?

- **Format:** `Tool` or `Tool(specifier)`. Read/Edit specifiers use gitignore syntax [DOCS permissions]:
  - `//abs/path` is absolute.
  - `~/path` is home-relative.
  - `/path` is relative to the **settings source**. For CLI flags that means the primary working directory, so `Edit(/src/**)` from `--allowedTools` means `<cwd>/src/**`.
  - `path` / `./path` is relative to the cwd.
  - Allow rule `Edit(src/**)` matches only `<cwd>/src`. Deny rule `Read(secrets/**)` matches at any depth.
  - **`Edit(...)` rules cover Write, Edit and NotebookEdit.** `Write(path)` / `Grep(path)` / `Glob(path)` path rules are accepted but **don't match**; use `Edit(...)` / `Read(...)`.
  - Observed: `Edit(/src/**)` allowed a `Write` to `src/ok.ts` [OBSERVED p1].
- **Bash:** `Bash(npm test)` is exact. `Bash(npm run *)` is a prefix (space before `*` matters). `Bash(ls:*)` is the legacy equivalent of `Bash(ls *)`.
  - Compound commands split on `&& || ; | |& &` and newlines, and every part must be allowed.
  - Wrappers stripped before matching: `timeout`, `time`, `nice`, `nohup`, `stdbuf`, bare `xargs`.
  - `npx`, `devbox run` and `docker exec` are **not** stripped. "isn't a security boundary around the program" [DOCS permissions].
- **Redirects and tee targets** are checked against Edit rules. Observed: deny `Edit(**)` also denied `echo > other/x` in Bash [OBSERVED n1].
- **Negation** (`Edit(**)` + `Edit(!src/**)`) did **not** carve out `src/`; everything was denied with "File is in a directory that is denied by your permission settings." [OBSERVED n1, n2]. Don't rely on `!`.
- **Answer:** yes. In `dontAsk`, `--allowedTools "Edit(/pkg/a/**)"` restricts built-in file writes to that tree.
  - **But** (a) Bash and any script Claude runs can still write anywhere the OS allows; (b) trusted-repo project `allow` rules can widen it (§2.2); (c) on 2.1.97 Windows, path rules spelled with backslashes or different case never matched (fixed 2.1.162) [SOURCE], so write them with forward slashes.
- **Read deny rules:** `Read(./.env)` blocks Read/Grep/Glob and recognized Bash readers (`cat`, `head`, …), "best-effort" [DOCS permissions].
- **Agent rules:** `Agent(Explore)` deny disables one subagent type; the bare name `Agent` disables subagents.

### 5.4 Sandboxing, Windows, `--add-dir`

- **Bash sandbox:** "OS-level enforcement that restricts shell commands' filesystem and network access." It covers Bash/PowerShell/Monitor and child processes, not the file tools, hooks or MCP. Off by default. Enable with `sandbox.enabled` [DOCS sandboxing].
  - Default writes: working dir, temp, added dirs.
  - Network goes via a proxy with `allowedDomains` (empty by default).
  - Strict mode disables the unsandboxed retry.
- **"The sandbox runs on macOS, Linux, and WSL2. On native Windows, Claude Code runs commands unsandboxed."** [DOCS sandboxing]. Not available for the target Windows 11 native setup unless the workers run under WSL2.
- **`permissions.blockWritesOutsideWorkingDirectories`** (2.1.314+) and **`blockReadsOutsideWorkingDirectories`** limit file tools only [DOCS permissions]. Not on 2.1.97.
- **`--restricted`** (2.1.248+) removes code-running tools and ignores user/project/local settings [DOCS cli-reference]. Not on 2.1.97.
- **`--add-dir`** "Grants file access; Claude Code doesn't discover most `.claude/` configuration from these directories" [DOCS cli-reference]. Exceptions: skills, commands and agents, plus CLAUDE.md only with the env var [DOCS permissions].
- **Windows shells:** Git Bash is used for the Bash tool if installed; otherwise the PowerShell tool. On Windows with Git Bash the PowerShell tool is "on by default" for claude.ai accounts [DOCS tools-reference]. Hooks matching shells must use `Bash|PowerShell`.
  - "denying Bash also turns the PowerShell tool off" [DOCS tools-reference].
  - Glob/Grep are in the default tool set on Windows (absent by default on macOS/Linux, where `find`/`grep` via Bash are used).

### 5.5 Hooks

- **PreToolUse stdin JSON** [DOCS hooks], observed identically [OBSERVED guard log]:
  ```json
  {"session_id":"…","transcript_path":"…/<session>.jsonl","cwd":"/…/repo","prompt_id":"…","permission_mode":"acceptEdits","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"/abs/…/src/ok.ts","content":"ok\n"},"tool_use_id":"toolu_01"}
  ```
  - `tool_input.file_path` is always absolute. **On Windows it arrives with backslashes**, so normalize before comparing [DOCS hooks].
- **Deny methods** [DOCS hooks]:
  - (a) **exit code 2**: "Your stderr is the reason". Observed tool_result: `PreToolUse:Write hook error: [node …guard.js]: ORCH_GUARD(exit2): … is outside allowed paths` [OBSERVED h1].
  - (b) **exit 0 + JSON** `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`. Observed result: `PreToolUse:Write hook error: ORCH_GUARD(json): …` [OBSERVED h2].
  - Both blocked the call and added it to `permission_denials`.
  - Precedence: `deny > defer > ask > allow`.
  - **Exit 1 is a non-blocking error** ("If your hook is meant to enforce a policy, use `exit 2`").
  - `onFailure:"block"` (fail closed) needs 2.1.295+. The exec-form `args` field needs 2.1.139+.
  - A hook deny wins over allow rules; a hook "allow" cannot override deny/ask rules [DOCS permissions].
- **Enforced in `-p`:** yes, observed [OBSERVED h1, h2]. "Without `--bare`, a `-p` session runs the hooks in a project's `.claude/settings.json` … even in a folder you've never trusted" [DOCS headless].
  - Hooks from `--settings` run under `--setting-sources ""` [OBSERVED h1].
  - `--bare` runs no hooks at all, even from `--settings` [DOCS headless].
- **Gaps:**
  - A file-tool guard does **not** see Bash writes. Observed: `echo > other/viabash.txt` passed [OBSERVED h1]. Add a `Bash|PowerShell` matcher or remove the shells.
  - **Windows fail-open:** "Fixed PreToolUse and PermissionRequest hooks that set no shell failing open when Git for Windows isn't installed" (2.1.299), plus 2.1.309 and 2.1.310 fixes [SOURCE]. On 2.1.97 Windows, a guard hook may silently fail open, so require Git for Windows and still verify the diff.
  - A Stop hook (exit 2) can force "keep going until tests pass", capped at 8 consecutive blocks (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) [DOCS best-practices].

### 5.6 MCP

- **`--strict-mcp-config`** alone (no `--mcp-config`) gave `mcp_servers: []`, skipping `.mcp.json` [OBSERVED s08].
  - Explicit empty form also works: `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` [OBSERVED s07].
  - On Windows prefer a file path for `--mcp-config` to avoid quoting problems.
- claude.ai connectors load with a claude.ai login unless strict config, `disableClaudeAiConnectors`, or `ENABLE_CLAUDEAI_MCP_SERVERS=false` [DOCS agent-sdk/claude-code-features].
- In `-p`, `.mcp.json` servers are "Connected without asking, approved or not" [DOCS permissions]. Observed: `projsrv` connected [OBSERVED s01]. **Always pass `--strict-mcp-config`.**

### 5.7 `--no-session-persistence`, `--bare`

- `--no-session-persistence`: see §4.
- **`--bare` (2.1.81+)** [DOCS headless; SOURCE 2.1.81]:
  - Skips hooks, skills, plugins, MCP, auto memory and CLAUDE.md.
  - Tools are `Bash`, `Read` and `Edit` only (observed).
  - **Requires an API key:** "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)" [HELP]. It does not read `CLAUDE_CODE_OAUTH_TOKEN` [DOCS authentication].
  - **Unusable for Orchestra's subscription-only constraint.**

### 5.8 Env vars that switch billing or provider [DOCS authentication, env-vars]

- Credential precedence:
  1. `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` (also `CLAUDE_CODE_USE_ANTHROPIC_AWS`)
  2. `ANTHROPIC_AUTH_TOKEN`
  3. `ANTHROPIC_API_KEY`
  4. `apiKeyHelper`
  5. `CLAUDE_CODE_OAUTH_TOKEN`
  6. Anthropic profile (`ANTHROPIC_PROFILE`)
  7. subscription `/login`
- "In non-interactive mode (`-p`), the key is always used when present" (`ANTHROPIC_API_KEY`).
- `ANTHROPIC_BASE_URL` reroutes traffic.
- Subscription credentials on Windows live at `%USERPROFILE%\.claude\.credentials.json`. `CLAUDE_CONFIG_DIR` moves them.
- `claude setup-token` makes a 1-year subscription token for `CLAUDE_CODE_OAUTH_TOKEN`. It "can only make model requests" (no connectors).
- **Detecting billing source:**
  - init `apiKeySource` is `"none"` for a claude.ai login, and `"ANTHROPIC_API_KEY"` / `"apiKeyHelper"` / `"/login managed key"` when API-billed [DOCS agent-sdk/typescript ApiKeySource]. Observed `ANTHROPIC_API_KEY` with the mock key.
  - `claude auth status` (2.1.41+) prints JSON with `authMethod` in `none|claude.ai|oauth_token|api_key|api_key_helper|third_party` [DOCS cli-reference].

---

## 6. Subagents and delegation

- **Definitions:** `.claude/agents/*.md` (project), `~/.claude/agents/` (user), `--agents '<json>'` (session; file form 2.1.281+), managed settings, and plugins [DOCS sub-agents].
  - Frontmatter: `name`, `description` (both required), `tools`, `disallowedTools`, `model` (`sonnet|opus|haiku|fable|<id>|inherit`), `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `effort`, `isolation: worktree` (2.1.50+), `omitClaudeMd` (2.1.271+), `color`, `initialPrompt`.
  - "The body becomes the system prompt … Subagents receive only this system prompt plus basic environment details … not the Claude Code system prompt."
- **Startup context:** own system prompt, the delegation "Task message", CLAUDE.md files (except Explore/Plan and `omitClaudeMd`), git status, preloaded skills. Not included: parent history, auto memory, output style [DOCS sub-agents].
  - "If a rule must [reach the subagent], restate it in the prompt you give Claude when delegating."
- **Limits:**
  - Subagent `permissionMode` is ignored when the parent is in bypass/acceptEdits/auto.
  - `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3, 2.1.217+), `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (20).
  - `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` (`-p` only).
  - Each subagent's requests "count toward the same usage limits".
- **Tool name:** "In version 2.1.63, the Task tool was renamed to Agent. Existing `Task(...)` references … still work as aliases." [DOCS sub-agents]. In a worker, `--disallowedTools Agent` prevents fan-out inside the worker.
- **Agent teams:** "experimental and disabled by default" (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, research preview since 2.1.32). Has a lead, teammates, a shared task list and messaging. "use significantly more tokens"; "For sequential tasks, same-file edits, or work with many dependencies, a single session or subagents are more effective." [DOCS agent-teams]
  - Also: background sessions / `claude agents` (agent view), cross-session messaging, workflows [DOCS index].
  - These overlap with Orchestra's conductor but are Claude-only, so not a fit for a multi-engine conductor.
- **Guidance on parallel instances and delegation:**
  - Current docs [DOCS best-practices]:
    - Parallel sessions: "give each its own checkout so the edits can't collide" (`claude -w`, `.worktreeinclude` for gitignored files).
    - Independent reviewer: "A second session is also the easiest independent reviewer … hasn't watched it being written".
    - Before unattended runs, check five things: done-criteria, a self-check, what it may touch, what stops it, who signs off.
    - Script recipe: `claude --bare -p "… Reply OK or FAIL." --allowedTools "Read,Edit,Bash(git add *),Bash(git commit *)" --permission-mode dontAsk --max-turns 20`.
    - "Delegate to a subagent for a better answer" is listed as outdated: "A fresh reviewer does help … which is a different thing from delegating."
    - Specific prompts: "name the file, describe the symptom, and say what 'fixed' looks like".
    - "Give Claude something it can run that comes back pass or fail."
    - "ask Claude for evidence: the command it ran and its output".
    - Review prompts: "report gaps that affect correctness and skip style".
  - Original engineering post (Apr 18 2025, "no longer maintained") [SECONDARY https://www.anthropic.com/research/claude-code-best-practices]:
    - "have one Claude write code while another reviews or tests it".
    - "3-4 git checkouts in separate folders".
    - git worktrees "for multiple independent tasks".
    - headless "Fanning out … calling Claude programmatically for each and giving it a task and a set of tools", e.g. `claude -p "migrate foo.py … you MUST return the string OK … or FAIL" --allowedTools Edit Bash(git commit:*)`.
    - "use the --verbose flag for debugging … turning verbose mode off in production".
- **Worktrees and CLAUDE.md [OBSERVED v2.1.328]:**
  - Worktree created *inside* the repo (`repo/.orchestra/wt`): loaded `parent/CLAUDE.md` (monorepo ancestor) plus the worktree's own CLAUDE.md, .claude/CLAUDE.md and rules. It did **not** load the main checkout's `repo/CLAUDE.md` (no duplication).
  - Worktree *outside* the repo (`../wt`): only the worktree's own files; monorepo ancestors are lost (w1/w2).
  - The docs say subagent worktrees under `.claude/worktrees/` don't load the worktree-root CLAUDE.md [DOCS worktrees]. That rule applies to subagents only, not to a `claude -p` started with cwd = worktree.
  - Gitignored `CLAUDE.local.md` doesn't exist in fresh worktrees [DOCS memory].

---

## 7. Best practices for CLAUDE.md

Current docs [DOCS memory, best-practices]:

- **What to include:** "build commands, conventions, project layout, 'always do X' rules". Also: "the exact test, typecheck, and lint commands, and how to run a single test file"; "Places where the code is misleading"; "Decisions that aren't in the repo"; "Anything you've had to correct twice already". "If your repo already has [a check], the single most useful line in your CLAUDE.md is the command that runs it."
- **What to leave out:** "Only write down what Claude can't find by reading the repo". Outdated advice: "Describe your architecture and file layout in CLAUDE.md". Multi-step procedures go to skills; area-specific rules go to `.claude/rules/` with `paths:`.
- **Length:** "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence." Imports organize text but don't reduce context.
- **Style:** concrete and verifiable ("Use 2-space indentation" not "Format code properly"), grouped under headers and bullets, no contradictions ("Claude may pick one arbitrarily").
- **Emphasis:** advice has changed.
  - 2025 post: "tune instructions (e.g. adding emphasis with 'IMPORTANT' or 'YOU MUST') to improve adherence" [SECONDARY].
  - Current docs: "Add IMPORTANT or ALL CAPS … Older models sometimes needed the emphasis. Current ones follow a plainly worded line, and piling on emphasis mostly makes Claude over-apply the rule. If it's a rule that can't bend, turn it into a hook or a deny rule." "adding IMPORTANT probably won't fix it" [DOCS best-practices].
- **Enforcement vs guidance:** "CLAUDE.md files … are context, not enforced configuration"; "If something has to happen every time, make it a hook, a deny rule, or a managed setting." [DOCS memory, best-practices]
- **Keeping it current:**
  - Add a rule "when Claude makes the same mistake a second time" or a code review catches it.
  - Review periodically for outdated or conflicting lines.
  - Tools: `/doctor` proposes trims for content Claude can derive from the code; `/doctor prompt-audit` (requires v2.1.283) finds stale, conflicting or old-model instructions; `/init` generates a starting file.
  - "Personal preferences go in `CLAUDE.local.md`".
- Docs example of a good, short file:
  ```markdown
  # Commands
  - Install: pnpm install
  - Run one test file: pnpm vitest run path/to/file.test.ts
  - Typecheck: pnpm tsc --noEmit
  # Conventions
  - Use the error helpers in src/lib/errors.ts, never throw raw strings
  - src/legacy/ is still live but don't copy its patterns into new code
  # Gotchas
  - Integration tests need DATABASE_URL set, see .env.example
  ```

---

## 8. Version map: features against the user's v2.1.97 (2026-04-08) [SOURCE changelog + DOCS "requires" notes]

| Feature | Since | On 2.1.97? |
|---|---|---|
| `-p`, `--output-format json/stream-json` (+`--verbose`), `--input-format stream-json` | ≤0.2.66 | yes |
| `--allowedTools` / `--disallowedTools` | 0.2.82 | yes |
| `--settings` | 1.0.61 | yes |
| `--system-prompt-file`; `--append-system-prompt[-file]` | 1.0.55 / ≤2.1.69 | yes |
| `--max-budget-usd` | 2.0.28 | yes |
| `--setting-sources` | ≤2.0.24 | yes, **but** the history-deletion bug without `user` was fixed in 2.1.101 |
| `.claude/rules/` (+ `paths`; works in `-p` since 2.1.69) | 2.0.64 | yes (Read-triggered only) |
| `--tools` | 2.1.0 | yes |
| `--add-dir` + `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` | 2.1.20 | yes |
| `--json-schema` | ≤2.1.22 | yes |
| `--worktree` / subagent `isolation: worktree` | 2.1.49 / 2.1.50 | yes |
| Task tool renamed Agent | 2.1.63 | yes (use `Agent`; `Task` is an alias) |
| `--bare` (API key only) | 2.1.81 | yes (not usable on a subscription) |
| PowerShell tool (Windows) | 2.1.84 preview | yes (preview) |
| `dontAsk` permission mode | ? | **[UNCLEAR]**, verify with `claude --help` |
| `--strict-mcp-config` | <2.1.143 | yes (exact version [UNCLEAR]) |
| `--no-session-persistence` | ? | [UNCLEAR], verify |
| `--exclude-dynamic-system-prompt-sections` | 2.1.98 | **no** |
| deny rule beats a hook's `ask` | fix 2.1.101 | no |
| hook exec form `args` | 2.1.139 | no |
| Windows path rules with backslashes/case match | fix 2.1.162 | **no**: use forward slashes |
| `--append-subagent-system-prompt` | 2.1.205 | no |
| `--restricted` | 2.1.248 | no |
| `--permission-prompts none` | 2.1.259 | no |
| `permission_denials` includes path-scoped-deny blocks | fix 2.1.269 | no |
| `omitClaudeMd` | 2.1.271 | no |
| **native AGENTS.md** | 2.1.277 | **no**: use `@AGENTS.md` in CLAUDE.md |
| `--agents <file>` | 2.1.281 | no (inline JSON only) |
| rules/nested CLAUDE.md load on Write/Edit / Bash `cat` | 2.1.288 / 2.1.293 | no |
| hook `onFailure:"block"` | 2.1.295 | no |
| Windows hooks fail-open fixes | 2.1.299 / .309 / .310 | **no**: guard hooks may fail open |
| `-p` defaults to Manual mode | 2.1.302 | before that, could default to auto in some cases |
| `blockWritesOutsideWorkingDirectories` | 2.1.314 | no |
| `denyInsteadOfPrompting` | 2.1.319 | no |
| prompt after a list option no longer dropped | fix 2.1.326 | **no**: prompt via stdin |

---

## Implications for Orchestra

### Make the Claude worker follow project rules (and only project rules)

1. **Use one shared instruction file.**
   - Recommend projects keep `AGENTS.md` as the canonical file, plus a committed `CLAUDE.md` whose first line is `@AGENTS.md`. This is the documented pattern, it works on 2.1.97, and it is safe on Windows (no symlink).
   - Orchestra should *detect* this (warn if AGENTS.md exists without a CLAUDE.md import on CLI < 2.1.277). It should not write coding rules itself.
2. **Load project scope only:** `--setting-sources project`.
   - Gives repo + ancestor CLAUDE.md, `.claude/CLAUDE.md`, rules (incl. path-scoped and nested, lazily) and imports.
   - Excludes the user's personal `~/.claude/CLAUDE.md`, user hooks, user permissions, user MCP and any `apiKeyHelper` in user settings.
   - Also excludes CLAUDE.local.md, which is gitignored and absent from worktrees anyway.
   - Fallback when the user's repo has hooks or settings Orchestra must not run: Option B (§2.2: `--setting-sources "" --add-dir <wt>` + `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`). It loses path-scoped and nested rules.
   - **On 2.1.97, require an upgrade to ≥2.1.101 before using `--setting-sources` without `user`** (history-deletion bug), or accept that risk knowingly.
3. **Worktree placement:** create worktrees **inside** the repo (e.g. `<repo>/.orchestra/wt/<task>`, gitignored), or at least under the same ancestors, so monorepo-ancestor CLAUDE.md still loads. In 2.1.328 the main checkout's CLAUDE.md was not duplicated [OBSERVED].
   - Never place them in a path shaped like `…/claude*/<project>/<uuid>/scratchpad/…` (instruction files are refused there).
   - Copy needed gitignored files explicitly.
4. **Put Orchestra's worker contract in `--append-system-prompt-file`** (role, allowed paths, done-criteria, report format), not in CLAUDE.md, and keep it engine-neutral text.
   - Also set `--settings` `{"includeGitInstructions": false, "attribution": {"commit": "", "pr": ""}}` if the conductor owns commits.
   - Disable auto memory with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` so workers don't write personal memories or read cross-run ones.

### Limit the worker (defense in depth; the conductor's diff check stays the final authority)

5. **Baseline command line** (works with 2.1.97 flags; items marked † need verifying there):
   ```
   claude -p
     --output-format stream-json --verbose
     --setting-sources project
     --strict-mcp-config
     --settings <wt>/.orchestra/claude-worker-settings.json
     --permission-mode dontAsk            † (fallback: default; in -p both deny unapproved calls)
     --tools "Read,Edit,Write,Glob,Grep,Bash"   (drop Bash/PowerShell when the subtask needs no commands)
     --allowedTools "Read" "Edit(/<allowed>/**)" "Bash(npm test)" ...   (built from the planner's file scope + verify commands; forward slashes)
     --disallowedTools "Agent" "WebFetch" "WebSearch" "mcp__*"
     --max-turns <N>
     --append-system-prompt-file <contract.md>
     [--json-schema <report-schema>]  (or ask for a fenced JSON report in the final text)
     [--no-session-persistence]  † (or keep transcripts for debugging)
     [--model <alias>]
     prompt on stdin
   ```
   - Env:
     - **delete** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY/ANTHROPIC_AWS`, `ANTHROPIC_PROFILE`
     - set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `DISABLE_TELEMETRY=1` (optional), `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (optional)
   - Spawn with an args array (no shell). On Windows resolve `claude.exe` (native) or handle the npm `claude.cmd` shim.
6. **Guard hook in the worker settings file:** a Node `PreToolUse` hook (matcher `Write|Edit|NotebookEdit|Bash|PowerShell`) that denies file-tool paths outside the subtask's scope and shell commands outside an allow pattern.
   - Use exit 2 with stderr, or JSON `permissionDecision:"deny"` with a helpful reason. Normalize `\` to `/`.
   - Reason: trusted repos' project `permissions.allow` can widen `--allowedTools` (observed), and hook denials beat allow rules.
   - Caveats: project hooks also run in this mode; `disableAllHooks` would kill Orchestra's guard too; on 2.1.97 Windows hooks may fail open without Git for Windows.
   - A working example was built during the research (not committed).
7. **Don't trust "success":** treat the result as failed if `is_error` is true, if `subtype` ≠ `success`, if `permission_denials` is non-empty (worth reporting), or if `structured_output` is missing (when a schema is used).
   - Verify `init.apiKeySource == "none"` (subscription) and, preflight, `claude auth status` → `authMethod == "claude.ai"`.
   - Check `init.tools` and `init.mcp_servers` match expectations.
   - Ignore unknown event types.
   - Exit code: 1 on max-turns, 143 on SIGTERM.
8. **The conductor's post-run diff check is mandatory.** Bash writes, scripts, git hooks and native-Windows lack of sandbox mean no Claude-side mechanism fully restricts file changes on Windows (the Bash sandbox is WSL2/macOS/Linux only).
   - Run `git status --porcelain` / `git diff --name-only` in the worktree and reject changes outside scope, including `.git` hooks, `.claude/`, `CLAUDE.md` and `AGENTS.md`.
9. **Planning and review workers:** use `--permission-mode plan` (read-only, enforced in `-p`) or `--tools "Read,Glob,Grep"` with `dontAsk`.
10. **Parallelism:** all workers share one subscription's usage limits and one OAuth credential file. OAuth refresh-lock races were fixed in 2.1.248 and 2.1.285 [SOURCE], so cap concurrency (e.g. 2–4) and retry on `system/api_retry` with `rate_limit`.
11. **Recommend the user upgrade the CLI** (`claude update`) to a version that matches the VS Code extension (≥2.1.325). That brings native AGENTS.md, `--permission-prompts none`, `onFailure:"block"`, Windows hook fail-open fixes, the history-deletion fix and others. The conductor should read `claude --version` and the init `capabilities`, and gate features on them.

## Open questions / must verify on the user's machine (2.1.97 and Windows 11)

1. Does `claude --help` list `dontAsk` in `--permission-mode` choices, and `--no-session-persistence`, `--strict-mcp-config` and `--json-schema`? Save the full `claude --help` output from 2.1.97.
2. Run a dummy-key, local-mock test like mine on Windows (`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`) to observe on 2.1.97:
   - which CLAUDE.md files load with `--setting-sources project`;
   - whether `@AGENTS.md` imports work;
   - the import depth (4 or 5);
   - whether the add-dir trick works.

   (The research scripts were not committed; port the approach to Node.)
3. Windows: is Git for Windows installed? Is the Bash tool or the PowerShell tool active? Does a Node `PreToolUse` guard block (exit 2) and fail **closed** when the script is missing on 2.1.97?
4. Windows paths in `--allowedTools "Edit(/src/**)"`: do they match on 2.1.97 (pre-2.1.162 backslash/case bug)? Does `tool_input.file_path` arrive with backslashes?
5. Which `claude` binary does Orchestra spawn: the global CLI (2.1.97) or the VS Code extension's bundled one (2.1.325)? Native `claude.exe` or the npm `claude.cmd` shim? The shim matters for Node `spawn` without `shell:true`.
6. Has the user trusted the repo (`~/.claude.json` → `projects[<root>].hasTrustDialogAccepted`)? Does the repo's `.claude/settings.json` contain `permissions.allow` or hooks that would widen or affect workers?
7. On a subscription: init `apiKeySource` value (expected `"none"`), `claude auth status` JSON on 2.1.97, and whether any `ANTHROPIC_*` variables are set in the user's environment.
8. Behavior of several parallel `claude -p` workers on one OAuth login on 2.1.97: token refresh and rate limits.
9. Whether 2.1.97's `-p` default permission mode could be `auto` (pre-2.1.302 behavior), so always pass the flag.
10. External `@` imports (outside the worktree) in `-p` on 2.1.97: silently skipped or loaded?
