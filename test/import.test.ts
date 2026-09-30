import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getActiveFlowName, loadLocalConfig, setActiveFlow } from '../src/core/config.js';
import { DflError } from '../src/core/errors.js';
import { createFlow, listFlows, readFlowDefinition, writeFlowDefinition } from '../src/core/flow.js';
import { findFlowDirs, importFlows, parseFlowSource, pullFlow } from '../src/core/import.js';
import { flowTemplatesDir } from '../src/core/paths.js';
import type { FlowDefinition, ProjectPaths } from '../src/core/types.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

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

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Project-relative posix path, as recorded in `source.ref` for local imports. */
function relRef(paths: ProjectPaths, dir: string): string {
  return path.relative(paths.root, dir).split(path.sep).join('/');
}

/** Every file under `dir` → content (for byte-identical checks). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, abs)] = fs.readFileSync(abs, 'utf8');
  }
  return out;
}

function leftovers(paths: ProjectPaths): string[] {
  return fs.readdirSync(paths.dfDir).filter((name) => name.startsWith('.dfl-'));
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof DflError ? error.code : `non-dfl: ${String(error)}`;
  }
  return undefined;
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

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
    // Local sources are recorded relative to the project root (never absolute).
    expect(def.source).toEqual({ type: 'local', ref: relRef(paths, src), path: 'flows/feature' });
    expect(path.isAbsolute(def.source!.ref!)).toBe(false);
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
    expect(bugfix?.def.source).toEqual({ type: 'local', ref: relRef(paths, path.join(src, 'flows', 'bugfix')) });
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

    const state = { version: 1, flows: { feature: { current: 'build', history: [], updatedAt: '2026-01-01T00:00:00.000Z' } } };
    fs.writeFileSync(paths.stateFile, JSON.stringify(state));
    const models = await importFlows(paths, src, { force: true });
    expect(models.map((m) => m.name)).toEqual(['bugfix', 'feature']);
    expect(fs.existsSync(path.join(paths.flowDir('feature'), 'steps', 'plan', 'local-only.txt'))).toBe(false);
    expect(getActiveFlowName(paths)).toBe('feature');
    expect(JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'))).toEqual(state);
    expect(leftovers(paths)).toEqual([]);
  });

  it('imports from a git repository at a ref and cleans up the clone', async () => {
    const repo = makeRepo();
    const url = `file://${repo}`;
    const paths = makeTempProject();
    const tempBefore = importTempDirs();

    const [v1] = await importFlows(paths, `${url}//flows#v1`, { flows: ['feature'] });
    expect(v1?.def.title).toBe('Feature v1');
    expect(v1?.def.source).toEqual({ type: 'git', ref: url, path: 'flows/feature', rev: 'v1', commit: gitOut(repo, 'rev-parse', 'v1^{commit}') });
    expect(fs.existsSync(path.join(paths.flowDir('feature'), '.git'))).toBe(false);
    expect(fs.existsSync(path.join(paths.flowDir('feature'), 'steps', 'build', 'scripts', 'run.sh'))).toBe(true);

    const [head] = await importFlows(paths, url, { flows: ['feature'], name: 'feature-head' });
    expect(head?.def.title).toBe('Feature v2');
    expect(head?.def.source).toEqual({ type: 'git', ref: url, path: 'flows/feature', commit: gitOut(repo, 'rev-parse', 'main') });

    await expect(importFlows(paths, `${url}#no-such-tag`)).rejects.toMatchObject({ code: 'CLONE_FAILED' });
    await expect(importFlows(paths, `${url}//missing`)).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    expect(importTempDirs()).toEqual(tempBefore);
  });
});

describe('importFlows safety', () => {
  /** A source dir with one flow whose flow.json has the given name. */
  function sourceNamed(name: string, title = 'Imported'): string {
    const src = makeTempDir('dfl-src-');
    const def = { ...sampleFlowDefinition('placeholder'), name, title };
    writeFlowDir(path.join(src, 'flows', 'one'), def);
    return src;
  }

  function projectWithFeature(): ProjectPaths {
    const paths = makeTempProject();
    writeSampleFlow(paths, sampleFlowDefinition('feature'));
    return paths;
  }

  it('validates the incoming name before replacing anything (case variants, traversal)', async () => {
    const paths = projectWithFeature();
    const before = snapshot(paths.flowDir('feature'));
    expect(await rejectionCode(importFlows(paths, sourceNamed('Feature'), { force: true }))).toBe('INVALID_NAME');
    expect(await rejectionCode(importFlows(paths, sourceNamed('feature/../feature'), { force: true }))).toBe('INVALID_NAME');
    expect(await rejectionCode(importFlows(paths, sourceNamed('../victim'), { force: true }))).toBe('INVALID_NAME');
    expect(await rejectionCode(importFlows(paths, sourceNamed('ok'), { force: true, name: 'Feature' }))).toBe('INVALID_NAME');
    expect(snapshot(paths.flowDir('feature'))).toEqual(before);
    expect(listFlows(paths)).toEqual(['feature']);
    // --name is validated before cloning.
    expect(await rejectionCode(importFlows(paths, 'https://127.0.0.1:1/none.git', { name: '../x' }))).toBe('INVALID_NAME');
    expect(leftovers(paths)).toEqual([]);
  });

  it('never deletes outside .df, even with a flow.json at the project root', async () => {
    const paths = projectWithFeature();
    fs.writeFileSync(path.join(paths.root, 'flow.json'), '{"other":"tool"}');
    fs.writeFileSync(path.join(paths.root, 'keep.txt'), 'keep');
    fs.mkdirSync(path.join(paths.root, 'x'));
    fs.writeFileSync(path.join(paths.root, 'x', 'flow.json'), JSON.stringify(sampleFlowDefinition('x')));
    const src = sourceNamed('ok');
    for (const name of ['..', '../x', '.', '../..']) {
      expect(await rejectionCode(importFlows(paths, src, { force: true, name }))).toBe('INVALID_NAME');
    }
    expect(fs.readFileSync(path.join(paths.root, 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(paths.root, 'x', 'flow.json'))).toBe(true);
    expect(fs.existsSync(paths.flowFile('feature'))).toBe(true);
  });

  it('checks every flow before replacing the first one', async () => {
    const paths = makeTempProject();
    writeSampleFlow(paths, { ...sampleFlowDefinition('aaa'), title: 'Mine' });
    const before = snapshot(paths.flowDir('aaa'));
    const src = makeTempDir('dfl-src-');
    writeFlowDir(path.join(src, 'flows', 'aaa'), { ...sampleFlowDefinition('aaa'), title: 'Theirs' });
    writeFlowDir(path.join(src, 'flows', 'zzz'), { ...sampleFlowDefinition('placeholder'), name: 'Bad' });
    expect(await rejectionCode(importFlows(paths, src, { force: true }))).toBe('INVALID_NAME');
    expect(snapshot(paths.flowDir('aaa'))).toEqual(before);
    expect(listFlows(paths)).toEqual(['aaa']);
  });

  it("refuses to import the project's own flows over themselves", async () => {
    const paths = projectWithFeature();
    writeSampleFlow(paths, sampleFlowDefinition('bugfix'));
    const feature = snapshot(paths.flowDir('feature'));
    const bugfix = snapshot(paths.flowDir('bugfix'));
    expect(await rejectionCode(importFlows(paths, paths.root, { force: true }))).toBe('INVALID_SOURCE');
    expect(await rejectionCode(importFlows(paths, paths.dfDir, { force: true }))).toBe('INVALID_SOURCE');
    expect(await rejectionCode(importFlows(paths, paths.flowDir('feature'), { force: true }))).toBe('INVALID_SOURCE');
    expect(await rejectionCode(importFlows(paths, paths.root))).toBe('INVALID_SOURCE');
    expect(snapshot(paths.flowDir('feature'))).toEqual(feature);
    expect(snapshot(paths.flowDir('bugfix'))).toEqual(bugfix);
    expect(leftovers(paths)).toEqual([]);

    // Copying one of the project's flows under a new name is fine.
    const [copy] = await importFlows(paths, paths.flowDir('feature'), { name: 'feature-copy' });
    expect(copy?.def.source).toEqual({ type: 'local', ref: '.df/feature' });
    // Searching the project root skips its own .df flows but finds others.
    writeFlowDir(path.join(paths.root, 'flows', 'shared'), sampleFlowDefinition('shared'));
    const models = await importFlows(paths, paths.root);
    expect(models.map((m) => m.name)).toEqual(['shared']);
    expect(models[0]?.def.source).toEqual({ type: 'local', ref: '.', path: 'flows/shared' });
  });

  (process.platform === 'win32' || isRoot ? it.skip : it)('leaves the existing flow untouched when the copy fails', async () => {
    const paths = projectWithFeature();
    const before = snapshot(paths.flowDir('feature'));
    const src = makeTempDir('dfl-src-');
    writeFlowDir(src, { ...sampleFlowDefinition('feature'), title: 'New' });
    const locked = path.join(src, 'steps', 'plan', 'locked.txt');
    fs.writeFileSync(locked, 'x');
    fs.chmodSync(locked, 0o000);
    try {
      await expect(importFlows(paths, src, { force: true })).rejects.toThrow();
    } finally {
      fs.chmodSync(locked, 0o644);
    }
    expect(snapshot(paths.flowDir('feature'))).toEqual(before);
    expect(leftovers(paths)).toEqual([]);
  });

  it('imports a git commit by full or abbreviated SHA and records it', async () => {
    const repo = makeRepo();
    const url = `file://${repo}`;
    const paths = makeTempProject();
    const sha = gitOut(repo, 'rev-parse', 'v1^{commit}');
    const [full] = await importFlows(paths, `${url}//flows#${sha}`, { flows: ['feature'], name: 'by-sha' });
    expect(full?.def.title).toBe('Feature v1');
    expect(full?.def.source).toEqual({ type: 'git', ref: url, path: 'flows/feature', rev: sha, commit: sha });
    const [short] = await importFlows(paths, `${url}//flows#${sha.slice(0, 10)}`, { flows: ['feature'], name: 'by-short' });
    expect(short?.def.title).toBe('Feature v1');
    expect((short?.def.source as { commit?: string }).commit).toBe(sha);
    expect(await rejectionCode(importFlows(paths, `${url}#deadbeefdeadbeef`))).toBe('CLONE_FAILED');
  });
});

describe('pullFlow', () => {
  it('re-imports a template flow, keeping runtime state and the active flow', async () => {
    const paths = makeTempProject();
    createFlow(paths, 'mine', { from: 'quick' });
    setActiveFlow(paths, 'mine');
    const state = { version: 1, flows: { mine: { current: 'make-change', history: [], updatedAt: '2026-01-01T00:00:00.000Z' } } };
    fs.writeFileSync(paths.stateFile, JSON.stringify(state));
    const stepDir = paths.stepDir('mine', 'make-change');
    fs.writeFileSync(path.join(stepDir, 'SKILL.md.hbs'), 'locally edited');
    fs.writeFileSync(path.join(stepDir, 'SKILL.md'), 'rendered output');
    fs.writeFileSync(path.join(stepDir, 'local.txt'), 'local');

    const dry = await pullFlow(paths, 'mine', { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, added: [], removed: ['steps/make-change/local.txt'], changed: ['steps/make-change/SKILL.md.hbs'] });
    expect(fs.readFileSync(path.join(stepDir, 'SKILL.md.hbs'), 'utf8')).toBe('locally edited');

    const result = await pullFlow(paths, 'mine');
    expect(result.source).toEqual({ type: 'template', ref: 'quick' });
    expect(result.model.name).toBe('mine');
    const template = path.join(flowTemplatesDir(), 'quick', 'steps', 'make-change', 'SKILL.md.hbs');
    expect(fs.readFileSync(path.join(stepDir, 'SKILL.md.hbs'), 'utf8')).toBe(fs.readFileSync(template, 'utf8'));
    expect(fs.existsSync(path.join(stepDir, 'local.txt'))).toBe(false);
    expect(readFlowDefinition(paths, 'mine').machine.id).toBe('mine');
    expect(JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'))).toEqual(state);
    expect(loadLocalConfig(paths).activeFlow).toBe('mine');
    expect(leftovers(paths)).toEqual([]);

    const again = await pullFlow(paths, 'mine');
    expect([again.added, again.removed, again.changed]).toEqual([[], [], []]);
  });

  it('re-imports a local source recorded relative to the project', async () => {
    const src = makeSource();
    const paths = makeTempProject();
    await importFlows(paths, src, { flows: ['feature'] });
    const upstream = path.join(src, 'flows', 'feature', 'steps', 'plan', 'SKILL.md.hbs');
    fs.writeFileSync(upstream, '# plan v2\n');
    const result = await pullFlow(paths, 'feature');
    expect(result.changed).toEqual(['steps/plan/SKILL.md.hbs']);
    expect(result.source).toEqual({ type: 'local', ref: relRef(paths, src), path: 'flows/feature' });
    expect(fs.readFileSync(path.join(paths.stepDir('feature', 'plan'), 'SKILL.md.hbs'), 'utf8')).toBe('# plan v2\n');
  });

  it('re-imports a git source at its recorded rev or a new one', async () => {
    const repo = makeRepo();
    const url = `file://${repo}`;
    const paths = makeTempProject();
    await importFlows(paths, `${url}//flows#v1`, { flows: ['feature'] });
    const same = await pullFlow(paths, 'feature');
    expect([same.added, same.removed, same.changed]).toEqual([[], [], []]);

    const main = await pullFlow(paths, 'feature', { rev: 'main' });
    expect(main.changed).toEqual(['flow.json']);
    expect(main.model.def.title).toBe('Feature v2');
    expect(readFlowDefinition(paths, 'feature').source).toEqual({
      type: 'git',
      ref: url,
      path: 'flows/feature',
      rev: 'main',
      commit: gitOut(repo, 'rev-parse', 'main'),
    });
  });

  it('refuses flows without a source to pull from', async () => {
    const paths = makeTempProject();
    createFlow(paths, 'blank', { steps: ['a'] });
    expect(await rejectionCode(pullFlow(paths, 'blank'))).toBe('NO_SOURCE');
    writeSampleFlow(paths, sampleFlowDefinition('nosource'));
    expect(await rejectionCode(pullFlow(paths, 'nosource'))).toBe('NO_SOURCE');
    expect(await rejectionCode(pullFlow(paths, '../x'))).toBe('INVALID_NAME');
    expect(await rejectionCode(pullFlow(paths, 'missing'))).toBe('FLOW_NOT_FOUND');
    createFlow(paths, 'tpl', { from: 'quick' });
    expect(await rejectionCode(pullFlow(paths, 'tpl', { rev: 'main' }))).toBe('INVALID_OPTION');
    // A local source that is the flow itself is a self-import.
    const def = readFlowDefinition(paths, 'tpl');
    writeFlowDefinition(paths, { ...def, source: { type: 'local', ref: '.df/tpl' } });
    expect(await rejectionCode(pullFlow(paths, 'tpl'))).toBe('INVALID_SOURCE');
    writeFlowDefinition(paths, { ...def, source: { type: 'local', ref: '.', path: '../outside' } });
    expect(await rejectionCode(pullFlow(paths, 'tpl'))).toBe('INVALID_SOURCE');
    expect(fs.existsSync(paths.flowFile('tpl'))).toBe(true);
  });
});
