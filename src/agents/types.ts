import type { AgentId, McpServerSpec } from '../core/types.js';

/** What an upsert does (or would do) to the server entry. */
export type McpUpsertStatus = 'added' | 'updated' | 'unchanged';

export interface McpRemoveOptions {
  /** Delete the file when the removal leaves nothing but disposable content. Default true (pass false for files dfl did not create). */
  deleteEmptyFile?: boolean | undefined;
  /** Drop the servers container (e.g. `mcpServers`) when the removal empties it. Default true. */
  dropEmptyContainer?: boolean | undefined;
  /** OpenCode: only touch this file (`opencode.json` or `opencode.jsonc`). Default: every file the target may use. */
  file?: string | undefined;
  /** Remove the config dirs a deleted file leaves empty (e.g. `.kiro/settings/`). Default true; the caller may do it itself. */
  removeEmptyDirs?: boolean | undefined;
}

/** What the project MCP config currently holds (to record what dfl created). */
export interface McpTargetState {
  /** Project-relative posix file the target writes for this project (OpenCode: `.json` or `.jsonc`). */
  file: string;
  /** The file exists (also when it is blank: a pre-existing file is never deleted by uninstall). */
  exists: boolean;
  /** The servers container (e.g. `mcpServers`) exists; always true for TOML (no container to drop). */
  container: boolean;
}

/** A project-level MCP config file of one agent. */
export interface McpTarget {
  /** Project-relative posix path, e.g. `.mcp.json`, `.codex/config.toml`. */
  file: string;
  format: 'json' | 'jsonc' | 'toml';
  /** Idempotently adds/updates the server entry, preserving unrelated content and comments. Returns true if the file changed. */
  upsert(root: string, spec: McpServerSpec): boolean;
  /** What `upsert` would do, without writing (throws like `upsert` for invalid files). */
  plan(root: string, spec: McpServerSpec): McpUpsertStatus;
  /** Removes the server entry (see McpRemoveOptions for the file / container). Returns true if changed. */
  remove(root: string, name: string, options?: McpRemoveOptions): boolean;
  /** True when the file contains an entry for `name`. */
  has(root: string, name: string): boolean;
  /**
   * The launch command of the `name` entry (undefined when there is none). `file` picks OpenCode's
   * file. Throws DflError for invalid JSON.
   */
  read(root: string, name: string, file?: string): { command: string | undefined; args: string[] } | undefined;
  /** Whether the config file and its servers container exist. */
  inspect(root: string): McpTargetState;
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
  /**
   * Some clients of this tool start stdio MCP servers with a working directory outside the project,
   * where the per-project `npx --no-install dfl mcp` entry cannot start.
   */
  mcpCwdOutsideWorkspace?: boolean | undefined;
  /** Short caveats shown by `dfl agents` (e.g. reload needed after install). */
  notes?: string | undefined;
  /** Docs URL. */
  docs?: string | undefined;
}
