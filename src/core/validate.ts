/**
 * Flow validation (OWNER: flow-engine agent). See docs/ARCHITECTURE.md §2.1.
 */
import type { FlowDefinition, ProjectPaths, ValidationIssue } from './types.js';

/** Pure checks on a definition (no file system): ids, targets, unsupported xstate features, xstate createMachine, reachability. */
export function validateDefinition(def: FlowDefinition, expectedName?: string): ValidationIssue[] {
  throw new Error('not implemented');
}

/** Full validation of `.df/<name>`: parse + validateDefinition + step directories/templates + stray files. */
export function validateFlow(paths: ProjectPaths, name: string): ValidationIssue[] {
  throw new Error('not implemented');
}

/** Throws a DflError (code `INVALID_FLOW`) listing all errors if validateFlow reports any error. Returns warnings. */
export function assertFlowValid(paths: ProjectPaths, name: string): ValidationIssue[] {
  throw new Error('not implemented');
}
