/**
 * dfl MCP server (OWNER: mcp agent). See docs/ARCHITECTURE.md §7.
 * Uses `@modelcontextprotocol/server` v2. Never writes to stdout except via the transport.
 */
import type { McpServer } from '@modelcontextprotocol/server';

export interface DflMcpOptions {
  /** Explicit project root (`--root`). */
  root?: string | undefined;
}

/** Creates the server with all tools/resources registered (not connected). */
export function createDflMcpServer(options?: DflMcpOptions): McpServer {
  throw new Error('not implemented');
}

/** `dfl mcp`: serves over stdio until stdin closes. */
export async function runMcpServer(options?: DflMcpOptions): Promise<void> {
  throw new Error('not implemented');
}
