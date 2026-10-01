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
- [Keeping flows safe: updates, export, backups](#keeping-flows-safe-updates-export-backups)
- [Windows](#windows)
- [Command reference](#command-reference)
- [Development](#development)

## Install

Requires **Node.js 22.12 or newer** (older versions stop with a clear error). `dfl` is published
to GitHub Packages as `@vishin-pavel/dfl`. GitHub Packages needs a token even for reading, so set
up npm once:

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

Release candidates are published under the `next` dist-tag (`npm install -g @vishin-pavel/dfl@next`);
a plain install always gets the latest stable release.

### Global or per project

| | Global | Per project |
|---|---|---|
| Install | `npm install -g @vishin-pavel/dfl` | `npm install -D @vishin-pavel/dfl` |
| Run | `dfl …` | `npx dfl …` |
| MCP server entry written for agents | `dfl mcp` (dfl must be on the agent's `PATH`) | `npx --no-install dfl mcp` |
| Commands in rendered skills (`dfl.cli`) | `dfl status`, `dfl next` | `npx --no-install dfl status`, … |

The form depends only on the project, never on which `dfl` binary runs: when the project's
`package.json` lists `@vishin-pavel/dfl` in `dependencies`, `devDependencies` or
`optionalDependencies`, dfl uses `npx --no-install dfl`, otherwise `dfl`. So every developer
writes the same committed MCP entry, whether they run a global or a local dfl. `--no-install`
keeps npx from downloading an unrelated public package called `dfl`.

For a per-project install, commit a project `.npmrc` with only the registry line
(`@vishin-pavel:registry=https://npm.pkg.github.com`); every developer keeps the token in
`~/.npmrc`. You can override the MCP command in `.df/config.json`:

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
dfl status                      # where am I, which events can I fire, are my skills up to date
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
   Every installed skill folder gets a `.gitignore` file that ignores the folder itself, because
   rendered skills can contain personal values.
3. dfl registers its MCP server in each agent's project MCP config (unless you turned that off).
4. The current position of each flow is kept in `.df/state.json`, per developer.

Only one flow is active (installed) at a time; switching with `dfl flow use` removes the old
flow's skills and installs the new ones. dfl records everything it writes outside `.df/` in
`.df/installed.json`, so updates and `dfl uninstall` remove exactly the files dfl created. A skill
folder you wrote yourself is never overwritten or deleted: dfl only treats a folder as its own when
it holds dfl's `.gitignore` marker or its `SKILL.md` carries dfl's `metadata.dfl-*` keys, deletes
only the files it installed there, and keeps the folder (with a warning) when other files remain.
dfl never writes or deletes through a symbolic link.

Syncing never changes a flow: `dfl install`, `dfl flow-update` (`dfl update`) and the MCP `sync` tool only
write rendered output, also after upgrading dfl. A flow changes only when you edit it, or when you
explicitly update it with `dfl flow pull` / `dfl flow import --force`, which show the changes and ask
first (see [Keeping flows safe](#keeping-flows-safe-updates-export-backups)).

Changes made with `dfl step …`, `dfl vars …`, `dfl flow use` and the MCP editing tools re-install
the skills automatically, but only once you ran `dfl install` in this clone (until then they print
"Skills not installed for you yet; run `dfl install`"). `dfl status` (and the MCP `get_status`
tool) warn when the installed skills are out of date, for example after a `git pull` changed a
template: run `dfl flow-update`.

## The `.df/` directory

```
<project>/
  .df/
    config.json            committed   project config: team default flow, project variables, MCP override
    local.json             ignored     personal config: your agents, personal variables, flow override, MCP preference
    state.json             ignored     current step and history of each flow
    installed.json         ignored     manifest of the files dfl wrote (skills, MCP entries, rendered files)
    .gitignore             committed   generated by dfl, ignores the files above and rendered skills
    .dfl-backups/          ignored     a copy of every flow dfl replaced or deleted (`dfl flow import <file>` restores it)
    <flow>/
      flow.json            committed   flow definition ("name" must equal the directory name)
      partials/*.hbs       committed   optional Handlebars partials of this flow
      steps/<step>/
        SKILL.md.hbs       committed   template of the step's skill
        **/*.md.hbs        committed   optional extra templated files (X.md.hbs → X.md)
        **/* (not .hbs)    committed   static files copied verbatim (scripts, JSON, images)
        SKILL.md, **/*.md  ignored     rendered output
```

`.df/.gitignore` is rewritten on every sync:

```gitignore
# generated by dfl – do not edit
# personal config, runtime state and install manifest
local.json
state.json
installed.json
# skills rendered from *.md.hbs templates (may contain personal values)
*/steps/**/*.md
# temporary dirs of an interrupted flow import
.dfl-*/
# held while a dfl process changes the project
.lock
```

Outside `.df/`:

| Path | Git | Why |
|------|-----|-----|
| `.claude/skills/<skill>/`, `.cursor/skills/<skill>/`, … | ignored by the `.gitignore` inside each skill folder | rendered with personal variables, regenerated on every sync |
| `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, `opencode.json`, … | committed | shared MCP server registration; dfl edits only its own `dfl` entry and keeps comments and formatting |

The `.gitignore` in each installed skill folder looks like this; git then ignores the whole folder
(the marker included), so nothing personal is committed and your root `.gitignore` is never touched:

```gitignore
# generated by dfl – this skill is rendered from .df templates and may contain personal values
*
```

Older dfl versions wrote a `# >>> dfl (managed) >>>` block into the root `.gitignore`; the next sync
removes it (lines you added are kept).

## Flows and steps

### Prebuilt flow templates

| Template | Steps | Other events |
|----------|-------|--------------|
| `feature` | `spec-feature` → `plan-feature` → `implement-feature` → `verify-feature` → `review-feature` → `ship-feature` | `BACK`, `FAILED` (verify → implement), `CHANGES_REQUESTED` (review/ship → implement) |
| `bugfix` | `reproduce-bug` → `diagnose-bug` → `fix-bug` → `verify-fix` → `ship-fix` | `BACK`, `FAILED` (verify → fix), `CHANGES_REQUESTED` (ship → fix) |
| `quick` | `plan-change` → `make-change` → `check-change` | `BACK`, `FAILED` (check → make) |

Their variables: `mainBranch` and `testCommand` (project); `feature` also has `specsDir` (where
specs are written) and the personal `featureBranchPrefix` and `reviewer`; `bugfix` has `bugNotesDir`
(default `docs/bugs`: each bug gets a notes file with its reproduction, diagnosis and verification,
committed as the flow goes) and the personal `fixBranchPrefix` and `reviewer`. Diffs and logs in the
steps compare against `origin/<mainBranch>`.

`dfl flow templates` lists them; `dfl flow create <name> --from <template>` copies one into
`.df/<name>/` (`dfl flow create feature --from feature --use` also activates it), and
`dfl flow create <name> --steps a,b,c` creates a blank linear flow. The copy is yours to change:
upgrading dfl never touches it, and `dfl flow pull` updates it from the template (or git repository,
or directory) it came from only when you ask, showing which of your changes an update would replace,
see [Keeping flows safe](#keeping-flows-safe-updates-export-backups).

### flow.json

```json
{
  "name": "feature",
  "title": "Feature development",
  "description": "From spec to shipped PR.",
  "version": "1.0.0",
  "skillPrefix": "",
  "source": { "type": "template", "ref": "feature", "files": { "flow.json": "77caab347d357129", "steps/spec-feature/SKILL.md.hbs": "d1db6b335b8ee37d" } },
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

- `source` is written by dfl: where the flow came from (a template, a git repository or a directory)
  and `files`, the digests of its files as they came from there. They let `dfl flow pull` tell your
  changes apart from changes in the source; leave them alone.
- Flow names and step ids (state keys) are kebab-case, at most 64 characters; a step id needs at
  least one letter (`step-1`, not `1`). `name` must equal the flow's directory name. The skill
  name and slash command is `skillPrefix + id`.
- The state `description` becomes the skill's `description` (what the agent reads to decide
  when to use it): one sentence that starts with a verb and says when to use the step.
- Transitions are `"EVENT": "target"` or `{ "target": "…", "description": "…" }`. The description
  says when to fire the event; the step skills show it to the agent, so give one to every event
  other than `NEXT`. `NEXT` is the conventional forward event. Only flat machines are supported: no
  nested or parallel states, guards, actions or arrays of transitions.
- **Step order** (for lists, `step N of M` and the viewer) is the order of the states in
  `machine.states`, with the initial step moved first and final states moved last.

### Editing steps

Use the CLI (or let the agent do it with the built-in skills / MCP tools). Every change is
validated before it is written: an edit is refused when it introduces a validation error or a
template that does not parse. Errors the flow already had do not block an edit (so a broken flow
can be repaired one change at a time); dfl warns about the ones that remain. The skills are
re-installed when the flow is active and you ran `dfl install`.

```sh
dfl step list
dfl step add qa-check --after verify-feature --title "QA check" --description "Run the QA checklist. Use after verification passes."
dfl step edit qa-check --rename qa --template-file ./qa.md.hbs
dfl step edit spec-feature --initial
dfl step transition qa REJECTED implement-feature --description "The QA checklist found problems"
dfl step transition qa REJECTED --remove
dfl step remove qa --yes
dfl flow validate
```

- `step add` without `--after`/`--before` puts the step at the end of the `NEXT` path from the
  initial step: after the last step before the final state, which then leads to the new step.
  `--after X` makes `X` lead to the new step (it takes over `X`'s old target); `--before X`
  redirects the transitions into `X`. Only a `NEXT` insert before the initial step makes the new
  step the initial step. The new state is declared at its position in `flow.json`, so it shows up
  in the right place in the step order.
- `step remove` reroutes the transitions that led to the removed step to its `NEXT` target. A
  transition from that target back to the removed step (for example `review CHANGES_REQUESTED →
  build` when `build` is removed and `build NEXT → review`) would point at itself and is removed
  instead; dfl lists every rerouted and removed transition. A step without `NEXT` cannot be removed
  while other steps lead to it, unless you pass `--force` (those transitions are dropped). If it was
  your current step, your position moves to its `NEXT` target.
- To move a step, rewire the `NEXT` transitions around it with `dfl step transition` and move its
  entry in `machine.states` of `flow.json`, so the numbering follows (there is no reorder command).
- `dfl step add` writes a skeleton `SKILL.md.hbs` for you to fill in. After editing templates or
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
| `env.<NAME>` | the environment variable `DFL_ENV_<NAME>` at render time (no other environment variables are visible to templates) |
| `dfl.version`, `dfl.mcpServer`, `dfl.cli` | dfl version, MCP server name (`dfl`), CLI command (`dfl` or `npx --no-install dfl`, see [Global or per project](#global-or-per-project)) |

**Helpers**: `eq`, `ne`, `and`, `or`, `not` (inline or as blocks: `{{#eq a b}}…{{else}}…{{/eq}}`),
`default value fallback`, `upper`, `lower`, `kebab`, `title`, `json value`, `join list sep`,
`indent n text` (or `{{#indent 2}}…{{/indent}}`), `command skillName` (→ `/skill-name`),
`handle value` (a login without a leading `@` or spaces, e.g. for `gh --reviewer`). `{{log …}}`
prints to stderr for debugging and renders nothing.

**Partials**: end every step template with `{{> flow-context}}`. It renders a "Flow context"
section: the step's position, the step it comes after and the steps that send work back to it
(with their commands and conditions), the instruction to call `get_status` first, and the events
to finish with (`complete_step` with the right event, plus CLI fallbacks). The MCP calls name the
flow, so a skill keeps working on its own flow even when another flow is active. Put your own
partials (or an override of `flow-context`) in `.df/<flow>/partials/<name>.hbs` and use them as
`{{> name}}`.

**Rules**

- Write `\{{` for literal braces (for example a GitHub Actions expression:
  `$\{{ secrets.NPM_TOKEN }}`). `dfl flow validate` warns about an expression whose first name is
  not part of the context (`{{ secrets.NPM_TOKEN }}` would render as an empty string).
- Avoid `$ARGUMENTS`, `$1`…, lines starting with `` !` `` and `@word` tokens: Claude Code and
  OpenCode expand them when a skill runs as a slash command. The sync warns when a rendered
  `SKILL.md` contains one, for example from a variable value such as a reviewer stored as `@octocat`
  (render handles with `{{handle vars.reviewer}}`).
- Only `*.md.hbs` files are templates; `dfl flow validate` warns about other `.hbs` files under
  `steps/` (they are neither rendered nor copied) and reports template syntax errors and unknown
  partials with file and line.
- Every `.md` file under `.df/<flow>/steps/` is treated as rendered output and git-ignored. dfl
  deletes a rendered file only when it rendered it itself (it is listed in `.df/installed.json`) and
  its template is gone; a hand-written `.md` file there is kept but neither committed nor installed,
  so name hand-written reference docs `X.md.hbs`. Step directories without a state that hold only
  dfl-rendered files are removed on sync.
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

Stored values are shared by all flows of the project: a variable with the same name means the same
thing in every flow (the prebuilt flows use `featureBranchPrefix` and `fixBranchPrefix` rather than
one `branchPrefix`). `dfl install` asks for required variables that have no value. Guard optional
ones in templates with `{{#if vars.reviewer}}…{{/if}}`. Because rendered skills can contain personal
values, they are git-ignored.

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
| `get_status` | current step, its command, the events it can fire, the history tail and whether your installed skills are up to date (`skills`) |
| `get_flow` | the active (or named) flow: steps in order, transitions, variables, current step; also works on a broken flow (`current: null` plus `problem` and `issues`) |
| `list_flows` | all flows and which one is active |
| `get_step` | one step: metadata, transitions, template and rendered skill |
| `validate_flow` | validation errors and warnings |
| `get_authoring_guide` | how to write step templates: files, context, helpers, rules, an example |
| `transition` | fire an event (default `NEXT`) from the current step |
| `complete_step` | fire an event (default `NEXT`) from a given step; fails if it is not current |
| `goto_step` | jump to a step |
| `add_step` | create a step (directory, template, wiring), then re-install the skills; `placement` says where it went |
| `update_step` | change title, description, template, transitions (with descriptions), id or initial step, then re-install |
| `delete_step` | delete a step and reroute transitions (`rewired`, `dropped`), then re-install |
| `sync` | same as `dfl flow-update` |

- Resources: `dfl://flow` (flow.json of the active flow) and `dfl://steps/{id}` (a step's
  template). After `add_step`, `update_step`, `delete_step` and `sync` the server sends
  `notifications/resources/list_changed`; changes made outside the server (CLI, editor, `git pull`)
  are not announced.
- Every tool except `list_flows`, `sync` and `get_authoring_guide` accepts an optional `flow`
  argument (a flow name).
- Commands in results (`command`, `targetCommand`, `next.command`) use the client's syntax:
  `$name` when the MCP client identifies itself as Codex, `/name` otherwise.
- The editing tools re-install the skills only when you ran `dfl install` in this clone, and
  otherwise say so. Mutations take a lock file, `.df/.lock`, so several agents (and the CLI) never
  overwrite each other's changes.
- The project is found through `--root <dir>`, then `DFL_ROOT`, then the client's MCP roots (the
  first root inside a directory with `.df/`; clients on the 2026-07-28 protocol are asked for their
  roots through an `input_required` result), then the nearest parent of the working directory that
  has `.df/`.
- stdout carries only JSON-RPC (the template `log` helper writes to stderr); set `DFL_DEBUG=1` to
  log transport errors to stderr.

**Turning it off.** Answer "no" in the `dfl install` wizard or run `dfl install --no-mcp`: the
choice is stored in your `.df/local.json` and later syncs leave the MCP configs alone (`dfl install
--mcp` turns it back on; `dfl flow-update --mcp`/`--no-mcp` applies to one run only). The MCP entries
are committed team config, so deselecting an agent never removes one; only `dfl uninstall` removes
the `dfl` entry, and only when its command looks like dfl (`dfl …`, `npx`/`pnpm`/`yarn` running
`dfl`, or your `config.json` override). Files and containers dfl did not create are left in place.

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
cards with the full description and the skill command of your agents (`/name`, `$name` for
Codex). `--print` (or a non-terminal stdout) prints the whole graph instead; `--zoom <0-3>`,
`--lr` and `--ascii` (7-bit output, header and footer included) work in both modes.

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
(trust prompts, reloads, MCP approval).
[docs/AGENTS.md](https://github.com/vishin-pavel/dfl/blob/main/docs/AGENTS.md) has the details
and sources for each tool. Several tools also read other tools' folders (for example Cursor reads
`.claude/skills`), so installing for several agents can show a skill twice in one tool.

**Other tools.** The list of agents is fixed; there is no way yet to declare your own skills folder
or MCP config file. Many tools read one of the folders above (`.agents/skills` and
`.claude/skills` are the most widely read): install for the agent whose folder your tool reads, and
register a stdio MCP server named `dfl` running `dfl mcp` (or `npx --no-install dfl mcp`) in your
tool's MCP settings yourself. Selecting an agent also writes that agent's MCP config file; use
`--no-mcp` if you do not want it. Please open an issue for the tool you need.

## Sharing flows over git

A flow is just files, so the normal way to share it is to commit `.df/` (dfl's own
`.df/.gitignore` keeps personal files out) together with the MCP config files:

```sh
git add .df .mcp.json .cursor/mcp.json
git commit -m "Add the feature flow"
```

Installed skill folders ignore themselves, so `git status` never shows them, and the committed
files do not change when a teammate installs for other agents: dfl never writes the root
`.gitignore`, and the MCP entry is the same for everyone.

Teammates clone or pull and run `dfl install` once (it keeps the team's active flow from
`.df/config.json` and asks for their agents and any missing personal variables), then
`dfl flow-update` after pulling flow changes (`dfl status` tells them when that is needed).
`dfl install --project-agents` (or answering yes in the wizard) saves the agent selection as the
team default. With several flows and no team default, a non-interactive `dfl install` needs
`--flow <name>`; the team default (`activeFlow` in `.df/config.json`) is only written for a flow you
chose explicitly or the project's only flow, and `dfl flow use <name> --project` changes it.

To reuse flows across repositories, import them:

```sh
dfl flow import github:acme/dev-flows/flows/feature#v1     # GitHub shorthand: owner/repo[/path][#ref]
dfl flow import https://github.com/acme/dev-flows.git#main  # any git URL, optional //sub/path and #branch, tag or commit
dfl flow import ../other-project/.df/bugfix --name bf       # a local directory
dfl flow import github:acme/dev-flows --flow feature bugfix --use
```

A source may contain one flow (a directory with `flow.json`) or several (`*/flow.json`,
`flows/*/flow.json` or `.df/*/flow.json`); it can also be a file written by `dfl flow export` (see
below). Every target name is checked, and nothing is replaced, before anything is written; importing
a directory into itself is refused. The origin is recorded in `flow.json` `source`: the template
name, the git URL with `rev` and the imported `commit`, or the directory relative to the project
root, plus the digests of the imported files. An existing flow is only replaced with `--force`,
after dfl showed the changes and you confirmed them (`--yes` without a terminal).

## Keeping flows safe: updates, export, backups

A flow is your team's own: dfl never changes it behind your back, also not when you upgrade dfl and
its prebuilt templates change. Updating a flow is always explicit, shows what changes, and asks.

**Upgrading dfl.** `dfl install`, `dfl flow-update` / `dfl update` and the MCP `sync` tool only re-render
skills. When a prebuilt template changed since your flow was created from it (or last pulled), they
say so and leave the flow alone:

```
· Template "feature" has changed since flow "feature" was created or last pulled. The flow was not
  changed; review the update with `dfl flow pull feature --dry-run`.
```

**Updating a flow** from its template, repository or directory:

```sh
dfl flow pull --dry-run               # the active flow: only show what would change
dfl flow pull                         # show the changes, ask, then update (a backup is saved first)
dfl flow pull bugfix --yes            # without asking, when it discards none of your changes
dfl flow pull --yes --discard-local   # without asking, even if it replaces your changes
dfl flow pull --rev v2                # git sources: another branch, tag or commit
```

Because dfl records the version each flow came from (`source.files`), the preview tells the source's
changes apart from the changes your team made to the flow, and marks every change that would be lost:

```
Changes to flow feature from template "feature":
  ~ steps/ship-feature/SKILL.md.hbs
  ~ steps/plan-feature/SKILL.md.hbs ▲ edited here – your edits are lost
  − steps/qa/SKILL.md.hbs ▲ added here – it is deleted
  ▲ It would discard edits made in this project to 2 files (marked above).
```

The update replaces the flow's files with the new version: changes made here to the marked files are
replaced, so a customized flow is only updated when you answer yes to the question that names them,
or pass `--yes --discard-local`; `--yes` alone refuses. Hand-written `.md` files under `steps/` are
kept, and so is your position in the flow (it moves to the next surviving step when the new version
drops your current step). The skills are re-installed when the flow is active. Flows created with
`dfl flow create --steps` have no source to pull from. Flows created by dfl versions that did not
record `source.files` cannot tell your changes apart, so every update of them needs that explicit
consent; their first update records the version.

If the flow changes while dfl is asking (another terminal, an agent), nothing is replaced and you are
asked to run the command again.

**Backups.** Before `dfl flow pull`, `dfl flow import --force` or `dfl flow delete` replaces or deletes a
flow, dfl writes a copy of it to `.df/.dfl-backups/<flow>-<time>.dfl.json` (git-ignored, never deleted by
dfl) and prints how to restore it:

```sh
dfl flow import .df/.dfl-backups/feature-20261001T153000Z.dfl.json --force
```

**Export and import.** `dfl flow export` writes flows to one file, to keep a copy or to move a flow to
another project or team:

```sh
dfl flow export                       # the active flow → ./feature.dfl.json
dfl flow export bugfix -o backups/    # → backups/bugfix.dfl.json
dfl flow export --all -o all.dfl.json # every flow of the project
dfl flow export -o - > feature.dfl.json
dfl flow import feature.dfl.json      # in this or another project (--name, --force, --dry-run, --use)
```

An export is a snapshot: importing it restores the flow exactly as exported, including its `source`,
so a customized default flow keeps updating from its template and its customizations are still known
as such. It holds the flow's own files only: never rendered skills (they can contain personal values),
hand-written `.md` files under `steps/` (dfl warns about them) or OS junk. Existing files are only
overwritten with `--force`, and an export is never written into a flow directory.

## Windows

dfl is developed and tested on macOS and Linux; native Windows is not covered by CI. WSL works
like Linux. On native Windows the CLI and the skills work, but the default MCP entry does not
start: npm installs `dfl` and `npx` as `.cmd` shims, and agents start MCP servers without a shell,
so `dfl mcp` or `npx --no-install dfl mcp` fails with "Connection closed" or ENOENT. Set the MCP
command in `.df/config.json` and run `dfl flow-update`:

- Windows-only team: `"mcp": { "command": "cmd", "args": ["/c", "dfl", "mcp"] }` (per-project install:
  `["/c", "npx", "--no-install", "dfl", "mcp"]`).
- Mixed team with a per-project install: `"mcp": { "command": "node", "args":
  ["node_modules/@vishin-pavel/dfl/dist/cli.mjs", "mcp"] }` works on every OS, as long as the
  agent starts the server with the project root as its working directory (start the agent in the
  project root, not in a subdirectory).

The override is committed, so it applies to the whole team.

## Command reference

Global options: `--root <dir>` (default: `DFL_ROOT` or the nearest directory with `.df/`),
`--no-color`, `-v, --version`, `-h, --help`. The `.df/` search never crosses into an enclosing git
repository: inside a nested clone or submodule without its own `.df/`, commands fail with a hint to
pass `--root`, and `dfl install` sets up that repository instead. Commands never prompt with `--yes`,
when stdin or stdout is not a terminal, or when `CI` is set; destructive commands (`uninstall`,
`flow delete`, `flow pull`, `flow import --force`, `step remove`) then need `--yes` (and `flow pull`
also `--discard-local` when it would replace changes made in the project). Commands exit non-zero on errors.
Warnings go to stderr, so `--json` output can be piped. Tables fit the terminal width (or
`COLUMNS` when the output is not a terminal).

| Command | Description |
|---------|-------------|
| `dfl install [-a, --agents <list>] [-f, --flow <name>] [-y, --yes] [--mcp \| --no-mcp] [--project-agents]` | set up dfl: create/activate a flow, install skills and the MCP server (outside a dfl project it installs at the git root); `--mcp`/`--no-mcp` is remembered |
| `dfl uninstall [--purge] [-y]` | remove the installed skills and the `dfl` MCP entries; `--purge` also deletes `local.json`, `state.json` and rendered files (flows are kept) |
| `dfl flow-update` (alias `dfl update`) `[--dry-run] [--mcp \| --no-mcp] [-y]` | re-render and re-install the active flow (always, also before `dfl install`); `--mcp`/`--no-mcp` for this run only; never changes a flow, but says when a template has an update |
| `dfl status [--flow <f>] [--json]` | active flow, current step, available events, stale-skill warning (`--json`: `skills: { installed, upToDate, reason?, hint? }`) |
| `dfl next [event] [--from <step>] [--flow <f>] [--json]` | fire an event (default `NEXT`) |
| `dfl goto <step> [--flow <f>] [--json]` | jump to a step |
| `dfl reset [--flow <f>] [-y] [--json]` | back to the initial step |
| `dfl flow list` / `ls [--json]` | flows of the project |
| `dfl flow templates` | prebuilt templates |
| `dfl flow use <name> [--project] [--no-sync]` | make a flow active (personal, or team default with `--project`); an invalid flow is refused, and a failed sync restores the previous flow |
| `dfl flow create <name> [--from <template> \| --steps a,b] [--title] [--description] [--use] [--no-sync]` | create a flow |
| `dfl flow export [names...] [--all] [-o <file\|dir\|->] [--force]` | write flows to one file (default: the active flow → `<flow>.dfl.json`) |
| `dfl flow import <source> [--name <n>] [--flow <names...>] [--force] [--dry-run] [-y] [--use] [--no-sync]` | import flows from an export file, git or a directory; `--force` replaces existing flows after showing the changes and asking |
| `dfl flow pull [name] [--rev <ref>] [--dry-run] [-y] [--discard-local] [--no-sync]` | update a flow from its recorded source (template, git, directory) after showing the changes and asking |
| `dfl flow delete` / `rm <name> [-y]` | delete a flow (a backup is saved first) |
| `dfl flow validate [name] [--json]` | validate a flow (all flows when none is active); `--json`: `{ valid, flows: [{ flow, valid, issues }] }` |
| `dfl flow view [name] [--zoom <0-3>] [--print] [--lr] [--ascii]` | flow viewer |
| `dfl step list` / `ls [--flow <f>] [--json]` | steps in flow order |
| `dfl step add <id> [--after <s> \| --before <s>] [--title] [--description] [--event <E>] [--template-file <f>]` | add a step |
| `dfl step edit <id> [--title] [--description] [--rename <new-id>] [--template-file <f>] [--initial]` | change a step |
| `dfl step remove` / `rm <id> [--force] [-y]` | remove a step |
| `dfl step transition <id> <event> [target] [--description <text>] [--remove]` | set (with the condition for firing it) or remove a transition |
| `dfl vars list` / `ls [--json]` | variables and their sources (`dfl vars` alone lists them) |
| `dfl vars set <name> <value> [--personal \| --project]` | set a variable |
| `dfl vars unset <name>` | remove a stored value |
| `dfl agents [--json]` | supported agents, detection and paths |
| `dfl mcp` | run the MCP server over stdio |

Step and vars commands take `--no-sync`; step commands take `--flow <name>` (default: the active
flow).

## Development

Building, packing and publishing need **Node.js 22.18+ or 24.11+** (tsdown 0.23 cannot load its
config on older Node and fails with `Failed to import module "unrun"`); the installed CLI still runs
on 22.12+.

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
- [docs/ARCHITECTURE.md](https://github.com/vishin-pavel/dfl/blob/main/docs/ARCHITECTURE.md)
  describes the design and module contracts;
  [docs/AGENTS.md](https://github.com/vishin-pavel/dfl/blob/main/docs/AGENTS.md) the per-agent
  research.
- CI runs typecheck, tests and build on Ubuntu and macOS with Node 22 and 24 (and 22.18.0, the
  oldest Node that builds dfl), and runs the built CLI on Node 22.12 (and checks that Node 20 gets
  a clear error).
- Publishing to GitHub Packages runs on a GitHub release or a pushed `v*` tag whose version matches
  `package.json`:
  - release: `npm version patch && git push --follow-tags` (published under `latest`);
  - prerelease: `npm version prerelease --preid rc && git push --follow-tags` (for example
    `0.2.0-rc.0`, published under `next`, as is any GitHub release marked as a prerelease). Test it
    with `npm install -g @vishin-pavel/dfl@next`, then promote the final version with a normal
    release.

## License

MIT
