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
- **Optional Jira tracking**: each ticket keeps its own position in the flow, the ticket's status
  follows the steps, and a teammate on the same branch continues where you left off (see
  [Tracking tasks in Jira](#tracking-tasks-in-jira)).

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
- [Tracking tasks in Jira](#tracking-tasks-in-jira)
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
   into the skills folder of every selected agent, plus the [built-in skills](#built-in-skills)
   (three, plus `/init-task` in projects tracked in Jira).
   Every installed skill folder gets a `.gitignore` file that ignores the folder itself, because
   rendered skills can contain personal values.
3. dfl registers its MCP server in each agent's project MCP config (unless you turned that off).
4. The current position of each flow is kept in `.df/state.json`, per developer. For a flow
   [tracked in Jira](#tracking-tasks-in-jira), the position belongs to the ticket of the branch
   you are on and is stored in that ticket instead.

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
    tracker.json           committed   optional: Jira site, projects and the step → status mapping (see Tracking tasks in Jira)
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
| `/init-task` | Only in projects with `.df/tracker.json`: starts or continues work on a Jira ticket, e.g. `/init-task ABC-123` (see [Tracking tasks in Jira](#tracking-tasks-in-jira)) |

They fall back to the `dfl` CLI when the MCP server is not available. A step cannot have the
skill name of `/add-flow-step`, `/edit-flow-step` or `/delete-flow-step` (`dfl flow validate`
reports it); a step named `init-task` replaces the built-in `/init-task`.

## MCP server

`dfl mcp` is a stdio MCP server named `dfl`. `dfl install` registers it in the project MCP
config of each selected agent (see [Supported agents](#supported-agents)); you never start it by
hand. Files are re-read on every call, so edits and `git pull` are picked up immediately.

| Tool | Purpose |
|------|---------|
| `get_status` | current step, its command, the events it can fire, the history tail and whether your installed skills are up to date (`skills`); for a flow tracked in Jira, the ticket's position plus `task` (ticket, Jira status, params, instructions) |
| `get_flow` | the active (or named) flow: steps in order, transitions, variables, current step; also works on a broken flow (`current: null` plus `problem` and `issues`) |
| `list_flows` | all flows and which one is active |
| `get_step` | one step: metadata, transitions, template and rendered skill |
| `validate_flow` | validation errors and warnings |
| `get_authoring_guide` | how to write step templates: files, context, helpers, rules, an example |
| `transition` | fire an event (default `NEXT`) from the current step |
| `complete_step` | fire an event (default `NEXT`) from a given step; fails if it is not current |
| `goto_step` | jump to a step |
| `start_task` | start or continue a Jira ticket: bind it to a git branch (creating the branch when needed), record the task and move the ticket to its status |
| `add_step` | create a step (directory, template, wiring), then re-install the skills; `placement` says where it went |
| `update_step` | change title, description, template, transitions (with descriptions), id or initial step, then re-install |
| `delete_step` | delete a step and reroute transitions (`rewired`, `dropped`), then re-install |
| `sync` | same as `dfl flow-update` |

- Resources: `dfl://flow` (flow.json of the active flow) and `dfl://steps/{id}` (a step's
  template). After `add_step`, `update_step`, `delete_step` and `sync` the server sends
  `notifications/resources/list_changed`; changes made outside the server (CLI, editor, `git pull`)
  are not announced.
- Every tool except `list_flows`, `sync` and `get_authoring_guide` accepts an optional `flow`
  argument (a flow name). For flows tracked in Jira, `get_status`, `transition`, `complete_step`
  and `goto_step` also take `task` (the ticket key), and the three moves take `params` (values later
  steps need); for other flows they are ignored.
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

## Tracking tasks in Jira

Without a tracker, each developer's checkout has one position per flow. With Jira tracking, every
**ticket** has its own position, stored in the ticket itself:

- `/init-task ABC-123` in your agent (or `dfl task start ABC-123`) creates the branch
  `ABC-123-export-orders-as-csv` from `origin/main`, records the task at the first step of the flow
  and moves the ticket to the Jira status you mapped to that step.
- Every completed step (`complete_step` in a skill, `dfl next` in the terminal) moves the task, and
  the ticket to the status mapped to the next step. Steps can record values for later steps (a spec
  path, a pull request URL) and write them to Jira fields.
- The ticket key in the branch name identifies the task: a teammate who checks out the branch
  continues at the same step, on any machine.

dfl talks to the Jira REST API itself, from the CLI and from its MCP server alike; the agent needs
no Jira MCP server and calls no extra tool per step. Flows that `.df/tracker.json` does not track
work exactly as before, even while the file has a mistake in another flow's entry. This release
supports **Jira Cloud** with classic API tokens.

### How tracking works

- **The position is a hidden record in the ticket**, an issue property (`dfl.run`) with the flow,
  the step, the task's params (branch, slug, spec path, …) and a short history. It needs the Browse
  projects and Edit issues permissions (plus Transition issues to move the status), no Jira admin
  and no custom field, and it keeps the exact step even when several steps share one Jira status.
  The record is readable by everyone who can see the ticket, so never put secrets into params.
  Anyone who can edit the ticket can also change it, so dfl accepts only what it writes itself (step
  ids, single-line params, plain relative paths, a branch name of letters, digits and `._/+-`) and
  never turns record values into instructions for the agent; a damaged record is repaired with
  `dfl goto <step> --task <key>`.
- **The Jira status follows the mapping**: dfl moves the ticket to the status mapped to the current
  step, and never reads the step from the status. Several steps can share a status; a step mapped
  to *none* leaves the status alone. dfl asks Jira for English status names and also matches Jira's
  untranslated names, so teammates whose Jira profile uses another language share one mapping.
- **dfl does not fight people or automation.** When someone moved the ticket to a status the flow
  does not map (say *Blocked*), dfl leaves it there and says so. It never reopens a done ticket
  unless the mapping allows it (`"reopen": true`). When Jira offers no transition to the mapped
  status, the step still completes and dfl lists the transitions that were available.
- **The ticket comes from the branch name**: the first uppercase key of a configured project
  (`feature/ABC-123-csv-export` → `ABC-123`), or from `--task ABC-123` / the `task` argument of the
  MCP tools. On a branch without a key, a tracked flow does not move (`"requireTask": true`, the
  default): dfl tells you to start a ticket instead of silently using a local position.

### Setup (once per project)

```sh
dfl tracker init                 # asks for the Jira site and project key(s); writes .df/tracker.json
dfl tracker login                # your email and API token, saved in your user config (never in the project)
dfl tracker map                  # wizard: a Jira status, or none, for each step of the active flow
dfl tracker check                # checks the config, your token, the projects, the mapped statuses and fields
git add .df/tracker.json && git commit -m "Track the feature flow in Jira"
```

Optionally store the task branch in a Jira field: `dfl tracker field branch <field>` (see
[Fields](#mapping-steps-to-statuses) below; `dfl tracker check` reminds you while it is unset).

- Without a terminal: `dfl tracker init --url https://acme.atlassian.net --project ABC` (`--project
  ABC,OPS` for several projects; `--default-project ABC` expands bare numbers such as `123`, and is
  set automatically when there is one project). It tracks the active flow (or every `--flow <name>`)
  with no status changes yet, and re-installs your skills so that `/init-task` appears (`--no-sync`
  skips that). `--branch-template`, `--from` and `--property` change the defaults below.
- `dfl tracker login` asks for the token with a hidden prompt and checks it against Jira before
  saving it. Create a classic API token at
  [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) (scoped tokens are
  not supported yet). Without a terminal, pipe it in: `dfl tracker login --email you@acme.com
  --token-stdin < token-file`. The token is never accepted as a command-line argument.
- Pin dfl in the project (`npm install -D @vishin-pavel/dfl`, see
  [Global or per project](#global-or-per-project)): a teammate with an older global dfl would
  advance only local state. `dfl tracker check` warns about it.

### Mapping steps to statuses

```sh
dfl tracker map                              # in a terminal: the wizard; otherwise the step → status table
dfl tracker map --list                       # the table; --json: { flow, tracked, statuses }
dfl tracker map review-feature "In Review"   # a status name (checked against Jira, stored as Jira spells it in English)
dfl tracker map review-feature id:10004      # a status id
dfl tracker map verify-feature none          # no status change at this step (same as --none or --unset)
dfl tracker map --none                       # no status change at any step of the flow
dfl tracker map --remove                     # stop tracking the flow (asks first; --yes without a terminal)
dfl tracker map --flow bugfix reproduce-bug "In Progress"
```

- The wizard goes through the steps in flow order (the final state too) and offers, for each one,
  *keep* (the current mapping), every status of your Jira project(s), *none – don't change the Jira
  status at this step*, or a status name to type. It reads the statuses with your credential; without
  one you can still type names or choose none.
- **none** (`null` in `tracker.json`, or no entry) means dfl never changes the ticket's status at
  that step. `dfl tracker map --none` sets it for every step: the flow stays tracked (each ticket
  keeps its position, params and branch, and mapped fields are still written), but dfl never
  moves the status, for teams whose board is driven by people or automation.
- A flow is tracked as soon as `tracker.json` has an entry for it, even one that maps no step; any
  `dfl tracker map` edit creates it. `--remove` deletes the entry: the flow goes back to local state.
- The final state (`done`) is mapped like any step. Map it to *Done* only when nothing else closes
  tickets; leave it none when a pull-request merge automation does.
- Every move projects the mapping, backward moves too: `FAILED`, `CHANGES_REQUESTED`, `dfl goto` and
  `dfl reset` move the ticket back to the status of the step they lead to.
- An unknown status name fails with `TRACKER_STATUS_UNKNOWN` and suggests close matches; `--no-check`
  skips the check. Without a credential, or when Jira cannot be reached, dfl warns and writes the
  mapping anyway.
- Options that `map` does not set are edited in `tracker.json` (an object instead of the status
  name): `"done": { "status": "Done", "fields": { "resolution": { "name": "Done" } } }` sends fields
  the transition screen requires, and `"reopen": true` lets dfl move a ticket out of a done status.
  `dfl tracker map <step> <status>` keeps them when it changes the status. Jira accepts `fields` only
  on a transition whose screen has them: when several transitions lead to the status, dfl picks one
  with a screen for a mapping with `fields`, and one without a screen otherwise.
- Renaming a step (`dfl step edit <id> --rename <new-id>`, or the agent's `/edit-flow-step`) renames
  its mapping too, and removing a step removes its mapping.

**Fields.** Task params can be written to Jira fields, typically the branch name and the pull
request URL:

```sh
dfl tracker field branch customfield_10042   # by id, or by name: dfl tracker field prUrl "PR link"
dfl tracker field prUrl none                 # stop writing it (or --none)
dfl tracker field                            # the mapped fields (--json)
```

Only single-line text and URL custom fields can be used: dfl checks the field in Jira unless
`--no-check`, and without a credential, or when Jira cannot be read, it writes an id unchecked with
a warning (a name cannot be looked up then). `dfl tracker field --list` lists the mapped fields.
The field's context in Jira must include the projects and issue types of your tickets; dfl cannot
see that without admin rights, so `dfl tracker check` warns about it when you track several
projects or issue types, and a refused field write says so. `start_task` sets the params `branch`
and `slug`; steps record others (the shipped ship steps record `prUrl`, the pull request URL), and
the agent is told which params reach Jira fields. Every move writes each mapped field whose Jira
value differs from the task's param, so a field mapped later, or a write that failed, is filled on
the next move.

### `.df/tracker.json`

```json
{
  "version": 1,
  "provider": "jira",
  "jira": { "baseUrl": "https://acme.atlassian.net", "projectKeys": ["ABC"], "defaultProjectKey": "ABC" },
  "branch": { "template": "{key}-{slug}", "from": "origin/main", "protected": ["main", "master", "develop"], "fetch": true },
  "fields": { "branch": "customfield_10042", "prUrl": "customfield_10077" },
  "flowSelect": { "byIssueType": { "Bug": "bugfix" }, "default": "feature" },
  "flows": {
    "feature": {
      "branchTemplate": "feature/{key}-{slug}",
      "statuses": {
        "spec-feature": "In Progress",
        "implement-feature": "In Development",
        "verify-feature": null,
        "review-feature": "In Review",
        "done": { "status": "Done", "fields": { "resolution": { "name": "Done" } } }
      }
    },
    "bugfix": { "statuses": {} }
  }
}
```

| Key | Meaning |
|-----|---------|
| `jira.baseUrl` | your Jira Cloud site (`https://`; only the origin is used) |
| `jira.projectKeys` | projects whose tickets this repository works on (`ABC` for `ABC-123`) |
| `jira.defaultProjectKey` | expands bare numbers (`123`, `#123`) when starting a task or showing its status |
| `jira.property` | the issue property that holds the record (default `dfl.run`); change it only when two repositories work on the same tickets |
| `branch.template` | name of new task branches: `{key}` (required, with a separator such as `-` or `/` on both sides: `{key}{slug}` is refused) and `{slug}` (from the ticket summary). Default `{key}-{slug}`; a flow's `branchTemplate` wins |
| `branch.from` | where new task branches start (default `origin/<mainBranch>`; fetched first unless `fetch` is false). A plain ref: no `:`, `*`, `?`, `[`, `^`, `~`, `\`, `..`, `@{`, leading `+` or `-`, or spaces |
| `branch.protected` | branches a task is never recorded on; starting a ticket there creates a branch (default `main`, `master`, `develop` and the flow's `mainBranch`) |
| `fields` | task param → Jira custom field id |
| `flowSelect` | which flow `/init-task` uses: by issue type, else `default`, else the active flow |
| `flows.<flow>.statuses` | step → status name, `{ "id": "…" }`, `{ "status", "fields", "reopen" }`, or `null` (none) |
| `flows.<flow>.requireTask` | `false` lets a branch without a ticket key use the local position (default `true`) |

`dfl flow validate` reports problems in `tracker.json` as warnings (a mapped step the flow does not
have, for example); `dfl tracker check` checks everything against Jira.

### Daily use

In your agent:

```
/init-task ABC-123
```

(`$init-task ABC-123` in Codex.) The skill calls `start_task`, which:

- on `main` (or another protected branch) creates and checks out the task branch, carrying over
  uncommitted changes;
- on a branch whose name already contains `ABC-123` uses it;
- on any other branch stops and asks: create a new branch (`--branch create`), or rename the current
  branch to contain the key (`git branch -m`);
- for a ticket that was started before, continues at its recorded step (and tells you to switch to
  its branch when you are elsewhere). When the ticket has no branch recorded (after a repair), it
  picks one as for a new ticket and records it, without moving the step or the status.

Then run the steps as usual: each skill calls `get_status` (which returns the ticket, its Jira status
and its params) and `complete_step` (which moves the task and the ticket). The skills tell the agent
to take the slug and paths from the task's params instead of deriving them, and to pass the values
later steps need (the ship step records the pull request URL as `prUrl`). A ticket summary without
Latin letters gives the branch `ABC-123` and the slug `abc-123`. In the terminal:

```sh
dfl task start ABC-123                 # same as /init-task (also 123, "#123" or the ticket's URL)
dfl status                             # the ticket of this branch: step, Jira status, params
dfl next                               # complete the current step; the ticket follows the mapping
dfl next --set prUrl=https://github.com/acme/app/pull/42   # record a param (prUrl= deletes it)
dfl goto implement-feature             # move the task (and the ticket) to a step
dfl status --task ABC-123              # name the ticket, e.g. on main after finishing it (also 123 with a default project)
```

`dfl status` shows the ticket under the progress line:

```
ABC-123 · Export orders as CSV · Jira: In Progress ✓ · branch ABC-123-export-orders-as-csv
  https://acme.atlassian.net/browse/ABC-123
```

`≠ expected In Review` instead of `✓` means the ticket is not in the status of the current step.
`dfl reset` on a tracked flow asks before it moves the shared ticket back (`--yes` skips the
question). After you switch back to `main` at the end of a task, `dfl status` and the agent suggest
the ticket of the previous branch, even when the cleanup deleted that branch, so a forgotten last
step can still be completed.

- **Flows by issue type**: with `flowSelect`, a *Bug* can start in the `bugfix` flow. One flow is
  active per checkout: when a ticket belongs to another flow, dfl asks you to run `dfl flow use
  <flow>` first (and to restart your agent if it does not pick up the new skills).
- **Params** are short single-line strings (up to 1,000 characters, 30 per task). Names that look
  like secrets (`token`, `password`, …) are refused, path params (`specPath`, `notesDir`) must be
  relative (no `..`, `~` or `.git`), `branch` uses letters, digits and `._/+-`, and `slug` is one
  file name.
- **No ticket on the branch**: `dfl status` says how to start one, and moves fail with
  `TASK_REQUIRED`. Set `"requireTask": false` on the flow to let such branches use the local
  position instead.

### Teammates

Teammates pull the commit with `tracker.json`, run `dfl tracker login` once and `dfl flow-update`
(`dfl status` tells them when their skills are out of date; that installs `/init-task`). To
continue someone's ticket, check out its branch: `dfl status` and the skills show the same step and
params. One person works on a ticket at a time; dfl does not merge concurrent moves.

### Credentials, CI and security

- Your token is stored in `~/.config/dfl/credentials.json` (`%APPDATA%\dfl\credentials.json` on
  Windows, or `$DFL_CONFIG_DIR/credentials.json`), readable only by you (mode 0600) and bound to the
  exact site of `jira.baseUrl`. The CLI and the MCP server of every agent read the same file, so one
  login is enough. `dfl tracker logout` removes it.
- dfl never puts a token into the project, rendered skills, MCP configs, tool results, `--json`
  output, error messages or debug logs. When Jira rejects your token, agents are told to ask you to
  run `dfl tracker login` in your own terminal: never paste a token into a chat.
- CI and other non-interactive environments can set `DFL_JIRA_URL`, `DFL_JIRA_EMAIL` and
  `DFL_JIRA_TOKEN`; they are used only when `DFL_JIRA_URL` is the configured site.
- `DFL_TRACKER_TIMEOUT_MS` changes the time limit of one operation (default 10 seconds for all its
  Jira requests). A move holds the project lock while it talks to Jira and other dfl commands wait
  at most 15 seconds for it, so a value of 15000 or more can make them fail with `LOCKED` while Jira
  is slow. `DFL_DEBUG=1` logs each request's method, path, status and duration to stderr.
- The ticket summary and the task's params reach the agent as information only; the instructions it
  gets are written by dfl, never taken from the ticket. `dfl status` and the other commands replace
  control characters in ticket text, so a ticket cannot send escape sequences to your terminal.

### Troubleshooting

| Message (code) | What to do |
|----------------|------------|
| `TRACKER_AUTH_MISSING` | run `dfl tracker login` (in your own terminal) |
| `TRACKER_AUTH` | the token expired (they last at most a year), was revoked, or is a scoped token, or the email is wrong: run `dfl tracker login` with a new classic token. Jira then answers as for an anonymous user ("not found"), so dfl reports this instead of a missing ticket. A CAPTCHA lock-out needs one login in the browser |
| `TRACKER_FORBIDDEN` | the account needs Browse projects, Edit issues and Transition issues in the project |
| `TRACKER_UNREACHABLE` | check the VPN; behind a proxy set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` (and `NODE_EXTRA_CA_CERTS` for a proxy that re-signs TLS) where dfl and your agent run; allow network access for the `dfl` MCP server if your agent sandboxes it |
| `TRACKER_TIMEOUT` | the outcome of a write is unknown. Running the command again is safe for `dfl status`, `goto`, `reset`, `dfl next --from <step>` and the agent's moves; after a plain `dfl next`, check `dfl status --task <key>` first (the hint shows the safe `--from` form). Raise `DFL_TRACKER_TIMEOUT_MS` if Jira is slow (below 15000, see above) |
| `TRACKER_CONFIG_INVALID` | fix `.df/tracker.json` (the message names the key), then `dfl tracker check`. Until then `dfl status`/`next` and the agent's `get_status` fail for the flows the file names (for every flow when it is not valid JSON); other flows use their local state |
| `TASK_REQUIRED` | start a ticket (`/init-task <ticket>`, `dfl task start <ticket>`) or pass `--task <key>` |
| `TASK_BRANCH_CHOICE` | `dfl task start <ticket> --branch create`, or rename the branch to contain the key (`git branch -m`) and start again |
| `TASK_BRANCH_INVALID` | the branch name would not lead back to the ticket, or has characters dfl does not record: put `-` or `/` around `{key}` in the branch template, pass another `--slug`, or rename the checked-out branch |
| `TASK_REF_INVALID` | pass the full key (`ABC-123`; a bare number only works for `task start` and `status` with `jira.defaultProjectKey`). "ABC-7 is now XYZ-9": the ticket moved to a project this repository does not list; add it to `jira.projectKeys` |
| `TASK_BRANCH_MISMATCH` | the ticket you named is not the branch's: switch branches, or leave out `--task` |
| `TASK_FLOW_NOT_ACTIVE`, `TASK_FLOW_MISMATCH` | `dfl flow use <flow>` (the message names it) |
| `TASK_STEP_UNKNOWN`, `TASK_RECORD_INVALID` | the flow lost the task's step, or the record is damaged or was edited outside dfl (the message names the fields): `dfl goto <step> --task <key>` repairs it |
| `TASK_DONE` | the ticket finished the flow; `dfl goto <first step> --task <key>` restarts it |
| "was moved to '…' outside dfl" | someone moved the ticket to a status the flow does not map; move it back by hand, or leave it |
| "No transition from '…' to '…'" | the Jira workflow has no direct path, or the transition needs fields: move the ticket by hand, add `fields` to the mapping, or change it with `dfl tracker map` |
| "dfl could not write … to the Jira fields" | check `fields` with `dfl tracker check`: each must be a single-line text or URL field whose field context includes the ticket's project and issue type (a Jira admin can extend it); the next move writes it again |

- **The `#` character**: in a shell, `#123` starts a comment, so `dfl task start #123` loses the
  ticket. Write `123`, `ABC-123` or `"#123"`; for `--task` of `next`, `goto` and `reset` write the
  full key (`--task ABC-123`). In Kiro and Copilot chat `#` opens a picker; type `ABC-123` or `123`
  there too.
- **Offline**: a tracked step cannot be completed while Jira is unreachable (dfl does not queue
  moves, so the ticket and the record never disagree). `dfl flow list` and `dfl step list` show
  "tracked in Jira" instead of a stale local step and need no network.
- **Inspecting a task**: `dfl status --json` prints the `task` object; the raw record is at
  `https://<site>/rest/api/3/issue/ABC-123/properties/dfl.run`. Jira's issue history shows dfl's
  transitions and field edits (attributed to your account), not the record.

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
`flow delete`, `flow pull`, `flow import --force`, `step remove`, `tracker map --remove`) then need
`--yes` (and `flow pull` also `--discard-local` when it would replace changes made in the project). Commands exit non-zero on errors.
Warnings go to stderr, so `--json` output can be piped. Tables fit the terminal width (or
`COLUMNS` when the output is not a terminal).

| Command | Description |
|---------|-------------|
| `dfl install [-a, --agents <list>] [-f, --flow <name>] [-y, --yes] [--mcp \| --no-mcp] [--project-agents]` | set up dfl: create/activate a flow, install skills and the MCP server (outside a dfl project it installs at the git root); `--mcp`/`--no-mcp` is remembered |
| `dfl uninstall [--purge] [-y]` | remove the installed skills and the `dfl` MCP entries; `--purge` also deletes `local.json`, `state.json` and rendered files (flows are kept) |
| `dfl flow-update` (alias `dfl update`) `[--dry-run] [--mcp \| --no-mcp] [-y]` | re-render and re-install the active flow (always, also before `dfl install`); `--mcp`/`--no-mcp` for this run only; never changes a flow, but says when a template has an update |
| `dfl status [--flow <f>] [--task <key>] [--json]` | active flow, current step, available events, stale-skill warning (`--json`: `skills: { installed, upToDate, reason?, hint? }`); for a flow tracked in Jira, the ticket of the branch (or `--task`) with its Jira status and params (`--json`: `task`) |
| `dfl next [event] [--from <step>] [--flow <f>] [--task <key>] [--set <name=value>]... [--json]` | fire an event (default `NEXT`); tracked flows: also moves the ticket, `--set` records task params (`name=` deletes) |
| `dfl goto <step> [--flow <f>] [--task <key>] [--set <name=value>]... [--json]` | jump to a step |
| `dfl reset [--flow <f>] [--task <key>] [-y] [--json]` | back to the initial step (tracked flows: asks before moving the ticket) |
| `dfl task start <ticket> [--flow <f>] [--step <s>] [--branch auto\|create\|current] [--slug <s>] [--json]` | start or continue a Jira ticket (`ABC-123`, `123`, `"#123"` or its URL): bind it to a branch (created when needed), record the task, move the ticket to its status |
| `dfl tracker init [--url <u>] [--project <keys>] [--default-project <key>] [--branch-template <t>] [--from <ref>] [--property <p>] [--flow <names...>] [--force] [--no-sync] [-y]` | create `.df/tracker.json` (asks for the site and projects in a terminal) and track the active flow (or `--flow`) |
| `dfl tracker login [--email <e>] [--token-stdin]` / `logout` | save (after checking it) or remove your Jira API token for the project's site; the token is never an argument |
| `dfl tracker check [--json]` | check the config, your token, the projects, the mapped statuses and fields against Jira; exits 1 on problems |
| `dfl tracker map [step] [status \| id:<id> \| none] [--flow <f>] [--none] [--unset] [--remove] [--list] [--json] [--no-check] [-y]` | map steps to Jira statuses: the wizard (in a terminal) or the table; one step; `--none` for every step; `--remove` stops tracking the flow |
| `dfl tracker field [param] [field \| none] [--none] [--list] [--json] [--no-check]` | write a task param to a Jira custom field (by id or name), remove it, or list them |
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
