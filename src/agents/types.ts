import type { AgentId, McpServerSpec } from '../core/types.js';

/** A project-level MCP config file of one agent. */
export interface McpTarget {
  /** Project-relative posix path, e.g. `.mcp.json`, `.codex/config.toml`. */
  file: string;
  format: 'json' | 'jsonc' | 'toml';
  /** Idempotently adds/updates the server entry, preserving unrelated content and comments. Returns true if the file changed. */
  upsert(root: string, spec: McpServerSpec): boolean;
  /** Removes the server entry (deletes the file only if dfl created it and it is now empty). Returns true if changed. */
  remove(root: string, name: string): boolean;
  /** True when the file contains an entry for `name`. */
  has(root: string, name: string): boolean;
}

export interface AgentAdapter {
  id: AgentId;
  /** Display name, e.g. "Claude Code". */
  name: string;
  /** Project-relative posix dir holding `<skill>/SKILL.md`, e.g. `.claude/skills`. */
  skillsDir: string;
  /** How the user invokes a skill, e.g. `/plan-feature` (Codex CLI: `$plan-feature`). */
  invocation(skillName: string): string;
  /** True when the project already uses this tool (marker files/dirs exist). */
  detect(root: string): boolean;
  /** Project-level MCP config; undefined when the tool only supports a global config. */
  mcp?: McpTarget | undefined;
  /** Manual instructions shown when `mcp` is undefined or needs extra steps (e.g. trust the project). */
  mcpNote?: string | undefined;
  /** Short caveats shown by `dfl agents` (e.g. reload needed after install). */
  notes?: string | undefined;
  /** Docs URL. */
  docs?: string | undefined;
}
