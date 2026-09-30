/**
 * Comment-preserving MCP config editors (OWNER: agents agent).
 * JSON/JSONC via `jsonc-parser` modify/applyEdits; TOML via a text-level managed table
 * (`[mcp_servers.<name>]` with a `# managed by dfl` comment line) so user content is untouched.
 */
import type { McpServerSpec, ProjectPaths } from '../core/types.js';

/** Sets `<keyPath>.<name> = entry` in a JSON/JSONC file (creates the file if missing). Returns true if changed. */
export function upsertJsonEntry(file: string, keyPath: string[], name: string, entry: unknown): boolean {
  throw new Error('not implemented');
}

/** Removes `<keyPath>.<name>`; deletes the file if it becomes `{}` or `{ <key>: {} }` only. Returns true if changed. */
export function removeJsonEntry(file: string, keyPath: string[], name: string): boolean {
  throw new Error('not implemented');
}

export function hasJsonEntry(file: string, keyPath: string[], name: string): boolean {
  throw new Error('not implemented');
}

/** Writes/replaces the `[mcp_servers.<name>]` table in a TOML file. Returns true if changed. */
export function upsertTomlServer(file: string, spec: McpServerSpec): boolean {
  throw new Error('not implemented');
}

export function removeTomlServer(file: string, name: string): boolean {
  throw new Error('not implemented');
}

export function hasTomlServer(file: string, name: string): boolean {
  throw new Error('not implemented');
}

/**
 * The command agents use to start the dfl MCP server:
 * config.json `mcp` override → `npx --no-install dfl mcp` when the running dfl lives inside
 * `<root>/node_modules` → `dfl mcp`. Name is always `dfl`.
 */
export function resolveMcpServerSpec(paths: ProjectPaths): McpServerSpec {
  throw new Error('not implemented');
}
