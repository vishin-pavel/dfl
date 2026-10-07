import { afterEach, describe, expect, it } from 'vitest';
import { buildFlowModel } from '../src/core/flow.js';
import { planEvent, runtimeFromStored } from '../src/core/machine.js';
import { packageVersion } from '../src/core/paths.js';
import {
  RECORD_HISTORY_LIMIT,
  START_EVENT,
  buildRecord,
  mergeParams,
  processOpId,
  readRecord,
  recordHistoryEntry,
  storedPosition,
  type RecordHistoryEntry,
  type TaskRecord,
} from '../src/core/tracker/record.js';
import { cleanupTempDirs, sampleFlowDefinition } from './helpers/project.js';

afterEach(cleanupTempDirs);

const ISSUE = { id: '10231', key: 'ABC-123' };
const AT = '2026-10-01T09:00:00.000Z';

function validRecord(): Record<string, unknown> {
  return {
    schema: 1,
    issueId: '10231',
    key: 'ABC-123',
    flow: 'sample',
    step: 'build',
    params: { branch: 'ABC-123-csv-export', slug: 'csv-export' },
    history: [
      { from: '', to: 'plan', event: 'START', at: AT, op: '7f3a9c1e' },
      { from: 'plan', to: 'build', event: 'NEXT', at: AT, op: '7f3a9c1e' },
    ],
    updatedAt: AT,
    dfl: '0.1.0',
  };
}

function caught(fn: () => unknown): { code?: string; message: string; hint?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string; hint?: string };
  }
  throw new Error('expected an error');
}

describe('readRecord', () => {
  it('treats a missing property as not started', () => {
    expect(readRecord(undefined, ISSUE)).toEqual({ kind: 'missing' });
    expect(readRecord(null, ISSUE)).toEqual({ kind: 'missing' });
  });

  it('reads a valid record and keeps unknown keys', () => {
    const raw = { ...validRecord(), future: { x: 1 } };
    const read = readRecord(raw, ISSUE);
    expect(read.kind).toBe('ok');
    const record = (read as { record: TaskRecord }).record;
    expect(record).toMatchObject({ schema: 1, issueId: '10231', key: 'ABC-123', flow: 'sample', step: 'build', future: { x: 1 } });
    expect(record.history).toHaveLength(2);
  });

  it('fills defaults for optional parts', () => {
    const raw = validRecord();
    delete raw['params'];
    delete raw['dfl'];
    raw['history'] = [{ from: '', to: 'plan', event: 'START', at: AT }];
    const read = readRecord(raw, ISSUE) as { kind: 'ok'; record: TaskRecord };
    expect(read.record.params).toEqual({});
    expect(read.record.dfl).toBe('');
    expect(read.record.history[0]!.op).toBe('');
  });

  it('treats a record copied from another issue as not started', () => {
    const read = readRecord({ ...validRecord(), issueId: '99999' }, ISSUE);
    expect(read).toEqual({ kind: 'foreign', warning: expect.stringContaining('copied from another issue (id 99999); dfl treats ABC-123 as not started') });
    // even when the copied record is otherwise unusable
    expect(readRecord({ issueId: '99999', schema: 7 }, ISSUE).kind).toBe('foreign');
  });

  it('refuses a newer schema', () => {
    const error = caught(() => readRecord({ ...validRecord(), schema: 2 }, ISSUE));
    expect(error.code).toBe('TASK_SCHEMA_NEWER');
    expect(error.hint).toMatch(/Upgrade dfl/);
  });

  it.each<[string, (raw: Record<string, unknown>) => void]>([
    ['a non-object', () => undefined],
    ['a missing step', (raw) => delete raw['step']],
    ['a too long step', (raw) => (raw['step'] = 'x'.repeat(65))],
    ['a too long key', (raw) => (raw['key'] = 'A'.repeat(33))],
    ['an invalid param name', (raw) => (raw['params'] = { 'bad-name': 'x' })],
    ['a non-string param', (raw) => (raw['params'] = { count: 3 })],
    ['a too long param', (raw) => (raw['params'] = { note: 'x'.repeat(1001) })],
    ['too many params', (raw) => (raw['params'] = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`p${i}`, 'x'])))],
    ['a broken history entry', (raw) => (raw['history'] = [{ from: '', event: 'START', at: AT }])],
    ['schema 0', (raw) => (raw['schema'] = 0)],
  ])('reports %s as TASK_RECORD_INVALID', (name, edit) => {
    const raw = validRecord();
    edit(raw);
    const read = readRecord(name === 'a non-object' ? 'garbage' : raw, ISSUE);
    expect(read.kind).toBe('invalid');
    const { error } = read as { kind: 'invalid'; error: { code: string; message: string; hint: string } };
    expect(error.code).toBe('TASK_RECORD_INVALID');
    expect(error.message).toContain('The dfl record of ABC-123 is invalid');
    expect(error.hint).toContain('`dfl goto <step> --task ABC-123`');
  });
});

describe('buildRecord', () => {
  it('writes the position with this dfl version, keeping unknown keys of the previous record', () => {
    const previous = (readRecord({ ...validRecord(), future: 'kept' }, ISSUE) as { record: TaskRecord }).record;
    const now = new Date('2026-10-02T10:00:00.000Z');
    const entry = recordHistoryEntry({ from: 'build', to: 'review', event: 'NEXT', at: now.toISOString() });
    const record = buildRecord({
      previous,
      issueId: previous.issueId,
      key: previous.key,
      flow: previous.flow,
      step: 'review',
      params: { ...previous.params, specPath: 'docs/specs/x.md' },
      history: [...previous.history, entry],
      now,
    });
    expect(record).toMatchObject({
      schema: 1,
      step: 'review',
      updatedAt: '2026-10-02T10:00:00.000Z',
      dfl: packageVersion(),
      future: 'kept',
      params: { branch: 'ABC-123-csv-export', slug: 'csv-export', specPath: 'docs/specs/x.md' },
    });
    expect(record.history.at(-1)).toEqual({ from: 'build', to: 'review', event: 'NEXT', at: now.toISOString(), op: processOpId() });
    expect(readRecord(JSON.parse(JSON.stringify(record)), ISSUE)).toEqual({ kind: 'ok', record });
  });

  it('keeps only the newest history entries', () => {
    const history: RecordHistoryEntry[] = Array.from({ length: 60 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}`, event: 'NEXT', at: AT, op: 'aa' }));
    const record = buildRecord({ issueId: '1', key: 'ABC-1', flow: 'f', step: 's60', params: {}, history });
    expect(record.history).toHaveLength(RECORD_HISTORY_LIMIT);
    expect(record.history[0]!.from).toBe('s10');
    expect(record.history.at(-1)!.to).toBe('s60');
  });

  it('drops more history to stay within 32000 bytes, and refuses params that do not fit', () => {
    const params = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, 'x'.repeat(1000)]));
    const step = 's'.repeat(64);
    const history = Array.from({ length: 50 }, (_, i) => ({ from: step, to: `${i}`, event: 'E'.repeat(200), at: AT, op: 'aa' }));
    const record = buildRecord({ issueId: '1', key: 'ABC-1', flow: 'f', step: 's', params, history });
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(32_000);
    expect(record.params).toEqual(params);
    expect(record.history.length).toBeLessThan(50);
    expect(record.history.at(-1)!.to).toBe('49');

    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, '\u{1F600}'.repeat(500)]));
    const error = caught(() => buildRecord({ issueId: '1', key: 'ABC-1', flow: 'f', step: 's', params: wide, history }));
    expect(error.code).toBe('TASK_RECORD_TOO_LARGE');
  });
});

describe('processOpId / recordHistoryEntry / storedPosition', () => {
  it('uses one 8-hex id per process', () => {
    expect(processOpId()).toMatch(/^[0-9a-f]{8}$/);
    expect(processOpId()).toBe(processOpId());
    expect(recordHistoryEntry({ from: '', to: 'plan', event: START_EVENT, at: AT }).op).toBe(processOpId());
  });

  it('gives the planners a position without op ids', () => {
    const model = buildFlowModel(sampleFlowDefinition(), '/tmp/sample');
    const record = (readRecord(validRecord(), ISSUE) as { record: TaskRecord }).record;
    const position = storedPosition(record);
    expect(position.history[0]).toEqual({ from: '', to: 'plan', event: 'START', at: AT });
    const state = runtimeFromStored(model, position);
    expect(state.current).toBe('build');
    expect(state.repaired).toBeUndefined();
    expect(planEvent(model, state, 'NEXT', { from: 'build' }).to).toBe('review');

    const unknown = runtimeFromStored(model, storedPosition({ ...record, step: 'gone' }));
    expect(unknown.current).toBe('plan');
    expect(unknown.repaired).toContain('"gone" no longer exists');
  });
});

describe('mergeParams', () => {
  it('sets, stringifies and deletes values and reports changes', () => {
    const { params, changed } = mergeParams({ branch: 'b', slug: 's', old: 'x' }, { slug: 's', specPath: 'docs/specs/x.md', count: 3, draft: false, old: null, gone: null });
    expect(params).toEqual({ branch: 'b', slug: 's', specPath: 'docs/specs/x.md', count: '3', draft: 'false' });
    expect(changed).toEqual(['specPath', 'count', 'draft', 'old']);
    expect(mergeParams({ a: '1' }, undefined)).toEqual({ params: { a: '1' }, changed: [] });
  });

  it.each([
    ['apiToken', 'x'],
    ['client_secret', 'x'],
    ['dbPassword', 'x'],
    ['APIKEY', 'x'],
    ['api_key', 'x'],
    ['credentials', 'x'],
    ['bad-name', 'x'],
    ['1st', 'x'],
    ['x'.repeat(65), 'x'],
    ['note', { nested: true }],
    ['note', ['a']],
    ['note', 'y'.repeat(1001)],
    ['specPath', '/etc/passwd'],
    ['specPath', '../outside.md'],
    ['specPath', 'docs/../../x'],
    ['outputDir', 'C:\\temp'],
    ['outputDir', '\\\\server\\share'],
    ['path', 'a\\..\\..\\b'],
    ['specPath', ''],
  ])('refuses %s = %j with TASK_PARAM_INVALID', (name, value) => {
    expect(caught(() => mergeParams({}, { [name]: value })).code).toBe('TASK_PARAM_INVALID');
  });

  it('accepts plain relative paths and non-path params with slashes', () => {
    expect(mergeParams({}, { specPath: 'docs/specs/x.md', outputDir: 'out/build', prUrl: 'https://example.com/a/../b' }).params).toEqual({
      specPath: 'docs/specs/x.md',
      outputDir: 'out/build',
      prUrl: 'https://example.com/a/../b',
    });
  });

  it('allows at most 30 params', () => {
    const current = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, 'x']));
    expect(caught(() => mergeParams(current, { one: 'more' })).code).toBe('TASK_PARAM_INVALID');
    expect(Object.keys(mergeParams(current, { p0: null, one: 'more' }).params)).toHaveLength(30);
  });
});
