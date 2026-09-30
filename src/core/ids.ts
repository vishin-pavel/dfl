import { DflError } from './errors.js';

/**
 * Agent Skills name rules: lowercase letters, digits and single hyphens; max 64 chars. Step ids must
 * not be only digits ({@link isValidStepId}).
 */
export const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_ID_LENGTH = 64;

/** Names that cannot be used as flow ids because they clash with files in `.df/`. */
export const RESERVED_FLOW_NAMES: ReadonlySet<string> = new Set([
  'config',
  'local',
  'state',
  'installed',
  'node-modules',
  'steps',
  'partials',
]);

export function isValidId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH && ID_RE.test(id);
}

/** A valid, non-reserved flow name (see {@link assertValidFlowName}). */
export function isValidFlowName(name: string): boolean {
  return typeof name === 'string' && isValidId(name) && !RESERVED_FLOW_NAMES.has(name);
}

export function assertValidFlowName(name: string): void {
  if (typeof name !== 'string' || !isValidId(name)) {
    throw new DflError(`Invalid flow name "${name}".`, {
      hint: 'Use lowercase letters, digits and single hyphens (e.g. "feature" or "bug-fix"), max 64 characters.',
      code: 'INVALID_NAME',
    });
  }
  if (RESERVED_FLOW_NAMES.has(name)) {
    throw new DflError(`"${name}" is a reserved name and cannot be used as a flow name.`, { code: 'INVALID_NAME' });
  }
}

/**
 * All digits. JavaScript lists such object keys first, in numeric order, whatever order they were
 * declared in, so `machine.states` could not keep the flow order (§2) for them: not a step id.
 */
const DIGITS_ONLY_RE = /^[0-9]+$/;

/** True for an id made of digits only (`1`, `15`, `007`), which is not a valid step id. */
export function isDigitsOnlyId(id: string): boolean {
  return typeof id === 'string' && DIGITS_ONLY_RE.test(id);
}

/** A valid step id: a valid id (see {@link isValidId}) that is not only digits. */
export function isValidStepId(id: string): boolean {
  return isValidId(id) && !isDigitsOnlyId(id);
}

/** `Invalid step id "1": …` explanation and fix for an id made of digits only. */
export function digitsOnlyStepIdMessage(id: string): { message: string; hint: string } {
  return {
    message: `Invalid step id "${id}": a step id cannot be only digits (JSON objects list such keys first, so the step would lose its place in the flow order).`,
    hint: `Add a letter, e.g. "step-${id}".`,
  };
}

/** Throws INVALID_NAME unless `id` is a valid step id (lowercase letters, digits and single hyphens, not only digits). */
export function assertValidStepId(id: string): void {
  assertStepIdIsPathSafe(id);
  if (isDigitsOnlyId(id)) {
    const { message, hint } = digitsOnlyStepIdMessage(id);
    throw new DflError(message, { hint, code: 'INVALID_NAME' });
  }
}

/**
 * Throws INVALID_NAME unless `id` has the id shape, so it is safe as a `steps/<id>` directory name.
 * For reading existing steps: an all-digit id is accepted here (validateFlow reports it).
 */
export function assertStepIdIsPathSafe(id: string): void {
  if (!isValidId(id)) {
    throw new DflError(`Invalid step id "${id}".`, {
      hint: 'Use lowercase letters, digits and single hyphens (e.g. "plan-feature"), max 64 characters.',
      code: 'INVALID_NAME',
    });
  }
}

/** `plan-feature` → `Plan Feature` */
export function titleCase(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Best-effort conversion of free text to a valid id: `Plan Feature!` → `plan-feature`. */
export function toId(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/g, '');
}
