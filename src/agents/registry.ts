/**
 * Supported agents (OWNER: agents agent). Paths come from docs/AGENTS.md (researched 2026-09-30).
 */
import type { AgentId } from '../core/types.js';
import type { AgentAdapter } from './types.js';

/** All adapters in display order (same order as AGENT_IDS). */
export const AGENTS: readonly AgentAdapter[] = [];

/** Throws DflError `UNKNOWN_AGENT` listing valid ids. */
export function getAgent(id: string): AgentAdapter {
  throw new Error('not implemented');
}

/** Parses a comma/space separated list of agent ids (e.g. from `--agents claude,cursor`); throws on unknown ids; dedupes. */
export function parseAgentList(input: string | string[]): AgentId[] {
  throw new Error('not implemented');
}

/** Agents whose marker files exist in `root`. */
export function detectAgents(root: string): AgentId[] {
  throw new Error('not implemented');
}
