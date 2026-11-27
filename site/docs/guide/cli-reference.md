---
title: CLI Reference, Flow Viewer & Trade-Offs
description: Complete dfl v0.3.0 CLI command reference, dfl flow view interactive DAG controls, --json/--yes CI behavior, environment variables, Node >=22.12 requirements, troubleshooting, and honest trade-offs.
---

# CLI Reference, Flow Viewer & Trade-Offs

`@vishin-pavel/dfl` (v0.3.0, MIT) installs the `dfl` binary (named `dfl` rather than `df` to avoid colliding with `/bin/df` on macOS and Linux).

## Runtime & Installation

- **Runtime requirement:** **Node.js `>=22.12`** (enforced at startup with a clear error).
- **Building from source:** Requires **Node.js `>=22.18`** or **`>=24.11`** (for `tsdown`).
- **Install globally:** `npm install -g @vishin-pavel/dfl` (prereleases: `@vishin-pavel/dfl@next`).
- **Install per project:** `npm install -D @vishin-pavel/dfl` (run via `npx dfl …`; `dfl` automatically writes `npx --no-install dfl mcp` in MCP configs so `npx` never downloads an unrelated public `dfl` package).

---

## Global Options & Non-Interactive / CI Behavior

Global flags accepted by every command:

- `--root <dir>` — Project root override (defaults to `DFL_ROOT`, then nearest parent directory containing `.df/`; never crosses an enclosing git repository boundary).
- `--no-color` — Disable ANSI color output.
- `-v, --version` — Print installed `dfl` version.
- `-h, --help` — Print command help.

**Non-interactive & CI rules:**

- `dfl` never prompts when `--yes` is passed, when `stdin`/`stdout` is not a TTY, or when `CI` is set.
- Destructive commands (`uninstall`, `flow delete`, `flow pull`, `flow import --force`, `step remove`, `tracker map --remove`) require `--yes` in non-interactive mode (and `flow pull` additionally requires `--discard-local` if local edits would be overwritten).
- Commands exit non-zero on error. Warnings go to `stderr` so `--json` output on `stdout` is safely pipeable.

---

## Complete Command Reference

### Setup, Sync & Inspection

| Command | Description |
|---------|-------------|
| `dfl install [-a, --agents <list>] [-f, --flow <name>] [-y, --yes] [--mcp \| --no-mcp] [--project-agents]` | Initialize or join a `dfl` project: create/activate a flow, render skills, and register the MCP server. `--mcp`/`--no-mcp` is saved in `.df/local.json`. |
| `dfl uninstall [--purge] [-y]` | Remove installed skills and `dfl` MCP config entries. `--purge` also deletes `local.json`, `state.json`, `fast-forward.json`, and rendered files (keeps `.df/<flow>/`). |
| `dfl flow-update` (`dfl update`) `[--dry-run] [--mcp \| --no-mcp] [-y]` | Re-render and re-install the active flow's skills. Never mutates flow definitions; notifies if an upstream template changed. |
| `dfl agents [--json]` | List all 9 supported coding agents, project detection status, skill paths, and per-agent notes. |
| `dfl mcp` | Run the built-in stdio MCP server (normally started by your coding agent). |

### Runtime Flow Navigation

| Command | Description |
|---------|-------------|
| `dfl status [--flow <f>] [--task <key>] [--json]` | Show active flow, current step, available events, skill freshness (`skills`), Jira ticket status (`task`), and fast-forward status (`fastForward`). |
| `dfl next [event] [--from <step>] [--flow <f>] [--task <key>] [--set <name=value>]... [--json]` | Fire an event (default `NEXT`). On Jira-tracked flows, also moves the ticket and updates params (`name=` deletes a param). |
| `dfl goto <step> [--flow <f>] [--task <key>] [--set <name=value>]... [--json]` | Jump directly to a step. |
| `dfl reset [--flow <f>] [--task <key>] [-y] [--json]` | Return to the initial step (asks before moving a shared Jira ticket). |
| `dfl fast-forward [state] [--stop] [--reason <text>] [--flow <f>] [--task <key>] [--json]` | Start or resume a fast-forward run to `state` (or flow end), or stop an active run. |

### Flow Management & Sharing

| Command | Description |
|---------|-------------|
| `dfl flow list` / `ls [--json]` | List all flows in `.df/` and the active flow. |
| `dfl flow templates` | List prebuilt templates (`dev`). |
| `dfl flow use <name> [--project] [--no-sync]` | Switch active flow (personal by default; `--project` updates team default in `.df/config.json`). Refuses invalid flows. |
| `dfl flow create <name> [--from <template> \| --steps a,b] [--title] [--description] [--use] [--no-sync]` | Create a flow from `dev` or a blank linear step list. |
| `dfl flow export [names...] [--all] [-o <file\|dir\|->] [--force]` | Export flow(s) to a portable `.dfl.json` snapshot (default: active flow → `<flow>.dfl.json`). |
| `dfl flow import <source> [--name <n>] [--flow <names...>] [--force] [--dry-run] [-y] [--use] [--no-sync]` | Import flow(s) from `.dfl.json`, `github:owner/repo[/path][#ref]`, git URL, or local directory. |
| `dfl flow pull [name] [--rev <ref>] [--dry-run] [-y] [--discard-local] [--no-sync]` | Pull upstream updates from recorded `source` with digest-based conflict preview and automatic backup. |
| `dfl flow delete` / `rm <name> [-y]` | Delete a flow (saves a backup to `.df/.dfl-backups/` first). |
| `dfl flow validate [name] [--json]` | Validate flow JSON, transitions, Handlebars templates, and optional `tracker.json` references. |
| `dfl flow view [name] [--zoom <0-3>] [--print] [--lr] [--ascii]` | Open the interactive terminal DAG viewer or print the graph to stdout. |

### Step & Variable Management

*(All `step` and `vars` commands accept `--no-sync`; `step` commands accept `--flow <name>`.)*

| Command | Description |
|---------|-------------|
| `dfl step list` / `ls [--flow <f>] [--json]` | List steps in flow order. |
| `dfl step add <id> [--after <s> \| --before <s>] [--title] [--description] [--event <E>] [--template-file <f>]` | Add a step and wire its transitions. |
| `dfl step edit <id> [--title] [--description] [--rename <new-id>] [--template-file <f>] [--initial]` | Edit a step's metadata, template, ID, or initial state. |
| `dfl step remove` / `rm <id> [--force] [-y]` | Remove a step and reroute incoming transitions. |
| `dfl step transition <id> <event> [target] [--description <text>] [--remove]` | Add, update, or remove an outgoing transition. |
| `dfl vars list` / `ls [--json]` | List resolved variables and their source layer (`dfl vars` alone also lists). |
| `dfl vars set <name> <value> [--personal \| --project]` | Set a variable in its declared (or explicitly chosen) scope. |
| `dfl vars unset <name>` | Remove a stored variable value. |

### Jira Task & Tracker Commands

| Command | Description |
|---------|-------------|
| `dfl task start <ticket> [--flow <f>] [--step <s>] [--branch auto\|create\|current] [--slug <s>] [--json]` | Start or continue a Jira ticket (`ABC-123`, `123`, `"#123"`, or URL). |
| `dfl tracker init [--url <u>] [--project <keys>] [--default-project <key>] [--branch-template <t>] [--from <ref>] [--property <p>] [--flow <names...>] [--force] [--no-sync] [-y]` | Create `.df/tracker.json` and enable tracking for the active (or named) flow(s). |
| `dfl tracker login [--email <e>] [--token-stdin]` / `logout` | Save (after live verification) or remove your classic Jira API token in `~/.config/dfl/credentials.json`. |
| `dfl tracker check [--json]` | Verify config, credentials, projects, statuses, and custom fields against Jira (exits `1` on problems). |
| `dfl tracker map [step] [status \| id:<id> \| none] [--flow <f>] [--none] [--unset] [--remove] [--list] [--json] [--no-check] [-y]` | Map flow steps to Jira statuses (or `none` / `--remove`). |
| `dfl tracker field [param] [field \| none] [--none] [--list] [--json] [--no-check]` | Map task params (`branch`, `prUrl`, …) to Jira custom fields. |

---

## Terminal Flow Viewer (`dfl flow view`)

`dfl flow view [name]` renders your flow as an orthogonal layered DAG directly in the terminal using Ink 7, React 19, and ELKjs (`elk.algorithm: layered`, `elk.edgeRouting: ORTHOGONAL`). The current step is drawn with a heavy cyan border; `NEXT` edges are unlabelled and all other transitions carry labels.

### Interactive Controls

| Key | Action |
|-----|--------|
| `w` `a` `s` `d` / Arrow keys | Pan by quarter-viewport |
| `W` `A` `S` `D` / PgUp / PgDn | Pan a full page |
| `q` | Zoom in (more detail, up to `3`) |
| `e` | Zoom out (less detail, down to `0`) |
| `l` | Toggle top-to-bottom (`TB`) ↔ left-to-right (`LR`) |
| `c` | Center viewport on the current step |
| `x` / `Ctrl+C` | Exit alternate screen |

### Zoom Levels & Flags

- **Zoom `0`:** Compact one-line nodes (`[Classify]`)
- **Zoom `1`:** Title boxes
- **Zoom `2`:** Cards with truncated descriptions (default for `--print`)
- **Zoom `3`:** Full cards with complete descriptions and agent skill commands (`/name` or `$name` for Codex)
- **`--print`:** Prints the full canvas to stdout and exits (also automatic when stdin/stdout is not a TTY — does not load Ink/React).
- **`--lr`:** Left-to-right layout instead of top-to-bottom.
- **`--ascii`:** Pure 7-bit ASCII box drawing, arrows, header, and footer.

For an architectural deep dive, see [Building an Orthogonal Terminal DAG Viewer with Ink & ELKjs](/blog/orthogonal-terminal-dag-ink-elkjs).

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DFL_ROOT` | Override project root discovery (same as `--root <dir>`); respected by `dfl mcp` |
| `DFL_CONFIG_DIR` | Override user config directory for `credentials.json` (default `~/.config/dfl` or `%APPDATA%\dfl`) |
| `DFL_JIRA_URL` | Jira Cloud origin for CI/non-interactive auth (used only if it matches `jira.baseUrl`) |
| `DFL_JIRA_EMAIL` | Atlassian account email for CI auth |
| `DFL_JIRA_TOKEN` | Classic Atlassian API token for CI auth (never logged or written to disk) |
| `DFL_TRACKER_TIMEOUT_MS` | Per-operation Jira HTTP timeout in ms (default `10000`; keep `<15000`) |
| `DFL_DEBUG` | Set `DFL_DEBUG=1` for stack traces, Jira HTTP diagnostics, and MCP transport errors on stderr |
| `DFL_VAR_<UPPER_SNAKE_NAME>` | Override any flow template variable (highest precedence) |
| `DFL_ENV_<NAME>` | Allow-listed environment variable exposed in Handlebars templates as `{{env.<NAME>}}` |
| `CI` | Disables interactive prompts (same as non-TTY) |
| `NO_COLOR` / `FORCE_COLOR` | Disable or force ANSI colors |
| `COLUMNS` | Override table width when stdout is not a TTY |

---

## Troubleshooting Common Errors

| Error / Symptom | Fix |
|-----------------|-----|
| `dfl needs Node.js 22.12 or newer` | Upgrade Node.js to `>=22.12` (`>=22.18` or `>=24.11` to build from source). |
| `NO_PROJECT` | Run `dfl install` at your repo root, or pass `--root <dir>` / `DFL_ROOT`. |
| `LOCKED` | Another `dfl` CLI or MCP server holds `.df/.lock` (waits up to 15s). Wait for it to finish, or verify the PID in `.df/.lock` is dead before removing it. |
| `INVALID_MANIFEST` | Repair `.df/installed.json`, or delete it and re-run `dfl install`. |
| Agent doesn't see `dfl` MCP server | Run `dfl agents`, verify `dfl`/`npx` is on the agent's `PATH`, and reload the agent. On native Windows, apply the `.df/config.json` workaround in [MCP Server](/guide/mcp-server#native-windows-workaround). |

---

## Honest Trade-Offs & Limitations

`dfl` is engineered for clarity and zero lock-in, which comes with explicit, documented boundaries in v0.3.0:

1. **Inside-step compliance is prompt-enforced + git-auditable, not OS-sandboxed.** XState v5 and `dfl mcp` deterministically enforce valid state transitions, loop limits (stopping on the 4th visit during `/fast-forward`), and refusal of unintended final states. Inside a step, the LLM follows rendered skill instructions and produces git-auditable artifacts (`REQUIREMENTS.md`, `TECH_DESIGN.md`, task briefs, and fresh-session Dev QA reports).
2. **Documentation-only Gherkin (no Cucumber runner).** `REQUIREMENTS.md` uses `Given / When / Then` as a structured specification format linked to your existing tests by stable ID (`CHK-1.2`), not executable `.feature` files.
3. **Node.js `>=22.12` required.** Node 20 LTS is rejected at startup with a clear error message.
4. **Native Windows MCP requires a one-line config override.** macOS, Linux, and WSL are first-class and CI-tested; native Windows requires a `cmd /c` or `node node_modules/...` override in `.df/config.json` due to npm `.cmd` shims.
5. **Fixed list of 9 built-in coding agents.** Custom agent adapters cannot be declared in config yet (tools reading `.agents/skills` or `.claude/skills` can piggyback on an existing adapter).
6. **Jira Cloud only (classic API tokens).** No GitHub Issues, Linear, Jira Server/Data Center, or scoped Atlassian tokens yet; tracked steps require Jira reachability.
7. **`elkjs` third-party license.** `@vishin-pavel/dfl` is MIT-licensed; its `elkjs` runtime dependency is licensed under `EPL-2.0 OR GPL-3.0-or-later`, dynamically imported unmodified at runtime and kept external from `dist/cli.mjs` (documented in `NOTICE`).
8. **100% local, zero telemetry.** Zero analytics packages, zero background pings — the sole network `fetch()` in the entire codebase is the opt-in Jira Cloud client (`src/core/tracker/http.ts`).
