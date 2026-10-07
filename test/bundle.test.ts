import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_DIR, backupFlow, bundleFlows, extractBundle, readBundle, serializeBundle } from '../src/core/bundle.js';
import { DflError } from '../src/core/errors.js';
import { createFlow, definitionDigest, fileDigest, flowDigests, readFlowDefinition, writeFlowDefinition } from '../src/core/flow.js';
import { importFlows, prepareImport, preparePull, pullFlow, templateUpdates } from '../src/core/import.js';
import { addStep } from '../src/core/steps.js';
import type { ProjectPaths } from '../src/core/types.js';
import { cleanupTempDirs, makeTempDir, makeTempProject, sampleFlowDefinition, writeSampleFlow } from './helpers/project.js';

// The flow templates dfl shipped before "dev" (feature, bugfix, quick) are test fixtures now.
vi.mock('../src/core/paths.js', async (original) => (await import('./helpers/fixture-templates.js')).fixtureTemplatesPaths(original));

afterEach(cleanupTempDirs);

function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Every file under `dir` (posix path → bytes as base64), for exact comparisons. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, abs).split(path.sep).join('/')] = fs.readFileSync(abs).toString('base64');
  }
  return out;
}

/** Writes `bundle` (any JSON) to a temp file and returns its path. */
function bundleFile(bundle: unknown): string {
  const file = path.join(makeTempDir('dfl-bundle-'), 'flows.dfl.json');
  fs.writeFileSync(file, typeof bundle === 'string' ? bundle : JSON.stringify(bundle));
  return file;
}

function flowJson(name: string): string {
  return JSON.stringify(sampleFlowDefinition(name));
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof DflError ? error.code : `non-dfl: ${String(error)}`;
  }
  return undefined;
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof DflError ? error.code : `non-dfl: ${String(error)}`;
  }
  return undefined;
}

describe('flow export files', () => {
  it('round-trip a flow byte for byte: text, binary, CRLF and executable files', () => {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    const dir = paths.flowDir('sample');
    write(path.join(dir, 'steps', 'build', 'scripts', 'run.sh'), 'echo run\n');
    fs.chmodSync(path.join(dir, 'steps', 'build', 'scripts', 'run.sh'), 0o755);
    write(path.join(dir, 'steps', 'build', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]));
    write(path.join(dir, 'partials', 'note.hbs'), 'line one\r\nline two\r\n');
    // Not part of the flow: rendered output (personal values), OS junk, dependencies.
    write(path.join(dir, 'steps', 'build', 'SKILL.md'), 'rendered for one developer');
    write(path.join(dir, 'steps', '.DS_Store'), 'junk');
    write(path.join(dir, 'node_modules', 'x', 'index.js'), 'x');
    const expected = tree(dir);
    delete expected['steps/build/SKILL.md'];
    delete expected['steps/.DS_Store'];
    delete expected['node_modules/x/index.js'];

    const bundle = bundleFlows(paths, ['sample']);
    const file = bundleFile(serializeBundle(bundle));
    const files = bundle.flows[0]!.files;
    expect(files.find((f) => f.path === 'steps/build/logo.png')).toMatchObject({ base64: 'iVBORwD//g==' });
    expect(files.find((f) => f.path === 'steps/build/scripts/run.sh')).toMatchObject({ text: 'echo run\n', executable: true });

    const out = makeTempDir('dfl-extract-');
    extractBundle(readBundle(file), out);
    expect(tree(path.join(out, 'sample'))).toEqual(expected);
    expect(fs.statSync(path.join(out, 'sample', 'steps', 'build', 'scripts', 'run.sh')).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(out, 'sample', 'flow.json')).mode & 0o111).toBe(0);
  });

  it('are checked before anything is written', () => {
    const valid = { format: 'dfl-flows', version: 1, flows: [{ name: 'a', files: [{ path: 'flow.json', text: flowJson('a') }] }] };
    expect(readBundle(bundleFile(valid)).flows[0]!.name).toBe('a');

    const withFiles = (...files: unknown[]): unknown => ({ ...valid, flows: [{ name: 'a', files: [{ path: 'flow.json', text: flowJson('a') }, ...files] }] });
    const cases: Array<[unknown, RegExp]> = [
      ['{ not json', /is not a dfl flow export/],
      [{ hello: 'world' }, /is not a dfl flow export/],
      [{ ...valid, version: 2 }, /written by a newer dfl/],
      [{ ...valid, flows: [] }, /flows/],
      [{ ...valid, flows: [{ name: '../x', files: [] }] }, /invalid flow name/],
      [{ ...valid, flows: [valid.flows[0], valid.flows[0]] }, /appears twice/],
      [{ ...valid, flows: [{ name: 'a', files: [] }] }, /has no flow.json/],
      [{ ...valid, flows: [{ name: 'a', files: [{ path: 'flow.json', text: flowJson('b') }] }] }, /is named "b"/],
      [withFiles({ path: '../outside', text: 'x' }), /unsafe path/],
      [withFiles({ path: '/etc/passwd', text: 'x' }), /unsafe path/],
      [withFiles({ path: 'steps\\a', text: 'x' }), /unsafe path/],
      [withFiles({ path: 'C:/x', text: 'x' }), /unsafe path/],
      [withFiles({ path: 'steps/a/./b', text: 'x' }), /unsafe path/],
      [withFiles({ path: 'a', text: 'x', base64: 'eA==' }), /exactly one of/],
      [withFiles({ path: 'a' }), /exactly one of/],
      [withFiles({ path: 'a', base64: '%%%' }), /invalid base64/],
      [withFiles({ path: 'steps/A.txt', text: 'x' }, { path: 'steps/a.txt', text: 'y' }), /appears twice/],
      [withFiles({ path: 'steps/a', text: 'x' }, { path: 'steps/a/b.txt', text: 'y' }), /both a file and a directory/],
    ];
    for (const [bundle, message] of cases) {
      expect(() => readBundle(bundleFile(bundle)), JSON.stringify(bundle).slice(0, 120)).toThrow(message);
      expect(codeOf(() => readBundle(bundleFile(bundle)))).toBe('INVALID_BUNDLE');
    }

    // Rendered output, VCS dirs and OS junk in a hand-made file are dropped, like a directory import does.
    const dropped = readBundle(
      bundleFile(withFiles({ path: 'steps/a/SKILL.md', text: 'x' }, { path: '.git/config', text: 'x' }, { path: 'Thumbs.db', text: 'x' })),
    );
    expect(dropped.flows[0]!.files.map((f) => f.path)).toEqual(['flow.json']);
  });

  it('import as a snapshot: the recorded source and its digests are kept, also under another name', async () => {
    const paths = makeTempProject();
    createFlow(paths, 'feature', { from: 'feature' });
    addStep(paths, 'feature', { id: 'qa', after: 'verify-feature' });
    const file = bundleFile(serializeBundle(bundleFlows(paths, ['feature'])));
    const source = readFlowDefinition(paths, 'feature').source;

    const other = makeTempProject();
    const [copy] = await importFlows(other, file, { name: 'ours' });
    expect(copy?.name).toBe('ours');
    const def = readFlowDefinition(other, 'ours');
    expect(def.machine.id).toBe('ours');
    expect(def.source).toEqual(source);
    // The rename is not an edit; the added step still is.
    const dry = await pullFlow(other, 'ours', { dryRun: true });
    expect(dry.changes).toEqual([
      { path: 'flow.json', change: 'changed', local: 'reverted' },
      { path: 'steps/qa/SKILL.md.hbs', change: 'removed', local: 'added-here' },
    ]);
    await expect(importFlows(other, file, { flows: ['nope'] })).rejects.toMatchObject({ code: 'FLOW_NOT_FOUND' });
  });

  it('backups get unique names and restore the flow', async () => {
    const paths = makeTempProject();
    writeSampleFlow(paths);
    const first = backupFlow(paths, 'sample');
    const second = backupFlow(paths, 'sample');
    expect(first).toMatch(new RegExp(`^\\.df/${BACKUP_DIR}/sample-\\d{8}T\\d{6}Z(-\\d+)?\\.dfl\\.json$`));
    expect(second).not.toBe(first);
    const before = tree(paths.flowDir('sample'));
    fs.rmSync(paths.flowDir('sample'), { recursive: true });
    await importFlows(paths, path.join(paths.root, first));
    expect(tree(paths.flowDir('sample'))).toEqual(before);
  });
});

describe('flow digests', () => {
  it('ignore line ends, flow.json formatting, the name and the source; not the step order', () => {
    expect(fileDigest(Buffer.from('a\r\nb\r\n'))).toBe(fileDigest(Buffer.from('a\nb\n')));
    expect(fileDigest(Buffer.from('a\n'))).not.toBe(fileDigest(Buffer.from('b\n')));
    const def = sampleFlowDefinition('one');
    const renamed = { ...sampleFlowDefinition('two'), source: { type: 'template' as const, ref: 'x' } };
    expect(definitionDigest(renamed)).toBe(definitionDigest(def));
    const { plan, build, ...rest } = def.machine.states;
    const reordered = { ...def, machine: { ...def.machine, states: { build: build!, plan: plan!, ...rest } } };
    expect(definitionDigest(reordered)).not.toBe(definitionDigest(def));

    const paths = makeTempProject();
    writeSampleFlow(paths, def);
    const digests = flowDigests(paths.flowDir('one'));
    fs.writeFileSync(paths.flowFile('one'), JSON.stringify(def)); // reformatted: one line
    expect(flowDigests(paths.flowDir('one'))).toEqual(digests);
  });
});

describe('replacing a flow tells changes made here from changes in the source', () => {
  /** A local source dir with flow `f` (plan, build, review) and a project that imported it. */
  async function imported(): Promise<{ paths: ProjectPaths; src: string; step: (id: string) => string; up: (id: string) => string }> {
    const src = makeTempDir('dfl-src-');
    const def = sampleFlowDefinition('f');
    write(path.join(src, 'flow.json'), JSON.stringify(def, null, 2));
    for (const id of ['plan', 'build', 'review']) write(path.join(src, 'steps', id, 'SKILL.md.hbs'), `# ${id}\n`);
    const paths = makeTempProject();
    await importFlows(paths, src);
    return {
      paths,
      src,
      step: (id) => path.join(paths.stepDir('f', id), 'SKILL.md.hbs'),
      up: (id) => path.join(src, 'steps', id, 'SKILL.md.hbs'),
    };
  }

  it('classifies every kind of change', async () => {
    const { paths, step, up, src } = await imported();
    fs.writeFileSync(step('plan'), '# plan, ours\n'); // edited here only → reverted
    fs.writeFileSync(step('build'), '# build, ours\n'); // edited here and upstream → conflict
    fs.writeFileSync(up('build'), '# build v2\n');
    fs.writeFileSync(up('review'), '# review v2\n'); // upstream only → none
    write(path.join(paths.stepDir('f', 'build'), 'mine.txt'), 'ours'); // added here → added-here
    write(path.join(src, 'steps', 'build', 'new.txt'), 'theirs'); // added upstream → none
    write(path.join(src, 'steps', 'plan', 'extra.txt'), 'x'); // upstream has a file we deleted
    const dryBefore = await pullFlow(paths, 'f', { dryRun: true });
    expect(dryBefore.changes.find((c) => c.path === 'steps/plan/extra.txt')).toEqual({ path: 'steps/plan/extra.txt', change: 'added', local: 'none' });
    await pullFlow(paths, 'f', { discardLocal: true }); // take everything once, so the base has extra.txt
    fs.rmSync(path.join(paths.stepDir('f', 'plan'), 'extra.txt')); // deleted here → deleted-here
    fs.writeFileSync(step('plan'), '# plan, ours\n');
    fs.writeFileSync(step('build'), '# build, ours\n');
    fs.writeFileSync(up('build'), '# build v3\n');
    fs.writeFileSync(up('review'), '# review v3\n');
    write(path.join(paths.stepDir('f', 'build'), 'mine.txt'), 'ours');

    const dry = await pullFlow(paths, 'f', { dryRun: true });
    expect(dry.baseline).toBe(true);
    expect(dry.changes).toEqual([
      { path: 'steps/build/SKILL.md.hbs', change: 'changed', local: 'conflict' },
      { path: 'steps/build/mine.txt', change: 'removed', local: 'added-here' },
      { path: 'steps/plan/SKILL.md.hbs', change: 'changed', local: 'reverted' },
      { path: 'steps/plan/extra.txt', change: 'added', local: 'deleted-here' },
      { path: 'steps/review/SKILL.md.hbs', change: 'changed', local: 'none' },
    ]);

    // Without a recorded version, nothing is known.
    const def = readFlowDefinition(paths, 'f');
    writeFlowDefinition(paths, { ...def, source: { type: 'local', ref: def.source!.ref! } });
    const unknown = await pullFlow(paths, 'f', { dryRun: true });
    expect(unknown.baseline).toBe(false);
    expect(new Set(unknown.changes.map((c) => c.local))).toEqual(new Set(['unknown']));
  });

  it('a pull that only brings changes from the source needs no --discard-local', async () => {
    const { paths, up } = await imported();
    fs.writeFileSync(up('review'), '# review v2\n');
    const result = await pullFlow(paths, 'f');
    expect(result.changes).toEqual([{ path: 'steps/review/SKILL.md.hbs', change: 'changed', local: 'none' }]);
    expect(result.backup).toBeDefined();
    // The new version is the new base: editing the step now counts as a change made here.
    fs.writeFileSync(up('review'), '# review v3\n');
    expect((await pullFlow(paths, 'f', { dryRun: true })).changes[0]?.local).toBe('none');
  });

  it('refuses to apply a preview when the flow changed in between (PLAN_CHANGED)', async () => {
    const { paths, up, step } = await imported();
    fs.writeFileSync(up('review'), '# review v2\n');
    const pull = await preparePull(paths, 'f');
    try {
      fs.writeFileSync(step('plan'), '# edited while the question was open\n');
      expect(codeOf(() => pull.apply({ discardLocal: true }))).toBe('PLAN_CHANGED');
      expect(fs.readFileSync(step('plan'), 'utf8')).toBe('# edited while the question was open\n');
      expect(fs.readFileSync(step('review'), 'utf8')).toBe('# review\n');
    } finally {
      pull.discard();
    }

    // An import whose target appears after the preview is not applied either.
    const src = makeTempDir('dfl-src-');
    write(path.join(src, 'flow.json'), JSON.stringify(sampleFlowDefinition('late')));
    for (const id of ['plan', 'build', 'review']) write(path.join(src, 'steps', id, 'SKILL.md.hbs'), `# ${id}\n`);
    const prepared = await prepareImport(paths, src);
    try {
      writeSampleFlow(paths, sampleFlowDefinition('late'));
      expect(codeOf(() => prepared.apply())).toBe('PLAN_CHANGED');
    } finally {
      prepared.discard();
    }
    expect(fs.readdirSync(paths.dfDir).filter((name) => name.startsWith('.dfl-stage-'))).toEqual([]);
  });

  it('does not let --force overwrite flow files whose flow.json is missing without asking', async () => {
    const { paths, src } = await imported();
    fs.rmSync(paths.flowFile('f'));
    expect(await rejectionCode(importFlows(paths, src))).toBe('FLOW_EXISTS');
    const [model] = await importFlows(paths, src, { force: true });
    expect(model).toMatchObject({ replaced: true });
    expect(model?.backup).toBeDefined();
  });
});

describe('templateUpdates', () => {
  it('reports template flows whose template changed since they were created, and nothing else', () => {
    const paths = makeTempProject();
    createFlow(paths, 'mine', { from: 'quick' });
    createFlow(paths, 'blank', { steps: ['a'] });
    writeSampleFlow(paths, sampleFlowDefinition('legacy'));
    expect(templateUpdates(paths)).toEqual([]);

    // Customizing the flow is not a template update.
    fs.appendFileSync(path.join(paths.stepDir('mine', 'plan-change'), 'SKILL.md.hbs'), '\nOurs.\n');
    expect(templateUpdates(paths)).toEqual([]);

    // A recorded version that differs from the current template is (e.g. created by an older dfl).
    const def = readFlowDefinition(paths, 'mine');
    writeFlowDefinition(paths, { ...def, source: { ...def.source!, files: { ...def.source!.files, 'steps/make-change/SKILL.md.hbs': '0000000000000000' } } });
    expect(templateUpdates(paths)).toEqual([{ flow: 'mine', template: 'quick' }]);
  });
});
