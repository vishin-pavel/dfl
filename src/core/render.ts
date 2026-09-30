/**
 * Handlebars rendering of step and built-in skills (OWNER: render agent). See docs/ARCHITECTURE.md §3.
 */
import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { DflError, errorMessage } from './errors.js';
import { SKILL_TEMPLATE_FILE, defaultStepTemplate, skillNameFor, skillSteps } from './flow.js';
import { exists, listDirs, readText, relPosix, removeEmptyDirsUpTo, removePath, walkFiles, writeText } from './fsx.js';
import { titleCase, toId } from './ids.js';
import { builtinPartialsDir, builtinSkillsDir, packageRoot, packageVersion } from './paths.js';
import type {
  FlowModel,
  FlowTransition,
  ProjectPaths,
  RenderedFile,
  RenderedSkill,
  StepContext,
  StepInfo,
  StepRef,
  TemplateContext,
} from './types.js';

export type HandlebarsEnv = typeof Handlebars;

/** Template file suffix; `X.md.hbs` renders to `X.md`. */
const TEMPLATE_SUFFIX = '.md.hbs';
const SKILL_FILE = 'SKILL.md';
/** Agent Skills limit for the frontmatter `description`. */
export const MAX_DESCRIPTION_LENGTH = 1024;
/** `strict: true` throws on missing optional vars, so templates are compiled non-strict. */
const COMPILE_OPTIONS = { noEscape: true, strict: false } as const;
/** Files never copied from step / built-in skill dirs. */
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/** A StepRef plus a description for templates: the transition's, else (next refs only) the target step's. */
export interface StepRefContext extends StepRef {
  description: string;
}

// ---------------------------------------------------------------------------
// Handlebars environment
// ---------------------------------------------------------------------------

/**
 * Isolated Handlebars environment (`Handlebars.create()`) with dfl helpers and partials:
 * built-in partials from `<pkg>/templates/partials/*.hbs`, then each dir in `partialsDirs`
 * (later dirs override earlier ones; partial name = file name without `.hbs`).
 */
export function createHandlebars(options?: { partialsDirs?: string[] | undefined }): HandlebarsEnv {
  const hb = Handlebars.create();
  registerHelpers(hb);
  for (const dir of [builtinPartialsDir(), ...(options?.partialsDirs ?? [])]) registerPartialsFrom(hb, dir);
  return hb;
}

/** Registers every `**\/*.hbs` under `dir` as a partial named by its relative path without `.hbs`. */
function registerPartialsFrom(hb: HandlebarsEnv, dir: string): void {
  for (const rel of walkFiles(dir)) {
    if (!rel.endsWith('.hbs')) continue;
    const file = path.join(dir, ...rel.split('/'));
    const compiled = hb.compile(readText(file), COMPILE_OPTIONS);
    // Compiled lazily: parse errors surface on first use and are attributed to the partial's file.
    hb.registerPartial(rel.slice(0, -'.hbs'.length), (context: unknown, runtimeOptions?: Handlebars.RuntimeOptions) => {
      try {
        return compiled(context, runtimeOptions);
      } catch (error) {
        throw tagTemplateFile(error, file);
      }
    });
  }
}

type HelperArgs = unknown[];

/** Handlebars always passes the options object last; the rest are positional arguments. */
function helperArgs(args: HelperArgs): { values: unknown[]; options: Handlebars.HelperOptions | undefined } {
  return { values: args.slice(0, -1), options: args[args.length - 1] as Handlebars.HelperOptions | undefined };
}

/** Truthiness as templates expect it: empty arrays are false. */
function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function toText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * A logic helper usable inline (`{{#if (eq a b)}}`) and as a block (`{{#eq a b}}…{{else}}…{{/eq}}`).
 */
function logicHelper(test: (values: unknown[]) => boolean): Handlebars.HelperDelegate {
  return function (this: unknown, ...args: HelperArgs) {
    const { values, options } = helperArgs(args);
    const result = test(values);
    if (options && typeof options.fn === 'function') return result ? options.fn(this) : options.inverse(this);
    return result;
  };
}

/**
 * A value helper. Handlebars resolves a bare `{{title}}` to the helper before the context property,
 * so a call without arguments falls back to the property of the same name (`{{#each step.next}}{{title}}`).
 */
function valueHelper(name: string, fn: (...values: unknown[]) => unknown): Handlebars.HelperDelegate {
  return function (this: unknown, ...args: HelperArgs) {
    const { values } = helperArgs(args);
    if (values.length === 0) return isPlainObject(this) ? this[name] : undefined;
    return fn(...values);
  };
}

function registerHelpers(hb: HandlebarsEnv): void {
  const eq = (values: unknown[]): boolean => values.length > 0 && values.every((value) => value === values[0]);
  hb.registerHelper('eq', logicHelper(eq));
  hb.registerHelper('ne', logicHelper((values) => !eq(values)));
  hb.registerHelper('and', logicHelper((values) => values.length > 0 && values.every(truthy)));
  hb.registerHelper('or', logicHelper((values) => values.some(truthy)));
  hb.registerHelper('not', logicHelper((values) => !values.some(truthy)));

  const helpers: Record<string, (...values: unknown[]) => unknown> = {
    default: (value, fallback) => (value === undefined || value === null || value === '' ? fallback : value),
    upper: (value) => toText(value).toUpperCase(),
    lower: (value) => toText(value).toLowerCase(),
    kebab: (value) => toId(toText(value)),
    title: (value) => titleCase(toText(value)),
    json: (value, spaces) => JSON.stringify(value ?? null, null, typeof spaces === 'number' ? spaces : 2),
    join: (list, sep) => (Array.isArray(list) ? list.map(toText).join(typeof sep === 'string' ? sep : ', ') : toText(list)),
    command: (skillName) => `/${toText(skillName)}`,
  };
  for (const [name, fn] of Object.entries(helpers)) hb.registerHelper(name, valueHelper(name, fn));

  // `{{indent 2 text}}` or block form `{{#indent 2}}…{{/indent}}`; blank lines are left unpadded.
  hb.registerHelper('indent', function (this: unknown, ...args: HelperArgs) {
    const { values, options } = helperArgs(args);
    const [count, text] = values;
    const body = values.length >= 2 ? toText(text) : typeof options?.fn === 'function' ? options.fn(this) : '';
    const pad = ' '.repeat(Math.max(0, Math.floor(Number(count)) || 0));
    return body
      .split('\n')
      .map((line) => (line.trim() === '' ? line : pad + line))
      .join('\n');
  });
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * How the CLI is invoked in instructions: `npx dfl` when the running package is installed inside
 * `<root>/node_modules` (a project-local dependency), otherwise `dfl`.
 */
export function dflCliCommand(root: string, pkgRoot: string = packageRoot()): string {
  const rel = path.relative(path.join(realpath(root), 'node_modules'), realpath(pkgRoot));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? 'npx dfl' : 'dfl';
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Builds the template context for a flow (and optionally one step of it). */
export function buildTemplateContext(
  paths: ProjectPaths,
  model: FlowModel | undefined,
  vars: Record<string, unknown>,
  step?: StepInfo,
): TemplateContext {
  const nonFinal = model ? skillSteps(model) : [];
  const numbers = new Map(nonFinal.map((s, i) => [s.id, i + 1]));

  // Next refs fall back to the target step's description, prev refs only use the transition's.
  const ref = (t: FlowTransition, direction: 'next' | 'prev'): StepRefContext => {
    const id = direction === 'next' ? t.target : t.source;
    const other = model?.byId.get(id);
    return {
      event: t.event,
      id,
      skillName: other?.skillName ?? (model ? skillNameFor(model.def, id) : id),
      title: other?.title ?? titleCase(id),
      final: other?.final ?? false,
      description: t.description ?? (direction === 'next' ? (other?.description ?? '') : ''),
    };
  };
  const toStepContext = (s: StepInfo): StepContext => ({
    id: s.id,
    skillName: s.skillName,
    title: s.title,
    description: s.description,
    index: s.index,
    number: numbers.get(s.id) ?? 0,
    final: s.final,
    next: s.transitions.map((t) => ref(t, 'next')),
    prev: s.incoming.map((t) => ref(t, 'prev')),
  });

  return {
    project: { name: path.basename(paths.root), root: paths.root },
    flow: model
      ? {
          name: model.name,
          title: model.title,
          description: model.description,
          skillPrefix: model.def.skillPrefix ?? '',
          initial: model.initial,
          steps: nonFinal.map(toStepContext),
          stepCount: nonFinal.length,
        }
      : { name: '', title: '', description: '', skillPrefix: '', initial: '', steps: [], stepCount: 0 },
    step: step ? toStepContext(step) : undefined,
    vars,
    env: { ...process.env },
    dfl: { version: packageVersion(), mcpServer: 'dfl', cli: dflCliCommand(paths.root) },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const TEMPLATE_FILE = Symbol('dfl.templateFile');

/** Remembers the innermost template file an error came from (partials are rendered inside templates). */
function tagTemplateFile(error: unknown, file: string): unknown {
  if (typeof error === 'object' && error !== null && !(TEMPLATE_FILE in error)) {
    Object.defineProperty(error, TEMPLATE_FILE, { value: file });
  }
  return error;
}

function templateErrorLine(error: unknown): number | undefined {
  const lineNumber = (error as { lineNumber?: unknown } | null)?.lineNumber;
  if (typeof lineNumber === 'number') return lineNumber;
  const match = /\bon line (\d+)/.exec(errorMessage(error));
  return match ? Number(match[1]) : undefined;
}

/** Renders one template (`noEscape: true`). Errors are rethrown as DflError naming `filename`. */
export function renderTemplate(hb: HandlebarsEnv, source: string, context: TemplateContext, filename: string): string {
  try {
    return hb.compile(source, COMPILE_OPTIONS)(context);
  } catch (error) {
    if (error instanceof DflError) throw error;
    const tagged = (error as { [TEMPLATE_FILE]?: string } | null)?.[TEMPLATE_FILE];
    const file = tagged ? `${filename} (in partial ${tagged})` : filename;
    const line = templateErrorLine(error);
    throw new DflError(`Cannot render ${file}${line === undefined ? '' : `, line ${line}`}: ${errorMessage(error)}`, {
      hint: 'Fix the Handlebars syntax in the template, then run `dfl flow-update`.',
      code: 'RENDER_ERROR',
      cause: error,
    });
  }
}

const FRONTMATTER_RE = /^(?:[ \t]*\r?\n)*---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Collapses whitespace and truncates to MAX_DESCRIPTION_LENGTH characters (code points). */
function cleanDescription(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(collapsed);
  if (chars.length <= MAX_DESCRIPTION_LENGTH) return collapsed;
  return `${chars.slice(0, MAX_DESCRIPTION_LENGTH - 1).join('').trimEnd()}…`;
}

function stringifyMetadataValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** normalizeSkillMarkdown plus the resulting frontmatter description. */
function normalizeSkill(
  rendered: string,
  meta: { name: string; description: string; metadata?: Record<string, string> | undefined },
  source?: string,
): { text: string; description: string } {
  const label = source ?? `SKILL.md of "${meta.name}"`;
  const input = rendered.replace(/^﻿/, '');
  const match = FRONTMATTER_RE.exec(input);
  let data: Record<string, unknown> = {};
  if (match) {
    let parsed: unknown;
    try {
      parsed = parseYaml(match[1] ?? '');
    } catch (error) {
      throw new DflError(`Invalid YAML frontmatter in ${label}: ${errorMessage(error)}`, {
        hint: 'Fix the block between the leading `---` lines (or remove it; dfl generates name and description).',
        code: 'INVALID_FRONTMATTER',
        cause: error,
      });
    }
    if (parsed !== null && parsed !== undefined && !isPlainObject(parsed)) {
      throw new DflError(`Invalid YAML frontmatter in ${label}: expected a mapping of keys to values.`, {
        code: 'INVALID_FRONTMATTER',
      });
    }
    data = parsed ?? {};
  }
  const body = match ? input.slice(match[0].length) : input;

  const current = data['description'];
  const rawDescription =
    current === undefined || current === null || String(current).trim() === '' ? meta.description : String(current);
  const description = cleanDescription(rawDescription) || meta.name;

  const metadataValue = data['metadata'];
  if (metadataValue !== undefined && metadataValue !== null && !isPlainObject(metadataValue)) {
    throw new DflError(`Invalid YAML frontmatter in ${label}: "metadata" must be a mapping of strings.`, {
      code: 'INVALID_FRONTMATTER',
    });
  }
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadataValue ?? {})) {
    if (value !== undefined && value !== null) metadata[key] = stringifyMetadataValue(value);
  }
  Object.assign(metadata, meta.metadata ?? {});

  const out: Record<string, unknown> = { name: meta.name, description };
  for (const [key, value] of Object.entries(data)) {
    if (key === 'name' || key === 'description') continue;
    if (key === 'metadata') {
      if (Object.keys(metadata).length > 0) out['metadata'] = metadata;
      continue;
    }
    out[key] = value;
  }
  if (!('metadata' in out) && Object.keys(metadata).length > 0) out['metadata'] = metadata;

  const content = body.trim();
  const text = `---\n${stringifyYaml(out, { lineWidth: 0 })}---\n${content ? `\n${content}\n` : ''}`;
  return { text, description };
}

/**
 * Normalizes SKILL.md frontmatter: parses an optional leading YAML block, forces `name`,
 * sets `description` when missing (truncated to 1024 chars, newlines collapsed), merges `metadata`
 * (string map) and re-serializes with `yaml`. Returns `---\n<yaml>---\n\n<body>`.
 * `source` (optional) names the file in error messages.
 */
export function normalizeSkillMarkdown(
  rendered: string,
  meta: { name: string; description: string; metadata?: Record<string, string> | undefined },
  source?: string,
): string {
  return normalizeSkill(rendered, meta, source).text;
}

/** Orders files with SKILL.md first, then by path. */
function sortFiles(files: RenderedFile[]): RenderedFile[] {
  return files.sort((a, b) =>
    a.path === SKILL_FILE ? -1 : b.path === SKILL_FILE ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

function isIgnoredFile(rel: string): boolean {
  return IGNORED_FILES.has(rel.slice(rel.lastIndexOf('/') + 1));
}

/**
 * Renders every `steps/<id>/**\/*.md.hbs` of the flow's non-final steps to the sibling `.md` file
 * inside `.df/` (stale rendered `.md` files without a template are deleted) and returns one
 * RenderedSkill per non-final step (rendered `.md` content + static non-`.hbs` files as sourcePath).
 * A step without SKILL.md.hbs gets a generated SKILL.md from defaultStepTemplate().
 */
export function renderFlowSkills(paths: ProjectPaths, model: FlowModel, vars: Record<string, unknown>): RenderedSkill[] {
  const hb = createHandlebars({ partialsDirs: [path.join(model.dir, 'partials')] });
  const skills: RenderedSkill[] = [];
  for (const step of skillSteps(model)) {
    const context = buildTemplateContext(paths, model, vars, step);
    const all = walkFiles(step.dir);
    const templates = all.filter((rel) => rel.endsWith(TEMPLATE_SUFFIX));
    const sources: Array<{ out: string; label: string; read: () => string }> = templates.map((rel) => {
      const file = path.join(step.dir, ...rel.split('/'));
      return { out: rel.slice(0, -'.hbs'.length), label: relPosix(paths.root, file), read: () => readText(file) };
    });
    if (!templates.includes(SKILL_TEMPLATE_FILE)) {
      sources.unshift({
        out: SKILL_FILE,
        label: `default template of step "${step.id}"`,
        read: () => defaultStepTemplate({ title: step.title, description: step.description }),
      });
    }

    const files: RenderedFile[] = [];
    let description = '';
    for (const { out, label, read } of sources) {
      let content = renderTemplate(hb, read(), context, label);
      if (out === SKILL_FILE) {
        const normalized = normalizeSkill(
          content,
          {
            name: step.skillName,
            description: step.description || step.title,
            metadata: { 'dfl-flow': model.name, 'dfl-step': step.id },
          },
          label,
        );
        content = normalized.text;
        description = normalized.description;
      }
      writeText(path.join(step.dir, ...out.split('/')), content);
      files.push({ path: out, content });
    }

    const outputs = new Set(sources.map((s) => s.out));
    for (const rel of all) {
      if (rel.endsWith('.hbs') || outputs.has(rel)) continue;
      const abs = path.join(step.dir, ...rel.split('/'));
      if (rel.endsWith('.md')) {
        // Every .md under steps/ is generated; this one has no template anymore.
        removePath(abs);
        removeEmptyDirsUpTo(path.dirname(abs), step.dir);
        continue;
      }
      if (!isIgnoredFile(rel)) files.push({ path: rel, sourcePath: abs });
    }

    skills.push({ name: step.skillName, kind: 'step', stepId: step.id, description, files: sortFiles(files) });
  }
  return skills;
}

/**
 * Renders the built-in skills from `<pkg>/templates/skills/<name>/` in memory (never written into `.df`).
 * `model` is the active flow (may be undefined when the project has no flow yet).
 * `options.dir` replaces the built-in skills directory (tests).
 */
export function renderBuiltinSkills(
  paths: ProjectPaths,
  model: FlowModel | undefined,
  vars: Record<string, unknown>,
  options?: { dir?: string | undefined },
): RenderedSkill[] {
  const root = options?.dir ?? builtinSkillsDir();
  const names = builtinSkillNames(root);
  if (names.length === 0) return [];
  const hb = createHandlebars();
  const context = buildTemplateContext(paths, model, vars);
  return names.map((name) => {
    const dir = path.join(root, name);
    const all = walkFiles(dir);
    const templates = all.filter((rel) => rel.endsWith(TEMPLATE_SUFFIX));
    const outputs = new Set(templates.map((rel) => rel.slice(0, -'.hbs'.length)));
    const files: RenderedFile[] = [];
    let description = '';
    for (const rel of templates) {
      const file = path.join(dir, ...rel.split('/'));
      const out = rel.slice(0, -'.hbs'.length);
      let content = renderTemplate(hb, readText(file), context, file);
      if (out === SKILL_FILE) {
        const normalized = normalizeSkill(
          content,
          { name, description: titleCase(name), metadata: { 'dfl-builtin': 'true' } },
          file,
        );
        content = normalized.text;
        description = normalized.description;
      }
      files.push({ path: out, content });
    }
    for (const rel of all) {
      if (rel.endsWith('.hbs') || outputs.has(rel) || isIgnoredFile(rel)) continue;
      files.push({ path: rel, sourcePath: path.join(dir, ...rel.split('/')) });
    }
    return { name, kind: 'builtin', description, files: sortFiles(files) };
  });
}

/**
 * Names of the built-in skills shipped with the package (directory names under templates/skills
 * that contain a SKILL.md.hbs). `dir` replaces the built-in skills directory (tests).
 */
export function builtinSkillNames(dir: string = builtinSkillsDir()): string[] {
  return listDirs(dir).filter((name) => exists(path.join(dir, name, SKILL_TEMPLATE_FILE)));
}
