import fs from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENTS, detectAgents, getAgent, mcpConfigFile, opencodeConfigFile, parseAgentList } from '../src/agents/registry.js';
import { DflError } from '../src/core/errors.js';
import { AGENT_IDS, type AgentId, type McpServerSpec } from '../src/core/types.js';
import { cleanupTempDirs, makeTempDir } from './helpers/project.js';

afterEach(cleanupTempDirs);

const spec: McpServerSpec = { name: 'dfl', command: 'dfl', args: ['mcp'] };

function touch(root: string, rel: string, content = ''): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function mkdir(root: string, rel: string): void {
  fs.mkdirSync(path.join(root, ...rel.split('/')), { recursive: true });
}

function readConfig(root: string, rel: string): Record<string, any> {
  const text = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
  return (rel.endsWith('.toml') ? parseToml(text) : parseJsonc(text)) as Record<string, any>;
}

describe('agent registry', () => {
  it('has one adapter per AgentId in AGENT_IDS order', () => {
    expect(AGENTS.map((agent) => agent.id)).toEqual([...AGENT_IDS]);
    for (const agent of AGENTS) {
      expect(agent.name).not.toBe('');
      expect(agent.skillsDir).toMatch(/^\.[a-z]+\/skills$/);
      expect(agent.mcp).toBeDefined();
      expect(agent.docs).toMatch(/^https:\/\//);
    }
  });

  it('describes skills dirs and invocation per tool', () => {
    const dirs = Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.skillsDir]));
    expect(dirs).toEqual({
      claude: '.claude/skills',
      cursor: '.cursor/skills',
      antigravity: '.agents/skills',
      codex: '.agents/skills',
      gemini: '.gemini/skills',
      copilot: '.github/skills',
      windsurf: '.devin/skills',
      opencode: '.opencode/skills',
      kiro: '.kiro/skills',
    });
    expect(getAgent('claude').invocation('plan-feature')).toBe('/plan-feature');
    expect(getAgent('codex').invocation('plan-feature')).toBe('$plan-feature');
    expect(getAgent('windsurf').name).toBe('Windsurf / Devin');
    expect(getAgent('codex').mcpNote).toMatch(/trusted/);
  });

  it('getAgent normalizes case and rejects unknown ids', () => {
    expect(getAgent(' Cursor ').id).toBe('cursor');
    expect(getAgent('devin').id).toBe('windsurf');
    try {
      getAgent('vim');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DflError);
      expect((error as DflError).code).toBe('UNKNOWN_AGENT');
      expect((error as DflError).hint).toContain(AGENT_IDS.join(', '));
    }
  });
});

describe('parseAgentList', () => {
  it('accepts strings, arrays and comma lists; trims, lowercases and dedupes', () => {
    expect(parseAgentList('claude,cursor')).toEqual(['claude', 'cursor']);
    expect(parseAgentList(['claude', 'cursor'])).toEqual(['claude', 'cursor']);
    expect(parseAgentList(['claude,cursor'])).toEqual(['claude', 'cursor']);
    expect(parseAgentList(' Claude , CURSOR claude,,')).toEqual(['claude', 'cursor']);
    expect(parseAgentList(['kiro', 'codex,kiro'])).toEqual(['kiro', 'codex']);
    expect(parseAgentList('')).toEqual([]);
  });

  it('throws UNKNOWN_AGENT naming every unknown id', () => {
    expect(() => parseAgentList('claude,foo,bar')).toThrow(/Unknown agents "foo", "bar"/);
    expect(() => parseAgentList(['x'])).toThrow(expect.objectContaining({ code: 'UNKNOWN_AGENT' }));
  });
});

describe('detectAgents', () => {
  it('returns nothing for an empty project or shared-only markers', () => {
    const root = makeTempDir();
    expect(detectAgents(root)).toEqual([]);
    touch(root, 'AGENTS.md');
    mkdir(root, '.agents/skills');
    touch(root, '.mcp.json', '{}');
    expect(detectAgents(root)).toEqual([]);
  });

  it.each<[AgentId, string, boolean]>([
    ['claude', 'CLAUDE.md', false],
    ['claude', '.claude', true],
    ['cursor', '.cursor', true],
    ['cursor', '.cursorrules', false],
    ['antigravity', '.agents/mcp_config.json', false],
    ['antigravity', '.agent', true],
    ['codex', '.codex', true],
    ['gemini', 'GEMINI.md', false],
    ['gemini', '.gemini/settings.json', false],
    ['copilot', '.github/copilot-instructions.md', false],
    ['copilot', '.github/skills', true],
    ['windsurf', '.devin', true],
    ['windsurf', '.windsurf', true],
    ['opencode', 'opencode.json', false],
    ['opencode', 'opencode.jsonc', false],
    ['opencode', '.opencode', true],
    ['kiro', '.kiro', true],
  ])('detects %s from %s', (id, marker, dir) => {
    const root = makeTempDir();
    if (dir) mkdir(root, marker);
    else touch(root, marker);
    expect(detectAgents(root)).toEqual([id]);
  });

  it('does not treat Antigravity .gemini/config.json or .github/workflows as Gemini/Copilot', () => {
    const root = makeTempDir();
    touch(root, '.gemini/config.json', '{}');
    mkdir(root, '.github/workflows');
    expect(detectAgents(root)).toEqual(['antigravity']);
  });

  it('returns several agents in registry order', () => {
    const root = makeTempDir();
    mkdir(root, '.kiro');
    touch(root, 'CLAUDE.md');
    mkdir(root, '.codex');
    expect(detectAgents(root)).toEqual(['claude', 'codex', 'kiro']);
  });
});

describe('agent MCP targets', () => {
  const expected: Record<AgentId, { file: string; value: (config: Record<string, any>) => unknown; entry: unknown }> = {
    claude: { file: '.mcp.json', value: (c) => c['mcpServers'].dfl, entry: { type: 'stdio', command: 'dfl', args: ['mcp'] } },
    cursor: { file: '.cursor/mcp.json', value: (c) => c['mcpServers'].dfl, entry: { type: 'stdio', command: 'dfl', args: ['mcp'] } },
    antigravity: { file: '.agents/mcp_config.json', value: (c) => c['mcpServers'].dfl, entry: { command: 'dfl', args: ['mcp'] } },
    codex: { file: '.codex/config.toml', value: (c) => c['mcp_servers'].dfl, entry: { command: 'dfl', args: ['mcp'] } },
    gemini: { file: '.gemini/settings.json', value: (c) => c['mcpServers'].dfl, entry: { command: 'dfl', args: ['mcp'] } },
    copilot: { file: '.mcp.json', value: (c) => c['mcpServers'].dfl, entry: { type: 'stdio', command: 'dfl', args: ['mcp'] } },
    windsurf: { file: '.devin/mcp_config.json', value: (c) => c['mcpServers'].dfl, entry: { command: 'dfl', args: ['mcp'] } },
    opencode: { file: 'opencode.json', value: (c) => c['mcp'].dfl, entry: { type: 'local', command: ['dfl', 'mcp'], enabled: true } },
    kiro: { file: '.kiro/settings/mcp.json', value: (c) => c['mcpServers'].dfl, entry: { command: 'dfl', args: ['mcp'] } },
  };

  it.each(AGENT_IDS.map((id) => [id]))('%s: upsert → has → remove round trip', (id) => {
    const root = makeTempDir();
    const agent = getAgent(id);
    const target = agent.mcp!;
    const want = expected[id];
    expect(target.file).toBe(want.file);
    expect(mcpConfigFile(agent, root)).toBe(want.file);
    expect(target.has(root, 'dfl')).toBe(false);
    expect(target.upsert(root, spec)).toBe(true);
    expect(want.value(readConfig(root, want.file))).toEqual(want.entry);
    expect(target.has(root, 'dfl')).toBe(true);
    expect(target.upsert(root, spec)).toBe(false);
    expect(target.remove(root, 'dfl')).toBe(true);
    expect(target.has(root, 'dfl')).toBe(false);
    // Everything dfl created is gone, including emptied config dirs.
    expect(fs.readdirSync(root)).toEqual([]);
    expect(target.remove(root, 'dfl')).toBe(false);
  });

  it('writes env in each tool’s own shape', () => {
    const root = makeTempDir();
    const withEnv: McpServerSpec = { ...spec, env: { DFL_ROOT: '/p' } };
    getAgent('claude').mcp!.upsert(root, withEnv);
    getAgent('opencode').mcp!.upsert(root, withEnv);
    getAgent('codex').mcp!.upsert(root, withEnv);
    expect(readConfig(root, '.mcp.json')['mcpServers'].dfl.env).toEqual({ DFL_ROOT: '/p' });
    expect(readConfig(root, 'opencode.json')['mcp'].dfl.environment).toEqual({ DFL_ROOT: '/p' });
    expect(readConfig(root, '.codex/config.toml')['mcp_servers'].dfl.env).toEqual({ DFL_ROOT: '/p' });
  });

  it('shares .mcp.json between Claude Code and Copilot', () => {
    const root = makeTempDir();
    touch(root, '.mcp.json', '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n');
    expect(getAgent('claude').mcp!.upsert(root, spec)).toBe(true);
    expect(getAgent('copilot').mcp!.upsert(root, spec)).toBe(false);
    expect(getAgent('copilot').mcp!.remove(root, 'dfl')).toBe(true);
    expect(readConfig(root, '.mcp.json')).toEqual({ mcpServers: { other: { command: 'x' } } });
  });

  it('keeps unrelated Kiro files when removing', () => {
    const root = makeTempDir();
    touch(root, '.kiro/steering/rules.md', '# rules');
    const kiro = getAgent('kiro').mcp!;
    kiro.upsert(root, spec);
    kiro.remove(root, 'dfl');
    expect(fs.existsSync(path.join(root, '.kiro', 'settings'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.kiro', 'steering', 'rules.md'))).toBe(true);
  });

  describe('opencode config file choice', () => {
    it('adds $schema to a new opencode.json', () => {
      const root = makeTempDir();
      getAgent('opencode').mcp!.upsert(root, spec);
      expect(readConfig(root, 'opencode.json')['$schema']).toBe('https://opencode.ai/config.json');
    });

    it('uses opencode.jsonc when only that exists, preserving its comments', () => {
      const root = makeTempDir();
      touch(root, 'opencode.jsonc', '{\n  // my config\n  "theme": "dark"\n}\n');
      expect(opencodeConfigFile(root)).toBe('opencode.jsonc');
      expect(mcpConfigFile(getAgent('opencode'), root)).toBe('opencode.jsonc');
      getAgent('opencode').mcp!.upsert(root, spec);
      expect(fs.existsSync(path.join(root, 'opencode.json'))).toBe(false);
      const text = fs.readFileSync(path.join(root, 'opencode.jsonc'), 'utf8');
      expect(text).toContain('// my config');
      expect(parseJsonc(text)).toEqual({ theme: 'dark', mcp: { dfl: { type: 'local', command: ['dfl', 'mcp'], enabled: true } } });
      expect(getAgent('opencode').mcp!.has(root, 'dfl')).toBe(true);
      expect(getAgent('opencode').mcp!.remove(root, 'dfl')).toBe(true);
      expect(parseJsonc(fs.readFileSync(path.join(root, 'opencode.jsonc'), 'utf8'))).toEqual({ theme: 'dark' });
    });

    it('uses opencode.json when both exist, unless the .jsonc already has the entry', () => {
      const root = makeTempDir();
      touch(root, 'opencode.json', '{}\n');
      touch(root, 'opencode.jsonc', '{}\n');
      expect(opencodeConfigFile(root)).toBe('opencode.json');
      touch(root, 'opencode.jsonc', '{ "mcp": { "dfl": { "type": "local", "command": ["old"] } } }\n');
      expect(opencodeConfigFile(root)).toBe('opencode.jsonc');
    });
  });
});
