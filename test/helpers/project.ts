import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../src/core/config.js';
import { SKILL_TEMPLATE_FILE, defaultStepTemplate, writeFlowDefinition } from '../../src/core/flow.js';
import { projectPaths } from '../../src/core/paths.js';
import type { FlowDefinition, ProjectPaths } from '../../src/core/types.js';

const created: string[] = [];

/** Creates an empty temp directory (removed by cleanupTempDirs). */
export function makeTempDir(prefix = 'dfl-test-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** Creates a temp project with an initialized `.df/`. */
export function makeTempProject(): ProjectPaths {
  const paths = projectPaths(makeTempDir());
  initProject(paths);
  return paths;
}

export function cleanupTempDirs(): void {
  while (created.length > 0) fs.rmSync(created.pop()!, { recursive: true, force: true });
}

/** A small linear flow: plan → build → review (CHANGES_REQUESTED → build) → done. */
export function sampleFlowDefinition(name = 'sample'): FlowDefinition {
  return {
    name,
    title: 'Sample flow',
    description: 'A sample flow for tests.',
    version: '1.0.0',
    skillPrefix: '',
    vars: {
      mainBranch: { description: 'Main branch', default: 'main', scope: 'project' },
      reviewer: { description: 'Reviewer handle', scope: 'personal', required: true },
    },
    machine: {
      id: name,
      initial: 'plan',
      states: {
        plan: { description: 'Plan the work', meta: { title: 'Plan' }, on: { NEXT: 'build' } },
        build: { description: 'Build it', meta: { title: 'Build' }, on: { NEXT: 'review', BACK: 'plan' } },
        review: {
          description: 'Review it',
          meta: { title: 'Review' },
          on: { NEXT: 'done', CHANGES_REQUESTED: { target: 'build', description: 'Reviewer asked for changes' } },
        },
        done: { type: 'final', description: 'All done' },
      },
    },
  };
}

/** Writes a flow definition plus a SKILL.md.hbs for every non-final state. */
export function writeSampleFlow(paths: ProjectPaths, def: FlowDefinition = sampleFlowDefinition()): FlowDefinition {
  writeFlowDefinition(paths, def);
  for (const [id, node] of Object.entries(def.machine.states)) {
    if (node.type === 'final') continue;
    const file = path.join(paths.stepDir(def.name, id), SKILL_TEMPLATE_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, defaultStepTemplate({ title: node.meta?.title ?? id }));
  }
  return def;
}
