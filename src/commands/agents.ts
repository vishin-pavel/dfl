/**
 * `dfl agents`: supported agents, where their skills and MCP config go, detection and selection.
 */
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import { AGENTS, AGENT_ALIASES, mcpConfigFile } from '../agents/registry.js';
import { getSelectedAgents, isInitialized } from '../core/config.js';
import { c } from '../ui/colors.js';
import { print, printJson, printLines, sym, terminalWidth, width as textWidth, wrapItems } from '../ui/output.js';
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
      const aliases = Object.entries(AGENT_ALIASES);
      const rows = AGENTS.map((agent) => ({
        id: agent.id,
        name: agent.name,
        aliases: aliases.filter(([, id]) => id === agent.id).map(([alias]) => alias),
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
      // Fits the terminal: the detected mark shares the leading status cell, the AGENT column is dropped
      // when the table would not fit, and the last column (MCP CONFIG) is truncated as a last resort.
      const width = terminalWidth();
      const cells = rows.map((row) => ({
        status: `${row.selected ? c.cyan(sym.current) : c.dim(sym.pending)} ${row.detected ? c.green(sym.ok) : ' '}`,
        id: row.selected ? c.bold(row.id) : row.id,
        name: row.name,
        skillsDir: `${row.skillsDir}/`,
        invocation: row.invocation,
        mcp: row.mcpFile !== undefined ? { text: row.mcpFile } : { text: 'manual', style: c.dim },
      }));
      const build = (withName: boolean, maxWidth?: number): string[] =>
        table(
          cells.map((cell) => [
            cell.status,
            cell.id,
            ...(withName ? [cell.name] : []),
            cell.skillsDir,
            cell.invocation,
            cell.mcp,
          ]),
          {
            head: ['', 'ID', ...(withName ? ['AGENT'] : []), 'SKILLS DIR', 'INVOKE', 'MCP CONFIG'],
            maxWidth,
          },
        );
      const full = build(true);
      printLines(full.every((line) => textWidth(line) <= width) ? full : build(false, width));
      print();
      print(c.dim(`${sym.current} selected for this project   ${sym.ok} detected in this project`));
      if (selected.length === 0) print(c.dim('No agents selected yet: run `dfl install`.'));

      // Notes for the agents that matter here (selected or detected); all of them in a fresh project.
      const notesWidth = width - 4;
      const relevant = rows.filter((row) => row.selected || row.detected);
      const noted = (relevant.length > 0 ? relevant : rows).filter((row) => row.notes || row.mcpNote);
      if (noted.length > 0) {
        print();
        print(c.bold('Notes'));
        for (const row of noted) {
          const text = [row.notes, row.mcpNote].filter(Boolean).join(' ');
          const lines = wrapItems(text.split(/\s+/), ' ', notesWidth, '    ');
          print(`  ${c.bold(row.name)}`);
          printLines(lines.map((line) => c.dim(line)));
        }
      }
    });
}
