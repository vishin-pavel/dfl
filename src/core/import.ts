/**
 * Import flows distributed over git (OWNER: sync agent).
 * Sources: `https://…`/`git@…`/`ssh://…` URLs (optionally `#ref`), `github:owner/repo[/sub/path][#ref]`,
 * or a local directory path. Git sources are shallow-cloned (`git clone --depth 1 [--branch ref]`) into a temp dir.
 */
import type { FlowModel, ProjectPaths } from './types.js';

export interface ParsedFlowSource {
  kind: 'git' | 'local';
  /** Clone URL or absolute local path. */
  url: string;
  /** Sub-path inside the repo/dir where to look for flows. */
  subpath?: string | undefined;
  ref?: string | undefined;
}

export function parseFlowSource(input: string, cwd?: string): ParsedFlowSource {
  throw new Error('not implemented');
}

/**
 * Candidate flow dirs inside a checked-out source: the dir itself if it has flow.json, else
 * `*\/flow.json`, `flows/*\/flow.json`, `.df/*\/flow.json` (in that order; deduped).
 */
export function findFlowDirs(dir: string): string[] {
  throw new Error('not implemented');
}

export interface ImportOptions {
  /** Target flow name (default: the source flow's name). Only valid when importing one flow. */
  name?: string | undefined;
  /** Import only these source flow names. Default: all found. */
  flows?: string[] | undefined;
  /** Replace existing flows with the same name. */
  force?: boolean | undefined;
}

/** Imports flow(s) into `.df/` (records `source` in flow.json). Returns the imported models. */
export async function importFlows(paths: ProjectPaths, input: string, options?: ImportOptions): Promise<FlowModel[]> {
  throw new Error('not implemented');
}
