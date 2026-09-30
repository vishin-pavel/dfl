/**
 * dfl MCP server (OWNER: mcp agent). See docs/ARCHITECTURE.md §7.
 * Uses `@modelcontextprotocol/server` v2. Never writes to stdout except via the transport.
 *
 * Every tool call re-resolves the project root and re-reads the files it needs, so edits and
 * `git pull` are picked up without restarting the server.
 */
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { McpServer, ResourceTemplate, type CallToolResult } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { DflError } from '../core/errors.js';
import { getActiveFlowName } from '../core/config.js';
import { loadActiveFlow, skillSteps } from '../core/flow.js';
import { isDir, readText } from '../core/fsx.js';
import { findProjectRoot, packageVersion, projectPaths, resolveProjectRoot } from '../core/paths.js';
import type { ProjectPaths } from '../core/types.js';
import { AUTHORING_GUIDE } from './guide.js';
import {
  addStepTool,
  completeStep,
  deleteStepTool,
  describeFlow,
  describeStatus,
  describeStep,
  fireEvent,
  formatError,
  jumpToStep,
  listFlowsInfo,
  stepTemplateText,
  syncTool,
  updateStepTool,
  validateFlowInfo,
} from './tools.js';

export const MCP_SERVER_NAME = 'dfl';

/** How long to wait for the client's `roots/list` answer before falling back to the cwd. */
const ROOTS_TIMEOUT_MS = 5_000;

export const SERVER_INSTRUCTIONS = [
  'dfl manages the development flow of this project: an ordered state machine of steps, each installed as an agent skill (slash command).',
  'At the start of a step skill, call get_status to check that the step is the current one and which events it offers.',
  'When the step is done, call complete_step with the step id and the event that matches the outcome (NEXT by default), then tell the user the command of the next step.',
  'Use get_flow and get_step to inspect the flow. To change it, read get_authoring_guide, then use add_step, update_step or delete_step; they re-install the skills.',
  'Every tool except list_flows, sync and get_authoring_guide accepts an optional "flow" (default: the active flow).',
].join(' ');

export interface DflMcpOptions {
  /** Explicit project root (`--root`). */
  root?: string | undefined;
  /** Directory the project is searched from when nothing else names it. Default `process.cwd()`. */
  cwd?: string | undefined;
}

export interface RunMcpServerOptions extends DflMcpOptions {
  /** Streams to serve on instead of the process stdio (tests). */
  stdin?: Readable | undefined;
  stdout?: Writable | undefined;
}

const flowArg = z
  .string()
  .optional()
  .describe('Flow name (the directory under .df/). Defaults to the active flow.');
const stepArg = (what: string): z.ZodString => z.string().describe(what);

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** Creates the server with all tools/resources registered (not connected). */
export function createDflMcpServer(options?: DflMcpOptions): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, title: 'dfl development flow', version: safePackageVersion() },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const resolver = createRootResolver(server, options ?? {});

  /** Mutations run one at a time so concurrent calls never interleave file writes. */
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = lock.then(fn, fn);
    lock = next.catch(() => undefined);
    return next;
  };

  const run = async (fn: (paths: ProjectPaths) => object | Promise<object>, mutating = false): Promise<CallToolResult> => {
    try {
      const paths = await resolver.paths();
      const value = mutating ? await exclusive(async () => fn(paths)) : await fn(paths);
      return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
    } catch (error) {
      return errorResult(error);
    }
  };

  // --- Read tools -----------------------------------------------------------

  server.registerTool(
    'get_flow',
    {
      title: 'Get flow',
      description:
        'The active (or named) flow: steps in flow order with their transitions (event → target), the initial and current step, and the declared template variables.',
      inputSchema: z.object({ flow: flowArg }),
      annotations: READ_ONLY,
    },
    async ({ flow }) => run((paths) => describeFlow(paths, flow)),
  );

  server.registerTool(
    'list_flows',
    {
      title: 'List flows',
      description: 'All flows of the project (name, title, description, number of steps) and which one is active.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => run((paths) => listFlowsInfo(paths)),
  );

  server.registerTool(
    'get_status',
    {
      title: 'Get flow status',
      description:
        'Where the flow is: the current step and its slash command, the events it can fire with their targets, whether the flow is done, and the last history entries. Call at the start of every step.',
      inputSchema: z.object({ flow: flowArg }),
      annotations: READ_ONLY,
    },
    async ({ flow }) => run((paths) => describeStatus(paths, flow)),
  );

  server.registerTool(
    'get_step',
    {
      title: 'Get step',
      description:
        'One step: metadata, outgoing and incoming transitions, its template (SKILL.md.hbs) with its project-relative path, the rendered SKILL.md from the last sync, and the files in its directory.',
      inputSchema: z.object({ step: stepArg('Step id (state key).'), flow: flowArg }),
      annotations: READ_ONLY,
    },
    async ({ step, flow }) => run((paths) => describeStep(paths, step, flow)),
  );

  server.registerTool(
    'validate_flow',
    {
      title: 'Validate flow',
      description: 'Validates flow.json and the step templates of the active (or named) flow; returns errors and warnings.',
      inputSchema: z.object({ flow: flowArg }),
      annotations: { ...READ_ONLY, idempotentHint: true },
    },
    async ({ flow }) => run((paths) => validateFlowInfo(paths, flow)),
  );

  server.registerTool(
    'get_authoring_guide',
    {
      title: 'Step authoring guide',
      description:
        'How to write a step template (SKILL.md.hbs): files, frontmatter rules, the Handlebars context, helpers and partials, forbidden tokens, transition conventions and an example. Read before writing or editing a template.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => ({ content: [{ type: 'text', text: AUTHORING_GUIDE }], structuredContent: { guide: AUTHORING_GUIDE } }),
  );

  // --- Runtime tools --------------------------------------------------------

  server.registerTool(
    'transition',
    {
      title: 'Fire flow event',
      description:
        'Fires an event (default NEXT) from the current step and returns the new current step with its slash command. Pass "from" to fail unless that step is current.',
      inputSchema: z.object({
        event: z.string().optional().describe('Event to fire, e.g. NEXT, BACK, FAILED, CHANGES_REQUESTED. Default NEXT.'),
        from: z.string().optional().describe('Expected current step id; the call fails if the flow is elsewhere.'),
        flow: flowArg,
      }),
      annotations: WRITES,
    },
    async (args) => run((paths) => fireEvent(paths, args), true),
  );

  server.registerTool(
    'complete_step',
    {
      title: 'Complete step',
      description:
        'Marks a step as done by firing an event (default NEXT) from it; fails if the step is not the current one. Returns the next step and its slash command.',
      inputSchema: z.object({
        step: stepArg('Id of the step that was completed (must be the current step).'),
        event: z.string().optional().describe('Event matching the outcome, e.g. NEXT, FAILED, CHANGES_REQUESTED. Default NEXT.'),
        flow: flowArg,
      }),
      annotations: WRITES,
    },
    async (args) => run((paths) => completeStep(paths, args), true),
  );

  server.registerTool(
    'goto_step',
    {
      title: 'Go to step',
      description: 'Jumps to any step of the flow (recorded as event GOTO), regardless of transitions.',
      inputSchema: z.object({ step: stepArg('Id of the step to make current.'), flow: flowArg }),
      annotations: WRITES,
    },
    async (args) => run((paths) => jumpToStep(paths, args), true),
  );

  // --- Authoring tools ------------------------------------------------------

  server.registerTool(
    'add_step',
    {
      title: 'Add step',
      description:
        'Creates a step: its state in flow.json (wired in after/before another step), its directory and SKILL.md.hbs, then re-installs the skills. Without after/before it goes after the last step. Read get_authoring_guide first.',
      inputSchema: z.object({
        id: stepArg('New step id: kebab-case, max 64 characters; it becomes the skill name and slash command.'),
        title: z.string().optional().describe('Short title (1-3 words). Default: the id in title case.'),
        description: z
          .string()
          .optional()
          .describe('One sentence (max 200 chars) starting with a verb that says when to use the step; becomes the skill description.'),
        after: z.string().optional().describe('Insert after this step: its `event` transition now leads to the new step, which inherits the old target.'),
        before: z.string().optional().describe('Insert before this step: every `event` transition to it (and initial) now leads to the new step.'),
        event: z.string().optional().describe('Event used to splice the step in. Default NEXT.'),
        on: z
          .record(z.string(), z.string())
          .optional()
          .describe('Extra outgoing transitions of the new step, event → target step id, e.g. {"FAILED": "implement"}.'),
        template: z.string().optional().describe('SKILL.md.hbs content. Default: a skeleton to fill in later.'),
        flow: flowArg,
      }),
      annotations: WRITES,
    },
    async (args) => run((paths) => addStepTool(paths, args), true),
  );

  server.registerTool(
    'update_step',
    {
      title: 'Update step',
      description:
        'Changes a step (title, description, template, transitions, id, initial step), then re-installs the skills. Read get_authoring_guide before changing a template.',
      inputSchema: z.object({
        step: stepArg('Id of the step to change.'),
        title: z.string().optional().describe('New title.'),
        description: z.string().optional().describe('New description (one sentence, max 200 chars, starts with a verb).'),
        template: z.string().optional().describe('New full SKILL.md.hbs content.'),
        rename: z.string().optional().describe('New step id; transitions, the directory and the flow position follow.'),
        on: z
          .record(z.string(), z.string().nullable())
          .optional()
          .describe('Transitions to set (event → target step id) or remove (event → null).'),
        initial: z.boolean().optional().describe('true makes this the initial step of the flow.'),
        flow: flowArg,
      }),
      annotations: WRITES,
    },
    async (args) => run((paths) => updateStepTool(paths, args), true),
  );

  server.registerTool(
    'delete_step',
    {
      title: 'Delete step',
      description:
        "Deletes a step and its directory, reroutes transitions that led to it to its NEXT target, then re-installs the skills. Fails with CANNOT_REWIRE when it has no NEXT transition unless force is set (those transitions are then dropped).",
      inputSchema: z.object({
        step: stepArg('Id of the step to delete.'),
        force: z.boolean().optional().describe('Drop incoming transitions that cannot be rerouted. Only after the user agreed.'),
        flow: flowArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => run((paths) => deleteStepTool(paths, args), true),
  );

  server.registerTool(
    'sync',
    {
      title: 'Sync skills',
      description:
        'Re-renders the active flow and re-installs its skills and the MCP config for every configured agent (same as `dfl flow-update`). Use after editing files under .df/ by hand.',
      inputSchema: z.object({}),
      annotations: { ...WRITES, idempotentHint: true },
    },
    async () => run((paths) => syncTool(paths), true),
  );

  // --- Resources ------------------------------------------------------------

  server.registerResource(
    'flow',
    'dfl://flow',
    { title: 'Active flow', description: 'flow.json of the active flow.', mimeType: 'application/json' },
    async (uri) =>
      readResource(async () => {
        const paths = await resolver.paths();
        const name = getActiveFlowName(paths) ?? loadActiveFlow(paths).name;
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: readText(paths.flowFile(name)) }] };
      }),
  );

  server.registerResource(
    'step-template',
    new ResourceTemplate('dfl://steps/{id}', {
      list: async () => {
        try {
          const model = loadActiveFlow(await resolver.paths());
          return {
            resources: skillSteps(model).map((step) => ({
              uri: `dfl://steps/${step.id}`,
              name: step.id,
              title: step.title,
              description: step.description,
              mimeType: 'text/markdown',
            })),
          };
        } catch {
          return { resources: [] };
        }
      },
      complete: {
        id: async (value) => {
          try {
            return skillSteps(loadActiveFlow(await resolver.paths()))
              .map((step) => step.id)
              .filter((id) => id.startsWith(value));
          } catch {
            return [];
          }
        },
      },
    }),
    { title: 'Step template', description: 'SKILL.md.hbs of a step of the active flow.', mimeType: 'text/markdown' },
    async (uri, variables) =>
      readResource(async () => {
        const paths = await resolver.paths();
        const raw = variables['id'];
        const id = decodeURIComponent((Array.isArray(raw) ? raw[0] : raw) ?? '');
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: stepTemplateText(paths, id) }] };
      }),
  );

  return server;
}

/** `dfl mcp`: serves over stdio until stdin closes (or SIGINT/SIGTERM). */
export async function runMcpServer(options?: RunMcpServerOptions): Promise<void> {
  const { stdin, stdout, ...serverOptions } = options ?? {};
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve();
    };
    const transport = new ObservedStdioTransport(finish, stdin, stdout);
    const handle = serveStdio(() => createDflMcpServer(serverOptions), {
      transport,
      onerror: (error) => {
        if (process.env['DFL_DEBUG']) process.stderr.write(`dfl mcp: ${error.message}\n`);
      },
    });
    function onSignal(): void {
      void handle.close().finally(finish);
    }
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A stdio transport that reports when it closes (stdin ended, write error or `close()`). */
class ObservedStdioTransport extends StdioServerTransport {
  readonly #onClosed: () => void;

  constructor(onClosed: () => void, stdin?: Readable, stdout?: Writable) {
    super(stdin, stdout);
    this.#onClosed = onClosed;
  }

  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      this.#onClosed();
    }
  }
}

interface RootResolver {
  /** Resolves the project for one call (no caching of the result). */
  paths(): Promise<ProjectPaths>;
}

/**
 * Project root per call: `options.root` → `DFL_ROOT` → client roots (first `file://` root that
 * contains `.df/`, then the nearest ancestor with `.df/` of each root) → nearest ancestor with
 * `.df/` of the cwd. The client's root list is fetched once after initialization and again after
 * `notifications/roots/list_changed`.
 */
function createRootResolver(server: McpServer, options: DflMcpOptions): RootResolver {
  let roots: Promise<string[]> | undefined;

  const clientRoots = (): Promise<string[]> => {
    if (!server.server.getClientCapabilities()?.roots) return Promise.resolve([]);
    roots ??= server.server
      .listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS })
      .then((result) => result.roots.flatMap((root) => fileUriToPath(root.uri)))
      .catch(() => []);
    return roots;
  };

  server.server.oninitialized = () => {
    roots = undefined;
    void clientRoots();
  };
  server.server.setNotificationHandler('notifications/roots/list_changed', () => {
    roots = undefined;
  });

  return {
    async paths() {
      const cwd = path.resolve(options.cwd ?? process.cwd());
      if (options.root || process.env['DFL_ROOT']) return existingProject(resolveProjectRoot({ root: options.root, cwd }));
      const candidates = await clientRoots();
      const found =
        candidates.find((root) => isDir(path.join(root, '.df'))) ??
        candidates.map((root) => findProjectRoot(root)).find((root) => root !== undefined);
      return existingProject(found ?? resolveProjectRoot({ cwd }));
    },
  };
}

function existingProject(root: string): ProjectPaths {
  const paths = projectPaths(root);
  if (!isDir(paths.dfDir)) {
    throw new DflError(`No dfl project at ${paths.root} (it has no .df/ directory).`, {
      hint: 'Run `dfl install` in the project root, or point the server at it with `dfl mcp --root <dir>` or DFL_ROOT.',
      code: 'NO_PROJECT',
    });
  }
  return paths;
}

/** Resource reads report failures as protocol errors whose message includes the DflError hint. */
async function readResource<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(formatError(error));
  }
}

function fileUriToPath(uri: string): string[] {
  try {
    return uri.startsWith('file:') ? [path.resolve(fileURLToPath(uri))] : [];
  } catch {
    return [];
  }
}

function errorResult(error: unknown): CallToolResult {
  const text = formatError(error);
  const details =
    error instanceof DflError
      ? { error: error.message, code: error.code, ...(error.hint ? { hint: error.hint } : {}) }
      : { error: text, code: 'INTERNAL_ERROR' };
  return { isError: true, content: [{ type: 'text', text }], structuredContent: details };
}

function safePackageVersion(): string {
  try {
    return packageVersion();
  } catch {
    return '0.0.0';
  }
}
