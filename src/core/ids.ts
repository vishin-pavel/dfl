import { DflError } from './errors.js';

/** Agent Skills name rules: lowercase letters, digits and single hyphens; max 64 chars. */
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
  return id.length > 0 && id.length <= MAX_ID_LENGTH && ID_RE.test(id);
}

export function assertValidFlowName(name: string): void {
  if (!isValidId(name)) {
    throw new DflError(`Invalid flow name "${name}".`, {
      hint: 'Use lowercase letters, digits and single hyphens (e.g. "feature" or "bug-fix"), max 64 characters.',
      code: 'INVALID_NAME',
    });
  }
  if (RESERVED_FLOW_NAMES.has(name)) {
    throw new DflError(`"${name}" is a reserved name and cannot be used as a flow name.`, { code: 'INVALID_NAME' });
  }
}

export function assertValidStepId(id: string): void {
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
