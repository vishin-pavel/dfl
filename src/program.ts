/**
 * Commander program (OWNER: cli agent). `buildProgram()` is imported by tests; cli.ts runs it via runCli.
 * Every command lives in src/commands/*; this file only wires the tree and the global options.
 */
import { Command } from '@commander-js/extra-typings';
import { registerAgentsCommand } from './commands/agents.js';
import { registerFastForwardCommand } from './commands/fastforward.js';
import { registerFlowCommands } from './commands/flow.js';
import { registerInstallCommands } from './commands/install.js';
import { registerMcpCommand } from './commands/mcp.js';
import type { CliContext } from './commands/shared.js';
import { registerStateCommands } from './commands/state.js';
import { registerStepCommands } from './commands/step.js';
import { registerTaskCommands } from './commands/task.js';
import { registerTrackerCommands } from './commands/tracker.js';
import { registerVarsCommands } from './commands/vars.js';
import { packageVersion } from './core/paths.js';

export function buildProgram(): Command {
  // Settings that subcommands inherit (exitOverride, output, help behaviour) must be set before
  // the subcommands are created.
  const program = new Command('dfl')
    .description('Development flow manager: flow steps as Agent Skills, an MCP server and a flow viewer.')
    .version(packageVersion(), '-v, --version', 'print the dfl version')
    .option('--root <dir>', 'project root (default: $DFL_ROOT or the nearest directory with .df/)')
    .option('--no-color', 'disable colored output')
    .helpOption('-h, --help', 'show help')
    .helpCommand('help [command]', 'show help for a command')
    .showHelpAfterError('(run with --help for usage)')
    .exitOverride();

  const ctx: CliContext = {
    rootOption: () => program.opts().root ?? undefined,
  };

  registerInstallCommands(program, ctx);
  registerStateCommands(program, ctx);
  registerFastForwardCommand(program, ctx);
  registerTaskCommands(program, ctx);
  registerFlowCommands(program, ctx);
  registerStepCommands(program, ctx);
  registerVarsCommands(program, ctx);
  registerTrackerCommands(program, ctx);
  registerAgentsCommand(program, ctx);
  registerMcpCommand(program, ctx);
  return program as unknown as Command;
}
