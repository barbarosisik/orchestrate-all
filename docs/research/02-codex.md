# B. Codex CLI as a headless, limited worker (research notes)

Researcher B. Date of research: 2026-11-19.

## Versions and sources used

- npm `@openai/codex` latest = **0.170.0** (published 2026-11-18T03:45Z). `alpha` tag = 0.171.0-alpha.13. The user's `0.169.0-alpha.11.1` was published 2026-11-11T22:31Z. [SOURCE npm registry, `npm view @openai/codex time`]
- Installed locally (not globally) in a throwaway folder → `codex-cli 0.170.0`. Help texts were captured for codex, exec, exec_resume, exec_fork, exec_review, login, login_status, mcp, sandbox, features, debug, app-server, cloud, agents, ... (not committed).
- Source: shallow clone of `github.com/openai/codex`, tag `rust-v0.170.0`, commit `29eb79e9866b3262a777fdf8195c1b9e63684c91` (2026-11-17).
- **0.169.0-alpha.11.1 vs 0.170.0:** these files are byte-identical between tag `rust-v0.169.0-alpha.11.1` and `rust-v0.170.0`: `exec/src/cli.rs`, `utils/cli/src/shared_options.rs`, `cli/src/main.rs`, `core/src/agents_md.rs`, `exec/src/exec_events.rs` and `config/defaults.toml`. So the exec flags, JSONL schema and AGENTS.md discovery on the user's machine should match these notes. `codex mcp-server` is absent in both. [SOURCE raw.githubusercontent.com@rust-v0.169.0-alpha.11.1, diffed]
- Docs: developers.openai.com/codex now redirects to **learn.chatgpt.com/docs/** (Markdown twins: append `.md`). The index is `https://developers.openai.com/codex/llms.txt`.
- Empirical: I ran `codex debug prompt-input` (0.170.0) against a throwaway git repo and a worktree. It renders the model-visible input list locally and makes **no model call**, using an empty, logged-out `CODEX_HOME`. I did not run `codex exec`.

Labels: [DOCS url] [SOURCE path@rust-v0.170.0] [HELP v0.170.0] [EMPIRICAL v0.170.0 prompt-input] [SECONDARY url] [UNCLEAR].

---

## 1. AGENTS.md discovery

### 1.1 Global level (CODEX_HOME)
- Codex checks `$CODEX_HOME/AGENTS.override.md`, then `$CODEX_HOME/AGENTS.md`, and uses **the first non-empty one only**. `CODEX_HOME` defaults to `~/.codex`. [SOURCE codex-rs/codex-home/src/instructions/mod.rs] [DOCS https://learn.chatgpt.com/docs/agent-configuration/agents-md.md]
- The global file comes from `CodexHomeUserInstructionsProvider::new(config.codex_home)`, which the app-server message processor installs (`app-server/src/message_processor.rs:409`). It does **not** consult `ignore_user_config`. **So `--ignore-user-config` does NOT skip the global AGENTS.md.** The only ways to skip it are a different `CODEX_HOME` or an empty file there. [SOURCE; inferred from code paths, not run with exec]

### 1.2 Project level
- Root detection: Codex walks up from cwd until it finds a directory containing any `project_root_markers` entry. The default is `[".git"]` (packaged `config/defaults.toml`). `.git` may be a file, so **git worktrees work**. `project_root_markers = []` disables the parent walk, so only cwd is used. If no marker is found, only cwd is checked. Codex never walks above the root. [SOURCE core/src/agents_md.rs header comment + config/defaults.toml] [DOCS config-advanced.md "project_root_markers"] [EMPIRICAL: a worktree with a `.git` file loaded the worktree-root AGENTS.md]
- Markers come from the merged config **excluding project layers**, so a repo can't redefine its own root. [SOURCE agents_md.rs `agents_md_paths`]
- For each directory from the root down to cwd, the candidates are tried in this order: `AGENTS.override.md`, `AGENTS.md`, then each `project_doc_fallback_filenames` entry. **At most one file per directory** is used (the first that exists). [SOURCE `candidate_filenames`] [DOCS agents-md.md]
- Merge: the global text comes first, then the separator `\n\n--- project-doc ---\n\n`, then project files from root to cwd joined with `\n\n`. [SOURCE `legacy_text`, `AGENTS_MD_SEPARATOR`] [EMPIRICAL]
- Empty or whitespace-only files are skipped. Symlinks are allowed. Fallback names containing `/`, `\0`, `.`, `..` (and on Windows `\` or `:`) are ignored. [SOURCE]
- **Trust gate:** project docs are skipped only when the project is *explicitly* `trust_level = "untrusted"` (`is_untrusted()` matches `Some(Untrusted)` only). An unknown or unset trust level still loads AGENTS.md. [SOURCE agents_md.rs `load_project_instructions`, config/src/config_toml.rs:622]
- The AgentsMdManager re-resolves "at startup or a request boundary". If the text changes mid-thread, the new text is injected with "These AGENTS.md instructions replace all previously provided AGENTS.md instructions." [SOURCE core/src/agents_md_manager.rs, core/src/context/world_state/agents_md.rs] The docs say "once per run". Either way, for a one-turn `codex exec` it is built once.

### 1.3 Size limit
- `project_doc_max_bytes` defaults to **32768** (packaged defaults). It is a **total budget across all project files** (and across environments). Codex truncates the file that crosses the budget and skips the rest, with warnings. The global/thread instructions are *not* truncated. They only produce a warning if the combined text exceeds the budget. [SOURCE agents_md.rs, agents_md_manager.rs; config_toml.rs doc comment "Maximum total bytes of project instruction content across all selected environments"]
  - Doc inconsistency: config-advanced.md says "how much to read from each AGENTS.md file", while agents-md.md says "stops adding files once the combined size reaches the limit". The source agrees with the latter.
- `project_doc_max_bytes = 0` disables project AGENTS.md loading entirely (early return). The global AGENTS.md is still loaded. [SOURCE] [EMPIRICAL: with `-c project_doc_max_bytes=0` only "GLOBAL-AGENTS" remained]
- **There is no flag that disables all AGENTS.md loading.** Project docs can be turned off with `-c project_doc_max_bytes=0`. The global file can only be avoided through `CODEX_HOME`. [SOURCE]

### 1.4 Fallback filenames, so Codex can read CLAUDE.md / GEMINI.md
- `-c 'project_doc_fallback_filenames=["CLAUDE.md","GEMINI.md"]'` works. [EMPIRICAL] In a test tree:
  - `sub/CLAUDE.md` (no AGENTS.md in `sub/`) **was** included.
  - `sub/deeper/CLAUDE.md` was **ignored** because `sub/deeper/AGENTS.md` exists, which confirms the one-file-per-directory rule.
- Important caveat for Orchestra: a fallback is used only where AGENTS.md is absent. If a directory has both AGENTS.md and CLAUDE.md with different content, Codex sees only AGENTS.md. CLAUDE.md `@imports` are not expanded; Codex reads the file as plain text. [SOURCE; the `@import` claim is inferred because nothing in agents_md.rs parses imports]
- Fallback names are only for the project walk. The global level checks only `AGENTS.override.md`/`AGENTS.md`. [SOURCE codex-home/src/instructions/mod.rs]

### 1.5 How the content is injected
- **One `role: "user"` message**: `# AGENTS.md instructions for <cwd>\n\n<INSTRUCTIONS>\n...\n</INSTRUCTIONS>`. The directory is cwd (or omitted when only global instructions exist). Content-kind is `agents_md.instructions`. [SOURCE core/src/context/user_instructions.rs] [EMPIRICAL]
- The cookbook says "Each discovered file becomes its own user-role message", but in 0.170.0 all files are concatenated into **one** message with the `--- project-doc ---` marker. [SECONDARY https://github.com/openai/openai-cookbook/blob/main/examples/gpt-5/codex_prompting_guide.ipynb, contradicted by SOURCE+EMPIRICAL]
- The older base prompt (`prompt.md`) says AGENTS.md contents "are included with the developer message". That is inaccurate for 0.170.0, where they arrive as a user message.
- Observed full input order (`codex debug prompt-input`, defaults, cwd = nested dir) [EMPIRICAL]:
  1. developer: base instructions (model template, about 26 KB for gpt-6.2-sol). Because the `incremental_tools` feature is on, the base instructions are sent as the first developer input item, not in the Responses `instructions` field. [SOURCE core/src/session/turn.rs `build_prompt`]
  2. developer: `developer_instructions` (if set), placed right after the base instructions.
  3. developer: `<skills_instructions>` (skill catalog incl. `$CODEX_HOME/skills/.system`).
  4. developer: `<permissions instructions>` (sandbox mode, network, escalation rules).
  5. developer: `<collaboration_mode>`.
  6. developer: `<multi_agent_role>` + `<multi_agent_mode>` (sub-agents enabled by default).
  7. user: `# AGENTS.md instructions for <cwd>` block.
  8. user: `<environment_context>` (cwd, shell, date, tz, workspace_roots, permission_profile XML).
  9. user: the prompt.

### 1.6 `--ignore-user-config`: what it skips and what it keeps
Help: "Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`". [HELP v0.170.0]

Skipped [SOURCE config/src/loader/mod.rs `load_user_config_layer`, exec/src/lib.rs]:
- `$CODEX_HOME/config.toml`, so the user's `[mcp_servers]`, model, profile, `projects.*` trust, hook trust states and so on are not loaded. The user layer becomes an empty table.
- Profile files `$CODEX_HOME/<name>.config.toml` selected with `-p`, which use the same ignore flag.
- `EnvironmentManager::from_env` is used instead of `from_codex_home`, so remote environments configured in CODEX_HOME are skipped.

Still loaded or used [SOURCE]:
- Auth (`auth.json` / keyring keyed on CODEX_HOME).
- Global `$CODEX_HOME/AGENTS.md` (see 1.1).
- System config `/etc/codex/config.toml` (Windows: `%ProgramData%\OpenAI\Codex\...`), cloud-managed config bundle, `managed_config.toml`/MDM, `requirements.toml`.
- **Project layers** (`<repo>/.codex/config.toml`, `.codex/hooks.json`). These load only if the project is trusted. With the user config ignored, saved trust is invisible, so an untrusted project's layer is disabled and exec prints "warning: Untrusted project-local configuration is disabled...". [SOURCE exec/src/lib.rs] [DOCS non-interactive-mode.md: "Local `codex exec` ... load project configuration and project-defined MCP servers only for trusted projects"]
- `$CODEX_HOME/hooks.json` is still *discovered* (the user layer's config folder is CODEX_HOME), but without config.toml its trust state is missing, so non-managed hooks should be skipped as untrusted. [SOURCE hooks/src/engine/discovery.rs; UNCLEAR, not executed] Safer: `--disable hooks`.
- Execpolicy `.rules`: use `--ignore-rules` to skip user and project rules. [HELP]
- Skills in `$CODEX_HOME/skills` (bundled `.system` skills are written there on first run). [EMPIRICAL]
- `--trust` combined with `--ignore-user-config` is rejected ("--trust cannot be combined with --ignore-user-config"). `--worktree` is also rejected with `--ignore-user-config` and with `--ephemeral`. [SOURCE exec/src/lib.rs:274, :331]
- **`-c key=value` overrides still apply** with `--ignore-user-config`. They form their own `SessionFlags` layer above the user and project layers. [SOURCE loader/mod.rs] [EMPIRICAL via prompt-input]

---

## 2. `codex exec` in depth

### 2.1 Help (v0.170.0, identical CLI to 0.169.0-alpha.11.1)
Key options (full help text not committed):
```
codex exec [OPTIONS] [PROMPT]      | codex exec [OPTIONS] <COMMAND>  (resume, fork, review)
PROMPT: if omitted or "-", read from stdin. If stdin is piped AND a prompt is given, stdin is appended as a <stdin> block.
-c/--config key=value  --enable F  --disable F  --strict-config  -i/--image  -m/--model  --oss  --local-provider
-p/--profile NAME (layers $CODEX_HOME/NAME.config.toml)  -s/--sandbox read-only|workspace-write|danger-full-access
--approve-for-me (auto-review approvals, workspace-write)  --dangerously-bypass-approvals-and-sandbox (alias --yolo per docs)
--dangerously-bypass-hook-trust  -C/--cd DIR  --worktree  --add-dir DIR  --thread-source SRC
--cyber-access-program ...  --skip-git-repo-check  --trust  --ephemeral  --ignore-user-config  --ignore-rules
--output-schema FILE  --color always|never|auto  --json  -o/--output-last-message FILE
```
- **There is no `-a/--ask-for-approval` on `codex exec`.** It exists only on the interactive `codex`. [HELP]
- `--full-auto` was removed ("`--full-auto` is no longer supported. Update scripts to use `--sandbox workspace-write`, or use `--approve-for-me`"). [DOCS non-interactive-mode.md]
- Global (usable after a subcommand too): `--strict-config --thread-source --cyber-access-program --skip-git-repo-check --trust --ephemeral --ignore-user-config --ignore-rules --output-schema --json -o`. **Not global:** `-s -C --add-dir -m -p -i`. `codex exec resume --help` lists `-m` but not `-s`, `-C`, `--add-dir`. [SOURCE exec/src/cli.rs `global = true`] [HELP exec_resume.txt]
- Other relevant top-level commands: `codex login status`, `codex debug prompt-input [PROMPT]` (renders the model-visible input as JSON with no model call, which makes it a useful dry-run to check AGENTS.md and permissions), `codex debug models`, `codex features list`, `codex doctor`, `codex sandbox ...`, `codex app-server`, `codex cloud exec|status|list|apply|diff`. [HELP]

### 2.2 Prompt input and stdin
- `codex exec -` reads the whole of stdin to EOF. It detects UTF-8 and UTF-16 LE/BE BOMs, which helps PowerShell pipes. [SOURCE exec/src/lib.rs `read_prompt_from_stdin`, `decode_prompt_bytes`]
- **Pitfall:** if you pass the prompt as an argument and stdin is a non-TTY pipe (Node's `spawn` default `stdio: 'pipe'`), codex prints "Reading additional input from stdin..." and **blocks until stdin closes**. Either pass `-` and write+`end()` stdin, or spawn with `stdin: 'ignore'`. [SOURCE `StdinPromptBehavior::OptionalAppend`]

### 2.3 `--json` JSONL events (stdout)
Types are in `exec/src/exec_events.rs` (unchanged since alpha.11.1). [SOURCE] Top level, `"type"`:
- `thread.started` `{thread_id}`: the first event. thread_id is the resume id.
- `turn.started` `{}`
- `turn.completed` `{usage:{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}}`. The usage is the thread's **cumulative total** (`usage_from_last_total` uses `token_usage.total`). [SOURCE event_processor_with_jsonl_output.rs]
- `turn.failed` `{error:{message}}`
- `item.started` / `item.updated` / `item.completed` `{item:{id, type, ...}}`
- `error` `{message}`: unrecoverable stream error.

Item `type` values (snake_case) and fields:
- `agent_message {text}`. With `--output-schema`, text is the JSON string.
- `reasoning {text}` (summary)
- `command_execution {command, aggregated_output, exit_code|null, status: in_progress|completed|failed|declined}`
- `file_change {changes:[{path, kind: add|delete|update}], status: in_progress|completed|failed}`. This is emitted only as completed.
- `mcp_tool_call {server, tool, arguments, result:{content[], structured_content, _meta?}|null, error:{message}|null, status}`
- `collab_tool_call {tool: spawn_agent|send_input|wait|close_agent, sender_thread_id, receiver_thread_ids[], prompt, agents_states{}, status}`. These are sub-agent events.
- `web_search {id, query, action, results?}`
- `todo_list {items:[{text, completed}]}`. Plan updates arrive via item.started/updated/completed.
- `error {message}`: non-fatal. Config/startup warnings are also surfaced as `item.completed` with type `error`. [SOURCE `collect_warning`]

Docs sample (verbatim) [DOCS https://learn.chatgpt.com/docs/non-interactive-mode.md]:
```jsonl
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
```
Shapes from source, illustrative and not captured from a run:
```jsonl
{"type":"item.completed","item":{"id":"item_4","type":"file_change","changes":[{"path":"src/a.ts","kind":"update"}],"status":"completed"}}
{"type":"item.completed","item":{"id":"item_5","type":"command_execution","command":"...","aggregated_output":"...","exit_code":1,"status":"failed"}}
{"type":"item.updated","item":{"id":"item_2","type":"todo_list","items":[{"text":"Add parser","completed":true},{"text":"Run tests","completed":false}]}}
{"type":"turn.failed","error":{"message":"..."}}
```
- Without `--json`, progress goes to stderr and only the final agent message goes to stdout. [DOCS non-interactive-mode.md]
- **Exit code:** the process exits 1 if a fatal error notification (not `will_retry`) occurs for the primary turn, if the turn ends `Failed` or `Interrupted`, or if a server request could not be answered. Otherwise it exits 0. Startup/config errors also exit 1. [SOURCE exec/src/lib.rs ~1382-1486]
- `-o/--output-last-message FILE`: writes the final agent message. The file handle is opened *before* the agent starts ("Sandbox activity cannot redirect the final write"). It is written only when the turn completed successfully. The message is also printed to stdout. [SOURCE exec/src/lib.rs, jsonl processor `emit_final_message_on_shutdown`] [DOCS]
- `--output-schema FILE`: a JSON Schema sent as the Responses `text.format` with **`strict: true`** for exec sessions. The schema must meet OpenAI strict-schema rules: every property in `required` and `additionalProperties:false`. A missing file or invalid JSON → exit 1. [SOURCE core/src/session/turn.rs `output_schema_strict`, exec `load_output_schema`]

### 2.4 Other flags
- `--skip-git-repo-check`: without it exec exits 1 with "Not inside a trusted directory and --skip-git-repo-check was not specified." when cwd has no git ancestor. `--dangerously-bypass-approvals-and-sandbox` also skips the check. A `.git` *file* (worktree) counts. [SOURCE exec/src/lib.rs:1076, git-utils `find_ancestor_git_entry`]
- `--ephemeral`: does not persist the session rollout (so it can't be resumed later). Trust saved by `--trust` still persists. [HELP] [DOCS]
- `--add-dir DIR`: an extra writable root next to the workspace (relative paths resolve against the process cwd). [HELP] [SOURCE]
- `-C DIR`: working root. It is canonicalized and used for config/project discovery and as the cwd. [SOURCE]
- `codex exec resume [SESSION_ID|--last] [PROMPT|-]`: continues a recorded (non-ephemeral) session. `--all` disables the cwd filter used by `--last`. `fork` branches a session. [HELP]
- `--worktree` (new): runs in a Codex-managed git worktree. It can't be combined with `--ignore-user-config`, `--ephemeral` or `resume`. Orchestra manages its own worktrees, so ignore it. [SOURCE]

### 2.5 Approvals in exec mode
- The exec harness sets `approval_policy: Some(AskForApproval::Never)` ("Default to never ask for approvals in headless mode"). The only exception is when the resolved `approvals_reviewer` is `auto_review` (`--approve-for-me` or config), in which case it rebuilds without forcing. [SOURCE exec/src/lib.rs `build_exec_config`]
- With approval `never` the model is told: "Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected." [SOURCE prompts/templates/permissions/approval_policy/never.md]
- If any approval request still reaches the exec client, it is **rejected** with "... approval is not supported in exec mode". This covers command exec, file change, apply_patch, permissions, request_user_input and dynamic tools. MCP elicitations are auto-cancelled. A rejection error marks `error_seen`, so exit code 1. [SOURCE exec/src/lib.rs `handle_server_request`]
- Net effect: sandbox-denied actions fail and the failure goes back to the model. Nothing hangs waiting for a human.

---

## 3. Sandbox

### 3.1 Modes [DOCS https://learn.chatgpt.com/docs/sandboxing.md, https://learn.chatgpt.com/docs/agent-approvals-security.md]
- `read-only`: commands can read. No edits, no network.
- `workspace-write`: read everywhere (`:root` read). Writes are allowed in cwd/workspace roots, `$TMPDIR`, `/tmp` and `writable_roots`/`--add-dir`. **Network is off by default.**
- `danger-full-access`: no sandbox.
- Default for `codex exec` with no `-s` and no config: **read-only**. [DOCS non-interactive-mode.md: "By default, `codex exec` runs in a read-only sandbox."]
- The sandbox covers spawned commands *and* the built-in `apply_patch` editor ("sandboxing enforced by the explicit filesystem sandbox context"). [SOURCE core/src/tools/runtimes/apply_patch.rs] [DOCS "The sandbox applies to spawned commands, not just to built-in file operations."]

### 3.2 Protected paths [DOCS agent-approvals-security.md "Protected paths in writable roots"]
- `<writable_root>/.git` is read-only whether it is a dir or a file. **If `.git` is a pointer file (`gitdir: ...`), the resolved git dir is also read-only.** `.agents`, `.codex` and `.aws` are read-only when they exist as directories. Protection is recursive.
- [EMPIRICAL] in a git worktree with `-c sandbox_mode="workspace-write"`, the rendered profile shows: `:root` read, `<wt>` write, `:slash_tmp` write, `:tmpdir` write, `<wt>/.git` read, `<wt>/.agents` read, `<wt>/.codex` read, `<wt>/.aws` read.
- **Consequence:** a Codex worker in workspace-write **cannot `git add`/`git commit`** in its worktree. The conductor has to stage and commit. The current base prompt also says "Do not `git commit` your changes or create new git branches unless explicitly requested". [SOURCE protocol/src/prompts/base_instructions/default.md]

### 3.3 Config keys `sandbox_workspace_write.*` [DOCS config-reference.md]
- `writable_roots` (array<string>), `network_access` (bool), `exclude_tmpdir_env_var` (bool), `exclude_slash_tmp` (bool).
- TMPDIR: on Unix, `$TMPDIR` (if set and absolute) and `/tmp` are writable unless excluded. [SOURCE protocol/src/permissions.rs `local_temporary_directories`] On Windows, `TEMP`/`TMP` are the writable temp roots unless `exclude_tmpdir_env_var`. [SOURCE windows-sandbox-rs/src/allow.rs tests]
- Network: `-c sandbox_workspace_write.network_access=true`. Domain filtering needs `features.network_proxy=true` (experimental). [DOCS]

### 3.4 Permission profiles (beta, stronger per-path limits)
[DOCS https://learn.chatgpt.com/docs/permissions.md]
- `default_permissions = ":read-only" | ":workspace" | ":danger-full-access" | "<custom>"` with `[permissions.<name>]` tables. `extends` can inherit a built-in or another profile, but not `:danger-full-access`. Filesystem rules are `read|write|deny`. Special paths: `:root :minimal :workspace_roots :tmpdir :slash_tmp`, plus absolute paths and `~/` paths. The most specific rule wins, and for the same path `deny > write > read`.
- "**Permission profiles do not compose with the older sandbox settings** ... If `sandbox_mode` appears in any loaded config file, you pass `--sandbox`, or the selected config profile sets `sandbox_mode`, Codex uses those older sandbox settings instead of `default_permissions`." So you **must not pass `-s`** when using a profile.
- [EMPIRICAL] A profile defined purely with `-c` works:
  `-c default_permissions='"orch"' -c 'permissions.orch={extends=":workspace", filesystem={":workspace_roots"={"."="read", "sub/deeper"="write"}}}'`
  produces `:root` read, `:slash_tmp`/`:tmpdir` write, `<repo>` **read**, `<repo>/sub/deeper` **write**. So Codex can enforce a per-worker write allowlist at the OS level. That fits Orchestra's file-ownership model.
- Caveats: the feature is beta. "`read` or `write` globs are less portable on Linux, WSL, and native Windows sandboxing, so prefer exact paths or subtree rules". "Codex rejects direct write rules that the active runtime cannot enforce." Deny-read globs are snapshotted per process start. [DOCS]

### 3.5 Windows sandbox [DOCS https://learn.chatgpt.com/docs/windows/windows-sandbox.md]
- Three implementations, selected by `windows.sandbox = "mxc" | "elevated" | "unelevated"` and `features.prefer_mxc`:
  - **mxc**: recommended. Uses Microsoft Execution Containers. Needs Windows 11 24H2 build 26100.9278+ or 25H2 26200.9278+. No admin setup. Child processes stop when the foreground command exits.
  - **elevated**: the preferred legacy fallback. Needs admin-approved setup and creates dedicated low-privilege sandbox users, firewall rules and logon rights. IT can provision it with `codex sandbox setup --elevated --user ... --codex-home ...`.
  - **unelevated**: a restricted token plus ACLs. Weaker network isolation, no deny-read.
- MXC probe (CLI ≥ 0.162): `codex -c windows.sandbox=mxc sandbox --include-managed-config --permission-profile :workspace -- cmd.exe /d /c echo MXC_OK`, then check `$LASTEXITCODE` is 0.
- Logs are at `CODEX_HOME/.sandbox/sandbox.log`. Common failure: error 1385 (logon rights).
- `codex-windows-sandbox-setup.exe` ships in the win32 npm package at `vendor/x86_64-pc-windows-msvc/codex-resources/codex-windows-sandbox-setup.exe`, next to `codex-command-runner.exe`. [SOURCE npm tarball listing of @openai/codex@0.170.0-win32-x64; .github/dotslash-config.json; windows-sandbox-service/src/provisioning.rs] It is the provisioning helper for the elevated sandbox.
- `codex sandbox uninstall` removes the legacy Windows sandbox's machine-wide accounts and firewall rules. [HELP]
- Feature flags: `experimental_windows_sandbox` and `elevated_windows_sandbox` are now "removed". `windows_sandbox_service` is under development, and `prefer_mxc` is under development (default false in the CLI). [HELP features list]

---

## 4. Codex's own system prompt and instruction overrides

### 4.1 Where the base prompt comes from (0.170.0)
- Per-model `model_messages.instructions_template` from the model catalog. The bundled fallback copy is `codex-rs/models-manager/models.json`. The live catalog is fetched from the server, so the real text may differ: [UNCLEAR, needs a check on the machine with `codex debug prompt-input`]. Models listed in the bundled catalog: gpt-6.2-sol (priority 1, default reasoning "low", context 500k, `tool_mode: code_mode_only`, `multi_agent_version: v2`), gpt-6.2-astra, gpt-6.1-sol, gpt-6.1-terra, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-*, gpt-5.5, plus hidden ones.
- Fallback for unknown or local models: `models-manager/prompt.md` (= `protocol/src/prompts/base_instructions/default.md`). Legacy files `core/gpt_5_1_prompt.md`, `gpt_5_2_prompt.md`, `gpt-5.1-codex-max_prompt.md`, `gpt-5.2-codex_prompt.md` and `gpt_5_codex_prompt.md` remain in the repo. [SOURCE models-manager/src/model_info.rs `local_model_messages`]

### 4.2 AGENTS.md section (verbatim, from `default.md` / `prompt.md`; also present in gpt_5_1/gpt_5_2 prompts) [SOURCE protocol/src/prompts/base_instructions/default.md lines 17-27]
> # AGENTS.md spec
> - Repos often contain AGENTS.md files. These files can appear anywhere within the repository.
> - These files are a way for humans to give you (the agent) instructions or tips for working within the container.
> - Some examples might be: coding conventions, info about how code is organized, or instructions for how to run or test code.
> - Instructions in AGENTS.md files:
>     - The scope of an AGENTS.md file is the entire directory tree rooted at the folder that contains it.
>     - For every file you touch in the final patch, you must obey instructions in any AGENTS.md file whose scope includes that file.
>     - Instructions about code style, structure, naming, etc. apply only to code within the AGENTS.md file's scope, unless the file states otherwise.
>     - More-deeply-nested AGENTS.md files take precedence in the case of conflicting instructions.
>     - Direct system/developer/user instructions (as part of a prompt) take precedence over AGENTS.md instructions.
> - The contents of the AGENTS.md file at the root of the repo and any directories from the CWD up to the root are included with the developer message and don't need to be re-read. When working in a subdirectory of CWD, or a directory outside the CWD, check for any AGENTS.md files that may be applicable.

- **The current GPT-6.x templates (incl. default gpt-6.2-sol) have NO "AGENTS.md spec" section.** The only mention is in "When to ask the user for permission": "...explicitly explain why you need the confirmation (for example, a SKILL.md, AGENTS.md, memory, or approval auto-review block)". They also say "The user's instruction, whether implied from the task or explicitly stated, must take precedence over any guidelines provided in skills or external files." [SOURCE models.json gpt-6.2-sol template] The model is trained to follow the injected `# AGENTS.md instructions` block ("the model has been trained to closely adhere to these instructions"). [SECONDARY cookbook codex_prompting_guide]
- Consequence: files in subdirectories *below* cwd are **not** auto-loaded. Only the default.md-era prompt told the model to look for nested AGENTS.md. With the GPT-6.x templates, a worker whose cwd is the worktree root will **not** see `src/foo/AGENTS.md` unless it reads it itself.

### 4.3 Other content of the base prompts (summary)
- `default.md` covers:
  - **Task execution:** "keep going until the query is completely resolved".
  - **Editing:** use `apply_patch`, fix root causes, keep changes minimal and consistent with the codebase, "Do not attempt to fix unrelated bugs", "Do not `git commit` your changes or create new git branches unless explicitly requested".
  - **Validating:** go from specific to broad tests. "When running in the non-interactive approval mode **never**, proactively run tests, lint and do whatever you need to ensure you've completed the task." Do not add tests to codebases with no tests. Up to 3 formatting iterations.
  - **Planning:** use the `update_plan` tool, skip it for simple tasks.
  - **Preambles:** 8-12 word updates before tool calls.
  - **Final message:** concise, at most about 10 lines by default, file references instead of dumps.
- gpt-6.2-sol template:
  - Coding style (a)-(g): reuse existing logic; "(c) Skip new tests unless requested, required by the repo, or needed to catch a specific regression"; "(d) ... avoid generating unrequested/unrelated artifacts ... formatting churn, optional features, and configuration changes"; readability; avoid needless branching and abstraction.
  - "Do not invent requirements, rules or policies that block or delay work".
  - Final answer must disclose flaws and decisions made without guidance, and be self-contained.
  - Commentary/final channels.
  - "Never repurpose `$HOME`, `$home`, or `$CODEX_HOME`".
  - Prefer `rg`.

### 4.4 Override and append keys [SOURCE core/src/config/mod.rs ~4232] [DOCS config-reference.md]
- `model_instructions_file = "<path>"` **replaces** the base instructions. Docs: "Users are STRONGLY DISCOURAGED from using this field ... will likely degrade model performance." [EMPIRICAL: the first developer message became the file content.]
- `experimental_instructions_file` is the old name. "Rename `experimental_instructions_file` to `model_instructions_file`. Codex deprecates the old key". It no longer appears in the 0.170.0 source. [DOCS] [SOURCE grep]
- `instructions` (string) is a lower-precedence base override that docs call "Reserved for future use". Precedence: harness override > `model_instructions_file` > `instructions`. [SOURCE]
- `developer_instructions = "..."` adds a **separate developer-role message** right after the base instructions. [EMPIRICAL] This is the right channel for Orchestra's harness rules.
- `include_permissions_instructions`, `include_apps_instructions`, `include_collaboration_mode_instructions`, `include_environment_context`, `include_environment_context_time` (all default true) toggle the generated developer/user blocks. [SOURCE config_toml.rs, packaged defaults]
- `skills.include_instructions=false` removes the skills catalog block. `skills.bundled.enabled=false` disables bundled skills. [EMPIRICAL / DOCS]
- `personality` is deprecated. `compact_prompt` / `experimental_compact_prompt_file` set the compaction prompt.

---

## 5. OpenAI prompting guidance (Codex / GPT-5-class)

Sources:
- [DOCS https://learn.chatgpt.com/docs/prompting.md] (section "Prompting Codex")
- [DOCS https://learn.chatgpt.com/guides/prompting-gpt-6-2-astra.md]
- [SECONDARY openai-cookbook main: examples/gpt-5/codex_prompting_guide.ipynb (targets gpt-5.3-codex), examples/gpt-5/gpt-5_prompting_guide.ipynb], fetched 2026-11-19

Points:
- **Prompt shape:** "A useful Codex prompt names the behavior you want, points to the relevant code or reproduction steps, preserves important constraints, and says how to verify the change." [DOCS prompting.md] For GPT-6.2: describe the task as you would to a colleague who knows the project, "then tell Codex **what you'll look for when you review the work**". [DOCS gpt-6-2 guide]
- **Boundaries:** "Focus on the one or two boundaries that matter most. You don't need to control every step." [DOCS prompting.md]
- **Reasoning effort:** Medium for surveys, High for tracing a cause across systems, Extra High for interacting causes. [DOCS gpt-6-2 guide] The cookbook says "medium" is the all-round default and `high`/`xhigh` are for the hardest tasks. [SECONDARY] Set it in exec with `-c model_reasoning_effort="medium"`.
- **AGENTS.md best practice:** "Keep your `AGENTS.md` lean. Use AGENTS.md for project requirements and conventions that Codex can't infer from the code, tests, or docs. Include a workflow when the project depends on it. Leave routine decisions about how to do the work to Codex." [DOCS gpt-6-2 guide] Also: "Raise the limit or split instructions across nested directories when you hit the cap" and "place overrides as close to specialized work as possible". [DOCS agents-md.md]
- **Several agents on one machine:** "When several agents share the machine, ask each to consider how many builds or tests it needs to run at once and to leave CPU and memory available ... When wrapping up, have each agent stop the background jobs it started and remove the temporary files it created". [DOCS gpt-6-2 guide] This applies directly to Orchestra's worker prompt.
- **Minimal prompting for codex models:** "remove all prompting for the model to communicate an upfront plan, preambles, or other status updates during the rollout, as this can cause the model to stop abruptly before the rollout is complete." Start from the standard Codex prompt and make "tactical additions". [SECONDARY codex cookbook]
- **Autonomy/persistence snippet** (cookbook starter prompt): "Persist until the task is fully handled end-to-end ... Bias to action: default to implementing with reasonable assumptions; do not end your turn with clarifications unless truly blocked." "Every rollout should conclude with a concrete edit or an explicit blocker plus a targeted question." [SECONDARY] For eval or non-interactive use, "we recommend turning up the autonomy or prompting for a 'non-interactive' mode". [SECONDARY]
- **Dirty worktree rules** (cookbook): "NEVER revert existing changes you did not make" and "**NEVER** use destructive commands like `git reset --hard` or `git checkout --` unless specifically requested". [SECONDARY]
- **Plan tool:** skip it for the easiest ~25% of tasks, no single-step plans, and reconcile all plan items before finishing. [SECONDARY]
- **GPT-5 agentic eagerness** [SECONDARY gpt-5 guide]:
  - Less eagerness: lower `reasoning_effort` and a `<context_gathering>` block with early-stop criteria or a tool-call budget plus an escape hatch.
  - More eagerness: a `<persistence>` block.
  - In both cases, "clearly state the stop conditions ... outline safe versus unsafe actions".
  - Tool preambles are steerable (`<tool_preambles>`).
  - "Contradictory or vague instructions can be more damaging to GPT-5 than to other models, as it expends reasoning tokens searching for a way to reconcile the contradictions", so avoid conflicts between the Orchestra prompt and the project's AGENTS.md.
  - "Peak performance when distinct, separable tasks are broken up across multiple agent turns, with one turn for each task."
- **Sub-agents:** Codex delegates only "after a direct request or applicable project or skill instruction". [DOCS subagents.md] The injected `<multi_agent_mode>` says: "Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask". [EMPIRICAL] So a project AGENTS.md that mentions parallel agents could make an Orchestra worker spawn its own sub-agents unless `agents.enabled=false`.

---

## 6. Isolation from the user's setup

### 6.1 MCP servers, apps, plugins, hooks, skills
- User `[mcp_servers]` live in `$CODEX_HOME/config.toml`, so `--ignore-user-config` drops them. Project `.codex/config.toml` MCP servers load only for trusted projects, and with the user config ignored the trust is unknown, so they are disabled. [SOURCE] [DOCS non-interactive-mode.md] An `required = true` MCP server failing makes exec exit with an error. [DOCS]
- **Not covered by `--ignore-user-config`:**
  - `features.apps` (ChatGPT connectors exposed as tools; "stable; on by default") → `--disable apps`.
  - `plugins` / `remote_plugin` features → `--disable plugins`.
  - `hooks` → `--disable hooks`.
  - `memories` (default off).
  - `browser_use`, `computer_use`, `image_generation`, `tool_suggest`.
  - `web_search` → `-c web_search="disabled"`.
  - Sub-agents → `-c agents.enabled=false`. [SOURCE config/mod.rs `multi_agent_version_override`: `agents.enabled=false` → Disabled unless `features.multi_agent_v2`] [EMPIRICAL: multi-agent blocks disappear]
  - All of these flags are accepted by 0.170.0. [EMPIRICAL prompt-input] **Exec `--strict-config` validates config-file keys, and the loader also runs `validate_cli_overrides_strictly` on the `-c` layer when strict.** [SOURCE config/src/loader/mod.rs] Whether unknown `--disable <feature>` names are rejected is [UNCLEAR].
- Managed/system config (`/etc/codex`, `%ProgramData%\OpenAI\Codex`, `requirements.toml`, MDM, cloud bundle) always applies and can't be overridden. That is fine; it's the user's org policy.

### 6.2 CODEX_HOME and profiles
- `CODEX_HOME` is the root for config, auth, logs, sessions, skills, sqlite and so on. "If you set it, the directory must already exist." `CODEX_SQLITE_HOME` relocates the sqlite state. [DOCS https://learn.chatgpt.com/docs/config-file/environment-variables.md]
- Profiles v2: `-p NAME` layers `$CODEX_HOME/NAME.config.toml` over the base user config. Legacy `[profiles.NAME]` tables conflict with that and are rejected. Profiles are ignored with `--ignore-user-config`. [HELP] [SOURCE loader]
- **Separate CODEX_HOME = separate login.** File store: `$CODEX_HOME/auth.json`. Keyring key: `"cli|"` + a hash of the canonical CODEX_HOME. [SOURCE login/src/auth/storage.rs `compute_store_key`] `auth.json` may be a symlink and Codex follows "credential link" symlinks (up to 40 hops) and writes through them. [SOURCE login/src/auth/storage_file.rs `resolve_auth_file`] Sharing the user's login with a private worker CODEX_HOME through a symlink is therefore *possible*: [UNCLEAR, unverified on Windows, where symlinks need Developer Mode/admin].
- Concurrency: many `codex exec` processes sharing one local CODEX_HOME is the normal case (sqlite WAL on local disk). For isolation per job, the docs suggest a private `CODEX_HOME` + `CODEX_SQLITE_HOME`, or `--ephemeral` + `-o`. [DOCS https://learn.chatgpt.com/docs/environments/network-file-systems.md "Run independent batch jobs"]

### 6.3 Auth: ChatGPT login vs API key
- Precedence in `load_auth` [SOURCE login/src/auth/manager.rs ~1606]:
  1. **`CODEX_API_KEY` env** ("API key via env var takes precedence over any other auth method"), only where `enable_codex_api_key_env` is true. **`codex exec` sets it to true** (exec/src/lib.rs:810). The interactive app-server and `codex login status` use false.
  2. Ephemeral/external ChatGPT tokens.
  3. **`CODEX_ACCESS_TOKEN` env** (ChatGPT/Codex access token or agent identity, for enterprise automation).
  4. The persisted store (`auth.json`/keyring), which holds ChatGPT login or an API key saved via `codex login --with-api-key`.
- `OPENAI_API_KEY` is **not** read for model auth in 0.170.0. It is used only for TUI onboarding prefill, realtime voice and guardian-v2. It *can* bill if a custom `model_provider` uses `env_key="OPENAI_API_KEY"`, and `--ignore-user-config` removes such user providers. [SOURCE grep `read_openai_api_key_from_env`] Docs still warn not to expose `OPENAI_API_KEY`/`CODEX_API_KEY` to repo code. [DOCS]
- "When you sign in with an API key, Codex uses standard API pricing instead of included ChatGPT plan credits." [DOCS https://learn.chatgpt.com/docs/auth.md]
- `forced_login_method = "chatgpt" | "api"` and `forced_chatgpt_workspace_id`: "If the active credentials don't match the configured restrictions, **Codex logs the user out and exits**." [DOCS auth.md] [SOURCE `enforce_login_restrictions` → `logout_with_message`, which deletes stored credentials] **Do not use this as a guard from Orchestra.** A mismatch (e.g. a stray `CODEX_API_KEY`) would wipe the user's stored login. Strip the env vars instead.
- `preferred_auth_method` does not exist in the 0.170.0 config schema (not in config_toml.rs). [SOURCE]
- `cli_auth_credentials_store = file|keyring|auto|ephemeral`. The packaged default is `file`. [SOURCE config/defaults.toml] [DOCS]

### 6.4 Checking login status without reading auth.json
- `codex login status`. Output goes to **stderr**: "Logged in using ChatGPT" (exit 0), "API key configured - sk-...xxxx" (exit 0), "Logged in using access token" / "personal access token" / "workload identity" / Bedrock variants (exit 0), "Not logged in" (exit 1), "Error checking login status: ..." (exit 1). [SOURCE cli/src/login.rs `run_login_status`] [EMPIRICAL with empty home: "Not logged in", exit 1]
- It calls `load_auth(enable_codex_api_key_env=false)`, so it reports the *stored* login and ignores `CODEX_API_KEY` in the environment. Orchestra must check the env separately. [SOURCE]
- It loads config (accepts `-c`). Parse by prefix: `Logged in using ChatGPT` → OK for subscription billing.

---

## 7. Multi-agent features

- **In-session sub-agents** (multi_agent v2) are on by default with GPT-6.x catalog models. The tools are `spawn_agent`, `followup_task`/`send_input`, `wait`, `close_agent`, and they appear in JSONL as `collab_tool_call`. They are triggered by an explicit request or by AGENTS.md/skill instructions. Config: `[agents] enabled, max_concurrent_threads_per_session, max_depth, default_subagent_model, default_subagent_reasoning_effort`, plus custom roles `[agents.<name>] description, config_file, nickname_candidates`. [DOCS https://learn.chatgpt.com/docs/agent-configuration/subagents.md] [SOURCE config_toml.rs AgentsToml] OpenAI's own advice: "use parallel agents for read-heavy tasks such as exploration, tests, triage, and summarization. Be more careful with parallel write-heavy workflows, because agents editing code at once can create conflicts". [DOCS subagents.md]
- **`codex mcp-server` is removed** (also absent in the user's alpha): "The `codex mcp-server` command and the standalone `codex-mcp-server` binary have been removed ... The previous MCP tool reference and Agents SDK examples on this page are no longer supported." The replacement is the **app server** (JSON-RPC 2.0 over stdio JSONL; `thread/start`, `turn/start`, `item/*` notifications; "experimental and isn't supported for production workloads"). [DOCS https://learn.chatgpt.com/docs/mcp-server.md, app-server.md] So the old "Agents SDK + codex mcp-server" orchestration guide is obsolete.
- **Codex SDK** (TypeScript, `@openai/codex-sdk`, Node ≥ 18): `codex.startThread()`, `thread.run()`, `resumeThread(id, {sandboxMode})`, `threadSource`. It wraps the CLI and is a Node-native alternative to spawning `codex exec`. [DOCS https://learn.chatgpt.com/docs/codex-sdk.md] Whether its auth defaults suit the ChatGPT login: [UNCLEAR, not checked].
- **Codex Cloud:** `codex cloud exec|status|list|apply|diff` (EXPERIMENTAL). It runs tasks in OpenAI-hosted VMs, so it is not local. [HELP]
- `codex exec --worktree`: a Codex-managed git worktree per run. [HELP] `codex agents`: a TUI "agent command center" over a shared app-server daemon. `codex exec` itself runs an **in-process** app server, not the daemon. [SOURCE exec/src/lib.rs InProcessClientStartArgs]
- Under-development flags hint at more to come: `agent_message_board`, `subagent_thread_environments`, `runtime_agent_instances`. [HELP features list]
- Documented pattern for automation: run Codex with read-only repo permissions, serialize the diff as an artifact, and apply/commit in a separate privileged step. [DOCS non-interactive-mode.md "Autofix CI failures"] This matches Orchestra's conductor-merges design.

---

## Implications for Orchestra

### Recommended worker command line (Windows, Node `spawn`, no shell)
Conductor sets `cwd` = worker worktree, strips `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` and `OPENAI_API_KEY` from the env, and pipes the prompt on stdin:
```
codex exec -
  --json -o <run>/last.txt [--output-schema <run>/result.schema.json]
  --ephemeral --ignore-user-config --ignore-rules --strict-config
  -C <worktree>
  -s workspace-write                      # OR a permission profile (below), never both
  -m <model> -c model_reasoning_effort="medium"
  -c agents.enabled=false
  -c web_search="disabled"
  --disable apps --disable plugins --disable hooks --disable memories
  --disable browser_use --disable computer_use --disable image_generation --disable tool_suggest
  -c project_doc_fallback_filenames=["CLAUDE.md"]   # only if the project uses CLAUDE.md instead of AGENTS.md
  -c shell_environment_policy.ignore_default_excludes=false   # hide *KEY*/*SECRET*/*TOKEN* env from commands
  -c developer_instructions="<Orchestra harness contract: allowed paths, no commits, stop conditions, output format>"
```
- Write the prompt then call `stdin.end()`. Never pass a prompt argument with an open stdin pipe.
- Read JSONL from stdout and keep stderr for diagnostics. Exit code 0 means the turn completed. Treat `turn.failed` / `error` / exit 1 as failure.
- Collect the changed files from git (`git status --porcelain` in the worktree), not from `file_change` items alone. Commands can also write files.
- Usage: `turn.completed.usage` (cumulative; includes `cached_input_tokens`).
- Pre-flight once per run:
  - `codex --version`.
  - `codex login status`: stderr starts with "Logged in using ChatGPT", and the env has no `CODEX_API_KEY`.
  - Optionally a dry run of `codex debug prompt-input "<prompt>"` with the same `-c`/`--disable` flags and the process cwd set to the worktree (prompt-input has no `-C` or `--ignore-user-config`). It makes no model call and shows exactly which AGENTS.md text and permission profile a worker gets.

### Following the project's rules
- Codex auto-loads `AGENTS.md`/`AGENTS.override.md` from the worktree root down to cwd. Run workers with cwd = worktree root (or the subtask's directory, if subdirectory AGENTS.md files should load automatically).
- Nested AGENTS.md files *below* cwd are **not** auto-loaded, and current GPT-6.x prompts don't tell the model to look for them. Two options:
  - (a) Start the worker with `-C <worktree>/<deepest common dir of its allowed files>`. The project root is still found via the worktree's `.git` file, so every AGENTS.md from the worktree root down to that directory loads. The workspace (writable) root becomes that subdirectory, which also narrows writes. Downside: tools that write caches or lockfiles at the repo root would fail; `--add-dir` can re-grant specific paths. [EMPIRICAL prompt-input: with cwd = repo/sub/deeper, workspace_roots = that dir and root+deeper AGENTS.md both loaded; not tested with a real exec run]
  - (b) Have the conductor list the applicable nested AGENTS.md paths in the task prompt ("read and follow these").
- For a CLAUDE.md-only project, pass `project_doc_fallback_filenames=["CLAUDE.md"]`. This doesn't help where both files exist and differ, and CLAUDE.md `@imports` are not expanded.
- The global `~/.codex/AGENTS.md` (the user's personal rules) will be included even with `--ignore-user-config`. Either accept that (it's the user's own file) or use a dedicated worker `CODEX_HOME`, which needs its own login.
- Keep `project_doc_max_bytes` at 32 KiB or raise it via `-c` if the project files are bigger. Truncation shows up as `item.completed` `error` warnings in JSONL, so surface them.
- Put Orchestra's harness rules in `developer_instructions` (developer role, outranks AGENTS.md per the prompt hierarchy). Don't duplicate project rules. Avoid contradicting AGENTS.md: GPT-5-class models burn reasoning on conflicts.

### Limiting the worker
- OS-level: `-s workspace-write` restricts writes to the worktree, TEMP and `--add-dir`. `.git` stays read-only, which conveniently stops worker commits. Network is off by default.
- For per-file ownership, try a **permission profile via `-c`** (beta) instead of `-s`:
  `-c default_permissions='"orch"' -c 'permissions.orch={extends=":workspace", filesystem={":workspace_roots"={"."="read","src/feature"="write"}}}'`
  Verify that this works on the user's Windows sandbox implementation before relying on it. The conductor's post-run diff check stays the authoritative gate either way.
- Exec forces approval `never`. Escalations are rejected, never prompted, so a worker can't hang on a prompt. Also apply a wall-clock timeout plus a kill of the process tree. On Windows, MXC kills children when the command exits, while the legacy sandboxes may leave stragglers.
- Disable sub-agents, apps, plugins, hooks and web search as above. Use `--ignore-rules` so the user's execpolicy allow-rules can't widen what runs outside the sandbox.
- Don't use `--trust`. It would load the project's `.codex/config.toml` and MCP servers, which can run outside the sandbox, and it persists.
- Never use `forced_login_method`, because a mismatch logs the user out.

## Open questions / must verify on the user's machine
1. `codex --version`, `codex exec --help` and `codex debug prompt-input --help` on 0.169.0-alpha.11.1 from the VS Code bundle. Expected to match 0.170.0. Also find where the bundled binary lives on Windows (VS Code extension dir) and whether a standalone `npm i -g @openai/codex` is preferable.
2. Which Windows sandbox is active (`windows.sandbox` / MXC probe command above). Is `codex-windows-sandbox-setup.exe` present in the extension bundle, and does workspace-write actually block writes outside the worktree and to `.git` in a worktree?
3. Does a `-c`-defined permission profile with a `":workspace_roots"` subpath `write` rule enforce on Windows (mxc/elevated/unelevated)? Or is it "rejected because the runtime cannot enforce"?
4. `codex debug prompt-input` with the user's real login: the actual default model, its live instructions template, whether `apps`/plugins blocks appear, and what the global `~/.codex/AGENTS.md` contains.
5. Confirm that `--strict-config` rejects a misspelled `-c` key (the source says yes) and check unknown `--disable` feature names. This catches typos in the worker command line.
6. Is `codex exec -s workspace-write -C <dir> resume <id> -` accepted? (`-s`/`-C` are not global flags.) Is resume even needed, given `--ephemeral`?
7. Concurrency: N parallel `codex exec` on one `~/.codex`. Watch for sqlite locking and ChatGPT token-refresh races. Do the ChatGPT plan rate limits apply per account across parallel workers? (Expected yes.)
8. Does `codex login status` print "Logged in using ChatGPT" on the user's setup (VS Code extension login shares `~/.codex/auth.json` or keyring)?
9. Whether `codex exec` respects `--ignore-user-config` for hooks in practice (`$CODEX_HOME/hooks.json`). The plan already passes `--disable hooks`, so this only matters if hooks are wanted.
10. Codex SDK (`@openai/codex-sdk`) as an alternative to raw spawn: does it pass `--ignore-user-config` / arbitrary `-c` overrides, and does it use the ChatGPT login?
