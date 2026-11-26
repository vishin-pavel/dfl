# Built-in MCP Server (`dfl mcp`)

`dfl` ships a built-in stdio Model Context Protocol (MCP) server named `dfl`. During `dfl install`, `dfl` automatically registers it in the project MCP configuration of every selected coding agent — you never need to start it manually.

The server re-reads `.df/` files on every tool call, so manual edits, CLI commands, and `git pull` updates are reflected immediately without restarting the server.

---

## All 15 MCP Tools

| # | Tool | Category | Purpose |
|---|------|----------|---------|
| 1 | `get_flow` | Read | Returns the active (or named) flow: steps in order, transitions, variables, and current step. Also works on a broken flow (`current: null` plus `problem` and `issues`). |
| 2 | `list_flows` | Read | Lists all flows in `.df/` and identifies which flow is active. |
| 3 | `get_status` | Read | Returns current step, its invocation command, available events, history tail, skill freshness (`skills`), Jira `task` object (on tracked flows), and `fastForward` state while a run is active or recently ended. |
| 4 | `get_step` | Read | Returns one step's metadata, transitions, raw Handlebars template, and rendered skill. |
| 5 | `validate_flow` | Read | Runs flow and template validation and returns structured errors and warnings. |
| 6 | `get_authoring_guide` | Read | Returns the complete authoring guide for writing step templates: files, context variables, helpers, rules, and an example. |
| 7 | `transition` | Runtime | Fires an event (default `NEXT`) from the current step. |
| 8 | `complete_step` | Runtime | Fires an event (default `NEXT`) from a specific expected step; fails if that step is not current (prevents stale/double advances). |
| 9 | `goto_step` | Runtime | Jumps directly to a named step. |
| 10 | `start_task` | Jira | Starts or continues a Jira ticket: binds it to a git branch (creating the branch when needed), writes the `dfl.run` record, and transitions the ticket status. |
| 11 | `fast_forward` | Autopilot | Starts, resumes (`to`, or neither), or stops (`stop`, `reason`) a fast-forward run. Returns `get_status`-shaped output plus `fastForward` (or `{ flow, task?, fastForward }` on stop). |
| 12 | `add_step` | Authoring | Creates a step (directory, `SKILL.md.hbs`, transition wiring), validates pre-write, and re-installs skills. Returns `placement`. |
| 13 | `update_step` | Authoring | Updates a step's title, description, template, transitions (with descriptions), ID (rename), or initial-step flag, validates pre-write, and re-installs skills. |
| 14 | `delete_step` | Authoring | Deletes a step, reroutes incoming transitions (`rewired`, `dropped`), validates pre-write, and re-installs skills. |
| 15 | `sync` | Sync | Equivalent to `dfl flow-update`: re-renders and re-installs skills for the active flow without mutating `.df/<flow>/`. |

### Common Tool Behavior

- **Optional `flow` argument:** Every tool except `list_flows`, `sync`, and `get_authoring_guide` accepts an optional `flow` name.
- **Jira arguments:** On Jira-tracked flows, `get_status`, `transition`, `complete_step`, `goto_step`, and `fast_forward` accept `task` (ticket key); the three move tools also accept `params` (key/value pairs recorded on the ticket and synced to mapped Jira fields). Ignored on untracked flows.
- **Fast-forward block:** While a fast-forward run is active — and after it stops or ends until the flow moves on — `get_status`, `transition`, `complete_step`, and `goto_step` include the `fastForward` block (`status`, `reason`, `detail`, `step`, `instructions`).
- **Agent-aware command syntax:** Command fields in tool responses (`command`, `targetCommand`, `next.command`, `fastForward.step.command`) automatically use `$name` when the MCP client identifies itself as OpenAI Codex, and `/name` otherwise.
- **Compiler-guarded authoring:** `add_step`, `update_step`, and `delete_step` validate both the XState machine graph and Handlebars template compilation *before* writing to disk, rejecting invalid edits cleanly. Skills are re-installed automatically once `dfl install` has been run in the clone.

---

## 2 MCP Resources

| Resource URI | Contents |
|--------------|----------|
| `dfl://flow` | The `flow.json` definition of the active flow |
| `dfl://steps/{id}` | The raw `SKILL.md.hbs` template for step `{id}` |

After `add_step`, `update_step`, `delete_step`, and `sync`, the server emits `notifications/resources/list_changed`. External changes made via CLI, text editor, or `git pull` are read fresh on the next call but do not emit notifications.

---

## Concurrency, Root Discovery & Transport

- **Project lock (`.df/.lock`):** All mutating operations — across concurrent MCP clients and the CLI — acquire `.df/.lock` (waiting up to 15 seconds) so simultaneous agents never corrupt state or flow files.
- **Project root resolution order:**
  1. `--root <dir>` CLI flag
  2. `DFL_ROOT` environment variable
  3. Client MCP roots (first root inside a directory containing `.df/`; clients on the `2026-07-28` protocol are queried via `input_required`)
  4. Nearest parent of the working directory containing `.df/` (never crosses an enclosing git repo boundary)
- **Clean stdio transport:** `stdout` carries strictly JSON-RPC frames. Template `{{log …}}` calls and `DFL_DEBUG=1` transport diagnostics write exclusively to `stderr`.

---

## Comment-Preserving Config Editing Across 9 Agents

`dfl install` registers the `dfl` MCP server in each selected agent's project config file using format-aware, comment-preserving editors (JSON, JSONC via `jsonc-parser`, and TOML for Codex):

| Agent(s) | Config File | Format |
|----------|-------------|--------|
| Claude Code, GitHub Copilot | `.mcp.json` | JSON |
| Cursor | `.cursor/mcp.json` | JSON |
| Google Antigravity | `.agents/mcp_config.json` | JSON |
| OpenAI Codex | `.codex/config.toml` | TOML |
| Gemini CLI | `.gemini/settings.json` | JSONC |
| Windsurf / Devin | `.devin/mcp_config.json` | JSON |
| OpenCode | `opencode.json` / `opencode.jsonc` | JSONC |
| Kiro | `.kiro/settings/mcp.json` | JSON |

- **Global vs. per-project command:** If the project's `package.json` lists `@vishin-pavel/dfl` in `dependencies`, `devDependencies`, or `optionalDependencies`, `dfl` writes `npx --no-install dfl mcp`; otherwise it writes `dfl mcp`. `--no-install` prevents `npx` from downloading an unrelated public npm package named `dfl`.
- **Custom MCP command override:** Override in `.df/config.json` for all teammates:
  ```json
  {
    "version": 1,
    "vars": {},
    "mcp": { "command": "pnpm", "args": ["exec", "dfl", "mcp"] }
  }
  ```
- **Disabling MCP registration:** Pass `dfl install --no-mcp` (saved in `.df/local.json`) or `dfl flow-update --no-mcp` (single run). Because MCP configs are committed team files, deselecting an agent does not delete its entry; only `dfl uninstall` removes the `dfl` entry (and only if the entry matches `dfl`), leaving other servers and comments untouched.

---

## Native Windows Workaround

`dfl` is developed and tested in CI on macOS and Linux; **WSL works identically to Linux**.

On **native Windows**, the CLI and skills work, but npm installs `dfl` and `npx` as `.cmd` shims, and coding agents spawn stdio MCP servers without a shell — causing `dfl mcp` or `npx --no-install dfl mcp` to fail with `"Connection closed"` or `ENOENT`.

Set an explicit `mcp` override in `.df/config.json` and run `dfl flow-update`:

- **Windows-only team (global install):**
  ```json
  { "version": 1, "vars": {}, "mcp": { "command": "cmd", "args": ["/c", "dfl", "mcp"] } }
  ```
  *(For per-project install: `"args": ["/c", "npx", "--no-install", "dfl", "mcp"]`.)*

- **Cross-OS team (macOS + Linux + Windows, per-project install):**
  ```json
  {
    "version": 1,
    "vars": {},
    "mcp": { "command": "node", "args": ["node_modules/@vishin-pavel/dfl/dist/cli.mjs", "mcp"] }
  }
  ```
  Start your coding agent from the project root so the relative path resolves cleanly on every OS.
