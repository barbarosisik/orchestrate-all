# C. Gemini CLI, Antigravity and how they load project rules

Researcher C, 2026-11-19. Scope: Gemini CLI as a headless, tightly limited worker; Google Antigravity; how both load instruction files.

Labels: [DOCS url], [SOURCE url], [HELP vX] (captured `--help`), [SECONDARY url], [UNCLEAR], [TEST] (something I ran locally).

Versions examined:
- **Gemini CLI `@google/gemini-cli` 0.69.0.** This is npm `latest`, published 2026-11-19T01:51Z (`0.70.0-preview.0` is also out). Source tag `v0.69.0` is commit `58840eb9`. I installed it into a throwaway folder with `--ignore-scripts` and cloned the source.
- **Antigravity CLI `agy` 1.5.12.** This is the current release manifest for `windows_amd64` and `linux_amd64` at `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<platform>.json`. Docs were read on 2026-11-19 from `https://antigravity.google/docs/*.md` (index: `https://antigravity.google/llms.txt`).
- **Antigravity App** is v2.33.0 (2026-11-17), per [DOCS https://antigravity.google/docs/changelog].

What I did not do:
- I did not log in, use credentials or send any prompt to a model.
- I downloaded the `agy` Linux binary (sha512 verified) only to read its strings statically. The permission system blocked running it, so I never executed it, and `agy --help` is NOT captured here.
- `gemini --help` was captured with an isolated empty HOME: [`gemini-help-0.69.0.txt`](gemini-help-0.69.0.txt).

---

## 0. Two facts that change the plan (read first)

1. **Gemini CLI no longer serves Google AI Pro/Ultra or free personal accounts.**
   - README of v0.69.0: "**No free tier or Google AI plans:** Free individual access and **Google AI Pro / Ultra** (Google One) moved to Antigravity CLI on June 18, 2026" [SOURCE https://github.com/google-gemini/gemini-cli/blob/v0.69.0/README.md].
   - Google's transition post: "On June 18, 2026, Gemini CLI and Gemini Code Assist IDE extensions will stop serving requests for Google AI Pro and Ultra, as well as those using it free of charge using Gemini Code Assist for individuals … Gemini CLI will remain accessible via paid Gemini and Gemini Enterprise Agent Platform API keys" [DOCS https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/].
   - Gemini CLI is now "Designed for **Gemini Code Assist Standard / Enterprise** licenses" and is "Not optimized for Gemini 4+" [SOURCE README].
   - Some in-repo docs (`docs/get-started/authentication.mdx`, `docs/resources/quota-and-pricing.md`) still describe Pro/Ultra login and are **stale**. The README and blog post supersede them.
   - **Consequence:** with a consumer Google login and no API key, the Gemini CLI is **not** a usable stand-in. The official headless entry point for the user's plan is the **Antigravity CLI `agy`** (Go binary, `agy -p`).
2. **Antigravity now has an official CLI with a documented headless mode, but the consumer terms restrict wrapping it.**
   - Surfaces: "Antigravity App (v2.5+) · Antigravity CLI (`agy` · v1.2+) · IDE extensions · Antigravity SDK (Python)" [DOCS https://antigravity.google/docs/overview.md].
   - FAQ: "Antigravity CLI headless mode (`agy -p`) is intended for direct scripting and CI workflows. **Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans.**" [DOCS https://antigravity.google/docs/faq.md].
   - Terms: "You must not abuse … the Service. This includes … using the Service in connection with products not provided by us. Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts." [DOCS https://antigravity.google/terms].
   - **Consequence:** whether Orchestra (a third-party conductor, orchestrated by Claude Code or Codex) may spawn `agy -p` on a consumer plan is a **policy/ToS decision for the user**, not a technical question. See Implications.

"Neon": **Gemini 4 Neon exists.**
- Launched in Antigravity on **2026-11-18** [DOCS https://antigravity.google/docs/changelog.md]. It is "the default model for new conversations if you haven't chosen a model".
- Plans: Google AI Ultra, Google AI Pro (paid, or trial on eligible devices), Gemini Enterprise. **Not** Free or Plus.
- Context: up to 512K tokens. Thinking levels: Low / Medium / High (default) / Extra (`xhigh`) [DOCS https://antigravity.google/docs/models.md].
- CLI model slugs: `gemini-4-neon-xhigh`, `gemini-4-neon-high`, `gemini-4-neon-medium`, `gemini-4-neon-low`. Orchestrator variant: `gemini-pro-orchestrator-neon`, shown as "Orchestrator (Neon)": Neon plans, Gemini 4 Hydrogen implements [DOCS https://antigravity.google/docs/cli/headless.md, models.md].
- Not present in Gemini CLI 0.69.0 (no "neon" or "gemini-4" string in source or bundle) [SOURCE packages/core/src/config/models.ts; TEST grep of bundle].

---

## 1. Instruction files in Gemini CLI (v0.69.0)

### Hierarchy

Loading code: `MemoryContextManager.discoverMemoryPaths()` [SOURCE packages/core/src/context/memoryContextManager.ts].

1. **Global:** `~/.gemini/<each context filename>`, always loaded, even in untrusted folders [SOURCE memoryDiscovery.ts `getGlobalMemoryPaths`; memoryContextManager.ts].
2. **Extension context files:** from active extensions.
3. **Environment/workspace ("project"):**
   - For each workspace directory (cwd plus `--include-directories`), the CLI walks **upward to the first directory containing a boundary marker**. The default marker is `.git` (setting `context.memoryBoundaryMarkers`, default `[".git"]`; an empty array disables parent traversal) [SOURCE memoryDiscovery.ts `getEnvironmentMemoryPaths`/`findProjectRoot`; DOCS docs/reference/configuration.md].
   - The marker check is plain `fs.access`, and the source comment says "marker can be a directory (normal repos) or a file (submodules / worktrees)". So **in a git worktree the ceiling is the worktree root**, and the checked-out `AGENTS.md` is used.
   - **Only loaded when the folder is trusted** (`this.config.isTrustedFolder() ? … : []`) [SOURCE memoryContextManager.ts].
4. **User-private project memory:** `~/.gemini/tmp/<project-id>/memory/MEMORY.md` (or a legacy GEMINI.md there) [SOURCE storage.ts `getProjectMemoryDir`; memoryDiscovery.ts `getUserProjectMemoryPaths`].
5. **JIT subdirectory memory:**
   - "When a tool accesses a file or directory, the CLI automatically scans for `GEMINI.md` files in that directory and its ancestors up to a trusted root" [DOCS docs/cli/gemini-md.md; SOURCE `loadJitSubdirectoryMemory`].
   - There is **no longer an eager downward scan**; subdirectory files are loaded lazily.
   - Setting `context.discoveryMaxDirs` (default 200) still exists [DOCS configuration.md].

Ordering: within an upward walk, files are "ordered by directory level (root to leaf), with all filename variants grouped together per directory". Files are deduplicated by device and inode [SOURCE memoryDiscovery.ts].

### `context.fileName`
- "The name of the context file or files to load into memory. Accepts either a single string or an array of strings." Type `string | string[]`, default `undefined`, which means `GEMINI.md` [DOCS configuration.md; SOURCE settingsSchema.ts; memoryTool.ts `DEFAULT_CONTEXT_FILENAME = 'GEMINI.md'`].
- The doc example is exactly `{"context":{"fileName":["AGENTS.md","CONTEXT.md","GEMINI.md"]}}` [DOCS docs/cli/gemini-md.md]. So **`["AGENTS.md","CLAUDE.md","GEMINI.md"]` is valid.**
- The first name is the "current" filename that memory-writing features use (`getCurrentGeminiMdFilename()` returns `[0]`) [SOURCE memoryTool.ts].
- The **global** lookup also uses this list (`~/.gemini/AGENTS.md`, …) [SOURCE getGlobalMemoryPaths]. Side effect: with `fileName: ["AGENTS.md"]` only, the user's `~/.gemini/GEMINI.md` is not loaded (useful for isolation).
- The old top-level `contextFileName` key is not in the 0.69 schema; use `context.fileName`. Migration behaviour for the old key: [UNCLEAR].

### Imports
- Syntax `@./path.md`, `@../x.md`, `@/abs/path.md`, nested.
- Circular-import detection; **max import depth 5**; `@` inside code blocks or spans is ignored; missing files fail "gracefully with an error comment".
- `validateImportPath` restricts imports to allowed directories [DOCS docs/reference/memport.md].
- Setting `context.importFormat` (`tree` | `flat`) [SOURCE].

### `/memory` and other context controls
- `/memory show` shows the concatenated memory; `/memory reload` rescans [DOCS gemini-md.md]. These are interactive only.
- **No `save_memory` tool anymore.** The model edits GEMINI.md and MEMORY.md files directly with edit tools [SOURCE prompts/snippets.ts `toolUsageRememberingFacts`]. Orchestra's per-file allowlist must therefore cover or deny edits to `GEMINI.md`/`AGENTS.md`.
- **`.geminiignore`:** gitignore syntax, project root, "tools that respect this file will exclude matching files". Toggles: `context.fileFiltering.respectGeminiIgnore` / `respectGitIgnore` (default true) and `customIgnoreFilePaths` [DOCS docs/cli/gemini-ignore.md, configuration.md].
- **Size limits:** no explicit byte cap on GEMINI.md found; only import depth 5 and `discoveryMaxDirs` 200 [SOURCE; UNCLEAR whether a hard cap exists elsewhere].

### Where memory goes in the prompt
- Memory is appended to the **end of the system instruction** by `renderFinalShell(basePrompt, userMemory)` [SOURCE packages/core/src/prompts/promptProvider.ts, snippets.ts].
- The block is wrapped as:
  ```
  <loaded_context>
  <global_context>…</global_context>
  <user_project_memory>…</user_project_memory>
  <extension_context>…</extension_context>
  <project_context>…</project_context>
  </loaded_context>
  ```
- Each file is wrapped as `--- Context from: <path> --- … --- End of Context from: <path> ---` [SOURCE memoryDiscovery.ts `concatenateInstructions`].
- Core mandate: "**Contextual Precedence:** Instructions found in `GEMINI.md` [or the configured names] files are foundational mandates. They take absolute precedence over the general workflows and tool defaults described in this system prompt."
- Conflict order: `<project_context>` > `<extension_context>` > `<global_context>` [SOURCE snippets.ts].
- MCP server instructions are appended to the project memory [SOURCE memoryContextManager.ts].

### Disabling user-level memory and settings while keeping project files
- `GEMINI_CLI_HOME` moves the whole `~/.gemini` (settings, GEMINI.md, trusted folders, **and `oauth_creds.json`**) [SOURCE packages/core/src/utils/paths.ts `homedir()`; storage.ts `getOAuthCredsPath`; DOCS configuration.md]. That loses the user's login (or needs keychain storage), so it does not fit "use the user's own login".
- There is **no flag to skip only global memory** [UNCLEAR, none found].
- Workarounds:
  - Choose `context.fileName` names the user doesn't have in `~/.gemini/`.
  - Override settings through the system-settings file (§5).

## 2. Headless mode (Gemini CLI 0.69.0)

### Package and binary
- Package `@google/gemini-cli`, `"bin": {"gemini": "bundle/gemini.js"}`, `"type":"module"`, `engines.node >=20` [TEST package.json].
- On Windows, spawn `node <npm-global-prefix>\node_modules\@google\gemini-cli\bundle\gemini.js` (the global prefix is usually `%APPDATA%\npm`).
- The CLI **relaunches itself in a child Node process** (to set `--max-old-space-size`) unless `GEMINI_CLI_NO_RELAUNCH` is set [SOURCE packages/cli/src/gemini.tsx, utils/relaunch.ts]. Kill the whole process tree on timeout, or set that variable.

### `--help` (v0.69.0), key lines [HELP v0.69.0, full text in [`gemini-help-0.69.0.txt`](gemini-help-0.69.0.txt)]
```
-m, --model  -p, --prompt "Run in non-interactive (headless) mode with the given prompt. Appended to input on stdin (if any)."
--skip-trust "Trust the current workspace for this session."
-w, --worktree  -s, --sandbox  -y, --yolo
--approval-mode [choices: "default","auto_edit","yolo","plan"]
--policy  --admin-policy  --acp  --allowed-mcp-server-names
--allowed-tools "[DEPRECATED: Use Policy Engine instead…]"
-e, --extensions  --include-directories  -o, --output-format [text|json|stream-json]
-r/--resume  --session-id  --session-file  --list-sessions
Commands: mcp, extensions, skills, hooks, gemma, models
```

### Prompt input
- Headless starts when `-p` is given or stdin/stdout is not a TTY (or `CI=true`) [DOCS docs/cli/headless.md; SOURCE core/utils/headless.ts].
- Piped stdin is read, and `-p` text is appended after it [HELP; SOURCE gemini.tsx]. Large prompts can go through stdin, which avoids the Windows command-line length limit.

### `--output-format json`
- Shape: `{session_id?, response?, stats?: SessionMetrics, error?: {type,message,code?}, warnings?}` [SOURCE packages/core/src/output/types.ts].
- `SessionMetrics` contains:
  - `models[name]`, with `api{totalRequests,totalErrors,totalLatencyMs}` and `tokens{input,prompt,candidates,total,cached,thoughts,tool}`;
  - `tools{totalCalls,totalSuccess,totalFail,totalDurationMs,totalDecisions,byName}`;
  - `files{totalLinesAdded,totalLinesRemoved}` [SOURCE telemetry/uiTelemetry.ts].
- [TEST] real output with no auth configured (exit 41):
  ```json
  {"session_id":"b2a06995-…","error":{"type":"Error","message":"Please set an Auth method in your …/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA","code":41}}
  ```

### `--output-format stream-json` (JSONL)
Event types [SOURCE types.ts]:
- `init{session_id,model}`
- `message{role:user|assistant,content,delta?}`
- `tool_use{tool_name,tool_id,parameters}`
- `tool_result{tool_id,status:success|error,output?,error?}`
- `error{severity:warning|error,message}`
- `result{status,error?,stats{total_tokens,input_tokens,output_tokens,cached,input,duration_ms,tool_calls,models{<name>:{total_tokens,input_tokens,output_tokens,cached,input}}}}`

Every event has a `timestamp`. Sample from the test snapshots [SOURCE packages/cli/src/__snapshots__/nonInteractiveCli.test.ts.snap]:
```
{"type":"init","timestamp":"…","session_id":"test-session-id","model":"test-model"}
{"type":"message","timestamp":"…","role":"assistant","content":"Thinking...","delta":true}
{"type":"tool_use","timestamp":"…","tool_name":"testTool","tool_id":"tool-1","parameters":{"arg1":"value1"}}
{"type":"error","timestamp":"…","severity":"error","message":"Maximum session turns exceeded"}
{"type":"result","timestamp":"…","status":"success","stats":{"total_tokens":0,"input_tokens":0,"output_tokens":0,"cached":0,"input":0,"duration_ms":…,"tool_calls":0,"models":{}}}
```

### Exit codes
- [DOCS headless.md] lists 0, 1, 42 (input) and 53 (turn limit).
- The source adds 41 (auth), 44 (sandbox), 52 (config), 54 (tool execution), 55 (untrusted workspace) and 130 (cancel) [SOURCE core/utils/errors.ts, exitCodes.ts].

### Approval modes
`--approval-mode default|auto_edit|yolo|plan`. Settings `general.defaultApprovalMode` accept only `default|auto_edit|plan`: "YOLO mode … can only be enabled via command line" [DOCS configuration.md]. Without a TTY the built-in policies behave as follows [SOURCE packages/core/src/policy/policies/*.toml]:
- **default:**
  - `replace`, `run_shell_command`, `write_file`, `activate_skill` and `web_fetch` are **denied** (`interactive=false`, priority 10).
  - Read-only tools are allowed: `glob`, `grep_search`, `list_directory`, `read_file`, `google_web_search`, `codebase_investigator`, …
  - `ask_user` is always denied in headless runs. Any `ask_user` decision becomes deny [DOCS docs/reference/policy-engine.md].
  - Net effect: **default headless = read-only worker.**
- **auto_edit:**
  - `write_file` and `replace` are allowed at priority 15, gated by the **`allowed-path` safety checker**.
  - The checker denies paths outside cwd and workspace dirs, denies "sensitive" segments, and **asks (so denies in headless) for any `.gemini` or `.vscode` path** [SOURCE packages/core/src/safety/built-in.ts].
  - `web_fetch` is allowed. Shell stays denied.
- **yolo:** `toolName="*" decision=allow priority=998` in the *default* tier, which means everything including the shell and MCP. Any user-tier or admin-tier deny rule still wins (tiers: default 1, extension 2, workspace 3, user 4, admin 5) [SOURCE policy/config.ts].
- **plan:**
  - Catch-all deny (priority 40) except read-only tools and writing `.md` plans into the plans dir.
  - `exit_plan_mode` is auto-allowed when non-interactive.
  - The docs still say the CLI flag is "under development" [DOCS configuration.md] (stale).
  - A good fit for planning-only or review workers.

### Tool limiting (Policy Engine)
- `--allowed-tools` is **deprecated** in favour of the Policy Engine [HELP]. `tools.exclude` is deprecated in favour of policy `deny` rules [DOCS policy-engine.md].
- Settings still work and become user-tier rules [SOURCE policy/config.ts]:
  - `tools.core` is an allowlist: each listed tool is allowed (priority 4.25) and `*` is denied just below it.
  - `tools.allowed`: skips confirmation; `run_shell_command(git)` syntax narrows to a prefix and adds a deny for other shell commands.
  - `tools.confirmationRequired`.
  - `tools.exclude`: deny at priority 4.4.
- Denied global tools "are completely excluded from the model's memory" (not even offered) [DOCS].
- **TOML rules:**
  - Fields: `toolName`, `mcpName`, `argsPattern` (regex on stable JSON of the args), `commandPrefix`, `commandRegex`, `decision allow|deny|ask_user`, `priority 0–999`, `modes`, `interactive`, `denyMessage`, `subagent`, `toolAnnotations`, `allowRedirection`, `allowCommandSubstitution` [DOCS policy-engine.md].
  - **`--policy <paths>` replaces the user policy dir `~/.gemini/policies`** for that run ("When provided, these replace the default user policies directory") [SOURCE policy/config.ts `getPolicyDirectories`]. This is the right per-worker hook.
  - `--admin-policy` adds admin-tier files, but these are **ignored if `.toml` files exist in the system policy dir** (`C:\ProgramData\gemini-cli\policies` on Windows) [DOCS].
  - Workspace-tier policies (`.gemini/policies`) are **currently non-functional** (issue #18186) [DOCS].
- **`--include-directories`** adds workspace roots, "5 directories can be added at maximum" [DOCS configuration.md]. The safety checker allows writes there.

### Trusted folders
- `security.folderTrust.enabled` **defaults to `true` in 0.69.0** [SOURCE settingsSchema.ts]. The docs page saying "disabled by default" is stale [DOCS docs/cli/trusted-folders.md].
- **Headless in an untrusted folder throws `FatalUntrustedWorkspaceError` (exit 55)**: "To proceed, either use `--skip-trust`, set the `GEMINI_CLI_TRUST_WORKSPACE=true` environment variable, or trust this directory…" [SOURCE packages/cli/src/utils/userStartupWarnings.ts].
- Untrusted means:
  - no workspace `.gemini/settings.json`;
  - no project `.env`;
  - no MCP;
  - no custom commands;
  - **no project GEMINI.md/AGENTS.md** [DOCS trusted-folders.md; SOURCE memoryContextManager].
- In my no-credential test the auth check (exit 41) fired before the trust check [TEST].
- Every fresh Orchestra worktree is untrusted, so pass `--skip-trust`. Otherwise you get exit 55, or the project rules are silently not loaded.

### Checkpointing and sessions
- `general.checkpointing.enabled`, default false. When on, it keeps a shadow git repo in `~/.gemini/history/<project>` plus checkpoints in `~/.gemini/tmp/<project>/checkpoints` [DOCS docs/cli/checkpointing.md].
- Sessions are stored in `~/.gemini/tmp/<project>/chats/`. Retention is `general.sessionRetention.*` (default 30 days) [DOCS session-management.md, configuration.md].
- `--session-id <uuid>`, `--resume`.
- A project registry is created at `~/.gemini/projects.json` [TEST: created on first run].

## 3. Sandboxing (Gemini CLI)
- How to enable: `-s/--sandbox`, `GEMINI_SANDBOX=true|docker|podman|sandbox-exec|runsc|lxc`, or setting `tools.sandbox` (also `"windows-native"`). Precedence is flag > env > settings [DOCS docs/cli/sandbox.md, configuration.md].
- Container mounts:
  - Docker/Podman mount the project.
  - `SANDBOX_MOUNTS=from:to:opts` adds mounts (default `ro`).
  - `tools.sandboxAllowedPaths`; `tools.sandboxNetworkAccess` (default false).
- macOS Seatbelt profiles: `permissive-open` (default; "confining writes to the project folder"), `restrictive-*`, `strict-*` [DOCS].
- **Windows native sandbox:**
  - Uses `icacls` to set a "Low Mandatory Level" on paths it writes.
  - "These integrity level changes are persistent on the filesystem" [DOCS sandbox.md §3].
  - Docker or Podman also work on Windows. Any extra Windows details: [UNCLEAR].
- `security.toolSandboxing` (default false): per-tool sandboxing instead of whole-process sandboxing [DOCS].
- **Without a sandbox:**
  - `write_file` and `replace` run `config.validatePathAccess()`, which refuses paths outside workspace dirs [SOURCE tools/write-file.ts, edit.ts, config.ts].
  - In auto_edit the allowed-path checker also blocks this.
  - **Nothing stops `run_shell_command` from writing anywhere.** Keep the shell denied, or allow only exact command prefixes. The conductor's post-run diff check remains the real enforcement.

## 4. System prompt (Gemini CLI)
- Assembly in `getCoreSystemPrompt` [SOURCE packages/core/src/prompts/snippets.ts]:
  1. Preamble: "You are Gemini CLI, an **autonomous** CLI agent specializing in software engineering tasks. You are currently operating in **<Mode>** mode." (non-interactive wording).
  2. **Core Mandates:** security; context efficiency; Engineering Standards (contextual precedence of GEMINI.md; conventions; no lint suppression; tests required; "For bug fixes, you must empirically reproduce the failure…").
  3. Sub-agents.
  4. Agent skills.
  5. Hook context.
  6. **Primary Workflows:** "Research -> Strategy -> Execution", each sub-task done as "Plan -> Act -> Validate"; "Validation is the only path to finality"; strategic re-evaluation after 3 failed fixes.
  7. Operational guidelines.
  8. Sandbox or git notes.
  9. Then `<loaded_context>` memory, appended last.
- Headless-specific mandate: "**Non-Interactive Environment:** … Do not ask the user questions … Use your best judgment to complete the task."
- **Important wording trap:**
  - "Assume all requests are Inquiries unless they contain an explicit instruction to perform a task. For Inquiries … you MUST NOT modify files."
  - Orchestra prompts must therefore be explicit *Directives* ("Implement …; modify only these files …").
- `GEMINI_SYSTEM_MD` behaviour:
  - Values `true|1` mean `./.gemini/system.md`; any other value is a path; `false|0` disables it. "This is a full replacement, not a merge."
  - Supports `${AgentSkills}`, `${SubAgents}`, `${AvailableTools}`, `${<tool>_ToolName}`.
  - A missing file errors with `missing system prompt file '<path>'` [DOCS docs/cli/system-prompt.md].
  - **Memory is still appended after a custom system.md** (renderFinalShell runs in both paths) [SOURCE promptProvider.ts].
- `GEMINI_WRITE_SYSTEM_MD=1|<path>` writes the effective prompt to a file [DOCS]. Exporting it requires one run, which requires auth.

## 5. Isolation from the user's setup (Gemini CLI)

### Settings layers
Lowest to highest [DOCS configuration.md]:
1. defaults;
2. system-defaults (`C:\ProgramData\gemini-cli\system-defaults.json`, or `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`);
3. user `~/.gemini/settings.json`;
4. project `.gemini/settings.json` (trusted folders only);
5. **system settings** (`C:\ProgramData\gemini-cli\settings.json`, or **`GEMINI_CLI_SYSTEM_SETTINGS_PATH`**), which "override all other settings files";
6. environment variables;
7. CLI flags.

**Orchestra can point `GEMINI_CLI_SYSTEM_SETTINGS_PATH` at its own per-run file to force keys.**

### Admin settings
`admin.*` keys from files are **ignored**: "Remote admin settings always take precedence and file-based admin settings are ignored" [SOURCE packages/cli/src/config/settings.ts]. So `admin.mcp.enabled:false` cannot be set locally.

### MCP
- `--allowed-mcp-server-names X` replaces `mcp.allowed`. A non-empty list blocks every server not in it [SOURCE core/tools/mcp-client-manager.ts `isBlockedBySettings`]. **Pass a dummy name (e.g. `__orchestra_none__`) and no MCP server connects.**
- Untrusted folders also skip MCP.
- Policy `mcpName="*"` deny is a second layer.

### Extensions
`-e none` disables all extensions [DOCS configuration.md CLI args].

### Skills, subagents and hooks
- Skills: `skills.enabled:false`.
- Subagents: `experimental.enableAgents:false`, or a policy deny on `invoke_agent`.
- Hooks: `hooksConfig.enabled`. Hooks merge from project, user, system and extension layers [DOCS docs/hooks/index.md]. Project hooks are fingerprinted and warned about.
- Hook `BeforeTool` can return `{"decision":"deny","reason":…}` or exit 2 to block a tool call. The input includes `tool_name` and `tool_input` [DOCS docs/hooks/reference.md]. This is usable as a file-allowlist guard.

### Auth types
`oauth-personal` (Login with Google), `gemini-api-key`, `vertex-ai`, `compute-default-credentials`, `gateway`, `cloud-shell` [SOURCE core/core/contentGenerator.ts].
- Environment detection order: `GOOGLE_GENAI_USE_GCA=true` → oauth; `GOOGLE_GENAI_USE_VERTEXAI=true`; `GOOGLE_GEMINI_BASE_URL` → gateway; `GEMINI_API_KEY`; `CLOUD_SHELL`/`GEMINI_CLI_USE_COMPUTE_ADC`.
- The configured `security.auth.selectedType` is used first.
- **`security.auth.enforcedType`** makes headless runs fail if the effective type differs [SOURCE validateNonInterActiveAuth.ts]. Set it to `oauth-personal` in the forced system settings so a stray `GEMINI_API_KEY` cannot switch billing. Also strip `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_*`, `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_GEMINI_BASE_URL` from the worker environment.
- Note: project `.env` files are loaded (trusted folders) and can set these variables. Use `advanced.ignoreLocalEnv:true`.
- Quotas for subscription logins: no longer applicable to Pro/Ultra (§0). For Code Assist Standard/Enterprise the stale docs table says 1,500 / 2,000 requests per user per day [DOCS docs/resources/quota-and-pricing.md, stale].

### Checking login without reading OAuth files
- There is no `gemini auth status` command [HELP].
- `gemini models` works fully offline, without auth [TEST], so it is not a login check.
- Practical fail-fast:
  - Set `NO_BROWSER=true` on workers. With no valid cached credentials and a non-interactive run, this throws `FatalAuthenticationError` ("Manual authorization is required but the current session is non-interactive…") → **exit 41** [SOURCE core/code_assist/oauth2.ts].
  - Without `NO_BROWSER` it prints "Opening authentication page in your browser. Do you want to continue? [Y/n]:" and **waits on stdin** [SOURCE utils/authConsent.ts]. This is a hang risk.
- Credentials can live in the keychain (encrypted storage) or `~/.gemini/oauth_creds.json` [SOURCE oauth2.ts].

## 6. Antigravity (as of 2026-11-19)

### What it is
- One "agent harness" behind several surfaces [DOCS overview.md]:
  - **Antigravity App** (desktop, v2.x, "evolved from the Agent Manager into a standalone desktop command center");
  - **Antigravity CLI** (`agy`, Go, v1.5.x);
  - **Antigravity IDE** (standalone editor);
  - **IDE extensions** (VS Code, JetBrains, Visual Studio, Zed, Xcode, Eclipse, Android Studio);
  - **SDK** (Python `google-antigravity`).
- The VS Code extension "automatically installs the local `agy` backend service on first launch". Setting `antigravity.serverPort` is "Port for the Antigravity background server (`agy --hub`)" [DOCS https://antigravity.google/docs/ide/extensions/vscode.md]. This is almost certainly the "CLI binary" in the user's extension README. Where it lives on the user's machine is [UNCLEAR].

### Rule files [DOCS https://antigravity.google/docs/rules.md, customization-discovery.md]
- **Workspace:** `AGENTS.md`, `GEMINI.md`, `.agents/AGENTS.md`, `.agents/GEMINI.md`, `.agents/rules/*.md` (legacy `.agent/rules/*.md`; `_agents/` and `_agent/` are also recognised).
  - Read "in your workspace folder and in any parent folder up to the repository root". It "stops at the repository root".
  - "**doesn't load rules from subfolders below the workspace folder**, even when the agent reads or edits files there". This differs from Gemini CLI's JIT loading.
- **Global:**
  - `~/.gemini/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.gemini/config/AGENTS.md`, `~/.gemini/config/GEMINI.md` (always on);
  - `~/.gemini/config/rules/*.md` (frontmatter required);
  - plugin rules.
- **No CLAUDE.md support** (not in any listed path).
- Rules are cumulative ("Antigravity loads every rule it finds"). The migration page says the Gemini CLI and Antigravity "use identical workspace context rules" (GEMINI.md and AGENTS.md) [DOCS cli/gcli-migration.md].
- `.agents/rules/*.md` frontmatter:
  - `trigger: always_on | model_decision | glob | manual`, plus `description`, `globs`. A missing or invalid trigger is silently dropped.
  - AGENTS.md and GEMINI.md take no frontmatter and are always on.
  - The CLI doesn't support `manual` rule mentions.
- Includes: `@[label](path)` inlines content (frontmatter stripped); `@file` only rewrites to an absolute path.
- Limits: **24,000 bytes per file** (truncated) and a **20,000-token aggregate** budget for global plus always_on rules. Over budget, the largest files are demoted to pointers.
- `.agents/rules.json` manifests (`entries`, `inherits`, `exclude`).
- Repo-root `.gemini/config.json` `personal_customization_dir` (per-user folders).
- One secondary blog claims GEMINI.md beats AGENTS.md when both exist [SECONDARY https://thepromptshelf.dev/blog/google-antigravity-agents-md-rules-guide-2026]. The official docs say rules are cumulative [UNCLEAR on precedence].

### MCP [DOCS mcp.md, settings.md]
- Global config: `~/.gemini/config/mcp_config.json`. Workspace config: `<workspace>/.agents/mcp_config.json`. Plugin `mcp_config.json`.
- Per-server keys: `disabled`, `disabledTools`, `enabledTools`, `serverUrl` (Streamable HTTP only), `timeoutSeconds`.
- MCP tools default to **Ask**, which is soft-denied in headless runs. Permission `mcp(*)` in the deny list blocks them all.
- There is no CLI flag to skip loading MCP servers [UNCLEAR, none documented].
- (The paths in the user's VS Code extension README match these.)

### Official CLI and headless entry point [DOCS https://antigravity.google/docs/cli/headless.md, cli/reference.md]
- **Install on Windows:**
  - `irm https://antigravity.google/cli/install.ps1 | iex`.
  - The binary goes to **`%LOCALAPPDATA%\agy\bin\agy.exe`** (a real `.exe`, no `.cmd` shim) [DOCS getting-started.md; SOURCE install.ps1].
  - It "automatically self-updates in the background" [SOURCE install.ps1].
- **Flags** (reference page plus the headless page):
  - Prompt and I/O: `-p/--print/--prompt`, `--output-format text|json|stream-json`, `--input-format text|stream-json`, `--json-schema`, `--print-timeout` (default 0, meaning no limit), `--disable-slash-commands`.
  - Model and agent: `--model <slug>`, `--effort low|medium|high|xhigh|max`, `--agent`.
  - Behaviour: `--mode accept-edits|auto|plan`, `--sandbox`, `--dangerously-skip-permissions`, `--add-dir`.
  - Sessions and projects: `-c/--continue`, `--conversation <id>`, `--project`, `--new-project`, `--remote-agent`, `--remote-control`, `--log-file`.
  - Subcommands: `agy models`, `agy agents`, `agy acp`, `agy plugin import gemini`.
  - An undocumented **`--settings <file>`** flag exists: the changelog says "files passed to `--settings`", and the binary contains `reading --settings file: %w` [DOCS changelog v1.5.8–1.5.10 area; static strings]. Whether it overrides or merges is [UNCLEAR].
- **stdout and stderr:** the response goes to stdout. "Diagnostics—errors, authentication prompts, progress, and permission notices—go to stderr."
- **Auth in headless:** "Headless mode uses your cached credentials… a run that isn't already authenticated exits with an `authentication required` error instead of hanging."
- **JSON result:** `{conversation_id, status: SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING, response, error?, duration_seconds, num_turns, structured_output?, json_schema?, usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}}`, plus **`denied_actions`** for refused tools [DOCS changelog: "report them as `denied_actions` in the JSON output"].
- **stream-json:**
  - `{"event":"init","conversation_id":…,"init":{"cwd","tools":[…],"permission_mode":"request-review"}}`
  - then `{"event":"step_update","step_update":{conversation_id,step_index,state:ACTIVE|DONE,step_type:user_input|agent_response|tool|checkpoint,tool_name?,text_delta?,duration_seconds?,usage?,tool_info{name,parameters,output,error?}?,subagent_info?}}`
  - then `{"event":"result","result":{…same as json…}}`
  - Example tool step: `{"event":"step_update","step_update":{…,"step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello_headless_demo"},"output":"hello_headless_demo\r\n"}}}`.
- **Prompt via stdin:** `--input-format stream-json` (requires `--output-format stream-json`); one line per prompt, `{"event":"user","message":{"content":"…"}}`; closing stdin ends the session.
- **Permissions in headless:**
  - "Any tool action that requires approval it can't obtain in headless mode is **soft-denied**: the run continues, **exits `0`**, and prints a notice to stderr." The conductor must inspect `denied_actions`.
  - Since v1.5.7 the default mode is **auto where available**, including for `-p` runs [DOCS changelog].
  - `--mode` was previously ignored in `-p` runs (fixed) [DOCS changelog].
- **Exit codes** [DOCS headless.md, changelog]:
  - 0: success, including soft-denied actions;
  - 1: errors (unknown model; unknown `--agent`; malformed stream input);
  - 2: control messages or CLI-handled slash commands in a stream, or quota commands with an API key;
  - 3: model or agent API failure mid-turn, or `--print-timeout` cutting a turn. It prints `AGY_ERROR: {json}` on stderr.
- **Zero-cost status and quota check:** `-p "/usage"` (also `/quota`, `/credits`, `/model`, `/effort`, `/skills`) "emit … a structured payload under `--output-format json` … without starting an agent turn, spending quota, or leaving a conversation behind" [DOCS changelog]. This is the login check that does not read OAuth files.
- **`agy acp`:** an Agent Client Protocol server (JSON-RPC over stdio) for editors [DOCS cli/acp.md].
- **SDK:** authenticates with a Gemini API key, Vertex/Gemini Enterprise, or local models only. No personal-subscription login is documented [DOCS install.md], so it does not fit "no API keys".

### Permissions and settings (CLI) [DOCS permissions.md, settings.md, cli/reference.md]
- **Settings files:**
  - Main: `~/.gemini/antigravity-cli/settings.json` (global; rewritten and normalised at startup; mode 0600).
  - Hooks: `~/.gemini/config/hooks.json` or `<workspace>/.agents/hooks.json`. Hooks in settings.json are ignored.
  - Permission rule scopes: **Global, Project, Shared** ("Rules shared across all Antigravity products").
- **Rules:**
  - Format: `action(target)`, with actions `read_file`, `write_file`, `read_url`, `execute_url`, `command` (prefix or `regex:`), `unsandboxed` (business accounts only), `mcp`.
  - Precedence is **Deny > Ask > Allow**. Workspace read and write is auto-allowed.
  - On Windows, paths are normalised by stripping the drive letter and using `/`. Commands that can't be split need exact matches or `regex:`.
- **Keys:**
  - `agentMode`: `""`, `accept-edits`, `auto` or `plan`.
  - `toolPermission`: `request-review` (default), `proceed-in-sandbox`, `always-proceed`, `strict`.
  - `allowNonWorkspaceAccess` (default false); `enableTerminalSandbox`; `useG1Credits` (spend AI credits after quota; default false); `trustedWorkspaces`; `modelProvider` (`"gemini"` plus `GEMINI_API_KEY` switches to API-key billing).
- **Sandbox (CLI):**
  - On Windows, commands run in an AppContainer. This "Requires Windows 11 24H2 or later with the August 2026 update or later". Folders outside the user profile are readable but not writable [DOCS sandbox.md].
  - Auto mode needs the sandbox: v1.4.4+ on Windows, personal accounts only. When the sandbox is unavailable, `--mode=auto` in headless "prints a warning and continues in `default` mode" [DOCS cli/modes.md].
- **Hooks (CLI):**
  - Events: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `SessionStart`, `Stop`.
  - `PreToolUse` gets `toolCall{name,args}` plus `workspacePaths` and returns `decision allow|auto_approve|deny|ask|force_ask|deny_unless_prior_grant`.
  - Tool names: `write_to_file` (`TargetFile`), `replace_file_content`, `multi_replace_file_content`, `run_command` (`CommandLine`, `Cwd`), `invoke_subagent` (`Workspace`), … [DOCS hooks.md].
  - Workspace hooks and skills sit behind "interactive Workspace Trust verification" [DOCS changelog]. How headless handles an untrusted new worktree is [UNCLEAR].

### Plan and quota
- Plans [DOCS plans.md]:
  - Pro: "high, generous quota, refreshed every five hours until the weekly limit is reached".
  - Ultra: highest, refreshed every 5 hours.
  - Free: weekly.
  - Optional AI-credit overages (`useG1Credits`).
- `/usage`: "The models in a group share a weekly limit and a five-hour limit" [DOCS cli/commands/usage.md].
- Auth is unified ("Signing in on one local surface shares your credentials across your local environment"; tokens are kept in the OS keyring, Windows Credential Manager) [DOCS install.md].
- That quota is shared between App, CLI and extensions is **implied but not stated outright** [UNCLEAR, likely one per-account pool].
- **Relationship to Gemini CLI quota:** none now. Gemini CLI does not serve consumer plans after 2026-06-18. The ToS treats both as "Antigravity and/or Gemini CLI accounts".

### Built-in multi-agent features and isolation
- **Subagents:** workspace `inherit`, `branch` ("create an isolated Git worktree") or `share`. Temporary worktrees are cleaned up. "Parent agents retain full access to their subagents' workspaces" [DOCS subagents.md].
- **App projects:** "New worktree mode creates a new Git worktree for the conversation" [DOCS projects.md].
- **`/teamwork`:** a dedicated directory `~/teamwork_projects/{PROJECT_NAME}` "with exclusive file ownership".
- **`/swarm`:** current workspace, or per-worker working copies.
- **Orchestrator models:** planner and Hydrogen inside one conversation [DOCS teamwork.md, swarm.md, models.md].
- FAQ: worktrees are supported "in the Antigravity App".
- These are internal to Antigravity. An `agy` worker could spawn its *own* worktree subagents inside Orchestra's worktree. Deny `invoke_subagent` through a hook if that is unwanted.

## 7. Subagents in Gemini CLI, and Google's prompting guidance
- **Gemini CLI subagents:**
  - Built-ins: `codebase_investigator`, `cli_help`, generalist, browser.
  - Custom agents: `.gemini/agents/*.md` and `~/.gemini/agents/*.md`. Remote: A2A.
  - Invoked via the `invoke_agent` tool; policy can target `toolName=<agent>` or `subagent=`.
  - Disable with `experimental.enableAgents:false` [DOCS docs/core/subagents.md; configuration.md].
  - `-w/--worktree` (experimental, `experimental.worktrees:true`) creates `.gemini/worktrees/<name>` [DOCS docs/cli/git-worktrees.md]. Orchestra shouldn't use it; it manages its own worktrees.
- **Google prompting guidance** [DOCS https://ai.google.dev/gemini-api/docs/prompting-strategies.md.txt]:
  - "Place essential behavioral constraints, role definitions (persona), and output format requirements in the System Instruction or at the very beginning".
  - "When providing large amounts of context … supply all the context first. Place your specific instructions or questions at the very *end*."
  - Use XML or Markdown sections (`<role>`, `<constraints>`, `<context>`, `<task>`).
  - Gemini 3 is terse by default ("Control output verbosity").
  - Thinking is built in, so there's no need to ask for visible chain-of-thought.
  - It includes an agentic system-instruction template covering dependencies, risk assessment, persistence and retry limits.
- **Antigravity CLI best practices:** give a verification loop ("Run npm test afterward"); explore, then plan, then execute; put rules in `AGENTS.md`/`GEMINI.md` [DOCS cli/best-practices.md].

---

## Implications for Orchestra

### A. What can stand in for "Antigravity"
1. **The only officially supported headless route on the user's consumer Google plan is `agy -p` (Antigravity CLI).**
   - It is not the Gemini CLI, which needs Code Assist Standard/Enterprise or paid API keys after 2026-06-18. It is not the VS Code extension (UI only, by design). It is not the SDK (API keys only).
   - **Blocking decision for the user:**
     - Google states that wrapping `agy` "inside third-party coding agents or applications … is not supported under consumer plans".
     - Its Terms call third-party software accessing the Service a breach that "may be grounds for suspension".
   - Orchestra spawning the official binary is not OAuth reuse. Even so, it is plausibly "a third-party application wrapping agy" and is orchestrated by Claude Code or Codex.
   - Recommend:
     - (a) show this to the user and let them decide or ask Google;
     - (b) design a **fallback "manual Antigravity lane"**: the conductor prepares the worktree and a task brief, the user runs it in the Antigravity App/IDE (whose "New worktree" or Local mode can open the prepared worktree folder), and the conductor then verifies the diff and merges as usual;
     - (c) the Gemini CLI lane only if the user has a Code Assist Standard/Enterprise license.
2. **If the user approves the `agy` lane, the recommended worker invocation (Windows)** is below. Every flag is documented except where marked.
   ```
   %LOCALAPPDATA%\agy\bin\agy.exe
     --input-format stream-json --output-format stream-json   # prompt on stdin, no cmdline-length limit
     --mode accept-edits            # auto-approve workspace edits; commands -> Ask -> soft-denied unless allowed
     --model gemini-4-neon-high     # or gemini-pro-orchestrator-neon; Neon needs paid Pro/Ultra
     --print-timeout 45m            # exit 3 + AGY_ERROR if cut
     --disable-slash-commands       # treat leading "/" as text
     [--sandbox]                    # Win11 24H2 + Aug-2026 update only; then consider --mode auto
     [--settings <orchestra-run-settings.json>]   # UNDOCUMENTED, verify semantics first
   cwd = the worker's git worktree
   stdin: {"event":"user","message":{"content":"<brief>"}}\n  then close stdin
   ```
   - **Never pass `--dangerously-skip-permissions`.** It approves commands, web and MCP calls, and with subagents even outside-workspace file access.
   - Allow test and lint commands through `permissions.allow` rules such as `command(regex:npm (test|run lint))`. These go in a `--settings` file if that flag works per run. Otherwise they live in the user's global settings, which is a trade-off.
   - Add `deny: ["mcp(*)", "read_url(*)", "execute_url(*)", "write_file(.git/)", "write_file(.agents/)"]`.
   - Parse the final `result` event. Treat `status != SUCCESS`, a non-zero exit, or any `denied_actions` as needing attention. Record `usage`.
   - Before a batch, preflight with `agy -p "/usage" --output-format json` (no quota spent): exit status tells you whether the user is logged in, and the payload shows remaining quota.
3. **Rules:**
   - Both `agy` and Gemini CLI read `AGENTS.md` and `GEMINI.md` natively (Gemini CLI only after `context.fileName` is set), from the worktree root and its parents up to the git root. A worktree's `.git` file makes the worktree root the ceiling.
   - **Neither reads CLAUDE.md.** If the project's rules live in CLAUDE.md, the project should keep `AGENTS.md` canonical, with CLAUDE.md importing it, or the reverse.
   - Antigravity ignores subfolder AGENTS.md below the workspace, and Gemini CLI loads them lazily (JIT). Keep rules at the root, or point to them from the root file.
   - Global user rules (`~/.gemini/AGENTS.md`/`GEMINI.md`, `~/.gemini/config/rules`) always load in `agy`. There is no documented way to suppress them [UNCLEAR]; the user must keep them compatible.
4. **Limiting:**
   - The conductor's own post-run `git diff --name-only` check against the allowed-file list stays the authoritative gate for all engines.
   - Defence in depth for `agy`: a `PreToolUse` hook that denies `write_to_file`/`replace_file_content`/`multi_replace_file_content` when `TargetFile` is outside the allowlist, plus `invoke_subagent`.
     - In the workspace this needs `.agents/hooks.json`, which must be kept out of the merge.
     - Globally, in `~/.gemini/config/hooks.json`, it would affect the user's normal use.
     - Workspace hooks are trust-gated, and headless behaviour for that is [UNCLEAR].

### B. Gemini CLI lane (only with a Code Assist Standard/Enterprise license)
```
node "%APPDATA%\npm\node_modules\@google\gemini-cli\bundle\gemini.js"
  -p "Follow the task on stdin."  -o stream-json
  --approval-mode auto_edit       # or plan for read-only planners; never yolo
  --skip-trust                    # fresh worktree is untrusted -> else exit 55 / no project rules
  -e none --allowed-mcp-server-names __orchestra_none__
  --policy <run>\policies          # replaces ~/.gemini/policies; allow exact test cmds, deny the rest
  -m <model>
env: GEMINI_CLI_SYSTEM_SETTINGS_PATH=<run>\system-settings.json  NO_BROWSER=true
     GEMINI_CLI_NO_RELAUNCH=true (optional; else kill process tree)
     strip GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENAI_USE_VERTEXAI GOOGLE_CLOUD_* GOOGLE_APPLICATION_CREDENTIALS GOOGLE_GEMINI_BASE_URL
stdin: the full brief (context first, explicit directive and file allowlist last)
```
`system-settings.json` (forced, highest file precedence):
```json
{"context":{"fileName":["AGENTS.md","GEMINI.md"]},
 "security":{"auth":{"enforcedType":"oauth-personal"},"folderTrust":{"enabled":true}},
 "advanced":{"ignoreLocalEnv":true},
 "skills":{"enabled":false},"experimental":{"enableAgents":false},
 "general":{"checkpointing":{"enabled":false},"enableAutoUpdate":false},
 "tools":{"exclude":["web_fetch","google_web_search"]},
 "privacy":{"usageStatisticsEnabled":false}}
```
Policy file (user tier, through `--policy`):
```toml
[[rule]]
commandPrefix = ["npm test", "npm run lint"]
decision = "allow"
priority = 900
[[rule]]
toolName = ["write_file", "replace"]
argsPattern = "…outside-allowlist…"
decision = "deny"
priority = 950
```
`write_file`/`replace` path regexes are brittle: paths may be relative or absolute, with either slash on Windows. Keep the conductor's diff check as the authority.

## Open questions / must verify on the user's machine
1. Is `agy.exe` already present? Look in `%LOCALAPPDATA%\agy\bin\agy.exe`, or wherever the VS Code extension 1.12.0 installed its "local `agy` backend". Record its version, and save `agy --help` and `agy -p --help`.
2. Is `agy` already signed in through the shared keyring? Check with `agy -p "/usage" --output-format json` (documented as spending no quota) and record the exit code and payload.
3. Which plan does the user have? Neon needs **paid** Pro (not a trial) or Ultra; Claude 5.5 in Antigravity needs non-trial Pro. Check the exact `agy models` slugs.
4. What does `--settings <file>` do (override, merge, or which keys)? Can permissions and `agentMode` be supplied per run without touching `~/.gemini/antigravity-cli/settings.json`?
5. How does headless `agy` behave in an **untrusted** new worktree folder: a prompt or hang, an error, or skipped `.agents/` hooks and skills? Does the trust prompt ever block `-p`?
6. Is the Windows sandbox available (Windows 11 24H2 plus the August 2026 update or later)? Does `--mode auto` work, or does it fall back to default?
7. Does a soft-denied action show up in `denied_actions` with exit 0 as documented? What happens to file edits outside the allowlist in `accept-edits` mode?
8. Does `agy` self-update in the middle of a batch, and can that be pinned or disabled? (`~/.gemini/bin/agy.version.json` and `~/.gemini/antigravity-cli/updater/` appear in the docs.)
9. **Policy:** the user should confirm they accept the consumer-ToS risk of Orchestra driving `agy -p`, or choose the manual Antigravity lane or the Gemini CLI with a Code Assist license.
10. Gemini CLI only: does the user have a Gemini Code Assist Standard/Enterprise license? If not, drop the Gemini CLI lane.
11. Does the user have global `~/.gemini/GEMINI.md`, `~/.gemini/AGENTS.md`, `~/.gemini/config/rules/*` or global MCP servers that would leak into workers?
12. Whether quota is shared between the user's own interactive Antigravity use and Orchestra's `agy` workers is not stated explicitly, but is likely. Watch the `/usage` 5-hour and weekly limits.
