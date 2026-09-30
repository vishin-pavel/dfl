/**
 * `dfl agents`: supported agents, where their skills and MCP config go, detection and selection.
 */
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import { AGENTS, mcpConfigFile } from '../agents/registry.js';
import { getSelectedAgents, isInitialized } from '../core/config.js';
import { c } from '../ui/colors.js';
import { print, printJson, printLines, sym, terminalWidth, wrapItems } from '../ui/output.js';
import { table } from '../ui/table.js';
import { projectFor, type CliContext } from './shared.js';

export function registerAgentsCommand(program: CommandUnknownOpts, ctx: CliContext): void {
  program
    .command('agents')
    .description('List supported agents, where skills and MCP config go, and which are detected/selected')
    .option('--json', 'print JSON')
    .action((opts) => {
      // Works outside a dfl project too (detection only): the install root rules apply.
      const paths = projectFor(ctx, { forInstall: true });
      const selected = isInitialized(paths) ? getSelectedAgents(paths) : [];
      const rows = AGENTS.map((agent) => ({
        id: agent.id,
        name: agent.name,
        skillsDir: agent.skillsDir,
        invocation: agent.invocation('<skill>'),
        mcpFile: mcpConfigFile(agent, paths.root),
        detected: agent.detect(paths.root),
        selected: selected.includes(agent.id),
        mcpNote: agent.mcpNote,
        notes: agent.notes,
        docs: agent.docs,
      }));
      if (opts.json) {
        printJson({ root: paths.root, agents: rows });
        return;
      }
      printLines(
        table(
          rows.map((row) => [
            row.selected ? c.cyan(sym.current) : c.dim(sym.pending),
            row.selected ? c.bold(row.id) : row.id,
            row.name,
            `${row.skillsDir}/`,
            row.invocation,
            row.mcpFile ?? c.dim('manual'),
            row.detected ? c.green(`${sym.ok} detected`) : '',
          ]),
          { head: ['', 'ID', 'AGENT', 'SKILLS DIR', 'INVOKE', 'MCP CONFIG', ''] },
        ),
      );
      print();
      print(c.dim(`${sym.current} selected for this project${selected.length === 0 ? ' (none yet: run `dfl install`)' : ''}`));

      // Notes for the agents that matter here (selected or detected); all of them in a fresh project.
      const width = terminalWidth() - 4;
      const relevant = rows.filter((row) => row.selected || row.detected);
      const noted = (relevant.length > 0 ? relevant : rows).filter((row) => row.notes || row.mcpNote);
      if (noted.length > 0) {
        print();
        print(c.bold('Notes'));
        for (const row of noted) {
          const text = [row.notes, row.mcpNote].filter(Boolean).join(' ');
          const lines = wrapItems(text.split(/\s+/), ' ', width, '    ');
          print(`  ${c.bold(row.name)}`);
          printLines(lines.map((line) => c.dim(line)));
        }
      }
    });
}
