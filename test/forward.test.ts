import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFlowModel, parseFlowDefinition } from '../src/core/flow.js';
import { bypassSteps, flowEnd, forwardPath, forwardReachable } from '../src/core/forward.js';
import { flowTemplatesDir } from '../src/core/paths.js';
import type { FlowDefinition, FlowModel, FlowStateNodeConfig } from '../src/core/types.js';
import { sampleFlowDefinition } from './helpers/project.js';

const sample = (def: FlowDefinition = sampleFlowDefinition()): FlowModel => buildFlowModel(def, '/project/.df/sample');

function dev(): FlowModel {
  const file = path.join(flowTemplatesDir(), 'dev', 'flow.json');
  return buildFlowModel(parseFlowDefinition(JSON.parse(fs.readFileSync(file, 'utf8')), file), '/project/.df/dev');
}

/** A flow with these states (declaration order) and initial state. */
function custom(states: Record<string, FlowStateNodeConfig>, initial = Object.keys(states)[0]!): FlowModel {
  return buildFlowModel({ name: 'custom', machine: { id: 'custom', initial, states } }, '/project/.df/custom');
}

const sorted = (set: Set<string>): string[] => [...set].sort();

describe('forwardReachable', () => {
  it('follows only transitions to later states of the flow order', () => {
    const model = sample();
    expect(sorted(forwardReachable(model, 'plan'))).toEqual(['build', 'done', 'plan', 'review']);
    expect(sorted(forwardReachable(model, 'review'))).toEqual(['done', 'review']);
    expect(sorted(forwardReachable(model, 'done'))).toEqual(['done']);
  });

  it('gives the forward sets of the dev flow', () => {
    const model = dev();
    expect(forwardReachable(model, 'classify-task').size).toBe(8);
    expect(sorted(forwardReachable(model, 'define-behavior'))).toEqual(
      ['define-behavior', 'design-tech', 'implement-task', 'verify-task', 'ship-task', 'done'].sort(),
    );
    expect(sorted(forwardReachable(model, 'implement-task'))).toEqual(['done', 'implement-task', 'ship-task', 'verify-task']);
    expect(sorted(forwardReachable(model, 'ship-task'))).toEqual(['done', 'ship-task']);
  });

  it('ignores array-form (guarded) transitions', () => {
    const def = sampleFlowDefinition();
    def.machine.states['plan']!.on = { NEXT: 'build', SKIP: [{ target: 'review' }] as unknown as string };
    def.machine.states['build']!.on = { BACK: 'plan' };
    expect(sorted(forwardReachable(sample(def), 'plan'))).toEqual(['build', 'plan']);
  });
});

describe('flowEnd', () => {
  it('is the final state the NEXT path reaches', () => {
    expect(flowEnd(sample())).toBe('done');
    expect(flowEnd(dev())).toBe('done');
  });

  it('falls back to the only final state, else is undefined', () => {
    // NEXT dead end, one final state.
    expect(flowEnd(custom({ a: { on: { GO: 'b' } }, b: { on: { NEXT: 'end' } }, end: { type: 'final' } }))).toBe('end');
    // NEXT cycle, two final states.
    expect(
      flowEnd(custom({ a: { on: { NEXT: 'b' } }, b: { on: { NEXT: 'a', X: 'x', Y: 'y' } }, x: { type: 'final' }, y: { type: 'final' } })),
    ).toBeUndefined();
    // No final state at all.
    expect(flowEnd(custom({ a: { on: { NEXT: 'b' } }, b: { on: { NEXT: 'a' } } }))).toBeUndefined();
  });
});

describe('forwardPath', () => {
  it('prefers NEXT, else the first forward transition that still reaches the target', () => {
    const model = dev();
    expect(forwardPath(model, 'classify-task', 'verify-task')).toEqual([
      'classify-task',
      'define-behavior',
      'design-tech',
      'implement-task',
      'verify-task',
    ]);
    expect(forwardPath(model, 'classify-task', 'design-tech')).toEqual(['classify-task', 'define-behavior', 'design-tech']);
    expect(forwardPath(model, 'implement-task', 'done')).toEqual(['implement-task', 'verify-task', 'ship-task', 'done']);
    expect(forwardPath(model, 'implement-task', 'implement-task')).toEqual(['implement-task']);

    const branch = custom({ a: { on: { NEXT: 'b', ALT: 'c' } }, b: { on: { NEXT: 'end' } }, c: { on: { NEXT: 'end' } }, end: { type: 'final' } });
    expect(forwardPath(branch, 'a', 'c')).toEqual(['a', 'c']);
  });

  it('is empty when the target cannot be reached going forward', () => {
    const model = dev();
    expect(forwardPath(model, 'implement-task', 'design-tech')).toEqual([]);
    expect(forwardPath(model, 'ship-task', 'not-handled')).toEqual([]);
  });
});

describe('bypassSteps', () => {
  it('lists the steps where the route may skip the target', () => {
    const model = dev();
    const toDesign = forwardPath(model, 'classify-task', 'design-tech');
    expect(bypassSteps(model, toDesign, 'design-tech')).toEqual(['classify-task', 'define-behavior']);
    const toVerify = forwardPath(model, 'classify-task', 'verify-task');
    expect(bypassSteps(model, toVerify, 'verify-task')).toEqual([]);
    const toReview = forwardPath(sample(), 'plan', 'review');
    expect(bypassSteps(sample(), toReview, 'review')).toEqual([]);
  });
});
