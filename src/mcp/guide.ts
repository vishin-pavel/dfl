/**
 * The step template authoring guide returned by the `get_authoring_guide` MCP tool.
 * Keep it in sync with src/core/render.ts (context, helpers, frontmatter) and templates/partials.
 */

/**
 * The guide with CLI commands spelled the way this project runs dfl (`cli`: `dfl` or
 * `npx --no-install dfl`, see dflLauncher). The Handlebars example (section 8) must stay free of
 * template-literal interpolation.
 */
export function authoringGuide(cli = 'dfl'): string {
  return `# Writing dfl step templates

A dfl flow is a state machine in \`.df/<flow>/flow.json\`. Every non-final state is a **step**
whose instructions live in a Handlebars template, \`.df/<flow>/steps/<step-id>/SKILL.md.hbs\`.
On every sync (the \`sync\` tool, \`${cli} flow-update\`, and automatically after \`add_step\`,
\`update_step\` and \`delete_step\` once you ran \`${cli} install\`) dfl renders the templates and
installs each step as an Agent Skill (\`<agent skills dir>/<skillName>/SKILL.md\`, invoked as
\`/<skillName>\`, or \`$<skillName>\` in Codex) for every coding agent configured in the project.

## 1. Files

| Path | Role |
|------|------|
| \`.df/<flow>/flow.json\` | flow definition: steps, titles, descriptions, transitions, variables |
| \`.df/<flow>/steps/<id>/SKILL.md.hbs\` | the step's skill template (required for every non-final step) |
| \`.df/<flow>/steps/<id>/**/*.md.hbs\` | extra templated reference files: \`X.md.hbs\` renders to \`X.md\` next to it |
| \`.df/<flow>/steps/<id>/**/*\` (not \`.hbs\`) | static files (scripts, JSON, images), copied verbatim into the skill |
| \`.df/<flow>/partials/<name>.hbs\` | flow-specific partials, used as \`{{> name}}\` |
| \`.df/<flow>/steps/<id>/SKILL.md\`, \`**/*.md\` | **generated** output: git-ignored and overwritten on every sync |

- Edit only the \`.hbs\` sources and flow.json. Every \`.md\` file under \`steps/\` is git-ignored
  as generated output; one dfl rendered from a template that no longer exists is deleted on the next
  sync. A hand-written \`.md\` file without a template is kept but neither committed nor installed:
  name a hand-written reference document \`X.md.hbs\` instead (it is rendered too, so escape
  literal braces).
- The installed copies in agent folders (\`.claude/skills/<name>/\`, \`.agents/skills/<name>/\`, ...)
  are regenerated on every sync; never edit them.
- The step directory is the skill directory. Link extra files from SKILL.md with relative paths,
  for example \`[review checklist](references/checklist.md)\` or \`scripts/check.sh\`.
- Step ids are kebab-case (\`^[a-z0-9]+(-[a-z0-9]+)*$\`, at most 64 characters). The skill name and
  slash command is \`skillPrefix + id\`. Avoid names of built-in agent commands (\`review\`, \`plan\`,
  \`init\`, \`help\`, \`status\`, ...) and of the dfl built-in skills (\`add-flow-step\`,
  \`edit-flow-step\`, \`delete-flow-step\`). A descriptive id such as \`review-feature\` is best.

## 2. Frontmatter

Do not write YAML frontmatter; dfl generates it. After rendering SKILL.md, dfl:

- forces \`name\` to the skill name;
- sets \`description\` from the state's \`description\` in flow.json (or its title) when the
  template has none; whitespace is collapsed and it is cut to 1024 characters;
- merges \`metadata\` (a string-to-string map) with \`dfl-flow: <flow>\` and \`dfl-step: <step>\`;
- keeps any other key.

If you really need frontmatter, use only the portable keys \`license\`, \`compatibility\`,
\`metadata\` and \`allowed-tools\`, in a leading \`---\` block. Put the description in flow.json
instead (\`description\` of \`add_step\` / \`update_step\`): agents read it to decide when to invoke
the skill, so write one sentence of at most 200 characters that starts with a verb and says when
to use the step.

## 3. Handlebars

Handlebars 4 with \`noEscape\` (nothing is HTML-escaped) in non-strict mode: a missing value renders
as an empty string, never as an error.

- Output literal braces with a backslash: \`\\{{vars.x}}\` renders as the text \`{{vars.x}}\` (a GitHub
  Actions expression: \`$\\{{ secrets.NPM_TOKEN }}\`). \`validate_flow\` warns about expressions whose
  first name is not part of the context below: they render as empty strings.
- Comments: \`{{!-- not rendered --}}\`. Whitespace control: \`{{~ ... ~}}\`.
- Built-in block helpers: \`{{#if}}\`, \`{{#unless}}\`, \`{{#each}}\` (\`@index\`, \`@first\`, \`@last\`,
  \`{{else}}\` for empty lists), \`{{#with}}\`, \`{{lookup}}\`.
- \`add_step\` / \`update_step\` refuse a template that does not parse (\`INVALID_TEMPLATE\`, nothing is
  written), and \`validate_flow\` reports parse errors and unknown partials with file and line. A
  template that fails while rendering makes the sync fail with \`Cannot render <file>, line N\`.
- \`{{log ...}}\` writes to stderr for debugging and renders nothing.

### Context

| Expression | Value |
|------------|-------|
| \`project.name\`, \`project.root\` | project directory name and absolute path |
| \`flow.name\`, \`flow.title\`, \`flow.description\` | the flow being rendered |
| \`flow.initial\`, \`flow.skillPrefix\` | initial step id, skill name prefix |
| \`flow.steps\`, \`flow.stepCount\` | non-final steps in flow order (each shaped like \`step\`), and their number |
| \`step.id\`, \`step.skillName\`, \`step.title\`, \`step.description\` | the step being rendered |
| \`step.number\` | 1-based position among the non-final steps (\`step.index\`: 0-based position among all states) |
| \`step.final\` | always false for a rendered step |
| \`step.next\` | outgoing transitions: \`{ event, id, skillName, title, final, description }\` |
| \`step.prev\` | incoming transitions, same shape (\`id\` is the source step) |
| \`vars.<name>\` | template variables (see section 6) |
| \`env.<NAME>\` | the environment variable \`DFL_ENV_<NAME>\` of the process that ran the sync (no other environment variables are visible) |
| \`dfl.cli\` | how to run the CLI here: \`npx --no-install dfl\` when the project's package.json depends on dfl, else \`dfl\` (here: \`${cli}\`) |
| \`dfl.mcpServer\`, \`dfl.version\` | MCP server name (\`dfl\`) and dfl version |

In \`step.next\`, \`description\` is the transition's description or else the target step's
description; in \`step.prev\` it is the transition's description only.

### Helpers

| Helper | Example | Result |
|--------|---------|--------|
| \`eq\`, \`ne\` | \`{{#if (eq vars.ci "github")}}...{{/if}}\` or \`{{#eq a b}}...{{else}}...{{/eq}}\` | equality |
| \`and\`, \`or\`, \`not\` | \`{{#if (and vars.a (not vars.b))}}\` | logic; empty arrays count as false |
| \`default\` | \`{{default vars.mainBranch "main"}}\` | the fallback when the value is empty |
| \`upper\`, \`lower\`, \`kebab\`, \`title\` | \`{{kebab "Plan Feature"}}\` | \`plan-feature\` |
| \`json\` | \`{{json vars 2}}\` | JSON text |
| \`join\` | \`{{join list ", "}}\` | joined array |
| \`indent\` | \`{{indent 4 text}}\` or \`{{#indent 2}}...{{/indent}}\` | indents non-blank lines |
| \`command\` | \`{{command skillName}}\` | \`/<skillName>\`, a step's slash command |
| \`handle\` | \`{{handle vars.reviewer}}\` | a login without leading \`@\` or spaces (for \`gh --reviewer\`) |

Inside \`{{#each step.next}}\` a bare \`{{title}}\` is the item's \`title\` (helpers called without
arguments fall back to the property of the same name); \`{{this.title}}\` is the explicit form.

### Partials

- \`{{> flow-context}}\` (built in) renders the "Flow context" section: the step's position
  (step n of total), the steps it comes after or is also reached from (with their slash commands and
  conditions), the instruction to call \`get_status\` before starting, the outgoing events with their
  targets and descriptions, and the instruction to call \`complete_step\` with the chosen event when
  done (with CLI fallbacks). End
  every step template with it, on the last line, and do not write your own version of these
  instructions.
- \`.df/<flow>/partials/<name>.hbs\` defines a partial \`{{> name}}\` for all steps of that flow
  (\`partials/common/footer.hbs\` is \`{{> common/footer}}\`). A file named \`flow-context.hbs\` there
  overrides the built-in one for the flow.

## 4. Forbidden tokens

Some agents expand placeholders when a skill runs as a slash command, which corrupts the text.
Never write, in templates or in values they render:

- \`$ARGUMENTS\` or a dollar sign followed by a digit (\`$1\`, \`$2\`, ...);
- a line that starts with an exclamation mark followed by a backtick (it runs a shell command);
- an at-sign directly followed by a word (\`@file\`, \`@user\`): it is read as a file mention.
  Write "the file src/index.ts" and GitHub handles without the at-sign.

Refer to arguments as "the text the user typed after the command".

## 5. Transitions and events

A step's \`on\` maps an event to a target state id (\`"NEXT": "review-feature"\`) or to
\`{ "target": "...", "description": "when to fire it" }\`. The target must exist.

- \`NEXT\` is the forward path. Give every non-final step a \`NEXT\`: \`delete_step\` reroutes incoming
  transitions through it (a transition from the \`NEXT\` target back to the deleted step is removed,
  it would become a self-loop), \`add_step\` without \`after\` / \`before\` appends to the end of the
  \`NEXT\` path, and inserting with \`after\` / \`before\` rewires \`NEXT\` by default.
- Flow order (lists, step numbers, the viewer) is the order of the states in flow.json, with the
  initial step first and final states last. \`add_step\` puts the new state where it belongs; to
  move a step, rewire its transitions with \`update_step\` and move its entry in flow.json.
- Conventional extra events: \`BACK\` (return to the previous step, for example when the input is
  incomplete), \`FAILED\` (checks or tests failed, back to the implementation step),
  \`CHANGES_REQUESTED\` (review asked for changes). Other events are allowed: UPPER_SNAKE_CASE, no
  whitespace, no \`*\`, not starting with \`xstate.\`.
- Give every non-\`NEXT\` transition a \`description\`: the \`{{> flow-context}}\` partial shows it to
  the agent as the condition for firing the event. Pass it in \`on\` of \`add_step\` / \`update_step\`:
  \`"on": { "FAILED": { "target": "implement", "description": "Tests failed" } }\`. In \`update_step\` a
  plain target string retargets an event and keeps its description, an object sets the target and
  the description (\`"description": ""\` removes it) and \`null\` removes the event. CLI:
  \`${cli} step transition <step> <EVENT> <target> --description <text>\`.
- Final states (\`{ "type": "final", "description": "..." }\`) have no skill, no directory and no
  transitions; reaching one completes the flow.
- Not supported: guards, actions, nested or parallel states, \`always\`, \`after\`, \`entry\`/\`exit\`,
  arrays of transitions.
- Describe the outcomes in the template ("fire \`FAILED\` with the list of failing tests"); the
  agent moves on with \`complete_step\` (\`step\`, \`event\`), \`transition\` or \`goto_step\`.

## 6. Variables

Declare variables in the \`vars\` object of flow.json:

\`\`\`json
"vars": {
  "testCommand": { "description": "Runs the test suite", "default": "npm test", "scope": "project" },
  "reviewer": { "description": "GitHub handle of your reviewer", "scope": "personal", "required": false }
}
\`\`\`

- \`project\` values are committed in \`.df/config.json\`; \`personal\` values live in the git-ignored
  \`.df/local.json\` (which is why rendered skills are git-ignored too).
- Precedence: \`default\` < \`.df/config.json\` < \`.df/local.json\` < environment \`DFL_VAR_<UPPER_SNAKE_NAME>\`.
- Set values with \`${cli} vars set <name> <value>\` (add \`--personal\` for personal ones), then sync.
- Use \`{{vars.testCommand}}\`, guard optional ones with \`{{#if vars.reviewer}}...{{/if}}\` or give a
  fallback with \`{{default vars.mainBranch "main"}}\`. Reuse existing variables (\`get_flow\` lists
  them) before adding new ones. Never put secrets in variables or templates.

## 7. Structure of a good step

1. A title line (\`# ...\`) and one paragraph with the goal of the step.
2. **Inputs**: what the step reads (files from earlier steps, the text the user typed after the
   command) and what to do when an input is missing (ask, or fire \`BACK\`).
3. **Procedure**: numbered, concrete actions with real commands (\`{{vars.testCommand}}\`).
4. **Outputs**: files, commits or reports the step produces and where they go.
5. **Exit criteria**: when the step is done, and which event to fire for which outcome.
6. **Pitfalls**: what not to do.
7. \`{{> flow-context}}\` as the last line.

Aim for 60 to 140 lines an agent can follow without guessing. Keep one responsibility per step.

## 8. Example

\`\`\`handlebars
# Review the change

Review the current branch of {{project.name}} before it is shipped, and decide whether it is
ready (\`NEXT\`) or needs more work (\`CHANGES_REQUESTED\`).

## Inputs

- The diff against \`{{default vars.mainBranch "main"}}\`.
- The acceptance criteria from the plan. If you cannot find them, ask the user.

## Procedure

1. Run \`git diff {{default vars.mainBranch "main"}}...HEAD\` and read every change.
2. Run \`{{vars.testCommand}}\` and note any failure.
3. Check each acceptance criterion and list the ones that are not met.
{{#if vars.reviewer}}
4. Ask {{vars.reviewer}} for a second review when the change touches public APIs.
{{/if}}

## Outputs

- A review summary: findings ordered by severity, with file and line.

## Exit criteria

- Fire \`NEXT\` when the tests pass and there are no blocking findings.
- Fire \`CHANGES_REQUESTED\` with the numbered list of blocking findings otherwise.

## Pitfalls

- Do not fix the findings yourself here; they go back to the implementation step.

{{> flow-context}}
\`\`\`

## 9. Workflow

1. \`get_flow\` for the steps, transitions and variables; \`get_step\` on a similar step to reuse
   its structure and tone.
2. Write the template, then create or change the step with \`add_step\` / \`update_step\`
   (\`template\`, \`title\`, \`description\`, \`on\`). dfl validates, writes and re-installs the skills.
3. Check the result: \`get_step\` returns the rendered SKILL.md; \`validate_flow\` lists problems.
4. Tell the user to commit \`.df/<flow>\` so the team gets the change.
`;
}

/** The guide for a project that runs dfl as `dfl` (kept for existing imports). */
export const AUTHORING_GUIDE = authoringGuide('dfl');
