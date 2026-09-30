# Supported agents

`dfl` installs each flow step as an [Agent Skill](https://agentskills.io/specification)
(`<skills dir>/<skill>/SKILL.md`) and registers its MCP server (`dfl mcp`) in each
tool's project-level MCP config. This page records where each tool looks, as
researched on **2026-09-30**. The code lives in `src/agents/registry.ts` (one
adapter per tool) and `src/agents/mcp-config.ts` (comment-preserving config editors).

## Summary

| id | Tool | Skills dir | Invoke | Project MCP config | Entry written |
|----|------|------------|--------|--------------------|---------------|
| `claude` | Claude Code | `.claude/skills` | `/name` | `.mcp.json` → `mcpServers` | `{ "type": "stdio", "command", "args" }` |
| `cursor` | Cursor (IDE + CLI) | `.cursor/skills` | `/name` | `.cursor/mcp.json` → `mcpServers` | `{ "type": "stdio", "command", "args" }` |
| `antigravity` | Google Antigravity | `.agents/skills` | `/name` | `.agents/mcp_config.json` → `mcpServers` | `{ "command", "args" }` |
| `codex` | OpenAI Codex | `.agents/skills` | `$name` | `.codex/config.toml` → `[mcp_servers.dfl]` | `command = …`, `args = […]` |
| `gemini` | Gemini CLI | `.gemini/skills` | `/name` | `.gemini/settings.json` (JSONC) → `mcpServers` | `{ "command", "args" }` |
| `copilot` | GitHub Copilot (VS Code + CLI) | `.github/skills` | `/name` | `.mcp.json` → `mcpServers` | `{ "type": "stdio", "command", "args" }` |
| `windsurf` | Windsurf / Devin (Devin Desktop, Devin CLI) | `.devin/skills` | `/name` | `.devin/mcp_config.json` → `mcpServers` | `{ "command", "args" }` |
| `opencode` | OpenCode | `.opencode/skills` | `/name` | `opencode.json` (or `opencode.jsonc`) → `mcp` | `{ "type": "local", "command": [cmd, …args], "enabled": true }` |
| `kiro` | Kiro (IDE, CLI, Web) | `.kiro/skills` | `/name` | `.kiro/settings/mcp.json` → `mcpServers` | `{ "command", "args" }` |

Shared locations: Antigravity and Codex both use `.agents/skills`; Claude Code and
Copilot both use `.mcp.json`. The installer writes each distinct directory or file
once. When `env` is set it is written as `env` (JSON), `environment` (OpenCode) or a
`[mcp_servers.dfl.env]` subtable (Codex).

## How dfl edits MCP configs

- **JSON / JSONC** (`jsonc-parser`): only the `dfl` entry is set or removed.
  Comments, key order, indentation (detected from the file), line endings and the
  trailing newline are kept. A missing file is created as `{}` first. Nothing is
  written when the entry is already equal. On removal, a container emptied by dfl
  (`"mcpServers": {}`) is dropped, and the file is deleted when nothing else is left
  (apart from `$schema`) and it has no comments.
- **TOML** (Codex): dfl owns the `[mcp_servers.dfl]` table (preceded by a
  `# managed by dfl` line) and its `[mcp_servers.dfl.env]` subtable. They are replaced
  in place by text, from the header to the next table header, so the rest of the file
  is untouched. Other subtables you add (e.g. `[mcp_servers.dfl.tools.<tool>]`) are kept
  on update and removed together with the server on uninstall.
- dfl owns the whole `dfl` entry: extra fields added to it by hand are replaced on the next sync.
- **Command**: `config.json` `mcp.command`/`mcp.args` if set; otherwise
  `npx --no-install dfl mcp` when the running dfl is installed in
  `<root>/node_modules`; otherwise `dfl mcp` (dfl must be on the agent's `PATH`).

## Detection (`dfl agents`, install pre-selection)

`AGENTS.md`, `.agents/skills/` and `.mcp.json` are shared by several tools and are
never used as markers.

| id | Project markers |
|----|-----------------|
| `claude` | `.claude/`, `CLAUDE.md`, `CLAUDE.local.md` |
| `cursor` | `.cursor/`, `.cursorrules`, `.cursorignore`, `.cursorindexingignore` |
| `antigravity` | `.agents/mcp_config.json`, `.agents/{rules,skills,hooks}.json`, `.agents/{plugins,agents,workflows}/`, `.agent/`, `.antigravityignore`, `.gemini/config.json` |
| `codex` | `.codex/` |
| `gemini` | `GEMINI.md`, `.geminiignore`, `.gemini/{settings.json,skills,commands,agents,policies,.env}` |
| `copilot` | `.github/copilot-instructions.md`, `.github/{instructions,prompts,agents,skills,copilot}/`, `.github/mcp.json` |
| `windsurf` | `.devin/`, `.windsurf/`, `.windsurfrules`, `.devinignore`, `.windsurfignore`, `.codeiumignore` |
| `opencode` | `opencode.json`, `opencode.jsonc`, `.opencode/` |
| `kiro` | `.kiro/` |

## Per-tool notes

### Claude Code

- Skills are watched live. Run `/reload-skills` only if `.claude/skills/` did not
  exist when the session started.
- Claude Code does **not** read `.agents/skills`, so it needs its own copy.
- Servers from `.mcp.json` must be approved on first use. A committed
  `.claude/settings.json` cannot pre-approve them in an untrusted folder. Reset
  choices with `claude mcp reset-project-choices`.
- `CLAUDE_PROJECT_DIR` and the server's cwd are the directory the session started
  in, which may be a subdirectory. `dfl mcp` walks up to `.df/`.
- Avoid step names that clash with built-ins (`/review`, `/plan`, `/init`, `/run`, …).

### Cursor

- The IDE picks up new skills. The Cursor CLI (`agent`) has no file watcher: start a
  new session after `dfl install`.
- MCP servers need approval (Customize > MCPs; CLI: `agent mcp enable dfl` or
  `--approve-mcps`). Restart Cursor after `.cursor/mcp.json` changes.
- Cursor also reads `.claude/skills` and `.agents/skills` (IDE toggle "Include
  third-party … configs"), so a skill installed for several agents can appear twice.

### Google Antigravity

- Skills directly under `.agents/skills/` (legacy `.agent/skills`). In the CLI, run
  `/skills reload` after install. Some CLI builds load workspace `.agents/`
  customizations only for registered workspaces (`agy --add-dir .`).
- **MCP caveat**: the docs list `.agents/mcp_config.json`, but the CLI has been
  reported to ignore it (google-antigravity/antigravity-cli#60). The fallback is the
  global `~/.gemini/config/mcp_config.json` (e.g. `agy mcp add`; older CLI builds used
  `~/.gemini/antigravity-cli/mcp_config.json`). The Desktop app starts stdio servers
  with the app folder as cwd, so `dfl mcp` cannot rely on its cwd there.

### OpenAI Codex

- Skills load from `.agents/skills` in every directory from cwd up to the repo root,
  even in untrusted projects. Changes are picked up automatically.
- The CLI and IDE extension have **no per-skill slash commands**: mention a skill with
  `$name` or pick it from `/skills`. The ChatGPT desktop app also lists skills under `/`.
- `.codex/config.toml` is applied **only to trusted projects**. Trust is stored in
  `~/.codex/config.toml` as `[projects."<abs path>"] trust_level = "trusted"`.
  `codex mcp add` only edits the global config, so dfl edits the project file itself.

### Gemini CLI

- Workspace skills (`.gemini/skills`, also `.agents/skills`) and `.gemini/settings.json`
  load **only in trusted folders**: use the first-run dialog or `/permissions trust`.
- Run `/skills reload` after install. `/name` for skills works only in the interactive
  UI (not `gemini -p`). Discovery is one level deep, so `<dir>/<skill>/SKILL.md` only.
- Start `gemini` from the project root: workspace dirs are resolved from its cwd.
- `settings.json` is JSONC and strictly validated: dfl writes only `command`/`args`/`env`.

### GitHub Copilot

- VS Code and the Copilot CLI read `.github/skills` (also `.agents/skills`,
  `.claude/skills`). CLI: `/skills reload`; project skills load only in trusted folders.
- Root `.mcp.json` (`mcpServers`, `type: "stdio"`) is the one file both VS Code
  (1.118+) and the CLI read. `.vscode/mcp.json` is deprecated and ignored by the CLI.
- The CLI loads project MCP servers only after folder trust; VS Code applies Workspace Trust.

### Windsurf / Devin

- Windsurf was renamed Devin Desktop (2026-06). The current agent (Devin Local, Devin
  CLI) reads `.devin/skills` and also imports `.windsurf/`, `.agents/`, `.claude/`,
  `.cursor/` and `.github/` skills. Installing dfl for several agents can therefore
  show prefixed duplicates (`/claude:name`, `/agents:name`).
- `.devin/mcp_config.json` needs Devin CLI v3000.3+ (older builds read `mcpServers`
  from `.devin/config.json`). Devin asks before every MCP tool call. Pre-approve with
  `{"permissions":{"allow":["mcp__dfl__*"]}}` in `.devin/config.json`.
- Legacy Cascade (JetBrains plugin) has no project MCP and uses `@skill-name`.

### OpenCode

- Reads `.opencode/skills` (also `.agents/skills`, `.claude/skills`). Skills are hidden
  from the `/` autocomplete: type `/name` or use the `/skills` picker.
- When a skill runs as a slash command, `$ARGUMENTS`, `$1`, ``!`cmd` `` and `@path` in its
  body are expanded, so templates must avoid them.
- MCP goes into `opencode.json` under `mcp`. dfl uses `opencode.jsonc` when only that
  file exists (or when it already holds the `dfl` entry, since `.jsonc` wins on
  conflicts). A new `opencode.json` gets `"$schema": "https://opencode.ai/config.json"`.

### Kiro

- Only `.kiro/skills` is documented (not `.agents/skills`). The CLI discovers skills when
  a chat starts: start a new session after install.
- Custom agents see skills only if their `resources` include
  `skill://.kiro/skills/**/SKILL.md`, and MCP servers only with `includeMcpJson: true`.
- Enable "MCP support" in the IDE settings. dfl does not write a `type` key (not documented).

## Sources

- Claude Code: https://code.claude.com/docs/en/skills, https://code.claude.com/docs/en/mcp
- Cursor: https://cursor.com/docs/skills, https://cursor.com/docs/mcp, https://cursor.com/docs/cli/changelog
- Antigravity: https://antigravity.google/docs/skills/, https://antigravity.google/docs/mcp/, https://github.com/google-antigravity/antigravity-cli/issues/60
- Codex: https://learn.chatgpt.com/docs/build-skills, https://learn.chatgpt.com/docs/extend/mcp, https://learn.chatgpt.com/docs/config-file/config-basic
- Gemini CLI: https://geminicli.com/docs/cli/skills/, https://geminicli.com/docs/tools/mcp-server/, https://geminicli.com/docs/cli/trusted-folders/
- GitHub Copilot: https://code.visualstudio.com/docs/agent-customization/agent-skills, https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
- Windsurf / Devin: https://docs.devin.ai/cli/extensibility/skills/overview, https://docs.devin.ai/cli/extensibility/mcp/configuration
- OpenCode: https://opencode.ai/docs/skills/, https://opencode.ai/docs/mcp-servers/, https://opencode.ai/config.json
- Kiro: https://kiro.dev/docs/skills/, https://kiro.dev/docs/mcp/configuration/
- Agent Skills spec: https://agentskills.io/specification
