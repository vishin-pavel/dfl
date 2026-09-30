import fs from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TOML_MANAGED_COMMENT,
  hasJsonEntry,
  hasTomlServer,
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

describe('resolveMcpServerSpec', () => {
  it('uses `dfl mcp` for a package outside the project', () => {
    const paths = makeTempProject();
    expect(resolveMcpServerSpec(paths, makeTempDir())).toEqual({ name: 'dfl', command: 'dfl', args: ['mcp'] });
    // Default argument: the running package (this repo) is not inside the temp project.
    expect(resolveMcpServerSpec(paths).command).toBe('dfl');
  });

  it('uses npx when the running package lives in <root>/node_modules', () => {
    const paths = makeTempProject();
    const pkg = path.join(paths.root, 'node_modules', '@vishin-pavel', 'dfl');
    fs.mkdirSync(pkg, { recursive: true });
    expect(resolveMcpServerSpec(paths, pkg)).toEqual({ name: 'dfl', command: 'npx', args: ['--no-install', 'dfl', 'mcp'] });
  });

  it('prefers the config.json override', () => {
    const paths = makeTempProject();
    saveProjectConfig(paths, { version: 1, vars: {}, mcp: { command: 'node', args: ['bin/dfl.js', 'mcp'] } });
    const pkg = path.join(paths.root, 'node_modules', 'dfl');
    expect(resolveMcpServerSpec(paths, pkg)).toEqual({ name: 'dfl', command: 'node', args: ['bin/dfl.js', 'mcp'] });
  });
});
