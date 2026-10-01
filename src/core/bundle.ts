/**
 * Flow exports (`dfl flow export`): one JSON file holding one or more flows, file by file. An export
 * is a snapshot: `dfl flow import <file>` restores the flows exactly, including their recorded
 * `source`, so `dfl flow pull` keeps updating them from the same template or repository. dfl also
 * writes one to `.df/.dfl-backups/` before it replaces or deletes a flow.
 *
 * Only flow content is exported (`isFlowContentPath`): never rendered `.md` output (it can hold
 * personal values), VCS dirs, OS junk or symlinks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DflError } from './errors.js';
import { flowContentFiles, isFlowContentPath } from './flow.js';
import { ensureDir, isSafeRelPath, relPosix } from './fsx.js';
import { isValidFlowName } from './ids.js';
import { packageVersion } from './paths.js';
import type { ProjectPaths } from './types.js';

/** `format` of an export file. */
export const BUNDLE_FORMAT = 'dfl-flows';
/** The export format version this dfl writes and reads. */
export const BUNDLE_VERSION = 1;
/** Extension of export files (`feature.dfl.json`). */
export const BUNDLE_EXTENSION = '.dfl.json';
/** Directory under `.df/` that holds the automatic backups (git-ignored by `.dfl-*\/`). */
export const BACKUP_DIR = '.dfl-backups';
/** Export files larger than this are refused (flows are small; this guards against reading huge files). */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/** One file of an exported flow: UTF-8 `text`, or `base64` for anything else. */
export interface BundledFile {
  path: string;
  text?: string | undefined;
  base64?: string | undefined;
  /** The file had an executable bit (scripts). */
  executable?: boolean | undefined;
}

export interface BundledFlow {
  /** The flow's directory name under `.df/` (equals flow.json `name`). */
  name: string;
  files: BundledFile[];
}

export interface FlowBundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  /** The dfl version that wrote it. */
  dfl: string;
  exportedAt: string;
  flows: BundledFlow[];
}

/** Bundles the flow directories `.df/<name>` (the names must be existing flows). */
export function bundleFlows(paths: ProjectPaths, names: readonly string[]): FlowBundle {
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    dfl: packageVersion(),
    exportedAt: new Date().toISOString(),
    flows: names.map((name) => bundleFlowDir(paths.flowDir(name), name)),
  };
}

/** The export file content (pretty JSON with a trailing newline). */
export function serializeBundle(bundle: FlowBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * Writes a backup of `.df/<name>` to `.df/.dfl-backups/<name>-<UTC time>.dfl.json` (never
 * overwriting another backup) and returns its project-relative path. A flow.json that does not
 * parse is backed up too: the backup holds the files as they are.
 */
export function backupFlow(paths: ProjectPaths, name: string): string {
  const dir = path.join(paths.dfDir, BACKUP_DIR);
  ensureDir(dir);
  const content = serializeBundle(bundleFlows(paths, [name]));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${name}-${stamp}${n > 1 ? `-${n}` : ''}${BUNDLE_EXTENSION}`);
    try {
      fs.writeFileSync(file, content, { flag: 'wx' });
      return relPosix(paths.root, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

const bundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.number(),
  dfl: z.string().optional(),
  exportedAt: z.string().optional(),
  flows: z
    .array(
      z.object({
        name: z.string(),
        files: z.array(
          z.object({
            path: z.string(),
            text: z.string().optional(),
            base64: z.string().optional(),
            executable: z.boolean().optional(),
          }),
        ),
      }),
    )
    .min(1),
});

/**
 * Reads and checks an export file (INVALID_BUNDLE): the format and version, flow names, and every
 * file path (plain relative paths only, no duplicates – also not by case –, no file that is also a
 * directory, a flow.json per flow whose `name` matches). Rendered `.md` files under steps/, VCS dirs
 * and OS junk are dropped, like a directory import does.
 */
export function readBundle(file: string): FlowBundle {
  const display = path.basename(file);
  const st = fs.statSync(file);
  if (st.size > MAX_BUNDLE_BYTES) throw invalid(display, `it is larger than ${MAX_BUNDLE_BYTES / 1024 / 1024} MB`);
  const notExport = 'Import a file written by `dfl flow export`, a flow directory or a git repository.';
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw invalid(display, `it is not a dfl flow export (not valid JSON: ${(error as Error).message})`, notExport);
  }
  if (typeof data !== 'object' || data === null || (data as { format?: unknown }).format !== BUNDLE_FORMAT) {
    throw invalid(display, 'it is not a dfl flow export', notExport);
  }
  const version = (data as { version?: unknown }).version;
  if (typeof version === 'number' && version > BUNDLE_VERSION) {
    throw invalid(display, `it was written by a newer dfl (export format ${version})`, 'Upgrade dfl to import it.');
  }
  const parsed = bundleSchema.safeParse(data);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw invalid(display, details);
  }
  if (parsed.data.version !== BUNDLE_VERSION) throw invalid(display, `unsupported export format ${parsed.data.version}`);

  const names = new Set<string>();
  const flows: BundledFlow[] = [];
  for (const flow of parsed.data.flows) {
    if (!isValidFlowName(flow.name)) throw invalid(display, `invalid flow name "${flow.name}"`);
    if (names.has(flow.name)) throw invalid(display, `flow "${flow.name}" appears twice`);
    names.add(flow.name);
    flows.push({ name: flow.name, files: checkFiles(display, flow.name, flow.files) });
  }
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, dfl: parsed.data.dfl ?? '', exportedAt: parsed.data.exportedAt ?? '', flows };
}

/** Writes every flow of a checked bundle to `<dir>/<name>/` (a fresh directory that must not exist yet). */
export function extractBundle(bundle: FlowBundle, dir: string): void {
  for (const flow of bundle.flows) {
    const base = path.join(dir, flow.name);
    for (const file of flow.files) {
      const dest = path.join(base, ...file.path.split('/'));
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, fileContent(file), { flag: 'wx' });
      if (file.executable) {
        const mode = fs.statSync(dest).mode & 0o777;
        fs.chmodSync(dest, mode | ((mode & 0o444) >> 2)); // x wherever r is set
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function bundleFlowDir(dir: string, name: string): BundledFlow {
  return {
    name,
    files: flowContentFiles(dir).map((rel) => {
      const abs = path.join(dir, ...rel.split('/'));
      const content = fs.readFileSync(abs);
      const text = content.toString('utf8');
      const isText = !text.includes('\0') && Buffer.from(text, 'utf8').equals(content);
      const executable = (fs.statSync(abs).mode & 0o111) !== 0;
      return { path: rel, ...(isText ? { text } : { base64: content.toString('base64') }), ...(executable ? { executable } : {}) };
    }),
  };
}

function checkFiles(display: string, flow: string, files: readonly BundledFile[]): BundledFile[] {
  const where = (rel: string): string => `"${rel}" in flow "${flow}"`;
  const seen = new Set<string>();
  const out: BundledFile[] = [];
  for (const file of files) {
    if (!isSafeRelPath(file.path)) throw invalid(display, `unsafe path ${where(file.path)}`);
    if ((file.text === undefined) === (file.base64 === undefined)) {
      throw invalid(display, `${where(file.path)} needs exactly one of "text" and "base64"`);
    }
    if (file.base64 !== undefined && !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw invalid(display, `${where(file.path)} has invalid base64`);
    if (!isFlowContentPath(file.path)) continue;
    // Case-insensitive file systems (macOS, Windows) would merge paths that differ only by case.
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw invalid(display, `${where(file.path)} appears twice`);
    seen.add(key);
    out.push(file);
  }
  for (const file of out) {
    const parts = file.path.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (seen.has(prefix)) throw invalid(display, `${where(prefix)} is both a file and a directory`);
    }
  }
  const flowJson = out.find((file) => file.path === 'flow.json');
  if (!flowJson) throw invalid(display, `flow "${flow}" has no flow.json`);
  let name: unknown;
  try {
    name = (JSON.parse(fileContent(flowJson).toString('utf8')) as { name?: unknown }).name;
  } catch {
    throw invalid(display, `the flow.json of flow "${flow}" is not valid JSON`);
  }
  if (name !== flow) throw invalid(display, `the flow.json of flow "${flow}" is named "${String(name)}"`);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function fileContent(file: BundledFile): Buffer {
  return file.text !== undefined ? Buffer.from(file.text, 'utf8') : Buffer.from(file.base64 ?? '', 'base64');
}

function invalid(display: string, reason: string, hint?: string): DflError {
  return new DflError(`Cannot import ${display}: ${reason}.`, { ...(hint ? { hint } : {}), code: 'INVALID_BUNDLE' });
}
