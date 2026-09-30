# dfl – development flow manager for coding agents

`dfl` turns your team's development process into a **flow**: an ordered state machine of
steps (spec → plan → implement → verify → review → ship, or whatever your team does). Each
step is an [Agent Skill](https://agentskills.io/specification) rendered from a Handlebars
template and installed into the project-level skill folders of your coding agents, so every
step is a slash command (`/plan-feature`) in Claude Code, Cursor, Codex, Gemini CLI, Copilot,
OpenCode, Windsurf/Devin, Kiro and Antigravity.

- **Flows live in your repo** (`.df/`), are reviewed like code and shared over git.
- **Skills are rendered per developer** from templates with project and personal variables.
- **A built-in MCP server** (`dfl mcp`) tells the agent where the flow is, which events it can
  fire (`NEXT`, `FAILED`, `CHANGES_REQUESTED`, …) and lets it add or edit steps.
- **A terminal flow viewer** (`dfl flow view`) draws the flow as a graph.

The binary is called `dfl`, not `df`, because `/bin/df` (disk free) exists on every macOS and
Linux machine.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [The `.df/` directory](#the-df-directory)
- [Flows and steps](#flows-and-steps)
- [Templates](#templates)
- [Variables](#variables)
- [Built-in skills](#built-in-skills)
- [MCP server](#mcp-server)
- [Flow viewer](#flow-viewer)
- [Supported agents](#supported-agents)
- [Sharing flows over git](#sharing-flows-over-git)
- [Command reference](#command-reference)
- [Development](#development)

## Install

Requires **Node.js 22.12 or newer**. `dfl` is published to GitHub Packages as
`@vishin-pavel/dfl`. GitHub Packages needs a token even for reading, so set up npm once:

1. Create a token with the `read:packages` scope, either a
   [classic personal access token](https://github.com/settings/tokens) or through the GitHub CLI.
2. Add the registry and the token to `~/.npmrc` (your user config, never commit the token):

   ```ini
   @vishin-pavel:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=<token with read:packages>
   ```

   With the GitHub CLI:

   ```sh
   gh auth refresh -s read:packages
   npm config set @vishin-pavel:registry https://npm.pkg.github.com
   npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"
   ```

### Global or per project

| | Global | Per project |
|---|---|---|
| Install | `npm install -g @vishin-pavel/dfl` | `npm install -D @vishin-pavel/dfl` |
| Run | `dfl …` | `npx dfl …` |
| MCP server entry written for agents | `dfl mcp` (dfl must be on the agent's `PATH`) | `npx --no-install dfl mcp` |
| Commands in rendered skills | `dfl status`, `dfl next` | `npx dfl status`, `npx dfl next` |

dfl picks the per-project form automatically when the running `dfl` is installed in
`<project>/node_modules`. For a per-project install, commit a project `.npmrc` with only the
registry line (`@vishin-pavel:registry=https://npm.pkg.github.com`); every developer keeps the
token in `~/.npmrc`. You can override the MCP command in `.df/config.json`:

```json
{ "version": 1, "vars": {}, "mcp": { "command": "pnpm", "args": ["exec", "dfl", "mcp"] } }
```

## Quick start

```sh
cd my-project
dfl install                     # wizard: pick flows, agents and whether to register the MCP server
# or, non-interactively:
dfl install --yes --agents claude,cursor --flow feature
```

Then, in your agent, run the first step's command, e.g. `/spec-feature` (Codex: `$spec-feature`).
Each step skill starts by calling the `get_status` MCP tool and ends by calling `complete_step`
with the event that matches the outcome. You can drive the flow from the terminal too:

```sh
dfl status                      # where am I, which events can I fire
dfl next                        # complete the current step (fires NEXT)
dfl next FAILED                 # fire another event
dfl goto implement-feature      # jump anywhere
dfl flow view                   # full-screen graph of the flow
```

Commit `.df/` and the MCP config files, and your teammates get the same flow with
`dfl install` (see [Sharing flows over git](#sharing-flows-over-git)).

## How it works

```
.df/feature/flow.json                     ─┐
.df/feature/steps/plan-feature/SKILL.md.hbs ├─ dfl install / flow-update ─┬─> .claude/skills/plan-feature/SKILL.md
.df/config.json + .df/local.json (vars)   ─┘                             ├─> .cursor/skills/plan-feature/SKILL.md
                                                                          ├─> .agents/skills/plan-feature/SKILL.md (Codex, Antigravity)
                                                                          └─> .mcp.json, .cursor/mcp.json, … (dfl MCP server)
```

1. A flow (`.df/<flow>/flow.json`) is an [xstate v5](https://stately.ai/docs/xstate) machine
   config: every normal state is a step, final states mark the end.
2. Every step has a template, `.df/<flow>/steps/<step>/SKILL.md.hbs`. `dfl install` and
   `dfl flow-update` render the templates of the **active flow** and copy each step directory
   into the skills folder of every selected agent, plus three [built-in skills](#built-in-skills).
3. dfl registers its MCP server in each agent's project MCP config.
4. The current position of each flow is kept in `.df/state.json`, per developer.

Only one flow is active (installed) at a time; switching with `dfl flow use` removes the old
flow's skills and installs the new ones. dfl records everything it writes outside `.df/` in
`.df/installed.json`, so updates and `dfl uninstall` remove exactly what dfl created and never
touch a skill folder you wrote yourself.

## The `.df/` directory

```
<project>/
  .df/
    config.json            committed   project config: team default flow, project variables
    local.json             ignored     personal config: your agents, personal variables, flow override
    state.json             ignored     current step and history of each flow
    installed.json         ignored     manifest of the files dfl wrote outside .df/
    .gitignore             committed   generated by dfl, ignores the files above and rendered skills
    <flow>/
      flow.json            committed   flow definition
      partials/*.hbs       committed   optional Handlebars partials of this flow
      steps/<step>/
        SKILL.md.hbs       committed   template of the step's skill
        **/*.md.hbs        committed   optional extra templated files (X.md.hbs → X.md)
        **/* (not .hbs)    committed   static files copied verbatim (scripts, JSON, images)
        SKILL.md, **/*.md  ignored     rendered output
```

Outside `.df/`:

| Path | Git | Why |
|------|-----|-----|
| `.claude/skills/<skill>/`, `.cursor/skills/<skill>/`, … | ignored (managed block in the root `.gitignore`) | rendered with personal variables, regenerated on every sync |
| `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, `opencode.json`, … | committed | shared MCP server registration; dfl edits only its own `dfl` entry and keeps comments and formatting |

The root `.gitignore` block looks like this and is rewritten on every sync:

```gitignore
# >>> dfl (managed) >>>
.claude/skills/plan-feature/
.claude/skills/spec-feature/
# <<< dfl (managed) <<<
```

## Flows and steps

### Prebuilt flow templates

| Template | Steps | Other events |
|----------|-------|--------------|
| `feature` | `spec-feature` → `plan-feature` → `implement-feature` → `verify-feature` → `review-feature` → `ship-feature` | `BACK`, `FAILED` (verify → implement), `CHANGES_REQUESTED` (review/ship → implement) |
| `bugfix` | `reproduce-bug` → `diagnose-bug` → `fix-bug` → `verify-fix` → `ship-fix` | `BACK`, `FAILED` (verify → fix), `CHANGES_REQUESTED` (ship → fix) |
| `quick` | `plan-change` → `make-change` → `check-change` | `BACK`, `FAILED` (check → make) |

`dfl flow templates` lists them; `dfl flow create <name> --from <template>` copies one into
`.df/<name>/`, and `dfl flow create <name> --steps a,b,c` creates a blank linear flow.

### flow.json

```json
{
  "name": "feature",
  "title": "Feature development",
  "description": "From spec to shipped PR.",
  "version": "1.0.0",
  "skillPrefix": "",
  "vars": {
    "mainBranch": { "description": "Default branch PRs target", "default": "main", "scope": "project" },
    "reviewer": { "description": "Your GitHub handle for review requests", "scope": "personal", "required": false }
  },
  "machine": {
    "id": "feature",
    "initial": "spec-feature",
    "states": {
      "spec-feature": { "description": "Write a feature spec. Use when starting a feature.", "meta": { "title": "Spec" }, "on": { "NEXT": "plan-feature" } },
      "plan-feature": {
        "description": "Plan the implementation. Use after the spec is agreed.",
        "meta": { "title": "Plan" },
        "on": { "NEXT": "done", "BACK": { "target": "spec-feature", "description": "The spec is missing information" } }
      },
      "done": { "type": "final", "description": "Feature shipped" }
    }
  }
}
```

- Step ids (state keys) are kebab-case, at most 64 characters. The skill name and slash command
  is `skillPrefix + id`.
- The state `description` becomes the skill's `description` (what the agent reads to decide
  when to use it): one sentence that starts with a verb and says when to use the step.
- Transitions are `"EVENT": "target"` or `{ "target": "…", "description": "…" }`. `NEXT` is the
  conventional forward event. Only flat machines are supported: no nested or parallel states,
  guards or actions.
- Step order (for lists, `step N of M` and the viewer) follows `NEXT` from `initial`, then other
  events, then unreachable states.

### Editing steps

Use the CLI (or let the agent do it with the built-in skills / MCP tools). Every change is
validated before it is written and the skills are re-installed when the flow is active.

```sh
dfl step list
dfl step add qa-check --after verify-feature --title "QA check" --description "Run the QA checklist. Use after verification passes."
dfl step edit qa-check --rename qa --template-file ./qa.md.hbs
dfl step edit spec-feature --initial
dfl step transition qa REJECTED implement-feature
dfl step transition qa REJECTED --remove
dfl step remove qa              # incoming transitions are rerouted to its NEXT target
dfl flow validate
```

`dfl step add` writes a skeleton `SKILL.md.hbs` for you to fill in. After editing templates or
`flow.json` by hand, run `dfl flow-update`.

## Templates

Templates are [Handlebars 4](https://handlebarsjs.com/guide/) (no HTML escaping). The body of
`SKILL.md.hbs` usually has no frontmatter: dfl generates it (`name` = skill name, `description`
= the step description, `metadata.dfl-flow` / `metadata.dfl-step`). Frontmatter you do write
(`license`, `compatibility`, `allowed-tools`, `metadata`) is kept; `name` is always forced.

**Context**

| Name | Value |
|------|-------|
| `project.name`, `project.root` | project directory name and absolute path |
| `flow.name`, `flow.title`, `flow.description`, `flow.skillPrefix`, `flow.initial`, `flow.stepCount` | the flow |
| `flow.steps[]` | non-final steps in order (same shape as `step`) |
| `step.id`, `step.skillName`, `step.title`, `step.description`, `step.number` (1-based), `step.index` | the step being rendered |
| `step.next[]`, `step.prev[]` | outgoing / incoming transitions: `event`, `id`, `skillName`, `title`, `final`, `description` |
| `vars.<name>` | [variables](#variables) |
| `env.<NAME>` | environment variables at render time |
| `dfl.version`, `dfl.mcpServer`, `dfl.cli` | dfl version, MCP server name (`dfl`), CLI command (`dfl` or `npx dfl`) |

**Helpers**: `eq`, `ne`, `and`, `or`, `not` (inline or as blocks: `{{#eq a b}}…{{else}}…{{/eq}}`),
`default value fallback`, `upper`, `lower`, `kebab`, `title`, `json value`, `join list sep`,
`indent n text` (or `{{#indent 2}}…{{/indent}}`), `command skillName` (→ `/skill-name`).

**Partials**: end every step template with `{{> flow-context}}`. It renders a "Flow context"
section: the step's position, the previous and next steps with their commands, and the
instructions to call `get_status` first and `complete_step` with the right event at the end.
Put your own partials (or an override of `flow-context`) in `.df/<flow>/partials/<name>.hbs`
and use them as `{{> name}}`.

**Rules**

- Write `\{{` for literal braces.
- Avoid `$ARGUMENTS`, `$1`…, lines starting with `` !` `` and `@word` tokens: Claude Code and
  OpenCode expand them when a skill runs as a slash command.
- Every `.md` file under `.df/<flow>/steps/` is generated; one without a matching `.md.hbs` is
  deleted on the next sync. Name hand-written reference docs `X.md.hbs`.
- Rendered skills are the same for every agent; slash commands in them use the `/name` form
  (Codex users invoke `$name`).

## Variables

Flows declare variables in `flow.json` `vars` (`description`, `default`, `scope`,
`required`). Values are resolved in this order, later wins:

1. `default` in `flow.json`
2. `.df/config.json` `vars` – **project** scope, committed
3. `.df/local.json` `vars` – **personal** scope, git-ignored
4. environment `DFL_VAR_<NAME>` (UPPER_SNAKE_CASE, e.g. `DFL_VAR_MAIN_BRANCH` for `mainBranch`)

```sh
dfl vars list                       # values and where they come from
dfl vars set mainBranch develop     # stored in its declared scope
dfl vars set reviewer octocat --personal
dfl vars unset reviewer
```

`dfl install` asks for required variables that have no value. Guard optional ones in templates
with `{{#if vars.reviewer}}…{{/if}}`. Because rendered skills can contain personal values, they
are git-ignored.

## Built-in skills

Installed with every flow, for every agent:

| Skill | What it does |
|-------|--------------|
| `/add-flow-step` | Interviews you, drafts the step template and wires the step into the active flow via the MCP tools |
| `/edit-flow-step` | Changes a step's title, description, template, transitions, id or position |
| `/delete-flow-step` | Removes a step and reroutes the transitions that led to it |

They fall back to the `dfl` CLI when the MCP server is not available. A step with the same
name wins over a built-in skill (`dfl flow validate` warns about it).

## MCP server

`dfl mcp` is a stdio MCP server named `dfl`. `dfl install` registers it in the project MCP
config of each selected agent (see [Supported agents](#supported-agents)); you never start it by
hand. Files are re-read on every call, so edits and `git pull` are picked up immediately.

| Tool | Purpose |
|------|---------|
| `get_status` | current step, its command, the events it can fire and the history tail |
| `get_flow` | the active (or named) flow: steps in order, transitions, variables, current step |
| `list_flows` | all flows and which one is active |
| `get_step` | one step: metadata, transitions, template and rendered skill |
| `validate_flow` | validation errors and warnings |
| `get_authoring_guide` | how to write step templates: files, context, helpers, rules, an example |
| `transition` | fire an event (default `NEXT`) from the current step |
| `complete_step` | fire an event (default `NEXT`) from a given step; fails if it is not current |
| `goto_step` | jump to a step |
| `add_step` | create a step (directory, template, wiring), then re-install the skills |
| `update_step` | change title, description, template, transitions, id or initial step, then re-install |
| `delete_step` | delete a step and reroute transitions, then re-install |
| `sync` | same as `dfl flow-update` |

Resources: `dfl://flow` (flow.json of the active flow) and `dfl://steps/{id}` (a step's
template). Every tool except `list_flows`, `sync` and `get_authoring_guide` accepts an optional
`flow` argument.

The project is found through `--root <dir>`, then `DFL_ROOT`, then the client's MCP roots (the
first root with a `.df/` directory), then the nearest parent of the working directory that has
`.df/`. stdout carries only JSON-RPC; set `DFL_DEBUG=1` to log transport errors to stderr.

## Flow viewer

`dfl flow view [name]` opens a full-screen graph of the flow in the terminal (alternate screen).
The current step has a heavy border; `NEXT` edges are unlabelled, other events are labelled.

| Key | Action |
|-----|--------|
| `w` `a` `s` `d` / arrows | pan |
| `W` `A` `S` `D` / PgUp PgDn | pan a full page |
| `q` | zoom in (more detail) |
| `e` | zoom out |
| `l` | toggle top-to-bottom / left-to-right |
| `c` | center the current step |
| `x` / Ctrl+C | exit |

Zoom levels: `0` one-line nodes, `1` title boxes, `2` cards with a short description, `3`
cards with the full description and the skill command. `--print` (or a non-terminal stdout)
prints the whole graph instead; `--zoom <0-3>`, `--lr` and `--ascii` (7-bit box drawing) work
in both modes.

## Supported agents

| id | Tool | Skills dir | Invoke | Project MCP config |
|----|------|------------|--------|--------------------|
| `claude` | Claude Code | `.claude/skills` | `/name` | `.mcp.json` |
| `cursor` | Cursor | `.cursor/skills` | `/name` | `.cursor/mcp.json` |
| `antigravity` | Google Antigravity | `.agents/skills` | `/name` | `.agents/mcp_config.json` |
| `codex` | OpenAI Codex | `.agents/skills` | `$name` | `.codex/config.toml` |
| `gemini` | Gemini CLI | `.gemini/skills` | `/name` | `.gemini/settings.json` |
| `copilot` | GitHub Copilot | `.github/skills` | `/name` | `.mcp.json` |
| `windsurf` | Windsurf / Devin | `.devin/skills` | `/name` | `.devin/mcp_config.json` |
| `opencode` | OpenCode | `.opencode/skills` | `/name` | `opencode.json` |
| `kiro` | Kiro | `.kiro/skills` | `/name` | `.kiro/settings/mcp.json` |

`dfl agents` shows which agents are detected in the project and selected, with per-tool notes
(trust prompts, reloads, MCP approval). [docs/AGENTS.md](docs/AGENTS.md) has the details and
sources for each tool. Several tools also read other tools' folders (for example Cursor reads
`.claude/skills`), so installing for several agents can show a skill twice in one tool.

## Sharing flows over git

A flow is just files, so the normal way to share it is to commit `.df/` (dfl's own
`.df/.gitignore` keeps personal files out) together with the MCP config files:

```sh
git add .df .mcp.json .cursor/mcp.json .gitignore
git commit -m "Add the feature flow"
```

Teammates clone or pull and run `dfl install` once (it keeps the team's active flow from
`.df/config.json` and asks for their agents and any missing personal variables), then
`dfl flow-update` after pulling flow changes. `dfl install --project-agents` (or answering yes in
the wizard) saves the agent selection as the team default.

To reuse flows across repositories, import them:

```sh
dfl flow import github:acme/dev-flows/flows/feature#v1     # GitHub shorthand: owner/repo[/path][#ref]
dfl flow import https://github.com/acme/dev-flows.git#main  # any git URL, optional //sub/path and #branch-or-tag
dfl flow import ../other-project/.df/bugfix --name bf       # a local directory
dfl flow import github:acme/dev-flows --flow feature bugfix --use
```

A source may contain one flow (a directory with `flow.json`) or several (`*/flow.json`,
`flows/*/flow.json` or `.df/*/flow.json`). The origin is recorded in `flow.json` `source`;
re-import with `--force` to update a flow.

## Command reference

Global options: `--root <dir>` (default: `DFL_ROOT` or the nearest directory with `.df/`),
`--no-color`, `-v, --version`, `-h, --help`. Commands never prompt with `--yes`, when stdin or
stdout is not a terminal, or when `CI` is set, and exit non-zero on errors. Warnings go to stderr, so `--json` output can
be piped.

| Command | Description |
|---------|-------------|
| `dfl install [-a, --agents <list>] [-f, --flow <name>] [-y, --yes] [--no-mcp] [--project-agents]` | set up dfl: create/activate a flow, install skills and the MCP server (outside a dfl project it installs at the git root) |
| `dfl uninstall [--purge] [-y]` | remove installed skills, MCP entries and the `.gitignore` block; `--purge` also deletes `local.json`, `state.json` and rendered files (flows are kept) |
| `dfl flow-update` (alias `dfl update`) `[--dry-run] [--no-mcp] [-y]` | re-render and re-install the active flow |
| `dfl status [--flow <f>] [--json]` | active flow, current step, available events |
| `dfl next [event] [--from <step>] [--flow <f>] [--json]` | fire an event (default `NEXT`) |
| `dfl goto <step> [--flow <f>] [--json]` | jump to a step |
| `dfl reset [--flow <f>] [-y] [--json]` | back to the initial step |
| `dfl flow list` / `ls [--json]` | flows of the project |
| `dfl flow templates` | prebuilt templates |
| `dfl flow use <name> [--project] [--no-sync]` | make a flow active (personal, or team default with `--project`) |
| `dfl flow create <name> [--from <template> \| --steps a,b] [--title] [--description] [--use]` | create a flow |
| `dfl flow import <source> [--name <n>] [--flow <names...>] [--force] [--use] [--no-sync]` | import flows from git or a directory |
| `dfl flow delete` / `rm <name> [-y]` | delete a flow |
| `dfl flow validate [name] [--json]` | validate a flow (all flows when none is active) |
| `dfl flow view [name] [--zoom <0-3>] [--print] [--lr] [--ascii]` | flow viewer |
| `dfl step list` / `ls [--flow <f>] [--json]` | steps in flow order |
| `dfl step add <id> [--after <s> \| --before <s>] [--title] [--description] [--event <E>] [--template-file <f>]` | add a step |
| `dfl step edit <id> [--title] [--description] [--rename <new-id>] [--template-file <f>] [--initial]` | change a step |
| `dfl step remove` / `rm <id> [--force] [-y]` | remove a step |
| `dfl step transition <id> <event> [target] [--remove]` | set or remove a transition |
| `dfl vars list` / `ls [--json]` | variables and their sources (`dfl vars` alone lists them) |
| `dfl vars set <name> <value> [--personal \| --project]` | set a variable |
| `dfl vars unset <name>` | remove a stored value |
| `dfl agents [--json]` | supported agents, detection and paths |
| `dfl mcp` | run the MCP server over stdio |

Step commands take `--flow <name>` (default: the active flow) and `--no-sync`.

## Development

```sh
git clone https://github.com/vishin-pavel/dfl.git && cd dfl
npm ci
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run build          # tsdown → dist/cli.mjs
node dist/cli.mjs --help
npm run check          # all of the above
```

- Source is TypeScript ESM in `src/` (`core/` flow model, rendering, sync; `agents/` tool
  adapters and MCP config editors; `mcp/` server; `tui/` viewer; `commands/` and `ui/` CLI),
  bundled to `dist/` with tsdown. Templates ship in `templates/`.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the design and module contracts;
  [docs/AGENTS.md](docs/AGENTS.md) the per-agent research.
- CI runs typecheck, tests and build on Ubuntu and macOS with Node 22 and 24. Publishing to
  GitHub Packages runs on a GitHub release or a pushed `v*` tag whose version matches
  `package.json` (`npm version patch && git push --follow-tags`).

## License

MIT
