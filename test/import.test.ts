import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getActiveFlowName, setActiveFlow } from '../src/core/config.js';
import { DflError } from '../src/core/errors.js';
import { listFlows, readFlowDefinition } from '../src/core/flow.js';
import { findFlowDirs, importFlows, parseFlowSource } from '../src/core/import.js';
import type { FlowDefinition } from '../src/core/types.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, sampleFlowDefinition } from './helpers/project.js';

afterEach(cleanupTempDirs);

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Writes a flow directory (flow.json + a SKILL.md.hbs per non-final step) at `dir`. */
function writeFlowDir(dir: string, def: FlowDefinition): void {
  write(path.join(dir, 'flow.json'), `${JSON.stringify(def, null, 2)}\n`);
  for (const [id, node] of Object.entries(def.machine.states)) {
    if (node.type !== 'final') write(path.join(dir, 'steps', id, 'SKILL.md.hbs'), `# ${id}\n`);
  }
}

/** A source tree with `flows/feature` and `flows/bugfix`. */
function makeSource(): string {
  const src = makeTempDir('dfl-src-');
  writeFlowDir(path.join(src, 'flows', 'feature'), { ...sampleFlowDefinition('feature'), title: 'Feature v1' });
  writeFlowDir(path.join(src, 'flows', 'bugfix'), sampleFlowDefinition('bugfix'));
  write(path.join(src, 'flows', 'feature', 'steps', 'build', 'scripts', 'run.sh'), 'echo run\n');
  write(path.join(src, 'flows', 'feature', 'steps', 'build', 'SKILL.md'), 'rendered output');
  write(path.join(src, 'README.md'), '# flows\n');
  return src;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=dfl', '-c', 'user.email=dfl@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  );
}

/** A git repo with the source tree committed and tagged `v1`, then a second commit on main. */
function makeRepo(): string {
  const repo = makeSource();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'v1');
  git(repo, 'tag', 'v1');
  const file = path.join(repo, 'flows', 'feature', 'flow.json');
  const def = JSON.parse(fs.readFileSync(file, 'utf8')) as FlowDefinition;
  write(file, JSON.stringify({ ...def, title: 'Feature v2' }, null, 2));
  git(repo, 'commit', '-q', '-am', 'v2');
  return repo;
}

function importTempDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('dfl-import-'));
}

describe('parseFlowSource', () => {
  it('parses github: shorthands', () => {
    expect(parseFlowSource('github:acme/flows')).toEqual({ kind: 'git', url: 'https://github.com/acme/flows.git' });
    expect(parseFlowSource('github:acme/flows.git#main')).toEqual({
      kind: 'git',
      url: 'https://github.com/acme/flows.git',
      ref: 'main',
    });
    expect(parseFlowSource(' github:acme/flows/flows/feature/#v1.2 ')).toEqual({
      kind: 'git',
      url: 'https://github.com/acme/flows.git',
      subpath: 'flows/feature',
      ref: 'v1.2',
    });
    expect(() => parseFlowSource('github:acme')).toThrow(DflError);
    expect(() => parseFlowSource('github:acme/flows#')).toThrow(/Invalid git ref/);
  });

  it('parses git URLs with optional //subpath and #ref', () => {
    expect(parseFlowSource('https://github.com/o/r.git//flows/x#v1')).toEqual({
      kind: 'git',
      url: 'https://github.com/o/r.git',
      subpath: 'flows/x',
      ref: 'v1',
    });
    expect(parseFlowSource('https://gitlab.com/group/sub/r.git')).toEqual({ kind: 'git', url: 'https://gitlab.com/group/sub/r.git' });
    expect(parseFlowSource('git@github.com:o/r.git#dev')).toEqual({ kind: 'git', url: 'git@github.com:o/r.git', ref: 'dev' });
    expect(parseFlowSource('git@github.com:o/r.git//flows')).toEqual({ kind: 'git', url: 'git@github.com:o/r.git', subpath: 'flows' });
    expect(parseFlowSource('ssh://git@host:2222/o/r.git//a/b')).toEqual({
      kind: 'git',
      url: 'ssh://git@host:2222/o/r.git',
      subpath: 'a/b',
    });
    expect(parseFlowSource('file:///tmp/repo//flows#v1')).toEqual({ kind: 'git', url: 'file:///tmp/repo', subpath: 'flows', ref: 'v1' });
    expect(() => parseFlowSource('https://github.com/o/r.git//../x')).toThrow(/"\.\." is not allowed/);
    expect(() => parseFlowSource('https://')).toThrow(DflError);
  });

  it('resolves local paths against cwd and rejects missing ones', () => {
    const src = makeSource();
    expect(parseFlowSource('flows', src)).toEqual({ kind: 'local', url: path.join(src, 'flows') });
    expect(parseFlowSource(src, '/')).toEqual({ kind: 'local', url: src });
    const error = (() => {
      try {
        parseFlowSource('nope', src);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(DflError);
    expect((error as DflError).code).toBe('SOURCE_NOT_FOUND');
    expect(() => parseFlowSource('README.md', src)).toThrow(/not a directory/);
  });
});

describe('findFlowDirs', () => {
  it('returns the dir itself when it holds a flow.json', () => {
    const src = makeSource();
    const dir = path.join(src, 'flows', 'feature');
    expect(findFlowDirs(dir)).toEqual([dir]);
  });

  it('looks in */, flows/*/ and .df/*/ in that order', () => {
    const src = makeTempDir();
    write(path.join(src, 'b', 'flow.json'), '{}');
    write(path.join(src, 'a', 'flow.json'), '{}');
    write(path.join(src, 'flows', 'c', 'flow.json'), '{}');
    write(path.join(src, '.df', 'd', 'flow.json'), '{}');
    write(path.join(src, '.df', 'config.json'), '{}');
    fs.mkdirSync(path.join(src, 'empty'));
    expect(findFlowDirs(src)).toEqual(['a', 'b', 'flows/c', '.df/d'].map((rel) => path.join(src, ...rel.split('/'))));
    expect(findFlowDirs(path.join(src, 'empty'))).toEqual([]);
  });
});

describe('importFlows', () => {
  it('imports every flow of a local directory and records the source', async () => {
    const src = makeSource();
    const paths = makeTempProject();
    const models = await importFlows(paths, src);
    expect(models.map((m) => m.name)).toEqual(['bugfix', 'feature']);
    expect(listFlows(paths)).toEqual(['bugfix', 'feature']);

    const def = readFlowDefinition(paths, 'feature');
    expect(def.source).toEqual({ type: 'local', ref: src, path: 'flows/feature' });
    expect(def.title).toBe('Feature v1');
    const dir = paths.flowDir('feature');
    expect(fs.readFileSync(path.join(dir, 'steps', 'build', 'scripts', 'run.sh'), 'utf8')).toBe('echo run\n');
    expect(fs.existsSync(path.join(dir, 'steps', 'build', 'SKILL.md.hbs'))).toBe(true);
    // Rendered output is never imported.
    expect(fs.existsSync(path.join(dir, 'steps', 'build', 'SKILL.md'))).toBe(false);
  });

  it('filters flows, renames a single flow and refuses --name for several', async () => {
    const src = makeSource();
    const paths = makeTempProject();
    const [model] = await importFlows(paths, src, { flows: ['feature'], name: 'my-feature' });
    expect(model?.name).toBe('my-feature');
    const def = readFlowDefinition(paths, 'my-feature');
    expect(def.name).toBe('my-feature');
    expect(def.machine.id).toBe('my-feature');
    expect(listFlows(paths)).toEqual(['my-feature']);

    await expect(importFlows(paths, src, { name: 'x' })).rejects.toMatchObject({ code: 'INVALID_OPTION' });
    await expect(importFlows(paths, src, { flows: ['nope'] })).rejects.toMatchObject({ code: 'FLOW_NOT_FOUND' });
    await expect(importFlows(paths, makeTempDir())).rejects.toMatchObject({ code: 'FLOW_NOT_FOUND' });
    // A single flow dir can be imported directly.
    const [bugfix] = await importFlows(paths, path.join(src, 'flows', 'bugfix'));
    expect(bugfix?.def.source).toEqual({ type: 'local', ref: path.join(src, 'flows', 'bugfix') });
  });

  it('refuses to overwrite existing flows unless forced, keeping the active flow', async () => {
    const src = makeSource();
    const paths = makeTempProject();
    await importFlows(paths, src, { flows: ['feature'] });
    setActiveFlow(paths, 'feature', 'project');
    write(path.join(paths.flowDir('feature'), 'steps', 'plan', 'local-only.txt'), 'x');

    await expect(importFlows(paths, src)).rejects.toMatchObject({ code: 'FLOW_EXISTS' });
    // Nothing was imported by the failed call (all targets are checked first).
    expect(listFlows(paths)).toEqual(['feature']);

    const models = await importFlows(paths, src, { force: true });
    expect(models.map((m) => m.name)).toEqual(['bugfix', 'feature']);
    expect(fs.existsSync(path.join(paths.flowDir('feature'), 'steps', 'plan', 'local-only.txt'))).toBe(false);
    expect(getActiveFlowName(paths)).toBe('feature');
  });

  it('imports from a git repository at a ref and cleans up the clone', async () => {
    const repo = makeRepo();
    const url = `file://${repo}`;
    const paths = makeTempProject();
    const tempBefore = importTempDirs();

    const [v1] = await importFlows(paths, `${url}//flows#v1`, { flows: ['feature'] });
    expect(v1?.def.title).toBe('Feature v1');
    expect(v1?.def.source).toEqual({ type: 'git', ref: url, path: 'flows/feature', rev: 'v1' });
    expect(fs.existsSync(path.join(paths.flowDir('feature'), '.git'))).toBe(false);
    expect(fs.existsSync(path.join(paths.flowDir('feature'), 'steps', 'build', 'scripts', 'run.sh'))).toBe(true);

    const [head] = await importFlows(paths, url, { flows: ['feature'], name: 'feature-head' });
    expect(head?.def.title).toBe('Feature v2');
    expect(head?.def.source).toEqual({ type: 'git', ref: url, path: 'flows/feature' });

    await expect(importFlows(paths, `${url}#no-such-tag`)).rejects.toMatchObject({ code: 'CLONE_FAILED' });
    await expect(importFlows(paths, `${url}//missing`)).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    expect(importTempDirs()).toEqual(tempBefore);
  });
});
