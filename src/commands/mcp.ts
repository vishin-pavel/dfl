/**
 * `dfl mcp`: the stdio MCP server. stdout carries JSON-RPC, so this command prints nothing itself;
 * the server module is loaded lazily to keep the other commands fast.
 */
import path from 'node:path';
import { format } from 'node:util';
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import type { CliContext } from './shared.js';

export function registerMcpCommand(program: CommandUnknownOpts, ctx: CliContext): void {
  program
    .command('mcp')
    .description('Run the dfl MCP server over stdio (started by your agent, not by hand)')
    .action(async () => {
      // stdout is the JSON-RPC channel: anything a dependency logs through console goes to stderr.
      for (const method of ['log', 'info', 'debug'] as const) {
        console[method] = (...args: unknown[]) => void process.stderr.write(`${format(...args)}\n`);
      }
      const { runMcpServer } = await import('../mcp/server.js');
      const root = ctx.rootOption();
      await runMcpServer({ root: root === undefined ? undefined : path.resolve(root) });
    });
}
