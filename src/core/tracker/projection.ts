/**
 * Status projection (pure): whether a move should transition the ticket, and which transition.
 *
 * The record is the truth; the ticket's status only mirrors the mapping of the current step, and
 * dfl does not fight people or automation: it leaves a ticket alone that someone moved to a status
 * the flow does not manage, and never reopens a done ticket unless the mapping says `reopen`.
 */
import { statusLabel, type NormalizedStatus } from './config.js';
import type { JiraTransition } from './jira.js';

/** The ticket's actual status. */
export interface ActualStatus {
  id: string;
  name: string;
  /** Jira's `untranslatedName`, when it sent one. */
  untranslatedName?: string | undefined;
  /** Status category key: `new`, `indeterminate` or `done`. */
  categoryKey: string;
}

export interface ProjectionInput {
  /** Ticket key (for warnings). */
  key: string;
  /** The step the task is now at (for warnings). */
  step: string;
  /** The status `step` maps to; null keeps the status. */
  target: NormalizedStatus | null;
  actual: ActualStatus;
  /** Every status the flow maps to ({@link managedStatuses}). */
  managed: NormalizedStatus[];
  /** True for `start_task` (the ticket may be anywhere, e.g. in the backlog). */
  start: boolean;
}

export interface ProjectionPlan {
  action: 'none' | 'transition';
  /** The status to move to (action `transition`). */
  target?: NormalizedStatus | undefined;
  /** Why dfl left the status alone, when the user should know. */
  warning?: string | undefined;
}

/**
 * True when `wanted` (a configured status or issue-type name) names `named`: its name or its
 * untranslated name, case-insensitively. Jira translates names into each user's language unless
 * the request forces English, while `untranslatedName` stays the same for everyone.
 */
export function nameMatches(wanted: string, named: { name: string; untranslatedName?: string | undefined }): boolean {
  const lower = wanted.toLowerCase();
  return named.name.toLowerCase() === lower || (named.untranslatedName !== undefined && named.untranslatedName.toLowerCase() === lower);
}

/** True when the ticket is in `status`: same id when the mapping has one, else the same name ({@link nameMatches}). */
export function statusMatches(status: NormalizedStatus, actual: { id: string; name: string; untranslatedName?: string | undefined }): boolean {
  if (status.id !== undefined) return status.id === actual.id;
  return status.name !== undefined && nameMatches(status.name, actual);
}

/**
 * What to do with the ticket's status after the task moved to `input.step`:
 * - no mapping (`target` null), or the ticket is already there → none;
 * - the ticket is done and the target is not known to be done → none + warning, unless `reopen`;
 * - not starting, and the ticket is in a status the flow does not manage → none + warning (someone
 *   moved it on purpose). A `new`-category status (To Do, Backlog) does not count as moved: a task
 *   whose first steps keep the status is still there when the first mapped step comes;
 * - else transition.
 */
export function planProjection(input: ProjectionInput): ProjectionPlan {
  const { key, step, target, actual, managed, start } = input;
  if (target === null) return { action: 'none' };
  if (statusMatches(target, actual)) return { action: 'none' };
  if (actual.categoryKey === 'done' && target.categoryKey !== 'done' && !target.reopen) {
    return {
      action: 'none',
      warning:
        `${key} is ${actual.name} (done); dfl does not reopen it. ` +
        `Add "reopen": true to the mapping of ${step} to allow it.`,
    };
  }
  if (!start && actual.categoryKey !== 'new' && !managed.some((status) => statusMatches(status, actual))) {
    return {
      action: 'none',
      warning:
        `${key} was moved to '${actual.name}' outside dfl; dfl left it there (expected '${statusLabel(target)}'). ` +
        'Move it yourself or run the step again after moving it back.',
    };
  }
  return { action: 'transition', target };
}

/**
 * The transition that leads to `target` (its `to` has the target's id when the mapping has one, else
 * its name, see {@link statusMatches}). When several do: with `fields` in the mapping the first that
 * has a screen (Jira rejects fields on a transition without one), without them the first that has
 * none (a screen may require fields dfl does not send); else the first. Without one, a warning
 * listing the available transitions (or, when there are none, pointing at the Transition issues
 * permission).
 */
export function chooseTransition(
  transitions: readonly JiraTransition[],
  target: NormalizedStatus,
  context: { key: string; actual: string },
): { transition?: JiraTransition | undefined; warning?: string | undefined } {
  const matches = transitions.filter((t) => statusMatches(target, t.to));
  if (matches.length > 0) {
    const withFields = target.fields !== undefined && Object.keys(target.fields).length > 0;
    return { transition: matches.find((t) => t.hasScreen === withFields) ?? matches[0] };
  }
  const wanted = statusLabel(target);
  if (transitions.length === 0) {
    return {
      warning:
        `No transition from '${context.actual}' to '${wanted}' for ${context.key}: Jira offers none to this account ` +
        '(it may lack the Transition issues permission). Move the ticket by hand or ask a Jira admin.',
    };
  }
  const available = transitions.map((t) => `${t.name} → ${t.to.name}`).join(', ');
  return {
    warning:
      `No transition from '${context.actual}' to '${wanted}' for ${context.key} (available: ${available}). ` +
      'Move the ticket by hand or change the mapping with `dfl tracker map`.',
  };
}
