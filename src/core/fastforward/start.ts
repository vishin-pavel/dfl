/**
 * Starting and stopping fast-forward runs: the operations behind the MCP tool `fast_forward` and
 * `dfl fast-forward` (docs/ARCHITECTURE.md §10). A start needs current skills (a run reads the
 * rendered `.df/<flow>/steps/*\/SKILL.md`) and, for a flow tracked in Jira, a started task; the
 * ticket is read outside the lock, the run file is read, planned and written under it. A stop
 * never reads the network; it reads the position only for a run of the local position (to refuse
 * stopping a run that has already ended).
 */
import { DflError } from '../errors.js';
import { loadRuntimeState } from '../machine.js';
import { checkFlowSyncState } from '../sync.js';
import type { InstructionsCommandPrefix } from '../tracker/instructions.js';
import { assertTaskMovable, taskKeyForMove, taskStatus, type TaskView, type WithLock } from '../tracker/runtime.js';
import type { FlowModel, FlowRuntimeState, ProjectPaths } from '../types.js';
import { fastForwardView } from './instructions.js';
import { evaluateRun, planFastForwardStart, type FastForwardStartPlan, type RunEvaluation } from './run.js';
import { assertStopReason, readFastForwardFile, readFastForwardRun, runKey, saveFastForwardRun, stopFastForwardRun, type FastForwardRun } from './store.js';

/** What {@link startFastForward} did (the caller builds the result with `fastForwardStartView`). */
export interface FastForwardStarted {
  /** The position the run starts from. */
  state: FlowRuntimeState;
  /** The tracked task (a flow tracked in Jira with a bound ticket). */
  task?: TaskView;
  /** The run's key in `.df/fast-forward.json`. */
  key: string;
  plan: FastForwardStartPlan;
  /** The run in `state` (status `running`). */
  evaluation: RunEvaluation;
  /** For the user: Jira updates, a takeover of a run that was driven, a replaced run file. */
  warnings: string[];
}

export interface FastForwardOptions {
  withLock: WithLock;
  /** How the agent invokes skills (`$` for Codex); default `/`. */
  commandPrefix?: InstructionsCommandPrefix | undefined;
}

/**
 * Throws DflError `FAST_FORWARD_SKILLS_STALE` unless the installed skills are those of `flowName`
 * and up to date (checkFlowSyncState): a run reads the rendered step files.
 */
export function assertSkillsCurrent(paths: ProjectPaths, flowName: string): void {
  const sync = checkFlowSyncState(paths, flowName);
  if (sync?.upToDate) return;
  let reason: string;
  let hint: string;
  if (sync === undefined) {
    reason = `"${flowName}" is not the active flow`;
    hint = `Run \`dfl flow use ${flowName}\`, then start the run again.`;
  } else if (!sync.installed) {
    reason = 'they are not installed for you yet';
    hint = 'Run `dfl install`, then start the run again.';
  } else {
    reason = (sync.reason ?? 'they are out of date').replace(/\.$/, '');
    hint = sync.fix ?? 'Run `dfl flow-update`, then start the run again.';
  }
  throw new DflError(`Fast-forward needs the installed skills of flow "${flowName}" to be up to date: ${reason}.`, {
    hint,
    code: 'FAST_FORWARD_SKILLS_STALE',
  });
}

/**
 * Throws DflError `INVALID_OPTIONS` for options of `fast_forward` / `dfl fast-forward` that do not go
 * together: a target with a stop, a reason without a stop, or a reason that is not one line of at
 * most 300 characters.
 */
export function assertFastForwardOptions(options: { to?: string | undefined; stop?: boolean | undefined; reason?: string | undefined }): void {
  if (options.stop && options.to !== undefined) {
    throw new DflError('A fast-forward run is either started (with a target) or stopped, not both.', { code: 'INVALID_OPTIONS' });
  }
  if (!options.stop && options.reason !== undefined) {
    throw new DflError('A reason applies only to stopping a run.', { code: 'INVALID_OPTIONS' });
  }
  assertStopReason(options.reason);
}

/**
 * Starts or resumes the fast-forward run of `model` (and the bound ticket) to `args.to`, else a
 * stopped run's target, else the end of the flow (see `planFastForwardStart`). For a tracked flow the
 * ticket's record is the position (read outside the lock); a tracked flow without a bound ticket and
 * `requireTask: false` uses the local state. Writes `.df/fast-forward.json` under `opts.withLock`,
 * except when the run is already running (nothing changes then).
 * Throws DflError `FAST_FORWARD_SKILLS_STALE`, `TASK_REQUIRED`, `TASK_NOT_STARTED`, `TASK_STEP_UNKNOWN`,
 * the errors of `taskStatus` and of `planFastForwardStart` (e.g. `FAST_FORWARD_POSITION_UNKNOWN`).
 */
export async function startFastForward(
  paths: ProjectPaths,
  model: FlowModel,
  args: { to?: string | undefined; task?: string | undefined },
  opts: FastForwardOptions,
): Promise<FastForwardStarted> {
  assertSkillsCurrent(paths, model.name);
  const status = await taskStatus(paths, model, { task: args.task }, { commandPrefix: opts.commandPrefix });
  const task = status ? assertTaskMovable(paths, model, status, opts.commandPrefix) : null;
  const key = runKey(model.name, task);
  const { state, plan, problem } = await opts.withLock(async () => {
    const state = status?.state ?? loadRuntimeState(paths, model);
    const { file, problem } = readFastForwardFile(paths);
    const existing = Object.hasOwn(file.runs, key) ? file.runs[key] : undefined;
    const plan = planFastForwardStart(model, state, existing, { to: args.to, task, now: new Date().toISOString() });
    if (plan.write) saveFastForwardRun(paths, key, plan.run);
    return { state, plan, problem };
  });

  const evaluation = evaluateRun(model, plan.run, state);
  const warnings: string[] = [];
  if (task) warnings.push(`Every move of this run updates ${task} in Jira: its status follows the step the run enters.`);
  // A takeover only of a run that was driven (moved, or resumed); a run started from the CLI and not driven yet is just picked up.
  if (plan.resumed?.after === 'running' && (evaluation.moves.length > 0 || plan.run.resumedAt !== undefined)) {
    warnings.push(`The run was already running (started ${plan.run.startedAt}): if another session still drives it, stop that session.`);
  }
  if (problem) warnings.push('.df/fast-forward.json could not be read and was replaced.');
  return {
    state,
    ...(status ? { task: status.task } : {}),
    key,
    plan,
    evaluation,
    warnings,
  };
}

/**
 * Stops the fast-forward run of `model` (and the ticket a move would use: the `task` argument, a bare
 * number as a start takes it, else the key in the current branch; no network) with an optional
 * one-line `reason` (without one, an earlier stop's reason is kept). The run stays open: a bare start
 * resumes it with its target. A run of the local position (no ticket) is evaluated under the lock
 * first: one that has already ended is not stopped, and the result carries the run as evaluated
 * after the stop (`evaluation`, with its moves). A ticket's run is stopped without reading its
 * position (no network).
 * Throws DflError `INVALID_OPTIONS` (the reason), `TASK_REQUIRED`, `TASK_REF_*` and `FAST_FORWARD_NOT_ACTIVE`.
 */
export async function stopFastForward(
  paths: ProjectPaths,
  model: FlowModel,
  args: { task?: string | undefined; reason?: string | undefined },
  opts: FastForwardOptions,
): Promise<{ key: string; task: string | null; run: FastForwardRun; evaluation?: RunEvaluation }> {
  assertStopReason(args.reason);
  const task = taskKeyForMove(paths, model, args.task, opts.commandPrefix, { allowBare: true }) ?? null;
  const key = runKey(model.name, task);
  return opts.withLock(async () => {
    if (task !== null) return { key, task, run: stopFastForwardRun(paths, model.name, task, { reason: args.reason }) };
    const state = loadRuntimeState(paths, model);
    const existing = readFastForwardRun(paths, key);
    const before = existing && evaluateRun(model, existing, state);
    if (existing && before?.status === 'ended') {
      const detail = fastForwardView(model, existing, before, { prefix: '/' }).detail ?? '';
      throw new DflError(
        `The fast-forward run of flow "${model.name}" to "${existing.target}" has already ended: ${detail.charAt(0).toLowerCase()}${detail.slice(1)}`,
        { code: 'FAST_FORWARD_NOT_ACTIVE' },
      );
    }
    const run = stopFastForwardRun(paths, model.name, null, { reason: args.reason });
    return { key, task, run, evaluation: evaluateRun(model, run, state) };
  });
}
