/**
 * Forward paths through a flow (pure, no I/O; docs/ARCHITECTURE.md §2.3). A transition `s → t` is
 * forward when `t` comes later in flow order (`StepInfo.index`, see `orderStates`); every other edge
 * is a loop. The forward subgraph is therefore a DAG, and every walk over it terminates. Fast-forward
 * runs use these helpers for their default target, start validation, likely path and skip detection;
 * `dfl flow view` draws the same notion of "ahead".
 */
import { NEXT_EVENT } from './flow.js';
import type { FlowModel, FlowTransition } from './types.js';

/**
 * The states reachable from `from` over forward transitions, `from` included (a BFS). A state the
 * model does not have reaches only itself.
 */
export function forwardReachable(model: FlowModel, from: string): Set<string> {
  const seen = new Set<string>([from]);
  const queue = [from];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const t of forwardTransitions(model, id)) {
      if (seen.has(t.target)) continue;
      seen.add(t.target);
      queue.push(t.target);
    }
  }
  return seen;
}

/**
 * The end of the flow (the default fast-forward target): the first final state the `NEXT` path from
 * the initial step reaches; else the only final state of the flow; else undefined (no final state,
 * or several and the `NEXT` path reaches none of them). Every other final state is a side exit.
 */
export function flowEnd(model: FlowModel): string | undefined {
  const visited = new Set<string>();
  for (let id: string | undefined = model.initial; id !== undefined && !visited.has(id); ) {
    visited.add(id);
    const step = model.byId.get(id);
    if (!step) break;
    if (step.final) return id;
    id = step.transitions.find((t) => t.event === NEXT_EVENT)?.target;
  }
  const finals = model.steps.filter((step) => step.final);
  return finals.length === 1 ? finals[0]!.id : undefined;
}

/**
 * The likely path from `from` to `target`, both included: at each state the forward transition whose
 * target is `target` or forward-reaches it, `NEXT` first, else the first in declaration order. `[]`
 * when `target` cannot be reached going forward.
 */
export function forwardPath(model: FlowModel, from: string, target: string): string[] {
  if (!forwardReachable(model, from).has(target)) return [];
  const reaches = reachCache(model);
  const path = [from];
  // Terminates: the index grows with every forward transition.
  for (let id = from; id !== target; ) {
    const candidates = forwardTransitions(model, id).filter((t) => t.target === target || reaches(t.target).has(target));
    const next = candidates.find((t) => t.event === NEXT_EVENT) ?? candidates[0];
    if (!next) return [];
    id = next.target;
    path.push(id);
  }
  return path;
}

/**
 * The forks of `path` (`target` excluded): its steps with a forward transition to a non-final state
 * other than `target` from which `target` cannot be reached going forward. A run may skip its target
 * there (the route decides), and then stops.
 */
export function bypassSteps(model: FlowModel, path: readonly string[], target: string): string[] {
  const reaches = reachCache(model);
  return path.filter(
    (id) =>
      id !== target &&
      forwardTransitions(model, id).some((t) => t.target !== target && model.byId.get(t.target)?.final === false && !reaches(t.target).has(target)),
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Outgoing transitions of `id` to a later state of the model (declaration order). */
function forwardTransitions(model: FlowModel, id: string): FlowTransition[] {
  const step = model.byId.get(id);
  if (!step) return [];
  return step.transitions.filter((t) => {
    const target = model.byId.get(t.target);
    return target !== undefined && target.index > step.index;
  });
}

/** {@link forwardReachable} memoized for one call. */
function reachCache(model: FlowModel): (id: string) => Set<string> {
  const cache = new Map<string, Set<string>>();
  return (id) => {
    let set = cache.get(id);
    if (!set) {
      set = forwardReachable(model, id);
      cache.set(id, set);
    }
    return set;
  };
}
