/**
 * Supported agents. Paths come from docs/AGENTS.md (researched 2026-09-30).
 */
import path from 'node:path';
import { DflError } from '../core/errors.js';
import { exists, removeEmptyDirsUpTo } from '../core/fsx.js';
import { AGENT_IDS, type AgentId, type McpServerSpec } from '../core/types.js';
import {
  MCP_SERVER_NAME,
  hasJsonContainer,
  hasJsonEntry,
  hasTomlServer,
  jsonFileExists,
  planJsonUpsert,
  planTomlUpsert,
  readJsonEntry,
  readTomlServer,
  removeJsonEntry,
  removeTomlServer,
  upsertJsonEntry,
  upsertTomlServer,
} from './mcp-config.js';
import type { AgentAdapter, McpTarget } from './types.js';

/** Alternative names accepted by `parseAgentList` / `getAgent`. */
export const AGENT_ALIASES: Readonly<Record<string, AgentId>> = {
  'claude-code': 'claude',
  agy: 'antigravity',
  'gemini-cli': 'gemini',
  'github-copilot': 'copilot',
  devin: 'windsurf',
};

function absPath(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

/** Detector: true when any of the project-relative marker paths exists. */
function markers(...paths: string[]): (root: string) => boolean {
  return (root) => paths.some((marker) => exists(absPath(root, marker)));
}

const slash = (skillName: string): string => `/${skillName}`;

// ---------------------------------------------------------------------------
// MCP entry shapes
// ---------------------------------------------------------------------------

function envOf(spec: McpServerSpec): Record<string, string> | undefined {
  return spec.env && Object.keys(spec.env).length > 0 ? { ...spec.env } : undefined;
}

/** `{ command, args, env? }` – Antigravity, Gemini CLI, Devin, Kiro (no `type` key documented). */
function plainEntry(spec: McpServerSpec): Record<string, unknown> {
  const env = envOf(spec);
  return { command: spec.command, args: [...spec.args], ...(env ? { env } : {}) };
}

/** `{ type: 'stdio', command, args, env? }` – Claude Code, Cursor, Copilot (`.mcp.json`). */
function stdioEntry(spec: McpServerSpec): Record<string, unknown> {
  return { type: 'stdio', ...plainEntry(spec) };
}

/** OpenCode: one `command` array and `environment` instead of `env`. */
function opencodeEntry(spec: McpServerSpec): Record<string, unknown> {
  const env = envOf(spec);
  return { type: 'local', command: [spec.command, ...spec.args], enabled: true, ...(env ? { environment: env } : {}) };
}

// ---------------------------------------------------------------------------
// MCP targets
// ---------------------------------------------------------------------------

/** Removes config dirs dfl emptied (e.g. `.kiro/settings/`), never the project root. */
function cleanupDirs(root: string, file: string): void {
  removeEmptyDirsUpTo(path.dirname(absPath(root, file)), root);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** `{ command, args }` of a `{ command: string, args: string[] }` entry. */
function commandOf(value: unknown): { command: string | undefined; args: string[] } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value === undefined ? undefined : { command: undefined, args: [] };
  const record = value as Record<string, unknown>;
  return { command: typeof record['command'] === 'string' ? record['command'] : undefined, args: strings(record['args']) };
}

/** OpenCode keeps the command and its args in one `command` array. */
function opencodeCommandOf(value: unknown): { command: string | undefined; args: string[] } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value === undefined ? undefined : { command: undefined, args: [] };
  const [command, ...args] = strings((value as Record<string, unknown>)['command']);
  return { command, args };
}

function jsonTarget(
  file: string,
  format: 'json' | 'jsonc',
  keyPath: string[],
  toEntry: (spec: McpServerSpec) => unknown,
): McpTarget {
  return {
    file,
    format,
    upsert: (root, spec) => upsertJsonEntry(absPath(root, file), keyPath, spec.name, toEntry(spec)),
    plan: (root, spec) => planJsonUpsert(absPath(root, file), keyPath, spec.name, toEntry(spec)),
    remove: (root, name, options) => {
      const abs = absPath(root, file);
      const changed = removeJsonEntry(abs, keyPath, name, options);
      if (changed && !exists(abs) && options?.removeEmptyDirs !== false) cleanupDirs(root, file);
      return changed;
    },
    has: (root, name) => hasJsonEntry(absPath(root, file), keyPath, name),
    read: (root, name) => commandOf(readJsonEntry(absPath(root, file), keyPath, name)),
    inspect: (root) => ({
      file,
      exists: jsonFileExists(absPath(root, file)),
      container: hasJsonContainer(absPath(root, file), keyPath),
    }),
  };
}

function tomlTarget(file: string): McpTarget {
  return {
    file,
    format: 'toml',
    upsert: (root, spec) => upsertTomlServer(absPath(root, file), spec),
    plan: (root, spec) => planTomlUpsert(absPath(root, file), spec),
    remove: (root, name, options) => {
      const abs = absPath(root, file);
      const changed = removeTomlServer(abs, name, { deleteEmptyFile: options?.deleteEmptyFile });
      if (changed && !exists(abs) && options?.removeEmptyDirs !== false) cleanupDirs(root, file);
      return changed;
    },
    has: (root, name) => hasTomlServer(absPath(root, file), name),
    read: (root, name) => {
      const server = readTomlServer(absPath(root, file), name);
      return server === undefined ? undefined : { command: server.command, args: server.args ?? [] };
    },
    inspect: (root) => ({ file, exists: jsonFileExists(absPath(root, file)), container: true }),
  };
}

const OPENCODE_JSON = 'opencode.json';
const OPENCODE_JSONC = 'opencode.jsonc';
const OPENCODE_SCHEMA = 'https://opencode.ai/config.json';

/**
 * The OpenCode config file dfl writes to: `opencode.jsonc` when it exists and either
 * `opencode.json` does not or the `.jsonc` already holds the entry (it wins merge conflicts);
 * otherwise `opencode.json`.
 */
export function opencodeConfigFile(root: string, name: string = MCP_SERVER_NAME): string {
  const jsonc = absPath(root, OPENCODE_JSONC);
  if (!exists(jsonc)) return OPENCODE_JSON;
  if (!exists(absPath(root, OPENCODE_JSON)) || hasJsonEntry(jsonc, ['mcp'], name)) return OPENCODE_JSONC;
  return OPENCODE_JSON;
}

/** OpenCode files a remove/read may touch: the one asked for, else both. */
function opencodeFiles(file: string | undefined): string[] {
  return file === OPENCODE_JSON || file === OPENCODE_JSONC ? [file] : [OPENCODE_JSONC, OPENCODE_JSON];
}

const opencodeInitial = { initial: { $schema: OPENCODE_SCHEMA } };

const opencodeTarget: McpTarget = {
  file: OPENCODE_JSON,
  format: 'jsonc',
  upsert: (root, spec) =>
    upsertJsonEntry(absPath(root, opencodeConfigFile(root, spec.name)), ['mcp'], spec.name, opencodeEntry(spec), opencodeInitial),
  plan: (root, spec) =>
    planJsonUpsert(absPath(root, opencodeConfigFile(root, spec.name)), ['mcp'], spec.name, opencodeEntry(spec), opencodeInitial),
  remove: (root, name, options) =>
    opencodeFiles(options?.file)
      .map((file) => removeJsonEntry(absPath(root, file), ['mcp'], name, options))
      .some(Boolean),
  has: (root, name) => [OPENCODE_JSON, OPENCODE_JSONC].some((file) => hasJsonEntry(absPath(root, file), ['mcp'], name)),
  read: (root, name, file) => {
    for (const candidate of opencodeFiles(file)) {
      const found = opencodeCommandOf(readJsonEntry(absPath(root, candidate), ['mcp'], name));
      if (found) return found;
    }
    return undefined;
  },
  inspect: (root) => {
    const file = opencodeConfigFile(root);
    return { file, exists: jsonFileExists(absPath(root, file)), container: hasJsonContainer(absPath(root, file), ['mcp']) };
  },
};

/** True for a project-relative MCP config file some adapter writes (manifest entries must name one of these). */
export function isKnownMcpFile(file: string): boolean {
  return mcpTargetForFile(file) !== undefined;
}

/** The MCP target that writes `file` (OpenCode for both of its files); undefined for unknown files. */
export function mcpTargetForFile(file: string): McpTarget | undefined {
  if (file === OPENCODE_JSON || file === OPENCODE_JSONC) return opencodeTarget;
  return AGENTS.find((adapter) => adapter.mcp?.file === file)?.mcp;
}

/**
 * Project-relative path of the MCP config file `agent` writes for `root` (OpenCode picks
 * `opencode.json` or `opencode.jsonc`); undefined when the agent has no project MCP config.
 */
export function mcpConfigFile(agent: AgentAdapter, root: string): string | undefined {
  if (!agent.mcp) return undefined;
  return agent.id === 'opencode' ? opencodeConfigFile(root) : agent.mcp.file;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

const claude: AgentAdapter = {
  id: 'claude',
  name: 'Claude Code',
  skillsDir: '.claude/skills',
  invocation: slash,
  // .mcp.json is shared with Copilot, AGENTS.md with everyone: not markers.
  detect: markers('.claude', 'CLAUDE.md', 'CLAUDE.local.md'),
  mcp: jsonTarget('.mcp.json', 'json', ['mcpServers'], stdioEntry),
  mcpNote: 'Claude Code asks to approve servers from .mcp.json on first use (reset with `claude mcp reset-project-choices`).',
  notes:
    'Skills are picked up live; if .claude/skills did not exist when the session started, run /reload-skills. Claude Code does not read .agents/skills.',
  docs: 'https://code.claude.com/docs/en/skills',
};

const cursor: AgentAdapter = {
  id: 'cursor',
  name: 'Cursor',
  skillsDir: '.cursor/skills',
  invocation: slash,
  detect: markers('.cursor', '.cursorrules', '.cursorignore', '.cursorindexingignore'),
  mcp: jsonTarget('.cursor/mcp.json', 'json', ['mcpServers'], stdioEntry),
  mcpNote:
    'Approve the dfl server in Cursor (Customize > MCPs) and restart Cursor after .cursor/mcp.json changes; in the Cursor CLI run `agent mcp enable dfl`.',
  notes: 'The Cursor CLI (`agent`) has no file watcher: start a new session after installing skills.',
  docs: 'https://cursor.com/docs/skills',
};

const antigravity: AgentAdapter = {
  id: 'antigravity',
  name: 'Google Antigravity',
  skillsDir: '.agents/skills',
  invocation: slash,
  // .agents/skills and .gemini/ alone are shared with Codex / Gemini CLI.
  detect: markers(
    '.agents/mcp_config.json',
    '.agents/rules.json',
    '.agents/skills.json',
    '.agents/hooks.json',
    '.agents/plugins',
    '.agents/agents',
    '.agents/workflows',
    '.agent',
    '.antigravityignore',
    '.gemini/config.json',
  ),
  mcp: jsonTarget('.agents/mcp_config.json', 'json', ['mcpServers'], plainEntry),
  mcpNote:
    'The Antigravity CLI (`agy`) may ignore the workspace .agents/mcp_config.json (google-antigravity/antigravity-cli#60). ' +
    'If the dfl tools are missing, add the server to the global ~/.gemini/config/mcp_config.json (e.g. `agy mcp add`). ' +
    'The global config starts servers outside the project: use `dfl mcp` from a global install (`npm i -g @vishin-pavel/dfl`) there, ' +
    'not the per-project `npx --no-install dfl mcp` entry.',
  // The Desktop app starts stdio servers with the app folder as cwd.
  mcpCwdOutsideWorkspace: true,
  notes:
    'Run `/skills reload` in the CLI after installing. The CLI may load workspace .agents/ customizations only for registered workspaces (`agy --add-dir .`).',
  docs: 'https://antigravity.google/docs/skills/',
};

const codex: AgentAdapter = {
  id: 'codex',
  name: 'OpenAI Codex',
  skillsDir: '.agents/skills',
  invocation: (skillName) => `$${skillName}`,
  detect: markers('.codex'),
  mcp: tomlTarget('.codex/config.toml'),
  mcpNote:
    'Codex applies .codex/config.toml only to trusted projects: trust the project when Codex asks (or via /permissions). Skills load without trust.',
  notes:
    'In the Codex CLI and IDE extension skills are not slash commands: mention them with $name or pick them from /skills (the ChatGPT desktop app also lists them under /).',
  docs: 'https://learn.chatgpt.com/docs/build-skills',
};

const gemini: AgentAdapter = {
  id: 'gemini',
  name: 'Gemini CLI',
  skillsDir: '.gemini/skills',
  invocation: slash,
  // Not the bare .gemini/ dir: Antigravity keeps .gemini/config.json there.
  detect: markers(
    'GEMINI.md',
    '.geminiignore',
    '.gemini/settings.json',
    '.gemini/skills',
    '.gemini/commands',
    '.gemini/agents',
    '.gemini/policies',
    '.gemini/.env',
  ),
  mcp: jsonTarget('.gemini/settings.json', 'jsonc', ['mcpServers'], plainEntry),
  mcpNote: 'Gemini CLI ignores .gemini/settings.json in untrusted folders: trust the project (first-run dialog or `/permissions trust`).',
  notes:
    'Workspace skills load only in a trusted folder; run `/skills reload` after installing. /name works in the interactive UI only (not `gemini -p`). Start gemini from the project root.',
  docs: 'https://geminicli.com/docs/cli/skills/',
};

const copilot: AgentAdapter = {
  id: 'copilot',
  name: 'GitHub Copilot',
  skillsDir: '.github/skills',
  invocation: slash,
  detect: markers(
    '.github/copilot-instructions.md',
    '.github/instructions',
    '.github/prompts',
    '.github/agents',
    '.github/skills',
    '.github/copilot',
    '.github/mcp.json',
  ),
  mcp: jsonTarget('.mcp.json', 'json', ['mcpServers'], stdioEntry),
  mcpNote: 'Copilot CLI loads project MCP servers only after the folder is trusted; VS Code applies Workspace Trust.',
  notes: 'Copilot CLI loads project skills only in trusted folders; run `/skills reload` after installing. VS Code lists skills under /.',
  docs: 'https://docs.github.com/en/copilot/concepts/agents/about-agent-skills',
};

const windsurf: AgentAdapter = {
  id: 'windsurf',
  name: 'Windsurf / Devin',
  skillsDir: '.devin/skills',
  invocation: slash,
  detect: markers('.devin', '.windsurf', '.windsurfrules', '.devinignore', '.windsurfignore', '.codeiumignore'),
  mcp: jsonTarget('.devin/mcp_config.json', 'json', ['mcpServers'], plainEntry),
  mcpNote:
    'Needs Devin Desktop (Devin Local) or Devin CLI v3000.3+. Devin asks before every MCP tool call; pre-approve with ' +
    '`{"permissions":{"allow":["mcp__dfl__*"]}}` in .devin/config.json. Legacy Cascade has no project MCP config.',
  notes:
    'Devin also imports .claude/.cursor/.github/.agents skills, so installing dfl for several agents can show prefixed duplicates (e.g. /claude:name).',
  docs: 'https://docs.devin.ai/cli/extensibility/skills/overview',
};

const opencode: AgentAdapter = {
  id: 'opencode',
  name: 'OpenCode',
  skillsDir: '.opencode/skills',
  invocation: slash,
  detect: markers(OPENCODE_JSON, OPENCODE_JSONC, '.opencode'),
  mcp: opencodeTarget,
  notes: 'Skills are hidden from the / autocomplete: type /name or pick the skill from /skills.',
  docs: 'https://opencode.ai/docs/skills/',
};

const kiro: AgentAdapter = {
  id: 'kiro',
  name: 'Kiro',
  skillsDir: '.kiro/skills',
  invocation: slash,
  detect: markers('.kiro'),
  mcp: jsonTarget('.kiro/settings/mcp.json', 'json', ['mcpServers'], plainEntry),
  mcpNote: 'Enable "MCP support" in the Kiro IDE settings. Custom agents only get the server with `includeMcpJson: true`.',
  notes:
    'The Kiro CLI discovers skills when a chat starts: start a new session after installing. Custom agents only see skills listed in their resources (skill://.kiro/skills/**/SKILL.md).',
  docs: 'https://kiro.dev/docs/skills/',
};

const BY_ID: Record<AgentId, AgentAdapter> = { claude, cursor, antigravity, codex, gemini, copilot, windsurf, opencode, kiro };

/** All adapters in display order (same order as AGENT_IDS). */
export const AGENTS: readonly AgentAdapter[] = AGENT_IDS.map((id) => BY_ID[id]);

function unknownAgentError(ids: string[]): DflError {
  const list = ids.map((id) => `"${id}"`).join(', ');
  return new DflError(`Unknown agent${ids.length > 1 ? 's' : ''} ${list}.`, {
    hint: `Valid agents: ${AGENT_IDS.join(', ')}.`,
    code: 'UNKNOWN_AGENT',
  });
}

function normalizeAgentId(input: string): AgentId | undefined {
  const id = input.trim().toLowerCase();
  if ((AGENT_IDS as readonly string[]).includes(id)) return id as AgentId;
  return AGENT_ALIASES[id];
}

/** Throws DflError `UNKNOWN_AGENT` listing valid ids. */
export function getAgent(id: string): AgentAdapter {
  const agentId = normalizeAgentId(id);
  if (!agentId) throw unknownAgentError([id.trim()]);
  return BY_ID[agentId];
}

/** Parses a comma/space separated list of agent ids (e.g. from `--agents claude,cursor`); throws on unknown ids; dedupes. */
export function parseAgentList(input: string | string[]): AgentId[] {
  const tokens = (Array.isArray(input) ? input : [input])
    .flatMap((part) => part.split(/[\s,]+/))
    .map((token) => token.trim())
    .filter(Boolean);
  const result: AgentId[] = [];
  const unknown: string[] = [];
  for (const token of tokens) {
    const id = normalizeAgentId(token);
    if (!id) {
      if (!unknown.includes(token)) unknown.push(token);
    } else if (!result.includes(id)) {
      result.push(id);
    }
  }
  if (unknown.length > 0) throw unknownAgentError(unknown);
  return result;
}

/** Agents whose marker files exist in `root`. */
export function detectAgents(root: string): AgentId[] {
  return AGENTS.filter((agent) => agent.detect(root)).map((agent) => agent.id);
}
