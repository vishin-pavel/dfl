import fs from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TOML_MANAGED_COMMENT,
  dflLauncher,
  hasJsonEntry,
  hasTomlServer,
  isCommandOnPath,
  isDflLauncher,
  localInstallPrefix,
  planJsonUpsert,
  planTomlUpsert,
  projectDependsOnDfl,
  readJsonEntry,
  readTomlServer,
  removeJsonEntry,
  removeTomlServer,
  resolveMcpServerSpec,
  upsertJsonEntry,
  upsertTomlServer,
} from '../src/agents/mcp-config.js';
import { saveProjectConfig } from '../src/core/config.js';
import { DflError } from '../src/core/errors.js';
import type { McpServerSpec } from '../src/core/types.js';
import { cleanupTempDirs, makeTempDir, makeTempProject } from './helpers/project.js';

afterEach(cleanupTempDirs);

const entry = { type: 'stdio', command: 'dfl', args: ['mcp'] };
const spec: McpServerSpec = { name: 'dfl', command: 'dfl', args: ['mcp'] };

function tempFile(name: string, content?: string): string {
  const file = path.join(makeTempDir(), ...name.split('/'));
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return file;
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');

describe('upsertJsonEntry', () => {
  it('creates the file (and parent dirs) with 2-space indentation and a trailing newline', () => {
    const file = tempFile('.cursor/mcp.json');
    expect(upsertJsonEntry(file, ['mcpServers'], 'dfl', entry)).toBe(true);
    expect(read(file)).toBe(`${JSON.stringify({ mcpServers: { dfl: entry } }, null, 2)}\n`);
  });

  it('seeds a new file with the initial object', () => {
    const file = tempFile('opencode.json');
    upsertJsonEntry(file, ['mcp'], 'dfl', { type: 'local' }, { initial: { $schema: 'https://opencode.ai/config.json' } });
    expect(JSON.parse(read(file))).toEqual({ $schema: 'https://opencode.ai/config.json', mcp: { dfl: { type: 'local' } } });
  });

  it('is idempotent and does not rewrite an equal entry with a different key order', () => {
    const file = tempFile('.mcp.json');
    upsertJsonEntry(file, ['mcpServers'], 'dfl', entry);
    const before = read(file);
    expect(upsertJsonEntry(file, ['mcpServers'], 'dfl', entry)).toBe(false);
    const reordered = '{ "mcpServers": { "dfl": { "args": ["mcp"], "command": "dfl", "type": "stdio" } } }';
    fs.writeFileSync(file, reordered);
    expect(upsertJsonEntry(file, ['mcpServers'], 'dfl', entry)).toBe(false);
    expect(read(file)).toBe(reordered);
    expect(before).not.toBe(reordered);
  });

  it('preserves comments, unrelated keys, their order and formatting (JSONC)', () => {
    const original = [
      '{',
      '  // editor settings',
      '  "theme": "Default",',
      '  "general": { "vimMode": true },',
      '  "mcpServers": {',
      '    /* other server */',
      '    "other": { "command": "other" }',
      '  },',
      '  "zzz": [1, 2]',
      '}',
      '',
    ].join('\n');
    const file = tempFile('.gemini/settings.json', original);
    expect(upsertJsonEntry(file, ['mcpServers'], 'dfl', { command: 'dfl', args: ['mcp'] })).toBe(true);
    const text = read(file);
    expect(text).toContain('// editor settings');
    expect(text).toContain('/* other server */');
    expect(text).toContain('"general": { "vimMode": true },');
    expect(text).toContain('"other": { "command": "other" },');
    expect(text).toContain('"zzz": [1, 2]\n}\n');
    const parsed = parseJsonc(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['theme', 'general', 'mcpServers', 'zzz']);
    expect(parsed['mcpServers']).toEqual({ other: { command: 'other' }, dfl: { command: 'dfl', args: ['mcp'] } });
    expect(text).toContain('\n    "dfl": {\n      "command": "dfl",\n');
  });

  it('adds the container key when it is missing', () => {
    const file = tempFile('.mcp.json', '{\n  "a": 1\n}\n');
    upsertJsonEntry(file, ['mcpServers'], 'dfl', entry);
    expect(JSON.parse(read(file))).toEqual({ a: 1, mcpServers: { dfl: entry } });
  });

  it('detects 4-space and tab indentation and CRLF line endings', () => {
    const spaces = tempFile('a.json', '{\r\n    "a": 1\r\n}\r\n');
    upsertJsonEntry(spaces, ['mcpServers'], 'dfl', { command: 'dfl' });
    expect(read(spaces)).toBe('{\r\n    "a": 1,\r\n    "mcpServers": {\r\n        "dfl": {\r\n            "command": "dfl"\r\n        }\r\n    }\r\n}\r\n');

    const tabs = tempFile('b.json', '{\n\t"a": 1\n}');
    upsertJsonEntry(tabs, ['mcp'], 'dfl', { enabled: true });
    expect(read(tabs)).toBe('{\n\t"a": 1,\n\t"mcp": {\n\t\t"dfl": {\n\t\t\t"enabled": true\n\t\t}\n\t}\n}');
  });

  it('replaces a stale entry in place', () => {
    const file = tempFile('.mcp.json', '{\n  "mcpServers": {\n    "dfl": { "command": "old" },\n    "b": {}\n  }\n}\n');
    expect(upsertJsonEntry(file, ['mcpServers'], 'dfl', entry)).toBe(true);
    const parsed = JSON.parse(read(file)) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers)).toEqual(['dfl', 'b']);
    expect(parsed.mcpServers['dfl']).toEqual(entry);
  });

  it('throws DflError on invalid JSON or a non-object container', () => {
    const broken = tempFile('.mcp.json', '{ "mcpServers": { ');
    expect(() => upsertJsonEntry(broken, ['mcpServers'], 'dfl', entry)).toThrow(DflError);
    const array = tempFile('.mcp.json', '{ "mcpServers": [] }');
    expect(() => upsertJsonEntry(array, ['mcpServers'], 'dfl', entry)).toThrow(/not an object/);
    const root = tempFile('.mcp.json', '[]');
    expect(() => upsertJsonEntry(root, ['mcpServers'], 'dfl', entry)).toThrow(/top-level/);
    expect(read(broken)).toBe('{ "mcpServers": { ');
  });

  it('treats an empty file as new', () => {
    const file = tempFile('.mcp.json', '\n');
    upsertJsonEntry(file, ['mcpServers'], 'dfl', entry);
    expect(JSON.parse(read(file))).toEqual({ mcpServers: { dfl: entry } });
  });
});

describe('removeJsonEntry / hasJsonEntry', () => {
  it('deletes a file that only held the dfl entry', () => {
    const file = tempFile('.mcp.json');
    upsertJsonEntry(file, ['mcpServers'], 'dfl', entry);
    expect(hasJsonEntry(file, ['mcpServers'], 'dfl')).toBe(true);
    expect(removeJsonEntry(file, ['mcpServers'], 'dfl')).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(hasJsonEntry(file, ['mcpServers'], 'dfl')).toBe(false);
    expect(removeJsonEntry(file, ['mcpServers'], 'dfl')).toBe(false);
  });

  it('treats $schema as disposable when deciding to delete', () => {
    const file = tempFile('opencode.json');
    upsertJsonEntry(file, ['mcp'], 'dfl', { type: 'local' }, { initial: { $schema: 'x' } });
    expect(removeJsonEntry(file, ['mcp'], 'dfl')).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps other servers and other keys, and drops the emptied container', () => {
    const original = '{\n  // keep me\n  "a": 1,\n  "mcpServers": {\n    "x": {},\n    "dfl": { "command": "dfl" }\n  }\n}\n';
    const file = tempFile('.mcp.json', original);
    expect(removeJsonEntry(file, ['mcpServers'], 'dfl')).toBe(true);
    expect(read(file)).toBe('{\n  // keep me\n  "a": 1,\n  "mcpServers": {\n    "x": {}\n  }\n}\n');
    expect(removeJsonEntry(file, ['mcpServers'], 'x')).toBe(true);
    expect(read(file)).toBe('{\n  // keep me\n  "a": 1\n}\n');
  });

  it('keeps a file whose remaining content is only comments', () => {
    const file = tempFile('.mcp.json', '{\n  "mcpServers": {\n    "dfl": {}\n  }\n  // note\n}\n');
    expect(removeJsonEntry(file, ['mcpServers'], 'dfl')).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(parseJsonc(read(file))).toEqual({});
  });

  it('does not touch a file without the entry', () => {
    const original = '{ "mcpServers": { "x": {} } }';
    const file = tempFile('.mcp.json', original);
    expect(removeJsonEntry(file, ['mcpServers'], 'dfl')).toBe(false);
    expect(read(file)).toBe(original);
  });
});

describe('TOML server table', () => {
  const existing = [
    '# my codex config',
    'model = "o5"',
    '',
    '[mcp_servers.other]',
    'command = "other"',
    '',
    '# comment about the profile',
    '[profiles.fast]',
    'model = "mini"',
    'notes = """',
    '[mcp_servers.dfl]',
    'not a header',
    '"""',
    'list = [',
    '  [1, 2]',
    ']',
    '',
  ].join('\n');

  it('creates a new file that parses as TOML', () => {
    const file = tempFile('.codex/config.toml');
    expect(upsertTomlServer(file, spec)).toBe(true);
    expect(read(file)).toBe(`${TOML_MANAGED_COMMENT}\n[mcp_servers.dfl]\ncommand = "dfl"\nargs = ["mcp"]\n`);
    expect(parseToml(read(file))).toEqual({ mcp_servers: { dfl: { command: 'dfl', args: ['mcp'] } } });
    expect(hasTomlServer(file, 'dfl')).toBe(true);
    expect(upsertTomlServer(file, spec)).toBe(false);
  });

  it('appends to an existing file without touching other content, idempotently', () => {
    const file = tempFile('.codex/config.toml', existing);
    expect(hasTomlServer(file, 'dfl')).toBe(false);
    expect(upsertTomlServer(file, spec)).toBe(true);
    const text = read(file);
    expect(text.startsWith(existing)).toBe(true);
    expect(text.slice(existing.length)).toBe(`\n${TOML_MANAGED_COMMENT}\n[mcp_servers.dfl]\ncommand = "dfl"\nargs = ["mcp"]\n`);
    const parsed = parseToml(text) as Record<string, any>;
    expect(parsed['mcp_servers']).toEqual({ other: { command: 'other' }, dfl: { command: 'dfl', args: ['mcp'] } });
    expect(parsed['profiles'].fast.notes).toContain('[mcp_servers.dfl]');
    expect(upsertTomlServer(file, spec)).toBe(false);
    expect(read(file)).toBe(text);
  });

  it('replaces an existing table in place and renders env as a subtable with escaping', () => {
    const original = ['model = "o5"', '', '[mcp_servers."dfl"]', 'command = "old"', '', '[mcp_servers.dfl.tools.get_flow]', 'approval_mode = "auto"', '', '[other]', 'x = 1', ''].join('\n');
    const file = tempFile('config.toml', original);
    const tricky: McpServerSpec = {
      name: 'dfl',
      command: 'C:\\tools\\dfl "x"',
      args: ['mcp', 'line\nbreak', 'tab\there', 'bell\u0007', 'ünï'],
      env: { DFL_ROOT: '/abs/path', 'WEIRD KEY': 'v' },
    };
    expect(upsertTomlServer(file, tricky)).toBe(true);
    const text = read(file);
    const parsed = parseToml(text) as Record<string, any>;
    expect(parsed['mcp_servers'].dfl).toEqual({
      command: tricky.command,
      args: tricky.args,
      env: tricky.env,
      tools: { get_flow: { approval_mode: 'auto' } },
    });
    expect(parsed['other']).toEqual({ x: 1 });
    expect(text.indexOf('[mcp_servers.dfl]')).toBeLessThan(text.indexOf('[other]'));
    expect(text).not.toContain('"old"');
    expect(upsertTomlServer(file, tricky)).toBe(false);

    // Dropping env removes the env subtable again.
    expect(upsertTomlServer(file, spec)).toBe(true);
    expect((parseToml(read(file)) as Record<string, any>)['mcp_servers'].dfl.env).toBeUndefined();
  });

  it('removes the table with all its subtables and keeps the rest', () => {
    const file = tempFile('config.toml', existing);
    upsertTomlServer(file, { ...spec, env: { A: 'b' } });
    fs.appendFileSync(file, '\n[mcp_servers.dfl.tools.x]\napproval_mode = "auto"\n');
    expect(removeTomlServer(file, 'dfl')).toBe(true);
    expect(read(file)).toBe(existing);
    expect(hasTomlServer(file, 'dfl')).toBe(false);
    expect(removeTomlServer(file, 'dfl')).toBe(false);
  });

  it('removes a table in the middle and collapses blank lines', () => {
    const file = tempFile('config.toml', 'a = 1\n\n[mcp_servers.dfl]\ncommand = "dfl"\n\n[b]\nc = 2\n');
    expect(removeTomlServer(file, 'dfl')).toBe(true);
    expect(read(file)).toBe('a = 1\n\n[b]\nc = 2\n');
  });

  it('deletes the file when only the dfl table was in it', () => {
    const file = tempFile('.codex/config.toml');
    upsertTomlServer(file, { ...spec, env: { A: 'b' } });
    expect(removeTomlServer(file, 'dfl')).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('resolveMcpServerSpec / dflLauncher (depends on the project, never on the running binary)', () => {
  const npx = { name: 'dfl', command: 'npx', args: ['--no-install', 'dfl', 'mcp'] };
  const global = { name: 'dfl', command: 'dfl', args: ['mcp'] };

  it('uses `dfl mcp` when the project does not depend on dfl, wherever the running package lives', () => {
    const paths = makeTempProject();
    expect(resolveMcpServerSpec(paths, makeTempDir())).toEqual(global);
    expect(resolveMcpServerSpec(paths).command).toBe('dfl');
    // Installed in node_modules without a package.json dependency: still the global form.
    const pkg = path.join(paths.root, 'node_modules', '@vishin-pavel', 'dfl');
    fs.mkdirSync(pkg, { recursive: true });
    expect(resolveMcpServerSpec(paths, pkg)).toEqual(global);
    expect(dflLauncher(paths)).toBe('dfl');
    fs.writeFileSync(path.join(paths.root, 'package.json'), '{ "devDependencies": { "other": "1" } }');
    expect(resolveMcpServerSpec(paths, pkg)).toEqual(global);
    fs.writeFileSync(path.join(paths.root, 'package.json'), '{ not json');
    expect(projectDependsOnDfl(paths.root)).toBe(false);
  });

  it.each(['dependencies', 'devDependencies', 'optionalDependencies'])(
    'uses `npx --no-install dfl mcp` when package.json lists dfl in %s (running binary irrelevant)',
    (key) => {
      const paths = makeTempProject();
      fs.writeFileSync(path.join(paths.root, 'package.json'), JSON.stringify({ [key]: { '@vishin-pavel/dfl': '^0.1.0' } }));
      expect(projectDependsOnDfl(paths.root)).toBe(true);
      // Global binary, local binary, default: always the same committed entry.
      expect(resolveMcpServerSpec(paths, makeTempDir())).toEqual(npx);
      expect(resolveMcpServerSpec(paths, path.join(paths.root, 'node_modules', '@vishin-pavel', 'dfl'))).toEqual(npx);
      expect(resolveMcpServerSpec(paths)).toEqual(npx);
      expect(dflLauncher(paths)).toBe('npx --no-install dfl');
      expect(dflLauncher(paths.root)).toBe('npx --no-install dfl');
    },
  );

  it('prefers the config.json override', () => {
    const paths = makeTempProject();
    fs.writeFileSync(path.join(paths.root, 'package.json'), JSON.stringify({ devDependencies: { '@vishin-pavel/dfl': '1' } }));
    saveProjectConfig(paths, { version: 1, vars: {}, mcp: { command: 'node', args: ['bin/dfl.js', 'mcp'] } });
    const pkg = path.join(paths.root, 'node_modules', 'dfl');
    expect(resolveMcpServerSpec(paths, pkg)).toEqual({ name: 'dfl', command: 'node', args: ['bin/dfl.js', 'mcp'] });
    // The CLI launcher (dfl.cli) ignores the MCP override.
    expect(dflLauncher(paths)).toBe('npx --no-install dfl');
  });
});

describe('isDflLauncher', () => {
  it('accepts dfl, npx/pnpm/yarn running dfl and the config override; rejects anything else', () => {
    expect(isDflLauncher({ command: 'dfl', args: ['mcp'] })).toBe(true);
    expect(isDflLauncher({ command: '/usr/local/bin/dfl', args: ['mcp'] })).toBe(true);
    expect(isDflLauncher({ command: 'C:\\tools\\dfl.cmd', args: ['mcp'] })).toBe(true);
    expect(isDflLauncher({ command: 'npx', args: ['--no-install', 'dfl', 'mcp'] })).toBe(true);
    expect(isDflLauncher({ command: 'pnpm', args: ['exec', 'dfl', 'mcp'] })).toBe(true);
    expect(isDflLauncher({ command: 'yarn', args: ['@vishin-pavel/dfl@1.0.0', 'mcp'] })).toBe(true);
    expect(isDflLauncher({ command: 'npx', args: ['-y', 'some-server'] })).toBe(false);
    expect(isDflLauncher({ command: 'gh', args: ['mcp'] })).toBe(false);
    expect(isDflLauncher({ command: 42, args: [] })).toBe(false);
    const override = { command: 'node', args: ['bin/dfl.js', 'mcp'] };
    expect(isDflLauncher({ command: 'node', args: ['bin/dfl.js', 'mcp'] }, override)).toBe(true);
    expect(isDflLauncher({ command: 'node', args: ['other.js'] }, override)).toBe(false);
  });
});

describe('dry-run planning (F83)', () => {
  it('JSON: added for a missing file, unchanged for an equal entry, updated for different args', () => {
    const file = tempFile('.mcp.json');
    expect(planJsonUpsert(file, ['mcpServers'], 'dfl', entry)).toBe('added');
    expect(fs.existsSync(file)).toBe(false);
    upsertJsonEntry(file, ['mcpServers'], 'dfl', entry);
    const before = read(file);
    expect(planJsonUpsert(file, ['mcpServers'], 'dfl', entry)).toBe('unchanged');
    expect(planJsonUpsert(file, ['mcpServers'], 'dfl', { ...entry, args: ['x'] })).toBe('updated');
    expect(read(file)).toBe(before);
    expect(() => planJsonUpsert(tempFile('bad.json', '{ ,'), ['mcpServers'], 'dfl', entry)).toThrow(DflError);
  });

  it('TOML: added, unchanged and updated (different command)', () => {
    const file = tempFile('.codex/config.toml');
    expect(planTomlUpsert(file, spec)).toBe('added');
    upsertTomlServer(file, spec);
    expect(planTomlUpsert(file, spec)).toBe('unchanged');
    const before = read(file);
    expect(planTomlUpsert(file, { ...spec, command: 'npx', args: ['--no-install', 'dfl', 'mcp'] })).toBe('updated');
    expect(read(file)).toBe(before);
  });
});

describe('reading entries', () => {
  it('reads JSON entries and TOML server tables', () => {
    const json = tempFile('.mcp.json', '{ "mcpServers": { "dfl": { "command": "npx", "args": ["dfl", "mcp"] } } }');
    expect(readJsonEntry(json, ['mcpServers'], 'dfl')).toEqual({ command: 'npx', args: ['dfl', 'mcp'] });
    expect(readJsonEntry(json, ['mcpServers'], 'x')).toBeUndefined();
    expect(readJsonEntry(tempFile('none.json'), ['mcpServers'], 'dfl')).toBeUndefined();
    expect(() => readJsonEntry(tempFile('bad.json', '{ ,'), ['mcpServers'], 'dfl')).toThrow(DflError);

    const toml = tempFile('config.toml', '[mcp_servers.dfl]\ncommand = "pnpm"\nargs = [\n  "exec",\n  \'dfl\',\n  "mcp",\n]\n\n[other]\nx = 1\n');
    expect(readTomlServer(toml, 'dfl')).toEqual({ command: 'pnpm', args: ['exec', 'dfl', 'mcp'] });
    expect(readTomlServer(toml, 'nope')).toBeUndefined();
    const escaped = tempFile('esc.toml', '[mcp_servers.dfl]\ncommand = "C:\\\\bin\\\\dfl"\nargs = ["mcp"]\n');
    expect(readTomlServer(escaped, 'dfl')).toEqual({ command: 'C:\\bin\\dfl', args: ['mcp'] });
  });
});

describe('removing without deleting what dfl did not create (F22)', () => {
  it.each([
    ['{"mcpServers": {}}\n', ['mcpServers']],
    ['{}\n', ['mcpServers']],
    ['{\n  "$schema": "https://opencode.ai/config.json"\n}\n', ['mcp']],
    ['{"$schema": "x", "mcp": {}}\n', ['mcp']],
  ])('keeps %j', (original, keyPath) => {
    const file = tempFile('.kiro/settings/mcp.json', original);
    upsertJsonEntry(file, keyPath, 'dfl', entry);
    expect(removeJsonEntry(file, keyPath, 'dfl', { deleteEmptyFile: false, dropEmptyContainer: original.includes(`"${keyPath[0]}"`) ? false : true })).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(parseJsonc(read(file))).toEqual(parseJsonc(original));
  });

  it('restores an empty container byte for byte', () => {
    const original = '{"mcpServers": {}}\n';
    const file = tempFile('.mcp.json', original);
    upsertJsonEntry(file, ['mcpServers'], 'dfl', entry);
    removeJsonEntry(file, ['mcpServers'], 'dfl', { deleteEmptyFile: false, dropEmptyContainer: false });
    expect(read(file)).toBe(original);
  });

  it('keeps an emptied TOML file dfl did not create', () => {
    const file = tempFile('.codex/config.toml', '\n');
    upsertTomlServer(file, spec);
    expect(removeTomlServer(file, 'dfl', { deleteEmptyFile: false })).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(read(file).trim()).toBe('');
  });
});

describe('localInstallPrefix / isCommandOnPath (F81)', () => {
  it('names the directory whose node_modules holds the package', () => {
    const root = makeTempDir();
    const nested = path.join(root, 'frontend', 'node_modules', '@vishin-pavel', 'dfl');
    const top = path.join(root, 'node_modules', '@vishin-pavel', 'dfl');
    const pnpm = path.join(root, 'node_modules', '.pnpm', 'dfl@1', 'node_modules', '@vishin-pavel', 'dfl');
    for (const dir of [nested, top, pnpm]) fs.mkdirSync(dir, { recursive: true });
    expect(localInstallPrefix(root, nested)).toBe('frontend');
    expect(localInstallPrefix(root, top)).toBe('');
    expect(localInstallPrefix(root, pnpm)).toBe('');
    expect(localInstallPrefix(root, makeTempDir())).toBeUndefined();
    expect(localInstallPrefix(root, root)).toBeUndefined();
  });

  it('finds executables on PATH only', () => {
    const bin = makeTempDir();
    expect(isCommandOnPath('dfl', { PATH: bin })).toBe(false);
    fs.writeFileSync(path.join(bin, 'dfl'), '#!/bin/sh\n', { mode: 0o755 });
    expect(isCommandOnPath('dfl', { PATH: bin })).toBe(true);
    expect(isCommandOnPath('dfl', { PATH: '' })).toBe(false);
  });
});
