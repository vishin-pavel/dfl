/**
 * `dfl mcp`: the stdio MCP server. stdout carries JSON-RPC, so this command prints nothing itself;
 * the server module is loaded lazily to keep the other commands fast.
 */
import path from 'node:path';
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import type { CliContext } from './shared.js';

export function registerMcpCommand(program: CommandUnknownOpts, ctx: CliContext): void {
  program
    .command('mcp')
    .description('Run the dfl MCP server over stdio (started by your agent, not by hand)')
    .action(async () => {
      const { runMcpServer } = await import('../mcp/server.js');
      const root = ctx.rootOption();
      await runMcpServer({ root: root === undefined ? undefined : path.resolve(root) });
    });
}
