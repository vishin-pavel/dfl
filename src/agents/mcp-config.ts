/**
 * Comment-preserving MCP config editors (OWNER: agents agent).
 * JSON/JSONC via `jsonc-parser` modify/applyEdits; TOML via a text-level managed table
 * (`[mcp_servers.<name>]` with a `# managed by dfl` comment line) so user content is untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  format,
  getNodeValue,
  modify,
  parseTree,
  printParseErrorCode,
  type FormattingOptions,
  type Node as JsonNode,
  type ParseError,
} from 'jsonc-parser';
import { loadProjectConfig } from '../core/config.js';
import { DflError } from '../core/errors.js';
import { readTextIfExists, removePath, writeText } from '../core/fsx.js';
import { PACKAGE_NAME, packageRoot } from '../core/paths.js';
import type { McpServerSpec, ProjectPaths } from '../core/types.js';

/** The server name dfl registers in every agent MCP config. */
export const MCP_SERVER_NAME = 'dfl';

/** Comment line written above the TOML table dfl owns. */
export const TOML_MANAGED_COMMENT = '# managed by dfl';

// ---------------------------------------------------------------------------
// JSON / JSONC
// ---------------------------------------------------------------------------

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };

/** Root keys that do not count as user content when deciding whether to delete a config file. */
const DISPOSABLE_ROOT_KEYS: ReadonlySet<string> = new Set(['$schema']);

export interface UpsertJsonOptions {
  /** Root object used when the file does not exist yet (e.g. OpenCode's `$schema`). Default `{}`. */
  initial?: Record<string, unknown> | undefined;
}

interface JsonDocument {
  /** Text without a leading BOM. */
  text: string;
  bom: string;
  root: JsonNode;
}

function splitBom(raw: string): { bom: string; text: string } {
  return raw.startsWith('﻿') ? { bom: '﻿', text: raw.slice(1) } : { bom: '', text: raw };
}

/** Parses a JSON/JSONC config file; throws a DflError for syntax errors or a non-object root. */
function parseJsonDocument(file: string, raw: string): JsonDocument {
  const { bom, text } = splitBom(raw);
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, PARSE_OPTIONS);
  const first = errors[0];
  if (first) {
    const line = text.slice(0, first.offset).split('\n').length;
    throw new DflError(`Cannot update ${file}: invalid JSON (${printParseErrorCode(first.error)} at line ${line}).`, {
      hint: 'Fix the syntax error (or delete the file) and run the command again.',
      code: 'INVALID_JSON',
    });
  }
  if (!root || root.type !== 'object') {
    throw new DflError(`Cannot update ${file}: the top-level value must be a JSON object.`, { code: 'INVALID_JSON' });
  }
  return { text, bom, root };
}

/** Indentation and line endings of an existing document (2 spaces / LF by default). */
function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^[ \t]+(?=\S)/m.exec(text)?.[0];
  if (indent?.startsWith('\t')) return { insertSpaces: false, tabSize: 4, eol };
  return { insertSpaces: true, tabSize: indent ? indent.length : 2, eol };
}

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/**
 * Throws when a prefix of `keyPath` exists but is not an object (modify() would otherwise
 * produce garbage or throw a raw error).
 */
function assertContainers(file: string, root: JsonNode, keyPath: string[]): void {
  for (let i = 1; i <= keyPath.length; i++) {
    const node = findNodeAtLocation(root, keyPath.slice(0, i));
    if (node === undefined) return;
    if (node.type !== 'object') {
      throw new DflError(`Cannot update ${file}: "${keyPath.slice(0, i).join('.')}" is not an object.`, {
        hint: 'Fix the file by hand and run the command again.',
        code: 'INVALID_JSON',
      });
    }
  }
}

/**
 * Applies `modify()` without its built-in formatting (which re-formats the whole line around the
 * edit, including unrelated siblings) and then formats only the inserted text plus the whitespace
 * directly around it.
 */
function applyModification(text: string, jsonPath: string[], value: unknown, options: FormattingOptions): string {
  const [edit] = modify(text, jsonPath, value, {});
  if (!edit) return text;
  const next = applyEdits(text, [edit]);
  if (value === undefined || edit.content.length === 0) return next;
  let start = edit.offset;
  while (start > 0 && isWhitespace(next[start - 1])) start--;
  if (start > 0) start--;
  let end = edit.offset + edit.content.length;
  while (end < next.length && isWhitespace(next[end])) end++;
  if (end < next.length) end++;
  return applyEdits(next, format(next, { offset: start, length: end - start }, options));
}

function hasComments(text: string): boolean {
  const scanner = createScanner(text, false);
  for (let token = scanner.scan(); token !== 17 /* EOF */; token = scanner.scan()) {
    if (token === 12 /* LineCommentTrivia */ || token === 13 /* BlockCommentTrivia */) return true;
  }
  return false;
}

/** True when the object node has no properties and nothing but whitespace between its braces. */
function isBareEmptyObject(text: string, node: JsonNode): boolean {
  return (node.children?.length ?? 0) === 0 && text.slice(node.offset + 1, node.offset + node.length - 1).trim() === '';
}

/** JSON round-trip: plain prototypes (getNodeValue uses null-prototype objects) and no `undefined` values. */
function plain(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** What an upsert would change. */
export type McpUpsertStatus = 'added' | 'updated' | 'unchanged';

/**
 * The text an upsert of `<keyPath>.<name> = entry` would write (undefined when the file already holds
 * an equal entry) and whether an entry existed before. Throws DflError for invalid files.
 */
function computeJsonUpsert(
  file: string,
  keyPath: string[],
  name: string,
  entry: unknown,
  options: UpsertJsonOptions,
): { next: string | undefined; had: boolean } {
  const raw = readTextIfExists(file);
  const isNew = raw === undefined || raw.trim() === '';
  const source = isNew ? JSON.stringify(options.initial ?? {}, null, 2) : raw;
  const doc = parseJsonDocument(file, source);
  const jsonPath = [...keyPath, name];
  assertContainers(file, doc.root, keyPath);
  const existing = isNew ? undefined : findNodeAtLocation(doc.root, jsonPath);
  if (existing !== undefined && isDeepStrictEqual(plain(getNodeValue(existing)), plain(entry))) return { next: undefined, had: true };
  const formatting = isNew ? { insertSpaces: true, tabSize: 2, eol: '\n' } : detectFormatting(doc.text);
  let next = applyModification(doc.text, jsonPath, entry, formatting);
  if (isNew) next += formatting.eol;
  const text = doc.bom + next;
  return { next: text === raw ? undefined : text, had: existing !== undefined };
}

/** Sets `<keyPath>.<name> = entry` in a JSON/JSONC file (creates the file if missing). Returns true if changed. */
export function upsertJsonEntry(
  file: string,
  keyPath: string[],
  name: string,
  entry: unknown,
  options: UpsertJsonOptions = {},
): boolean {
  const { next } = computeJsonUpsert(file, keyPath, name, entry, options);
  return next === undefined ? false : writeText(file, next);
}

/** What upsertJsonEntry would do, without writing (throws like upsertJsonEntry on invalid files). */
export function planJsonUpsert(
  file: string,
  keyPath: string[],
  name: string,
  entry: unknown,
  options: UpsertJsonOptions = {},
): McpUpsertStatus {
  const { next, had } = computeJsonUpsert(file, keyPath, name, entry, options);
  return next === undefined ? 'unchanged' : had ? 'updated' : 'added';
}

export interface RemoveEntryOptions {
  /** Drop the container (e.g. `mcpServers`) when the removal leaves it empty. Default true. */
  dropEmptyContainer?: boolean | undefined;
  /** Delete the file when nothing but disposable content (`{}`, `$schema`) is left. Default true. */
  deleteEmptyFile?: boolean | undefined;
}

/**
 * Removes `<keyPath>.<name>`. By default also drops the container it emptied and deletes the file
 * when it becomes `{}` (or only `$schema`); pass `dropEmptyContainer` / `deleteEmptyFile: false`
 * for files and containers dfl did not create. Returns true if changed.
 */
export function removeJsonEntry(file: string, keyPath: string[], name: string, options: RemoveEntryOptions = {}): boolean {
  const raw = readTextIfExists(file);
  if (raw === undefined || raw.trim() === '') return false;
  const doc = parseJsonDocument(file, raw);
  if (findNodeAtLocation(doc.root, [...keyPath, name]) === undefined) return false;
  const formatting = detectFormatting(doc.text);
  let text = applyModification(doc.text, [...keyPath, name], undefined, formatting);

  if (keyPath.length > 0) {
    const root = parseTree(text, [], PARSE_OPTIONS);
    const container = root && findNodeAtLocation(root, keyPath);
    if (container && container.type === 'object' && isBareEmptyObject(text, container)) {
      text =
        options.dropEmptyContainer === false
          ? // Keep the user's container, without the whitespace the removal left inside it.
            `${text.slice(0, container.offset)}{}${text.slice(container.offset + container.length)}`
          : applyModification(text, keyPath, undefined, formatting);
    }
  }

  const root = parseTree(text, [], PARSE_OPTIONS);
  const remaining = (root?.children ?? []).map((prop) => String(prop.children?.[0]?.value));
  if (options.deleteEmptyFile !== false && remaining.every((key) => DISPOSABLE_ROOT_KEYS.has(key)) && !hasComments(text)) {
    removePath(file);
    return true;
  }
  return writeText(file, doc.bom + text);
}

/** The value of `<keyPath>.<name>` (undefined when the file or the entry is missing). Throws DflError for invalid JSON. */
export function readJsonEntry(file: string, keyPath: string[], name: string): unknown {
  const raw = readTextIfExists(file);
  if (raw === undefined || raw.trim() === '') return undefined;
  const doc = parseJsonDocument(file, raw);
  const node = findNodeAtLocation(doc.root, [...keyPath, name]);
  return node === undefined ? undefined : plain(getNodeValue(node));
}

/**
 * True when the config file exists, also when it is blank or holds only whitespace (MCP targets'
 * `inspect`): such a file was there before dfl, so uninstall must never delete it.
 */
export function jsonFileExists(file: string): boolean {
  return readTextIfExists(file) !== undefined;
}

/** True when `<keyPath>` exists in the file (false for missing or unparsable files). */
export function hasJsonContainer(file: string, keyPath: string[]): boolean {
  const raw = readTextIfExists(file);
  if (raw === undefined) return false;
  const root = parseTree(splitBom(raw).text, [], PARSE_OPTIONS);
  return root !== undefined && findNodeAtLocation(root, keyPath) !== undefined;
}

export function hasJsonEntry(file: string, keyPath: string[], name: string): boolean {
  const raw = readTextIfExists(file);
  if (raw === undefined) return false;
  const root = parseTree(splitBom(raw).text, [], PARSE_OPTIONS);
  return root !== undefined && findNodeAtLocation(root, [...keyPath, name]) !== undefined;
}

// ---------------------------------------------------------------------------
// TOML (Codex `.codex/config.toml`)
// ---------------------------------------------------------------------------

interface TomlHeader {
  /** 0-based line index of the `[table]` header. */
  line: number;
  /** Decoded key path, e.g. `['mcp_servers', 'dfl']`. */
  path: string[];
}

interface LineRange {
  /** First line (inclusive). */
  start: number;
  /** Last line (exclusive). */
  end: number;
}

/** Index just past the closing quote of a single-line string starting after `from`, or the line length. */
function skipTomlString(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    if (quote === '"' && line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === quote) return i + 1;
  }
  return line.length;
}

/** Index just past the closing delimiter of a multi-line string, or -1 when it continues on the next line. */
function findMultilineClose(line: string, from: number, delimiter: string): number {
  const quote = delimiter[0]!;
  for (let i = from; i < line.length; i++) {
    if (delimiter === '"""' && line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] !== quote) continue;
    let end = i;
    while (line[end] === quote) end++;
    if (end - i >= 3) return end; // up to two extra quotes belong to the string content
    i = end - 1;
  }
  return -1;
}

function decodeTomlBasicString(body: string): string {
  const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
  return body.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|.)/g, (match, esc: string) => {
    if (esc.length > 1) return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
    return simple[esc] ?? match;
  });
}

/** Parses `a."b.c".'d'` (the inside of a table header). Returns undefined for malformed keys. */
function parseTomlKeyPath(text: string): string[] | undefined {
  const segments: string[] = [];
  let i = 0;
  const skipSpace = (): void => {
    while (text[i] === ' ' || text[i] === '\t') i++;
  };
  for (;;) {
    skipSpace();
    const char = text[i];
    if (char === '"' || char === "'") {
      const end = skipTomlString(text, i + 1, char);
      if (text[end - 1] !== char || end - 1 === i) return undefined;
      const body = text.slice(i + 1, end - 1);
      segments.push(char === '"' ? decodeTomlBasicString(body) : body);
      i = end;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!match) return undefined;
      segments.push(match[0]);
      i += match[0].length;
    }
    skipSpace();
    if (i >= text.length) return segments;
    if (text[i] !== '.') return undefined;
    i++;
  }
}

/** Parses a `[table]` / `[[array.table]]` header line; undefined when the line is not a header. */
function parseTomlHeader(line: string): string[] | undefined {
  const trimmed = line.trim();
  const array = trimmed.startsWith('[[');
  const open = array ? 2 : 1;
  const close = array ? ']]' : ']';
  let i = open;
  while (i < trimmed.length && trimmed[i] !== ']') {
    const char = trimmed[i]!;
    i = char === '"' || char === "'" ? skipTomlString(trimmed, i + 1, char) : i + 1;
  }
  if (!trimmed.startsWith(close, i)) return undefined;
  const rest = trimmed.slice(i + close.length).trim();
  if (rest !== '' && !rest.startsWith('#')) return undefined;
  return parseTomlKeyPath(trimmed.slice(open, i));
}

/**
 * Finds table headers while skipping multi-line strings and multi-line arrays/inline tables, so a
 * `[section]`-looking line inside a value is never mistaken for a header.
 */
function scanTomlHeaders(lines: string[]): TomlHeader[] {
  const headers: TomlHeader[] = [];
  let multiline: string | undefined;
  let depth = 0;
  lines.forEach((line, index) => {
    let pos = 0;
    if (multiline) {
      const close = findMultilineClose(line, 0, multiline);
      if (close < 0) return;
      pos = close;
      multiline = undefined;
    } else if (depth === 0 && line.trimStart().startsWith('[')) {
      const headerPath = parseTomlHeader(line);
      if (headerPath) {
        headers.push({ line: index, path: headerPath });
        return;
      }
    }
    while (pos < line.length) {
      const char = line[pos]!;
      if (char === '#') break;
      if (char === '"' || char === "'") {
        const triple = char.repeat(3);
        if (line.startsWith(triple, pos)) {
          const close = findMultilineClose(line, pos + 3, triple);
          if (close < 0) {
            multiline = triple;
            break;
          }
          pos = close;
        } else {
          pos = skipTomlString(line, pos + 1, char);
        }
        continue;
      }
      if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') depth = Math.max(0, depth - 1);
      pos++;
    }
  });
  return headers;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/**
 * Line ranges of the tables whose header path matches. A range starts at the header (or at the
 * `# managed by dfl` line right above it) and ends before the next header; trailing blank and
 * comment lines are left to the following table.
 */
function tableRanges(lines: string[], headers: TomlHeader[], match: (headerPath: string[]) => boolean): LineRange[] {
  const ranges: LineRange[] = [];
  headers.forEach((header, index) => {
    if (!match(header.path)) return;
    let start = header.line;
    if (start > 0 && lines[start - 1]!.trim() === TOML_MANAGED_COMMENT) start--;
    let end = headers[index + 1]?.line ?? lines.length;
    while (end > header.line + 1 && isBlankOrComment(lines[end - 1]!)) end--;
    ranges.push({ start, end });
  });
  return ranges;
}

const isBlank = (line: string | undefined): boolean => line !== undefined && line.trim() === '';

/** Removes the ranges (sorted ascending) and collapses the blank lines left at each seam. */
function removeRanges(lines: string[], ranges: LineRange[]): string[] {
  const kept = [...lines];
  for (const range of [...ranges].reverse()) {
    kept.splice(range.start, range.end - range.start);
    while (isBlank(kept[range.start]) && (range.start === 0 || isBlank(kept[range.start - 1]))) kept.splice(range.start, 1);
  }
  return kept;
}

interface TomlDocument {
  lines: string[];
  eol: string;
  finalEol: boolean;
}

function readTomlDocument(file: string): TomlDocument | undefined {
  const text = readTextIfExists(file);
  if (text === undefined) return undefined;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const finalEol = text.endsWith('\n');
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (finalEol) lines.pop();
  return { lines, eol, finalEol };
}

function tomlString(value: string): string {
  const escapes: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (escapes[char]) out += escapes[char];
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function renderTomlServer(spec: McpServerSpec): string[] {
  const table = `mcp_servers.${tomlKey(spec.name)}`;
  const lines = [
    TOML_MANAGED_COMMENT,
    `[${table}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(', ')}]`,
  ];
  const env = Object.entries(spec.env ?? {});
  if (env.length > 0) {
    lines.push('', `[${table}.env]`, ...env.map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`));
  }
  return lines;
}

const isServerPath = (headerPath: string[], name: string): boolean =>
  headerPath.length >= 2 && headerPath[0] === 'mcp_servers' && headerPath[1] === name;

/** The text upsertTomlServer would write (undefined when unchanged) and whether the table existed. */
function computeTomlUpsert(file: string, spec: McpServerSpec): { next: string | undefined; had: boolean } {
  const current = readTextIfExists(file);
  const doc = readTomlDocument(file) ?? { lines: [], eol: '\n', finalEol: true };
  const headers = scanTomlHeaders(doc.lines);
  // dfl owns the server table and its `env` subtable; other subtables (e.g. per-tool approval) stay.
  const owned = (headerPath: string[]): boolean =>
    isServerPath(headerPath, spec.name) && (headerPath.length === 2 || (headerPath.length === 3 && headerPath[2] === 'env'));
  const had = headers.some((header) => header.path.length === 2 && isServerPath(header.path, spec.name));
  const ranges = tableRanges(doc.lines, headers, owned);
  const kept = removeRanges(doc.lines, ranges);
  const at = ranges[0]?.start ?? kept.length;
  const before = kept.slice(0, at);
  const after = kept.slice(at);
  while (isBlank(before[before.length - 1])) before.pop();
  while (isBlank(after[0])) after.shift();
  const lines = [
    ...before,
    ...(before.length > 0 ? [''] : []),
    ...renderTomlServer(spec),
    ...(after.length > 0 ? ['', ...after] : []),
  ];
  const finalEol = doc.finalEol || after.length === 0;
  const text = lines.join(doc.eol) + (finalEol ? doc.eol : '');
  return { next: text === current ? undefined : text, had };
}

/** Writes/replaces the `[mcp_servers.<name>]` table in a TOML file. Returns true if changed. */
export function upsertTomlServer(file: string, spec: McpServerSpec): boolean {
  const { next } = computeTomlUpsert(file, spec);
  return next === undefined ? false : writeText(file, next);
}

/** What upsertTomlServer would do, without writing. */
export function planTomlUpsert(file: string, spec: McpServerSpec): McpUpsertStatus {
  const { next, had } = computeTomlUpsert(file, spec);
  return next === undefined ? 'unchanged' : had ? 'updated' : 'added';
}

/**
 * Removes `[mcp_servers.<name>]` and all its subtables; deletes the file when nothing else is left
 * (unless `deleteEmptyFile` is false: the file then stays, emptied).
 */
export function removeTomlServer(file: string, name: string, options: { deleteEmptyFile?: boolean | undefined } = {}): boolean {
  const doc = readTomlDocument(file);
  if (!doc) return false;
  const ranges = tableRanges(doc.lines, scanTomlHeaders(doc.lines), (headerPath) => isServerPath(headerPath, name));
  if (ranges.length === 0) return false;
  const kept = removeRanges(doc.lines, ranges);
  while (isBlank(kept[kept.length - 1])) kept.pop();
  if (kept.length === 0) {
    if (options.deleteEmptyFile === false) return writeText(file, '');
    removePath(file);
    return true;
  }
  return writeText(file, kept.join(doc.eol) + (doc.finalEol ? doc.eol : ''));
}

const TOML_STRING_RE = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;

/** Decoded single-line TOML string values in `text`, in order. */
function tomlStrings(text: string): string[] {
  return [...text.matchAll(TOML_STRING_RE)].map((match) =>
    match[1] !== undefined ? decodeTomlBasicString(match[1]) : (match[2] ?? ''),
  );
}

/**
 * `command` and `args` of the `[mcp_servers.<name>]` table (undefined when the table is missing).
 * Understands the simple forms dfl writes (single-line strings, arrays of strings).
 */
export function readTomlServer(file: string, name: string): { command?: string | undefined; args?: string[] | undefined } | undefined {
  const doc = readTomlDocument(file);
  if (!doc) return undefined;
  const headers = scanTomlHeaders(doc.lines);
  const index = headers.findIndex((header) => header.path.length === 2 && isServerPath(header.path, name));
  if (index < 0) return undefined;
  const header = headers[index]!;
  const body = doc.lines.slice(header.line + 1, headers[index + 1]?.line ?? doc.lines.length);
  const result: { command?: string; args?: string[] } = {};
  for (let i = 0; i < body.length; i++) {
    const match = /^\s*(command|args)\s*=\s*(.*)$/.exec(body[i]!);
    if (!match) continue;
    let value = match[2]!;
    if (match[1] === 'command') {
      result.command = tomlStrings(value)[0];
      continue;
    }
    // Arrays may span several lines.
    while (!value.includes(']') && i + 1 < body.length) value += `\n${body[++i]}`;
    result.args = tomlStrings(value.slice(0, value.lastIndexOf(']') + 1));
  }
  return result;
}

export function hasTomlServer(file: string, name: string): boolean {
  const doc = readTomlDocument(file);
  if (!doc) return false;
  return scanTomlHeaders(doc.lines).some((header) => header.path.length === 2 && isServerPath(header.path, name));
}

// ---------------------------------------------------------------------------
// Server spec
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rootOf(paths: ProjectPaths | string): string {
  return typeof paths === 'string' ? paths : paths.root;
}

/** True when `<root>/package.json` lists dfl in dependencies, devDependencies or optionalDependencies. */
export function projectDependsOnDfl(root: string): boolean {
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
  if (!isRecord(pkg)) return false;
  return ['dependencies', 'devDependencies', 'optionalDependencies'].some((key) => {
    const deps = pkg[key];
    return isRecord(deps) && Object.hasOwn(deps, PACKAGE_NAME);
  });
}

/**
 * How to run the dfl CLI in this project, as argv: `npx --no-install dfl` when the project's
 * package.json depends on dfl, otherwise `dfl`. Depends only on the project (never on which dfl
 * binary is running), so every developer writes the same committed MCP entry. `--no-install`
 * keeps npx from fetching an unrelated public package named `dfl`.
 */
export function dflLauncherArgv(paths: ProjectPaths | string): string[] {
  return projectDependsOnDfl(rootOf(paths)) ? ['npx', '--no-install', 'dfl'] : ['dfl'];
}

/** dflLauncherArgv as a command string (`npx --no-install dfl` or `dfl`): `dfl.cli` in templates, MCP guide, CLI hints. */
export function dflLauncher(paths: ProjectPaths | string): string {
  return dflLauncherArgv(paths).join(' ');
}

/**
 * The command agents use to start the dfl MCP server: config.json `mcp` override →
 * `npx --no-install dfl mcp` when `<root>/package.json` depends on dfl → `dfl mcp`. Name is always `dfl`.
 * The second parameter is ignored (kept for backwards compatibility): the spec never depends on the running binary.
 */
export function resolveMcpServerSpec(paths: ProjectPaths, _runningPackageRoot?: string): McpServerSpec {
  const override = loadProjectConfig(paths).mcp;
  if (override) return { name: MCP_SERVER_NAME, command: override.command, args: [...override.args] };
  const [command, ...args] = dflLauncherArgv(paths);
  return { name: MCP_SERVER_NAME, command: command!, args: [...args, 'mcp'] };
}

/** Package runners whose `dfl` argument counts as a dfl launcher. */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'pnpm', 'yarn']);

function commandName(command: string): string {
  return path.basename(command.replaceAll('\\', '/')).replace(/\.(cmd|exe|ps1)$/i, '').toLowerCase();
}

/**
 * True when an MCP entry's command looks like dfl: `dfl …`, `npx|pnpm|yarn … dfl …` (or the package
 * name), or exactly the config.json `mcp` override. Uninstall only removes entries that pass.
 */
export function isDflLauncher(
  entry: { command?: unknown; args?: unknown },
  override?: { command: string; args: string[] } | undefined,
): boolean {
  if (typeof entry.command !== 'string') return false;
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [];
  if (override && entry.command === override.command && isDeepStrictEqual(args, override.args)) return true;
  const name = commandName(entry.command);
  if (name === 'dfl') return true;
  return (
    PACKAGE_RUNNERS.has(name) &&
    args.some((arg) => arg === 'dfl' || arg === PACKAGE_NAME || arg.startsWith(`${PACKAGE_NAME}@`))
  );
}

/** True when an executable `name` is on PATH (PATHEXT is honoured on Windows). */
export function isCommandOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        const file = path.join(dir, name + ext);
        if (!fs.statSync(file).isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Where a dfl package inside the project is installed: the project-relative directory holding the
 * outermost `node_modules` above it (`''` for `<root>/node_modules`, `frontend` for
 * `<root>/frontend/node_modules/...`); undefined when the package is outside the project (global).
 */
export function localInstallPrefix(root: string, pkgRoot: string = packageRoot()): string | undefined {
  const rel = path.relative(realpathOrResolve(root), realpathOrResolve(pkgRoot));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const segments = rel.split(path.sep);
  const index = segments.indexOf('node_modules');
  return index < 0 ? undefined : segments.slice(0, index).join('/');
}
