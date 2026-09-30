/**
 * Handlebars rendering of step and built-in skills (OWNER: render agent). See docs/ARCHITECTURE.md §3.
 */
import type Handlebars from 'handlebars';
import type { FlowModel, ProjectPaths, RenderedSkill, StepInfo, TemplateContext } from './types.js';

export type HandlebarsEnv = typeof Handlebars;

/**
 * Isolated Handlebars environment (`Handlebars.create()`) with dfl helpers and partials:
 * built-in partials from `<pkg>/templates/partials/*.hbs`, then each dir in `partialsDirs`
 * (later dirs override earlier ones; partial name = file name without `.hbs`).
 */
export function createHandlebars(options?: { partialsDirs?: string[] | undefined }): HandlebarsEnv {
  throw new Error('not implemented');
}

/** Builds the template context for a flow (and optionally one step of it). */
export function buildTemplateContext(
  paths: ProjectPaths,
  model: FlowModel | undefined,
  vars: Record<string, unknown>,
  step?: StepInfo,
): TemplateContext {
  throw new Error('not implemented');
}

/** Renders one template (`noEscape: true`). Errors are rethrown as DflError naming `filename`. */
export function renderTemplate(hb: HandlebarsEnv, source: string, context: TemplateContext, filename: string): string {
  throw new Error('not implemented');
}

/**
 * Normalizes SKILL.md frontmatter: parses an optional leading YAML block, forces `name`,
 * sets `description` when missing (truncated to 1024 chars, newlines collapsed), merges `metadata`
 * (string map) and re-serializes with `yaml`. Returns `---\n<yaml>---\n\n<body>`.
 */
export function normalizeSkillMarkdown(
  rendered: string,
  meta: { name: string; description: string; metadata?: Record<string, string> | undefined },
): string {
  throw new Error('not implemented');
}

/**
 * Renders every `steps/<id>/**\/*.md.hbs` of the flow's non-final steps to the sibling `.md` file
 * inside `.df/` (stale rendered `.md` files without a template are deleted) and returns one
 * RenderedSkill per non-final step (rendered `.md` content + static non-`.hbs` files as sourcePath).
 * A step without SKILL.md.hbs gets a generated SKILL.md from defaultStepTemplate().
 */
export function renderFlowSkills(paths: ProjectPaths, model: FlowModel, vars: Record<string, unknown>): RenderedSkill[] {
  throw new Error('not implemented');
}

/**
 * Renders the built-in skills from `<pkg>/templates/skills/<name>/` in memory (never written into `.df`).
 * `model` is the active flow (may be undefined when the project has no flow yet).
 */
export function renderBuiltinSkills(
  paths: ProjectPaths,
  model: FlowModel | undefined,
  vars: Record<string, unknown>,
): RenderedSkill[] {
  throw new Error('not implemented');
}

/** Names of the built-in skills shipped with the package (directory names under templates/skills). */
export function builtinSkillNames(): string[] {
  throw new Error('not implemented');
}
