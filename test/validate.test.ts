import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowDefinition, ValidationIssue } from '../src/core/types.js';
import { assertFlowValid, validateDefinition, validateFlow } from '../src/core/validate.js';
import { cleanupTempDirs, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

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
