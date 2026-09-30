/**
 * Install/sync orchestrator – the only code path that writes outside `.df/` (OWNER: sync agent).
 * See docs/ARCHITECTURE.md §5.
 */
import type { AgentId, FlowVarDef, Manifest, ProjectPaths, SyncReport } from './types.js';

export interface SyncOptions {
  /** Agents to install for; default: getSelectedAgents(). Persisted to local.json when given. */
  agents?: AgentId[] | undefined;
  /** Write MCP config entries (default true). */
  mcp?: boolean | undefined;
  /** Called for each missing required var; the value is stored in its scope. Without it missing vars become warnings. */
  promptVar?: ((name: string, def: FlowVarDef) => Promise<unknown>) | undefined;
  /** Compute the report without writing anything. */
  dryRun?: boolean | undefined;
}

/**
 * 1. Resolves active flow (DflError when none) and agents. 2. Resolves vars (prompting via promptVar).
 * 3. Validates the flow (errors abort). 4. Renders flow skills (into .df) and built-in skills.
 * 5. Writes each skill into every distinct agent skills dir. 6. Removes dirs from the previous
 * manifest that are no longer produced. 7. Upserts MCP entries. 8. Writes .df/.gitignore, the managed
 * block in <root>/.gitignore (installed skill dirs) and the new manifest.
 */
export async function syncProject(paths: ProjectPaths, options?: SyncOptions): Promise<SyncReport> {
  throw new Error('not implemented');
}

export interface UninstallOptions {
  /** Also delete `.df/local.json`, `.df/state.json` and rendered `.md` files under `.df`. */
  purge?: boolean | undefined;
}

export interface UninstallReport {
  removed: string[];
  mcp: Array<{ file: string; changed: boolean }>;
}

/** Removes everything listed in the manifest, dfl MCP entries and the managed .gitignore block. Keeps `.df/` flows. */
export function uninstallProject(paths: ProjectPaths, options?: UninstallOptions): UninstallReport {
  throw new Error('not implemented');
}

export function readManifest(paths: ProjectPaths): Manifest {
  throw new Error('not implemented');
}

export function writeManifest(paths: ProjectPaths, manifest: Manifest): void {
  throw new Error('not implemented');
}
