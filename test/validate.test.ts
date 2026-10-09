import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowDefinition, ValidationIssue } from '../src/core/types.js';
import { assertFlowValid, diffDefinitionErrors, validateDefinition, validateFlow } from '../src/core/validate.js';
import { cleanupTempDirs, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

// The flow templates dfl shipped before "dev" (feature, bugfix, quick) are test fixtures now.
vi.mock('../src/core/paths.js', async (original) => (await import('./helpers/fixture-templates.js')).fixtureTemplatesPaths(original));

afterEach(cleanupTempDirs);

const errors = (issues: ValidationIssue[]): string[] => issues.filter((i) => i.level === 'error').map((i) => i.message);
const warnings = (issues: ValidationIssue[]): string[] => issues.filter((i) => i.level === 'warning').map((i) => i.message);

/** The sample flow with a skill prefix, so no skill name shadows an agent command ("plan", "review"). */
function cleanDefinition(): FlowDefinition {
  return { ...sampleFlowDefinition(), skillPrefix: 'sample-' };
}

/** Sample definition with `edit` applied to its states. */
function withStates(edit: (states: FlowDefinition['machine']['states'], def: FlowDefinition) => void): FlowDefinition {
  const def = sampleFlowDefinition();
  edit(def.machine.states, def);
  return def;
}

describe('validateDefinition', () => {
  it('accepts a valid flow', () => {
    expect(validateDefinition(cleanDefinition(), 'sample')).toEqual([]);
  });

  it('reports name, id, initial and target errors', () => {
    const def = withStates((states, d) => {
      d.machine.initial = 'missing';
      states['Bad_Id'] = { on: { NEXT: 'done' } };
      states['plan']!.on = { NEXT: 'nowhere', ALT: { target: 'gone', description: 'x' } };
    });
    const messages = errors(validateDefinition(def, 'other'));
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('does not match its directory name "other"'),
        expect.stringContaining('Invalid step id "Bad_Id"'),
        expect.stringContaining('Initial step "missing" does not exist'),
        expect.stringContaining('"NEXT" of step "plan" targets "nowhere"'),
        expect.stringContaining('"ALT" of step "plan" targets "gone"'),
      ]),
    );
    expect(errors(validateDefinition({ ...sampleFlowDefinition('Bad Name') }))).toEqual([
      expect.stringContaining('Invalid flow name'),
    ]);
  });

  it('reports step ids made of digits only (their declaration order is lost)', () => {
    const def = withStates((states, d) => {
      d.machine.initial = 'intro';
      states['intro'] = { on: { NEXT: '3' } };
      states['3'] = { on: { NEXT: '1' } };
      states['1'] = { on: { NEXT: 'plan' } };
    });
    expect(Object.keys(def.machine.states).slice(0, 2)).toEqual(['1', '3']); // what JavaScript does with them
    const issues = validateDefinition(def, 'sample').filter((issue) => issue.level === 'error');
    expect(issues.map((issue) => [issue.step, issue.message])).toEqual([
      ['1', expect.stringMatching(/^Invalid step id "1": a step id cannot be only digits .* Rename it, e\.g\. to "step-1"\.$/)],
      ['3', expect.stringContaining('Invalid step id "3": a step id cannot be only digits')],
    ]);
  });

  it('rejects unsupported xstate features', () => {
    const def = withStates((states) => {
      states['plan'] = { ...states['plan'], states: { a: {} }, initial: 'a' };
      states['build'] = { ...states['build'], type: 'parallel' as 'final' };
      (states['build'] as Record<string, unknown>)['entry'] = 'log';
      (states['build'] as Record<string, unknown>)['always'] = 'review';
      (states['build'] as Record<string, unknown>)['after'] = { 1000: 'review' };
      (states['build'] as Record<string, unknown>)['exit'] = 'log';
      (states['build'] as Record<string, unknown>)['invoke'] = { src: 'x' };
      states['review']!.on = {
        NEXT: [{ target: 'done' }] as unknown as string,
        CHANGES_REQUESTED: { target: 'build', guard: 'isBad', actions: 'x', cond: 'y' } as unknown as string,
        '*': 'done',
      };
      states['done'] = { type: 'final', on: { NEXT: 'plan' } };
    });
    const messages = errors(validateDefinition(def)).join('\n');
    for (const needle of [
      '"plan" uses "states"',
      'unsupported type "parallel"',
      '"build" uses "entry"',
      '"build" uses "always"',
      '"build" uses "after"',
      '"build" uses "exit"',
      '"build" uses "invoke"',
      '"NEXT" of step "review" is an array',
      'uses "guard"',
      'uses "cond"',
      'uses "actions"',
      'wildcard',
      'Final state "done" must not have transitions',
    ]) {
      expect(messages).toContain(needle);
    }
  });

  it('rejects machine-level xstate features', () => {
    const def = sampleFlowDefinition();
    def.machine['on'] = { ABORT: 'done' };
    def.machine['entry'] = 'log';
    const messages = errors(validateDefinition(def));
    expect(messages).toEqual([
      expect.stringContaining('The machine uses "on"'),
      expect.stringContaining('The machine uses "entry"'),
    ]);
  });

  it('wraps xstate createMachine errors', async () => {
    vi.resetModules();
    vi.doMock('xstate', async (importOriginal) => ({
      ...(await importOriginal<typeof import('xstate')>()),
      createMachine: () => {
        throw new Error('boom');
      },
    }));
    try {
      const fresh = await import('../src/core/validate.js');
      expect(errors(fresh.validateDefinition(sampleFlowDefinition()))).toEqual([
        'Flow "sample" is not a valid state machine: boom',
      ]);
    } finally {
      vi.doUnmock('xstate');
      vi.resetModules();
    }
  });

  it('errors on built-in skill collisions and warns on agent command names', () => {
    const def = withStates((states) => {
      states['add-flow-step'] = { on: { NEXT: 'done' } };
      states['review']!.on = { NEXT: 'add-flow-step' };
    });
    const issues = validateDefinition(def);
    expect(errors(issues)).toEqual([expect.stringContaining('"add-flow-step" collides with a built-in dfl skill')]);
    expect(warnings(issues)).toEqual(
      expect.arrayContaining([expect.stringContaining('"plan"'), expect.stringContaining('"review"')]),
    );
    // A prefix avoids both.
    const prefixed = withStates((_, d) => {
      d.skillPrefix = 'df-';
    });
    expect(validateDefinition(prefixed)).toEqual([]);
    const badPrefix = withStates((_, d) => {
      d.skillPrefix = 'DF_';
    });
    expect(errors(validateDefinition(badPrefix))[0]).toContain('Invalid skill name "DF_plan"');
  });

  it('reserves the skill name of the built-in fast-forward skill, also when a prefix produces it', () => {
    const def = withStates((states) => {
      states['fast-forward'] = { on: { NEXT: 'done' } };
      states['review']!.on = { NEXT: 'fast-forward' };
    });
    expect(errors(validateDefinition(def))).toEqual(['Skill name "fast-forward" of step "fast-forward" collides with a built-in dfl skill.']);
    const prefixed = withStates((states, d) => {
      d.skillPrefix = 'fast-';
      states['forward'] = { on: { NEXT: 'done' } };
      states['review']!.on = { NEXT: 'forward' };
    });
    expect(errors(validateDefinition(prefixed))).toEqual(['Skill name "fast-forward" of step "forward" collides with a built-in dfl skill.']);
  });

  it('rejects a final initial state unless the flow has only final states', () => {
    const def = withStates((_, d) => {
      d.machine.initial = 'done';
    });
    expect(errors(validateDefinition(def))).toEqual([
      'Initial step "done" is a final state, so the flow would start complete; make a step the initial one.',
    ]);
    const empty = sampleFlowDefinition();
    empty.machine = { id: 'sample', initial: 'done', states: { done: { type: 'final' } } };
    expect(errors(validateDefinition(empty))).toEqual([]);
  });

  it('rejects unknown keys in transition objects', () => {
    const def = withStates((states) => {
      states['plan']!.on = {
        NEXT: { 0: { target: 'build', guard: 'g' }, target: 'build' } as unknown as string,
        SKIP: { target: 'review', description: 'Skip', meta: { note: 'x' } } as unknown as string,
      };
    });
    const issues = validateDefinition(def);
    expect(issues.filter((i) => i.level === 'error')).toEqual([
      {
        level: 'error',
        message: 'Transition "NEXT" of step "plan" has an unsupported key "0" (only "target" and "description" are supported).',
        step: 'plan',
      },
    ]);
  });

  it('warns about unreachable states, dead ends and missing final states', () => {
    const def = withStates((states) => {
      states['orphan'] = { on: { NEXT: 'done' } };
      states['review']!.on = { CHANGES_REQUESTED: 'build', STUCK: 'stuck' };
      states['stuck'] = {};
    });
    const issues = validateDefinition(def);
    expect(errors(issues)).toEqual([]);
    expect(warnings(issues)).toEqual(
      expect.arrayContaining([
        'Step "orphan" is unreachable from the initial step "plan".',
        expect.stringContaining('No final state is reachable'),
        'Step "stuck" has no outgoing transitions (dead end).',
      ]),
    );
    const orphanWarning = issues.find((i) => i.message.includes('orphan'));
    expect(orphanWarning?.step).toBe('orphan');

    const noFinal = withStates((states) => {
      delete states['done'];
      states['review']!.on = { CHANGES_REQUESTED: 'build' };
    });
    expect(warnings(validateDefinition(noFinal))).toContain('The flow has no final state (`"type": "final"`); it can never complete.');
  });
});

describe('validateFlow', () => {
  it('reports a clean flow as valid', () => {
    const paths = makeTempProject();
    writeSampleFlow(paths, cleanDefinition());
    expect(validateFlow(paths, 'sample')).toEqual([]);
    expect(assertFlowValid(paths, 'sample')).toEqual([]);
  });

  it('turns missing files and parse errors into issues', () => {
    const paths = makeTempProject();
    expect(errors(validateFlow(paths, 'nope'))[0]).toContain('not found');
    fs.mkdirSync(paths.flowDir('broken'), { recursive: true });
    fs.writeFileSync(paths.flowFile('broken'), '{ "name": ');
    const [parse] = validateFlow(paths, 'broken');
    expect(parse).toMatchObject({ level: 'error', file: paths.flowFile('broken') });
    fs.writeFileSync(paths.flowFile('broken'), JSON.stringify({ name: 'broken' }));
    expect(errors(validateFlow(paths, 'broken'))[0]).toContain('machine');
  });

  it('checks templates, stray directories and hand-written markdown', () => {
    const paths = makeTempProject();
    writeSampleFlow(paths, cleanDefinition());
    const steps = paths.stepsDir('sample');
    fs.rmSync(path.join(steps, 'build', 'SKILL.md.hbs'));
    fs.mkdirSync(path.join(steps, 'old-step'));
    fs.mkdirSync(path.join(steps, 'done'));
    fs.writeFileSync(path.join(steps, 'plan', 'notes.md'), '# hand-written');
    fs.writeFileSync(path.join(steps, 'plan', 'SKILL.md'), '# rendered');
    fs.mkdirSync(path.join(steps, 'review', 'refs'));
    fs.writeFileSync(path.join(steps, 'review', 'refs', 'guide.md.hbs'), 'x');
    fs.writeFileSync(path.join(steps, 'review', 'refs', 'guide.md'), 'x');

    const issues = validateFlow(paths, 'sample');
    expect(issues.filter((i) => i.level === 'error')).toEqual([
      expect.objectContaining({ step: 'build', file: path.join(steps, 'build', 'SKILL.md.hbs') }),
    ]);
    const warned = warnings(issues).join('\n');
    expect(warned).toContain('steps/old-step does not belong to any step');
    expect(warned).toContain('Final state "done" has a steps/done directory');
    expect(warned).toContain('steps/plan/notes.md has no notes.md.hbs template');
    expect(warned).not.toContain('SKILL.md has no');
    expect(warned).not.toContain('guide.md');

    expect(() => assertFlowValid(paths, 'sample')).toThrow(/Flow "sample" is invalid:\n {2}- Step "build" has no template/);
    try {
      assertFlowValid(paths, 'sample');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('INVALID_FLOW');
    }
    fs.writeFileSync(path.join(steps, 'build', 'SKILL.md.hbs'), '# Build');
    expect(assertFlowValid(paths, 'sample')).toHaveLength(3);
  });

  it('reports a flow whose name does not match its directory', () => {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    const def = JSON.parse(fs.readFileSync(paths.flowFile('sample'), 'utf8')) as FlowDefinition;
    fs.mkdirSync(paths.flowDir('copy'));
    fs.writeFileSync(paths.flowFile('copy'), JSON.stringify(def));
    expect(errors(validateFlow(paths, 'copy'))).toContain('Flow name "sample" does not match its directory name "copy".');
  });
});

describe('diffDefinitionErrors', () => {
  it('separates new errors from errors the flow already had', () => {
    const before = withStates((states, d) => {
      d.machine.initial = 'ghost';
      states['plan']!.on = { NEXT: 'gone' };
    });
    const after = structuredClone(before);
    after.machine.states['extra'] = { on: { NEXT: 'nowhere' } };
    const { added, remaining } = diffDefinitionErrors(before, after, 'sample');
    expect(added.map((i) => i.message)).toEqual(['Transition "NEXT" of step "extra" targets "nowhere", which does not exist.']);
    // The initial-step message lists the states (it changed), but it is the same error.
    expect(remaining.map((i) => i.message)).toEqual([
      expect.stringContaining('Initial step "ghost" does not exist (states: plan, build, review, done, extra)'),
      'Transition "NEXT" of step "plan" targets "gone", which does not exist.',
    ]);
  });

  it('follows a rename', () => {
    const before = withStates((states) => {
      states['plan']!.on = { NEXT: 'gone' };
    });
    const after = structuredClone(before);
    after.machine.states = { 'plan-work': after.machine.states['plan']!, ...after.machine.states };
    delete after.machine.states['plan'];
    after.machine.initial = 'plan-work';
    after.machine.states['build']!.on = { NEXT: 'review', BACK: 'plan-work' };
    expect(diffDefinitionErrors(before, after, 'sample').added).toHaveLength(1);
    const { added, remaining } = diffDefinitionErrors(before, after, 'sample', { from: 'plan', to: 'plan-work' });
    expect(added).toEqual([]);
    expect(remaining).toHaveLength(1);
  });
});

describe('validateFlow templates', () => {
  function project(): { paths: ReturnType<typeof makeTempProject>; steps: string } {
    const paths = makeTempProject();
    writeSampleFlow(paths, cleanDefinition());
    return { paths, steps: paths.stepsDir('sample') };
  }

  it('reports templates that do not parse, with file and line', () => {
    const { paths, steps } = project();
    const skill = path.join(steps, 'build', 'SKILL.md.hbs');
    fs.writeFileSync(skill, '# Build\n\nThe chart uses `{{ .Values.image.tag }}`.\n');
    fs.mkdirSync(path.join(steps, 'review', 'ref'));
    const extra = path.join(steps, 'review', 'ref', 'x.md.hbs');
    fs.writeFileSync(extra, 'one\ntwo\n{{#if a}}x{{/each}}\n');
    const issues = validateFlow(paths, 'sample').filter((i) => i.level === 'error');
    expect(issues).toEqual([
      expect.objectContaining({ step: 'build', file: skill, message: expect.stringMatching(/^steps\/build\/SKILL\.md\.hbs, line 3: Handlebars syntax error/) }),
      expect.objectContaining({ step: 'review', file: extra, message: expect.stringContaining("steps/review/ref/x.md.hbs, line 3: Handlebars syntax error: if doesn't match each") }),
    ]);
    expect(() => assertFlowValid(paths, 'sample')).toThrow(/steps\/build\/SKILL\.md\.hbs, line 3/);
  });

  it('reports unknown partials and broken flow partials', () => {
    const { paths, steps } = project();
    fs.writeFileSync(path.join(steps, 'plan', 'SKILL.md.hbs'), '# Plan\n{{> no-such-partial}}\n{{> flow-context}}\n');
    fs.mkdirSync(paths.partialsDir('sample'));
    fs.writeFileSync(path.join(paths.partialsDir('sample'), 'broken.hbs'), '{{#if}}');
    fs.writeFileSync(path.join(paths.partialsDir('sample'), 'fine.hbs'), 'fine {{> flow-context}}');
    // Flow partials, inline partials, partial blocks (with fallback) and @partial-block are fine.
    fs.writeFileSync(
      path.join(steps, 'review', 'SKILL.md.hbs'),
      '{{> fine}}\n{{#*inline "local"}}x{{/inline}}{{> local}}\n{{#> maybe}}fallback{{/maybe}}\n',
    );
    const messages = errors(validateFlow(paths, 'sample'));
    expect(messages).toEqual([
      expect.stringContaining('steps/plan/SKILL.md.hbs uses the partial {{> no-such-partial}}, which does not exist'),
      expect.stringMatching(/^partials\/broken\.hbs, line 1: Handlebars syntax error/),
    ]);
  });

  it('warns about .hbs files that are neither rendered nor copied', () => {
    const { paths, steps } = project();
    fs.mkdirSync(path.join(steps, 'build', 'scripts'));
    fs.writeFileSync(path.join(steps, 'build', 'scripts', 'check.sh.hbs'), '#!/bin/sh\necho {{vars.testCommand}}\n');
    fs.writeFileSync(path.join(steps, 'build', 'scripts', 'data.json'), '{}');
    const issues = validateFlow(paths, 'sample');
    expect(errors(issues)).toEqual([]);
    expect(issues.filter((i) => i.level === 'warning')).toEqual([
      expect.objectContaining({
        step: 'build',
        message: expect.stringContaining('steps/build/scripts/check.sh.hbs is ignored: only *.md.hbs templates are rendered'),
      }),
    ]);
  });
});

describe('rendered output warnings (G8)', () => {
  it('tells stale dfl output (deleted template) from a hand-written .md file', () => {
    const paths = makeTempProject();
    writeSampleFlow(paths, cleanDefinition());
    const steps = paths.stepsDir('sample');
    fs.writeFileSync(path.join(steps, 'plan', 'old.md'), '# rendered by dfl earlier');
    fs.writeFileSync(path.join(steps, 'plan', 'notes.md'), '# my notes');
    fs.writeFileSync(
      paths.manifestFile,
      JSON.stringify({ version: 1, agents: [], skills: [], mcp: [], rendered: ['.df/sample/steps/plan/old.md'] }),
    );
    const warned = warnings(validateFlow(paths, 'sample')).join('\n');
    expect(warned).toContain('steps/plan/old.md was rendered from a old.md.hbs template that no longer exists; the next sync deletes it.');
    expect(warned).toContain('steps/plan/notes.md has no notes.md.hbs template: .md files under steps/ are git-ignored');
    expect(warned).toContain('Rename it to notes.md.hbs to commit and install it.');
    expect(warned).not.toContain('overwritten');
  });
});

describe('template context references (G8, F65)', () => {
  it('warns about expressions outside the template context, e.g. an unescaped GitHub Actions expression', () => {
    const paths = makeTempProject();
    writeSampleFlow(paths, cleanDefinition());
    const file = path.join(paths.stepsDir('sample'), 'build', 'SKILL.md.hbs');
    fs.writeFileSync(
      file,
      [
        '# Build',
        'token: ${{ secrets.NPM_TOKEN }}',
        'escaped: $\\{{ secrets.OTHER }}',
        '{{vars.mainBranch}} {{upper vars.mainBranch}} {{json vars 2}} {{default vars.x "y"}} {{dfl.cli}} {{env.HOME}}',
        '{{#if (eq vars.mainBranch "main")}}{{project.name}}{{/if}}',
        '{{#each step.next}}{{title}} {{event}} {{whatever}}{{else}}{{nothing.here}}{{/each}}',
        '{{#with flow}}{{title}}{{/with}} {{this.vars.x}} {{@root.vars}}',
        '{{github.sha}}',
        '{{> flow-context}}',
      ].join('\n'),
    );
    const warned = warnings(validateFlow(paths, 'sample')).filter((message) => message.includes('template context'));
    expect(warned).toEqual([
      expect.stringContaining('steps/build/SKILL.md.hbs, line 2: {{secrets.NPM_TOKEN}} refers to "secrets"'),
      expect.stringContaining('line 6: {{nothing.here}} refers to "nothing"'),
      expect.stringContaining('line 8: {{github.sha}} refers to "github"'),
    ]);
    expect(warned[0]).toContain('Write \\{{ to output literal braces');
    expect(errors(validateFlow(paths, 'sample'))).toEqual([]);
  });

  it('the prebuilt flow templates reference only the template context', async () => {
    const { createFlow } = await import('../src/core/flow.js');
    const paths = makeTempProject();
    for (const name of ['feature', 'bugfix', 'quick']) {
      createFlow(paths, name, { from: name });
      expect(warnings(validateFlow(paths, name)).filter((message) => message.includes('template context')), name).toEqual([]);
    }
  });
});
