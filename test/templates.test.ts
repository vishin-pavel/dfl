import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { afterEach, describe, expect, it } from 'vitest';
import { createActor, createMachine } from 'xstate';
import { parse as parseYaml } from 'yaml';
import {
  NEXT_EVENT,
  SKILL_TEMPLATE_FILE,
  buildFlowModel,
  createFlow,
  listFlowTemplates,
  loadFlow,
  orderStates,
  parseFlowDefinition,
} from '../src/core/flow.js';
import { listDirs, readJson, walkFiles } from '../src/core/fsx.js';
import { isValidId, titleCase, toId } from '../src/core/ids.js';
import { builtinSkillsDir, flowTemplatesDir } from '../src/core/paths.js';
import { renderBuiltinSkills, renderFlowSkills } from '../src/core/render.js';
import { validateFlow } from '../src/core/validate.js';
import { resolveVars } from '../src/core/vars.js';
import type { FlowDefinition, FlowModel, StepContext, StepInfo, TemplateContext } from '../src/core/types.js';
import { cleanupTempDirs, makeTempProject } from './helpers/project.js';

afterEach(cleanupTempDirs);

/** Helper names the dfl renderer registers (docs/ARCHITECTURE.md §3). */
const HELPER_NAMES = ['eq', 'ne', 'and', 'or', 'not', 'default', 'upper', 'lower', 'kebab', 'title', 'json', 'join', 'indent', 'command'];
const PARTIAL_MARKER = '<!-- flow-context partial -->';
const STEP_FRONTMATTER_KEYS = new Set(['allowed-tools', 'license']);
const BUILTIN_FRONTMATTER_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/** Tokens that agents expand when a skill runs as a slash command. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['$ARGUMENTS', /\$ARGUMENTS/],
  ['$<digit>', /\$[0-9]/],
  ['!` (shell injection)', /!`/],
  ['@mention', /(^|\s)@[A-Za-z]/],
];

/** Expected NEXT chain of every shipped flow (initial → final). */
const EXPECTED_FLOWS: Record<string, { title: string; chain: string[] }> = {
  feature: {
    title: 'Feature development',
    chain: ['spec-feature', 'plan-feature', 'implement-feature', 'verify-feature', 'review-feature', 'ship-feature', 'done'],
  },
  bugfix: { title: 'Bug fix', chain: ['reproduce-bug', 'diagnose-bug', 'fix-bug', 'verify-fix', 'ship-fix', 'done'] },
  quick: { title: 'Quick change', chain: ['plan-change', 'make-change', 'check-change', 'done'] },
};

const BUILTIN_SKILLS = ['add-flow-step', 'delete-flow-step', 'edit-flow-step'];

// ---------------------------------------------------------------------------
// Test doubles for the renderer (the real one lives in src/core/render.ts)
// ---------------------------------------------------------------------------

function testHandlebars(): typeof Handlebars {
  const hb = Handlebars.create();
  hb.registerPartial('flow-context', PARTIAL_MARKER);
  const variadic = (fn: (values: unknown[]) => unknown) => (...args: unknown[]) => fn(args.slice(0, -1));
  hb.registerHelper({
    eq: (a: unknown, b: unknown) => a === b,
    ne: (a: unknown, b: unknown) => a !== b,
    and: variadic((values) => values.every(Boolean)),
    or: variadic((values) => values.some(Boolean)),
    not: (value: unknown) => !value,
    default: (value: unknown, fallback: unknown) => (value === undefined || value === null || value === '' ? fallback : value),
    upper: (value: unknown) => String(value ?? '').toUpperCase(),
    lower: (value: unknown) => String(value ?? '').toLowerCase(),
    kebab: (value: unknown) => toId(String(value ?? '')),
    title: (value: unknown) => titleCase(String(value ?? '')),
    json: (value: unknown) => JSON.stringify(value),
    join: (items: unknown, sep: unknown) => (Array.isArray(items) ? items.join(typeof sep === 'string' ? sep : ', ') : ''),
    indent: (n: unknown, text: unknown) => String(text ?? '').replace(/^(?=.)/gm, ' '.repeat(Number(n) || 0)),
    command: (name: unknown) => `/${String(name)}`,
  });
  expect(Object.keys(hb.helpers)).toEqual(expect.arrayContaining(HELPER_NAMES));
  return hb;
}

/** Static compile: syntax errors and helpers outside the dfl set fail here. */
function precompile(source: string): void {
  const hb = testHandlebars();
  const knownHelpers = Object.fromEntries(HELPER_NAMES.map((name) => [name, true]));
  hb.precompile(source, { knownHelpers, knownHelpersOnly: true, noEscape: true });
}

/** Strict render: an unguarded reference to a missing field (a typo, an unset var) throws. */
function render(source: string, context: TemplateContext): string {
  return testHandlebars().compile(source, { noEscape: true, strict: true })(context);
}

function stepContext(model: FlowModel, step: StepInfo): StepContext {
  const ref = (event: string, id: string) => {
    const target = model.byId.get(id)!;
    return { event, id, skillName: target.skillName, title: target.title, final: target.final };
  };
  const skillSteps = model.steps.filter((s) => !s.final);
  return {
    id: step.id,
    skillName: step.skillName,
    title: step.title,
    description: step.description,
    index: step.index,
    number: skillSteps.indexOf(step) + 1,
    final: step.final,
    next: step.transitions.map((t) => ref(t.event, t.target)),
    prev: step.incoming.map((t) => ref(t.event, t.source)),
  };
}

function templateContext(model: FlowModel | undefined, vars: Record<string, unknown>, step?: StepInfo): TemplateContext {
  const steps = model ? model.steps.filter((s) => !s.final).map((s) => stepContext(model, s)) : [];
  return {
    project: { name: 'demo', root: '/work/demo' },
    flow: {
      name: model?.name ?? '',
      title: model?.title ?? '',
      description: model?.description ?? '',
      skillPrefix: model?.def.skillPrefix ?? '',
      initial: model?.initial ?? '',
      steps,
      stepCount: steps.length,
    },
    step: model && step ? stepContext(model, step) : undefined,
    vars,
    env: {},
    dfl: { version: '0.0.0-test', mcpServer: 'dfl', cli: 'dfl' },
  };
}

/** Var values as a fresh install sees them: declared defaults only. */
function defaultVars(def: FlowDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(def.vars ?? {})) if (v.default !== undefined) out[name] = v.default;
  return out;
}

/** Every declared var with a value, personal ones customised. */
function personalVars(def: FlowDefinition): Record<string, unknown> {
  const out = defaultVars(def);
  for (const [name, v] of Object.entries(def.vars ?? {})) {
    if (v.scope === 'personal') out[name] = name === 'reviewer' ? 'octocat' : 'pv/';
    else out[name] ??= `<${name}>`;
  }
  return out;
}

function expectNoForbiddenTokens(text: string, file: string): void {
  for (const [label, re] of FORBIDDEN) {
    const match = re.exec(text);
    expect(match, `${file} contains forbidden token ${label}: ${JSON.stringify(match?.[0])}`).toBeNull();
  }
}

// ---------------------------------------------------------------------------
// Flow templates
// ---------------------------------------------------------------------------

const flowNames = listDirs(flowTemplatesDir());

function loadTemplate(name: string): { dir: string; def: FlowDefinition; model: FlowModel } {
  const dir = path.join(flowTemplatesDir(), name);
  const def = parseFlowDefinition(readJson(path.join(dir, 'flow.json')), path.join(dir, 'flow.json'));
  return { dir, def, model: buildFlowModel(def, dir) };
}

describe('flow templates', () => {
  it('ships exactly the expected flows', () => {
    expect(flowNames).toEqual(Object.keys(EXPECTED_FLOWS).sort());
    expect(listFlowTemplates().map((t) => [t.name, t.title, t.steps])).toEqual([
      ['bugfix', 'Bug fix', 5],
      ['feature', 'Feature development', 6],
      ['quick', 'Quick change', 3],
    ]);
  });

  describe.each(flowNames)('%s', (name) => {
    const { dir, def, model } = loadTemplate(name);
    const expected = EXPECTED_FLOWS[name]!;
    const states = def.machine.states;
    const skillSteps = model.steps.filter((s) => !s.final);

    it('has a valid definition whose name matches the directory', () => {
      expect(def.name).toBe(name);
      expect(def.machine.id).toBe(name);
      expect(def.title).toBe(expected.title);
      expect(def.description).toBeTruthy();
      expect(def.skillPrefix ?? '').toBe('');
      for (const id of Object.keys(states)) expect(isValidId(id), id).toBe(true);
      expect(() => createMachine(def.machine as never)).not.toThrow();
    });

    it('declares states in flow order and follows the expected NEXT chain', () => {
      expect(orderStates(def.machine)).toEqual(Object.keys(states));
      const chain = [def.machine.initial];
      for (let id = def.machine.initial; states[id]?.type !== 'final'; ) {
        id = model.byId.get(id)!.transitions.find((t) => t.event === NEXT_EVENT)!.target;
        chain.push(id);
      }
      expect(chain).toEqual(expected.chain);
    });

    it('has well-formed states and transitions', () => {
      const finals = model.steps.filter((s) => s.final);
      expect(finals.map((s) => s.id)).toEqual(['done']);
      for (const step of skillSteps) {
        expect(step.description.length, step.id).toBeLessThanOrEqual(200);
        expect(step.description, step.id).toMatch(/^[A-Z][a-z]+ .*\bUse\b.*\.$/);
        expect(states[step.id]!.meta?.title, step.id).toMatch(/^.{1,24}$/);
        expect(step.transitions.filter((t) => t.event === NEXT_EVENT), step.id).toHaveLength(1);
        for (const t of step.transitions) {
          expect(model.byId.has(t.target), `${step.id} --${t.event}--> ${t.target}`).toBe(true);
          expect(t.event).toMatch(/^[A-Z][A-Z0-9_]*$/);
          if (t.event !== NEXT_EVENT) expect(t.description, `${step.id} ${t.event}`).toBeTruthy();
        }
      }
    });

    it('runs from the initial step to done under xstate', () => {
      const actor = createActor(createMachine(def.machine as never)).start();
      const visited = [String(actor.getSnapshot().value)];
      while (actor.getSnapshot().status !== 'done') {
        actor.send({ type: NEXT_EVENT });
        visited.push(String(actor.getSnapshot().value));
      }
      expect(visited).toEqual(expected.chain);
      // Every non-NEXT event is routable from its source state.
      for (const t of model.transitions.filter((tr) => tr.event !== NEXT_EVENT)) {
        const probe = createActor(createMachine({ ...def.machine, initial: t.source } as never)).start();
        probe.send({ type: t.event });
        expect(probe.getSnapshot().value).toBe(t.target);
      }
    });

    it('has one step directory with a SKILL.md.hbs per non-final state and nothing else', () => {
      expect(listDirs(path.join(dir, 'steps'))).toEqual(skillSteps.map((s) => s.id).sort());
      for (const step of skillSteps) {
        expect(walkFiles(path.join(dir, 'steps', step.id)), step.id).toEqual([SKILL_TEMPLATE_FILE]);
      }
      expect(walkFiles(dir).filter((f) => !f.startsWith('steps/'))).toEqual(['flow.json']);
    });

    it('declares every var it uses and uses every var it declares', () => {
      const declared = Object.keys(def.vars ?? {}).sort();
      const used = new Set<string>();
      for (const step of skillSteps) {
        const source = fs.readFileSync(path.join(dir, 'steps', step.id, SKILL_TEMPLATE_FILE), 'utf8');
        for (const match of source.matchAll(/\bvars\.([A-Za-z_]\w*)/g)) used.add(match[1]!);
      }
      expect([...used].sort()).toEqual(declared);
      for (const [varName, v] of Object.entries(def.vars ?? {})) {
        expect(v.description, varName).toBeTruthy();
        expect(v.scope, varName).toMatch(/^(project|personal)$/);
        if (v.required !== false) expect(v.default, `${varName} needs a default or required: false`).toBeDefined();
      }
    });

    describe.each(skillSteps.map((s) => s.id))('step %s', (stepId) => {
      const file = path.join(dir, 'steps', stepId, SKILL_TEMPLATE_FILE);
      const source = fs.readFileSync(file, 'utf8');
      const step = model.byId.get(stepId)!;

      it('is a body-only template of the right size ending with the flow-context partial', () => {
        const frontmatter = FRONTMATTER_RE.exec(source);
        if (frontmatter) {
          const data = parseYaml(frontmatter[1]!) as Record<string, unknown>;
          for (const key of Object.keys(data)) expect(STEP_FRONTMATTER_KEYS.has(key), `frontmatter key ${key}`).toBe(true);
        }
        expect(source.trimEnd().endsWith('{{> flow-context}}')).toBe(true);
        const lines = source.trimEnd().split('\n').length;
        expect(lines).toBeGreaterThanOrEqual(60);
        expect(lines).toBeLessThanOrEqual(140);
        expectNoForbiddenTokens(source, file);
        expect(() => precompile(source)).not.toThrow();
      });

      it.each([
        ['default vars', defaultVars(def)],
        ['personal vars', personalVars(def)],
      ])('renders with %s', (_label, vars) => {
        const out = render(source, templateContext(model, vars, step));
        expect(out.startsWith('# '), 'rendered skill starts with its heading').toBe(true);
        expect(out.trimEnd().endsWith(PARTIAL_MARKER)).toBe(true);
        expect(out).not.toMatch(/\{\{|\}\}/);
        expect(out).not.toMatch(/\n{3,}/);
        expectNoForbiddenTokens(out, `${file} (rendered)`);
        if (source.includes('--reviewer {{vars.reviewer}}')) {
          if (vars['reviewer']) expect(out).toContain('--reviewer octocat');
          else expect(out).not.toContain('--reviewer');
        }
      });
    });
  });

  it('can be copied into a project with createFlow', () => {
    const paths = makeTempProject();
    for (const name of flowNames) {
      const model = createFlow(paths, `my-${name}`, { from: name });
      expect(model.def.source).toEqual({ type: 'template', ref: name });
      const loaded = loadFlow(paths, `my-${name}`);
      expect(loaded.steps.map((s) => s.id)).toEqual(EXPECTED_FLOWS[name]!.chain);
      for (const step of loaded.steps.filter((s) => !s.final)) {
        expect(fs.existsSync(path.join(paths.stepDir(`my-${name}`, step.id), SKILL_TEMPLATE_FILE))).toBe(true);
      }
    }
  });

  it.each(flowNames)('%s validates and renders with the real renderer', (name) => {
    const paths = makeTempProject();
    const model = createFlow(paths, name, { from: name });
    expect(validateFlow(paths, name)).toEqual([]);
    const resolved = resolveVars(paths, model.def, {});
    expect(resolved.missing).toEqual([]);
    const skills = renderFlowSkills(paths, model, resolved.values);
    expect(skills.map((s) => s.name)).toEqual(model.steps.filter((s) => !s.final).map((s) => s.id));
    for (const skill of skills) {
      const content = skill.files.find((f) => f.path === 'SKILL.md')?.content ?? '';
      const frontmatter = parseYaml(FRONTMATTER_RE.exec(content)![1]!) as Record<string, unknown>;
      expect(frontmatter['name']).toBe(skill.name);
      expect(frontmatter['description']).toBe(model.byId.get(skill.name)!.description);
      expect(content).toContain('## Flow context');
      expect(content).not.toMatch(/\{\{|\}\}/);
      expectNoForbiddenTokens(content, `${name}/${skill.name}/SKILL.md (rendered)`);
    }
  });
});

// ---------------------------------------------------------------------------
// Built-in skills
// ---------------------------------------------------------------------------

describe('built-in skills', () => {
  const names = listDirs(builtinSkillsDir());
  const feature = loadTemplate('feature');

  it('ships the step management skills without clashing with flow steps', () => {
    expect(names).toEqual(BUILTIN_SKILLS);
    const stepIds = flowNames.flatMap((name) => Object.keys(loadTemplate(name).def.machine.states));
    for (const name of names) expect(stepIds).not.toContain(name);
  });

  describe.each(names)('%s', (name) => {
    const file = path.join(builtinSkillsDir(), name, SKILL_TEMPLATE_FILE);
    const source = fs.readFileSync(file, 'utf8');

    it('has only a SKILL.md.hbs', () => {
      expect(walkFiles(path.join(builtinSkillsDir(), name))).toEqual([SKILL_TEMPLATE_FILE]);
    });

    it('has valid static frontmatter', () => {
      const match = FRONTMATTER_RE.exec(source);
      expect(match, 'frontmatter block').not.toBeNull();
      expect(match![1]).not.toContain('{{');
      const data = parseYaml(match![1]!) as Record<string, unknown>;
      for (const key of Object.keys(data)) expect(BUILTIN_FRONTMATTER_KEYS.has(key), `frontmatter key ${key}`).toBe(true);
      expect(data['name']).toBe(name);
      expect(isValidId(name)).toBe(true);
      expect(typeof data['description']).toBe('string');
      const description = data['description'] as string;
      expect(description.length).toBeGreaterThan(20);
      expect(description.length).toBeLessThanOrEqual(1024);
      expect(description).not.toContain('\n');
    });

    it('compiles with the dfl helper set', () => {
      expectNoForbiddenTokens(source.replace(/\{\{[^}]*\}\}/g, ''), file);
      expect(() => precompile(source)).not.toThrow();
    });

    it.each([
      ['an active flow', feature.model],
      ['no active flow', undefined],
    ])('renders for %s', (_label, model) => {
      const out = render(source, templateContext(model, model ? defaultVars(model.def) : {}));
      expect(out.startsWith(`---\nname: ${name}\n`)).toBe(true);
      expect(out).not.toMatch(/\n{3,}/);
      expect(out).not.toMatch(/\{\{dfl\.cli\}\} /);
      expect(out).toContain('`dfl flow-update`');
      expectNoForbiddenTokens(out, `${file} (rendered)`);
      if (model) {
        // Loops print `this.title`: a bare `title` is ambiguous with the `title` helper.
        for (const step of model.steps.filter((s) => !s.final)) expect(out).toContain(`**${step.title}** (\`${step.id}\`)`);
        expect(out).toContain('[NEXT → plan-feature]');
      } else {
        expect(out).toContain('No flow was active at the last sync.');
      }
    });
  });

  it('render with the real renderer, with and without an active flow', () => {
    const paths = makeTempProject();
    const model = createFlow(paths, 'feature', { from: 'feature' });
    for (const active of [model, undefined]) {
      const skills = renderBuiltinSkills(paths, active, active ? resolveVars(paths, active.def, {}).values : {});
      expect(skills.map((s) => s.name)).toEqual(BUILTIN_SKILLS);
      for (const skill of skills) {
        const content = skill.files.find((f) => f.path === 'SKILL.md')?.content ?? '';
        expect(skill.description).toBe((parseYaml(FRONTMATTER_RE.exec(content)![1]!) as { description: string }).description);
        expect(skill.description).toMatch(/^[A-Z]/);
        expectNoForbiddenTokens(content, `${skill.name}/SKILL.md (rendered)`);
      }
    }
  });

  it.each(['add-flow-step', 'edit-flow-step'])('%s tells the agent to end templates with the literal partial', (name) => {
    const source = fs.readFileSync(path.join(builtinSkillsDir(), name, SKILL_TEMPLATE_FILE), 'utf8');
    const out = render(source, templateContext(feature.model, defaultVars(feature.def)));
    expect(out).toContain('`{{> flow-context}}`');
    expect(out).toContain('`{{vars.');
    expect(out).not.toContain(PARTIAL_MARKER);
  });
});
