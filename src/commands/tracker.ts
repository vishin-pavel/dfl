/**
 * `dfl tracker init | login | logout | check | map | field`: tracking flows in Jira.
 *
 * - `init` writes `.df/tracker.json` (committed: the site, the projects, the tracked flows).
 * - `login` / `logout` manage the developer's own API token (user level, never in the project).
 * - `check` validates the setup online (core/tracker/check.ts).
 * - `map` edits which Jira status each step of a flow moves the ticket to, including none (dfl keeps
 *   the ticket's status) per step or for the whole flow; a mapping entry is what makes a flow
 *   tracked. `field` maps task params to Jira fields.
 * Editors are read-modify-writes of the raw JSON under the project lock (core/tracker/edit.ts), so
 * key order and unknown keys survive; online checks and prompts run before the lock.
 */
import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import { getActiveFlowName } from '../core/config.js';
import { DflError, errorMessage } from '../core/errors.js';
import { flowExists, getStep, listFlows, loadActiveFlow, loadFlow, loadFlowOrActive } from '../core/flow.js';
import {
  checkTracker,
  fetchFieldCatalog,
  fetchStatusCatalog,
  fieldLabel,
  fieldProblem,
  findStatus,
  mappingName,
  unknownStatusError,
  type StatusCatalog,
} from '../core/tracker/check.js';
import {
  CUSTOM_FIELD_RE,
  DEFAULT_BRANCH_TEMPLATE,
  DEFAULT_RECORD_PROPERTY,
  PROJECT_KEY_RE,
  TRACKER_FILE_LABEL,
  hasTrackerConfig,
  loadTrackerConfig,
  notConfiguredError,
  readTrackerConfigRaw,
  requireTrackerConfig,
  trackerWarnings,
  writeTrackerConfigRaw,
  type TrackerConfig,
  type TrackerConfigRaw,
} from '../core/tracker/config.js';
import { credentialFor, credentialSource, removeCredential, saveCredential } from '../core/tracker/credentials.js';
import {
  applyStatusEdits,
  mappingLabel,
  newTrackerConfigRaw,
  parseStatusArg,
  removeTrackedFlow,
  setFieldMapping,
  type StatusEdit,
  type StatusEditResult,
  type StatusEditValue,
  type StatusTarget,
} from '../core/tracker/edit.js';
import { trackerDeadline } from '../core/tracker/http.js';
import { createJiraClient } from '../core/tracker/jira.js';
import { assertValidParamName } from '../core/tracker/record.js';
import type { FlowModel, ProjectPaths, StepInfo } from '../core/types.js';
import { c } from '../ui/colors.js';
import { CliExit } from '../ui/exit.js';
import { plain, plural, print, printJson, printLines, sym, terminalWidth, warning } from '../ui/output.js';
import { confirm, intro, isInteractive, logWarning, outro, password, select, spinner, text } from '../ui/prompts.js';
import { table } from '../ui/table.js';
import {
  confirmDestructive,
  launcherText,
  locked,
  printAfterChange,
  projectFor,
  syncIfInstalled,
  type AfterChange,
  type CliContext,
} from './shared.js';

/** Where Atlassian users create API tokens. */
const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
/** More than this on stdin is not an API token. */
const MAX_STDIN_BYTES = 64 * 1024;

export function registerTrackerCommands(program: CommandUnknownOpts, ctx: CliContext): void {
  const tracker = program.command('tracker').description('Track flows in Jira: project config, your credential, the step → status mapping');
  registerInit(tracker, ctx);
  registerLogin(tracker, ctx);
  registerCheck(tracker, ctx);
  registerMap(tracker, ctx);
  registerField(tracker, ctx);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function registerInit(tracker: CommandUnknownOpts, ctx: CliContext): void {
  tracker
    .command('init')
    .description('Create .df/tracker.json: the Jira site, its projects and the tracked flows')
    .option('--url <url>', 'Jira site, e.g. https://acme.atlassian.net')
    .option('--project <keys>', 'Jira project key(s), comma-separated')
    .option('--default-project <key>', 'project of bare ticket numbers such as 123 (default: the only project)')
    .option('--branch-template <template>', `names of task branches (default ${DEFAULT_BRANCH_TEMPLATE})`)
    .option('--from <ref>', 'ref task branches start from (default origin/<mainBranch>)')
    .option('--property <name>', `Jira issue property that holds the dfl record (default ${DEFAULT_RECORD_PROPERTY})`)
    .option('--flow <names...>', 'flows to track (default: the active flow)')
    .option('--force', 'replace an existing .df/tracker.json')
    .option('--no-sync', 'do not re-install the skills afterwards (they gain the built-in /init-task skill)')
    .option('-y, --yes', 'do not ask (then --url and --project are required)')
    .action(async (opts) => {
      const paths = projectFor(ctx);
      if (hasTrackerConfig(paths) && !opts.force) throw configExistsError();
      let url = opts.url;
      let project = opts.project;
      if (url === undefined || project === undefined) {
        if (!isInteractive(opts)) {
          throw new DflError('`dfl tracker init` needs --url and --project when there is no terminal to ask.', {
            hint: 'For example: `dfl tracker init --url https://acme.atlassian.net --project ABC`.',
            code: 'INVALID_OPTIONS',
          });
        }
        url ??= await text({ message: 'Jira site', placeholder: 'https://acme.atlassian.net', validate: (value) => problemOf(() => siteOrigin(value)) });
        project ??= await text({ message: 'Jira project key(s), comma-separated', placeholder: 'ABC', validate: (value) => problemOf(() => projectKeys(value)) });
      }
      const baseUrl = siteOrigin(url);
      const keys = projectKeys(project);
      const defaultProject = opts.defaultProject?.trim().toUpperCase();
      if (defaultProject !== undefined && !keys.includes(defaultProject)) {
        throw new DflError(`--default-project ${defaultProject} is not one of the projects (${keys.join(', ')}).`, { code: 'INVALID_OPTIONS' });
      }
      const active = getActiveFlowName(paths);
      const flows = opts.flow ?? (active !== undefined ? [active] : []);
      for (const flow of flows) {
        if (!flowExists(paths, flow)) {
          throw new DflError(`Flow "${flow}" does not exist.`, { hint: `Flows: ${listFlows(paths).join(', ') || '(none)'}`, code: 'FLOW_NOT_FOUND' });
        }
      }
      const raw = newTrackerConfigRaw({
        baseUrl,
        projectKeys: keys,
        defaultProjectKey: defaultProject ?? (keys.length === 1 ? keys[0] : undefined),
        property: opts.property,
        branchTemplate: opts.branchTemplate,
        from: opts.from,
        flows: [...new Set(flows)],
      });
      const synced = await locked(paths, async (): Promise<AfterChange | { kind: 'failed'; message: string }> => {
        if (hasTrackerConfig(paths) && !opts.force) throw configExistsError();
        writeTrackerConfigRaw(paths, raw);
        // The built-in /init-task skill is installed only with a tracker.json: re-install the skills
        // of a developer who installed them, like other mutations do. A failed sync keeps the file.
        try {
          return await syncIfInstalled(paths, { sync: opts.sync });
        } catch (error) {
          return { kind: 'failed', message: errorMessage(error) };
        }
      });

      const tracked = [...new Set(flows)];
      print(
        `${c.green(sym.ok)} Created ${TRACKER_FILE_LABEL} ${c.dim(
          `(Jira ${baseUrl}, ${keys.length === 1 ? 'project' : 'projects'} ${keys.join(', ')}; ${
            tracked.length > 0 ? `tracked: ${tracked.join(', ')}` : 'no tracked flow'
          })`,
        )}`,
      );
      if (synced.kind === 'synced') printAfterChange(paths, synced);
      if (synced.kind === 'failed') {
        warning(launcherText(paths, `The skills were not re-installed: ${synced.message.replace(/\.?$/, '.')} Run \`dfl flow-update\` to install the /init-task skill.`));
      }
      print();
      print(c.bold('Next steps'));
      printLines(
        [
          `  1. Commit ${TRACKER_FILE_LABEL}: teammates share this setup.`,
          '  2. Each developer runs `dfl tracker login` once (the API token stays in their user config, never in the project).',
          tracked.length > 0
            ? '  3. Map the steps to Jira statuses with `dfl tracker map` (or keep the statuses as they are: `dfl tracker map --none`), then run `dfl tracker check`.'
            : '  3. Track a flow with `dfl tracker map --flow <flow>` (`--none` keeps the Jira statuses as they are), then run `dfl tracker check`.',
          '  4. Optionally store the task branch in a Jira field: `dfl tracker field branch <field>`.',
        ].map((line) => launcherText(paths, line)),
      );
    });
}

function configExistsError(): DflError {
  return new DflError(`${TRACKER_FILE_LABEL} already exists.`, {
    hint: 'Edit it with `dfl tracker map` / `dfl tracker field` (or by hand), or pass --force to replace it.',
    code: 'TRACKER_CONFIG_EXISTS',
  });
}

/** The origin of a Jira site URL (`acme.atlassian.net` → `https://acme.atlassian.net`). */
function siteOrigin(value: string): string {
  const input = value.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL | undefined;
  try {
    url = new URL(withScheme);
  } catch {
    url = undefined;
  }
  if (input === '' || !url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') {
    throw new DflError(`"${input}" is not the URL of a Jira site.`, { hint: 'Pass it like https://acme.atlassian.net.', code: 'INVALID_OPTIONS' });
  }
  return url.origin;
}

/** `abc, XYZ` → `['ABC', 'XYZ']`. */
function projectKeys(value: string): string[] {
  const keys = [...new Set(value.split(/[\s,]+/).map((key) => key.trim().toUpperCase()).filter((key) => key !== ''))];
  if (keys.length === 0) {
    throw new DflError('No Jira project key given.', { hint: 'Pass --project ABC (the letters before the number of a ticket).', code: 'INVALID_OPTIONS' });
  }
  const invalid = keys.filter((key) => !PROJECT_KEY_RE.test(key));
  if (invalid.length > 0) {
    throw new DflError(`"${invalid[0]}" is not a Jira project key.`, {
      hint: 'A project key is the part of a ticket key before the number, e.g. ABC for ABC-123.',
      code: 'INVALID_OPTIONS',
    });
  }
  return keys;
}

/** The message of the error `fn` throws (for prompt validation), undefined when it does not throw. */
function problemOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

// ---------------------------------------------------------------------------
// login / logout
// ---------------------------------------------------------------------------

function registerLogin(tracker: CommandUnknownOpts, ctx: CliContext): void {
  tracker
    .command('login')
    .description("Save your Jira API token for this project's Jira site (in your user config, never in the project)")
    .option('--email <email>', 'the email you log in to Jira with (default: the saved one)')
    .option('--token-stdin', 'read the API token from stdin (it is never accepted as an argument)')
    .action(async (opts) => {
      const paths = projectFor(ctx);
      const cfg = requireTrackerConfig(paths);
      const origin = cfg.jira.origin;
      const interactive = isInteractive();
      if (!opts.tokenStdin && !interactive) {
        throw new DflError('There is no terminal to ask for the Jira API token.', {
          hint: launcherText(
            paths,
            'Run `dfl tracker login` in your own terminal, or pipe the token in: `dfl tracker login --email <email> --token-stdin < token-file`. ' +
              'Never pass a token as an argument or paste it into a chat.',
          ),
          code: 'INVALID_OPTIONS',
        });
      }
      print(`Jira site: ${c.bold(origin)}`);
      const saved = savedEmail(origin);
      let email = opts.email?.trim() || undefined;
      if (email === undefined) {
        if (opts.tokenStdin) {
          if (saved === undefined) {
            throw new DflError('--token-stdin needs --email (no credential for this site is saved yet).', {
              hint: 'Pass the email you log in to Jira with: --email you@example.com.',
              code: 'INVALID_OPTIONS',
            });
          }
          email = saved;
        } else {
          email = (
            await text({
              message: 'Email you log in to Jira with',
              placeholder: saved,
              defaultValue: saved,
              validate: (value) => (value.trim() === '' && saved === undefined ? 'Enter your email.' : undefined),
            })
          ).trim();
        }
      }
      const token = (
        opts.tokenStdin
          ? await readStdin()
          : await password({ message: `API token (create one at ${TOKEN_URL})`, validate: (value) => (value.trim() === '' ? 'Paste the token.' : undefined) })
      ).trim();
      if (token === '') {
        throw new DflError('No API token on stdin.', { hint: 'Pipe the token in, e.g. `--token-stdin < token-file`.', code: 'INVALID_OPTIONS' });
      }
      if (/\s/.test(token)) {
        throw new DflError('The API token contains whitespace.', { hint: `Paste the whole token as a single line (create one at ${TOKEN_URL}).`, code: 'INVALID_OPTIONS' });
      }

      const me = await createJiraClient({ baseUrl: cfg.jira.baseUrl, credential: { email, token }, signal: trackerDeadline() }).myself();
      const file = saveCredential(origin, { email, token, accountId: me.accountId, displayName: me.displayName });
      print(`${c.green(sym.ok)} Logged in to ${origin} as ${plain(me.displayName || email)} ${c.dim(`(${plain(email)})`)}`);
      print(c.dim(`  Saved to ${file} (readable only by you).`));
      if (credentialSource(origin) === 'env') {
        warning('DFL_JIRA_URL, DFL_JIRA_EMAIL and DFL_JIRA_TOKEN are set for this site: dfl uses them instead of the saved credential.');
      }
    });

  tracker
    .command('logout')
    .description("Remove your saved Jira API token for this project's Jira site")
    .action(() => {
      const paths = projectFor(ctx);
      const origin = requireTrackerConfig(paths).jira.origin;
      if (removeCredential(origin)) print(`${c.green(sym.ok)} Removed your saved Jira credential for ${origin}.`);
      else print(c.dim(`No Jira credential for ${origin} is saved; nothing changed.`));
      if (credentialSource(origin) === 'env') warning('DFL_JIRA_URL, DFL_JIRA_EMAIL and DFL_JIRA_TOKEN are still set for this site: dfl keeps using them.');
    });
}

/** The email of the saved (file) credential for `origin`, if any. */
function savedEmail(origin: string): string | undefined {
  try {
    const credential = credentialFor(origin);
    return credential?.source === 'file' ? credential.email : undefined;
  } catch {
    return undefined; // a broken file: saving reports it
  }
}

/** All of stdin (for `--token-stdin`). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_STDIN_BYTES) throw new DflError('stdin holds more than an API token.', { code: 'INVALID_OPTIONS' });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

function registerCheck(tracker: CommandUnknownOpts, ctx: CliContext): void {
  tracker
    .command('check')
    .description('Check the Jira setup: config, your credential, projects, mapped statuses and fields (exit 1 on problems)')
    .option('--json', 'print JSON: { ok, checks: [{ check, level, message, hint }] }')
    .action(async (opts) => {
      const paths = projectFor(ctx);
      const checks = (await checkTracker(paths)).map((check) => ({
        ...check,
        message: launcherText(paths, check.message),
        ...(check.hint !== undefined ? { hint: launcherText(paths, check.hint) } : {}),
      }));
      const failures = checks.filter((check) => check.level === 'fail').length;
      if (opts.json) {
        printJson({ ok: failures === 0, checks });
      } else {
        for (const check of checks) {
          const mark = check.level === 'ok' ? c.green(sym.ok) : check.level === 'warn' ? c.yellow(sym.warn) : c.red(sym.fail);
          // Messages quote Jira (status, field and project names): no control characters to the terminal.
          print(`${mark} ${plain(check.message)}`);
          if (check.hint !== undefined && check.level !== 'ok') print(c.dim(`  ${plain(check.hint)}`));
        }
        const warnings = checks.filter((check) => check.level === 'warn').length;
        print();
        print(
          failures > 0
            ? c.red(`${sym.fail} ${plural(failures, 'problem')} found.`)
            : `${c.green(sym.ok)} Ready to track tasks in Jira${warnings > 0 ? c.dim(` (${plural(warnings, 'warning')})`) : ''}.`,
        );
      }
      if (failures > 0) throw new CliExit(1);
    });
}

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------

interface MapView {
  flow: string;
  tracked: boolean;
  /** Step → raw mapping (string | object | null); steps of the flow in flow order, then other mapped keys. */
  statuses: Record<string, unknown>;
}

function registerMap(tracker: CommandUnknownOpts, ctx: CliContext): void {
  tracker
    .command('map')
    .description("Map the steps of a flow to Jira statuses (none: dfl leaves the ticket's status alone at that step)")
    .argument('[step]', 'step id (without one: the wizard in a terminal, else the mapping)')
    .argument('[status]', 'Jira status name, id:<status id>, or none')
    .option('--flow <name>', 'flow (default: the active flow)')
    .option('--none', 'no automated status change at <step>, or at every step of the flow when no step is given')
    .option('--unset', 'remove the mapping of <step> (same effect as none)')
    .option('--remove', 'stop tracking the flow in Jira (removes its entry from .df/tracker.json)')
    .option('--list', 'print the mapping (no wizard)')
    .option('--json', 'print the mapping as JSON: { flow, tracked, statuses }')
    .option('--no-check', 'do not check the status against Jira')
    .option('-y, --yes', 'do not ask (no wizard; confirms --remove)')
    .action(async (step, status, opts) => {
      const paths = projectFor(ctx);
      if (readTrackerConfigRaw(paths) === undefined) throw notConfiguredError();
      if (opts.remove && (step !== undefined || opts.none || opts.unset)) {
        throw invalidOptions('--remove takes no step, --none or --unset: it stops tracking the whole flow.');
      }
      if (opts.unset && (step === undefined || status !== undefined || opts.none)) {
        throw invalidOptions('--unset needs a step and nothing else: `dfl tracker map <step> --unset`.');
      }
      if (opts.none && status !== undefined) throw invalidOptions(`Pass either a status or --none for step "${step}", not both.`);

      if (opts.remove) {
        await removeFlow(paths, opts.flow ?? loadActiveFlow(paths).name, opts);
        return;
      }
      const model = loadFlowOrActive(paths, opts.flow);
      if (step === undefined && !opts.none) {
        if (!opts.list && !opts.json && isInteractive(opts)) {
          await mapWizard(paths, model, model.steps, opts.check);
          return;
        }
        printMapping(paths, model, opts.json === true);
        return;
      }

      let edits: StatusEdit[];
      if (step === undefined) {
        // --none: the flow stays tracked (record, params, branch field) without status changes.
        edits = model.steps.map((s) => ({ step: s.id, value: null }));
      } else {
        getStep(model, step);
        let value: StatusEditValue;
        if (opts.unset) value = 'unset';
        else if (opts.none) value = null;
        else if (status !== undefined) value = parseStatusArg(status);
        else if (!opts.json && isInteractive(opts)) {
          await mapWizard(paths, model, [model.byId.get(step)!], opts.check);
          return;
        } else {
          throw invalidOptions(`Missing the Jira status for step "${step}".`, 'Pass a status name, id:<status id>, or none: `dfl tracker map <step> <status>`.');
        }
        if (value !== null && value !== 'unset' && opts.check) value = await checkedStatus(paths, value);
        edits = [{ step, value }];
      }

      const { result, cfg } = await writeStatusEdits(paths, model.name, edits);
      if (opts.json) {
        printJson(mapView(readTrackerConfigRaw(paths) ?? {}, model));
        return;
      }
      if (result.created) print(`${c.green(sym.ok)} Flow "${model.name}" is now tracked in Jira.`);
      if (step === undefined) {
        print(`${c.green(sym.ok)} No step of flow "${model.name}" changes the Jira status: dfl still records each task, its params and branch.`);
      } else {
        const value = edits[0]!.value;
        print(
          value === null || value === 'unset'
            ? `${c.green(sym.ok)} ${step} ${c.dim(sym.arrow)} none ${c.dim("(dfl leaves the ticket's status alone at this step)")}`
            : `${c.green(sym.ok)} ${step} ${c.dim(sym.arrow)} ${c.bold(plain(targetLabel(value)))}`,
        );
      }
      printEditNotes(paths, model, result, cfg);
      print();
      printMapping(paths, model, false);
    });
}

/**
 * The status as Jira spells it (its untranslated name when Jira sends one), after checking that the
 * configured projects have it (`TRACKER_STATUS_UNKNOWN` with close matches otherwise). Without a credential, or when Jira cannot
 * be reached, a warning: the mapping is written unchecked.
 */
async function checkedStatus(paths: ProjectPaths, target: StatusTarget): Promise<StatusTarget> {
  let cfg: TrackerConfig | undefined;
  try {
    cfg = loadTrackerConfig(paths);
  } catch (error) {
    warning(`Not checked against Jira: ${errorMessage(error)}`);
    return target;
  }
  if (!cfg) return target;
  const catalog = await fetchStatusCatalog(cfg);
  if ('problem' in catalog) {
    warning(launcherText(paths, `Not checked against Jira: ${catalog.problem}.`));
    return target;
  }
  const found = findStatus(catalog.statuses, target);
  if (!found) throw unknownStatusError(target, catalog);
  return 'id' in target ? target : { name: mappingName(found) };
}

/** Applies `edits` to `flows.<flow>.statuses` under the project lock (re-reading the file there). */
async function writeStatusEdits(
  paths: ProjectPaths,
  flow: string,
  edits: readonly StatusEdit[],
): Promise<{ result: StatusEditResult; cfg: TrackerConfig }> {
  return locked(paths, () => {
    const raw = readTrackerConfigRaw(paths);
    if (!raw) throw notConfiguredError();
    const result = applyStatusEdits(raw, flow, edits);
    return { result, cfg: writeTrackerConfigRaw(paths, raw) };
  });
}

/** Kept mapping options and the offline warnings about the flow's mapping after an edit (`dfl tracker check` has the rest). */
function printEditNotes(paths: ProjectPaths, model: FlowModel, result: StatusEditResult, cfg: TrackerConfig): void {
  for (const step of result.kept) print(c.dim(`  The mapping of ${step} kept its other settings ("fields", "reopen").`));
  for (const message of trackerWarnings(paths, cfg, { flow: model.name })) {
    if (message.includes(`flows.${model.name}.`)) warning(launcherText(paths, message));
  }
}

/** `dfl tracker map --remove`: the flow is no longer tracked (asks first; `--yes` without a terminal). */
async function removeFlow(paths: ProjectPaths, flow: string, opts: { yes?: boolean | undefined; json?: boolean | undefined }): Promise<void> {
  const flows = readTrackerConfigRaw(paths)?.['flows'];
  const tracked = typeof flows === 'object' && flows !== null && !Array.isArray(flows) && Object.hasOwn(flows, flow);
  if (tracked) {
    const ok = await confirmDestructive(
      `Stop tracking flow "${flow}" in Jira (remove "flows.${flow}" and its status mapping from ${TRACKER_FILE_LABEL})?`,
      { yes: opts.yes },
    );
    if (!ok) {
      print(c.dim('Nothing changed.'));
      return;
    }
    const cfg = await locked(paths, () => {
      const raw = readTrackerConfigRaw(paths);
      if (!raw) throw notConfiguredError();
      removeTrackedFlow(raw, flow);
      return writeTrackerConfigRaw(paths, raw);
    });
    if (!opts.json) {
      print(`${c.green(sym.ok)} Flow "${flow}" is no longer tracked in Jira: dfl uses its local state again.`);
      // flowSelect may still name it.
      for (const message of trackerWarnings(paths, cfg)) if (message.includes(`"${flow}"`)) warning(launcherText(paths, message));
    }
  } else if (!opts.json) {
    print(c.dim(`Flow "${flow}" is not tracked in Jira; nothing changed.`));
  }
  if (opts.json) {
    printJson(flowExists(paths, flow) ? mapView(readTrackerConfigRaw(paths) ?? {}, loadFlow(paths, flow)) : { flow, tracked: false, statuses: {} });
  }
}

/** The mapping of `model` from the raw config. */
function mapView(raw: TrackerConfigRaw, model: FlowModel): MapView {
  const flows = raw['flows'];
  const entry = isPlainObject(flows) && Object.hasOwn(flows, model.name) ? flows[model.name] : undefined;
  const mapped = isPlainObject(entry) && isPlainObject(entry['statuses']) ? entry['statuses'] : {};
  const statuses: Record<string, unknown> = {};
  for (const step of model.steps) statuses[step.id] = Object.hasOwn(mapped, step.id) ? mapped[step.id] : null;
  for (const [step, value] of Object.entries(mapped)) if (!model.byId.has(step)) statuses[step] = value;
  return { flow: model.name, tracked: isPlainObject(entry), statuses };
}

/** `dfl tracker map` without changes: the `step | status` table (or JSON). */
function printMapping(paths: ProjectPaths, model: FlowModel, json: boolean): void {
  const view = mapView(readTrackerConfigRaw(paths) ?? {}, model);
  if (json) {
    printJson(view);
    return;
  }
  print(`${c.bold(model.title)} ${c.dim(`(${model.name})`)} ${c.dim(sym.arrow)} Jira statuses`);
  const rows = Object.entries(view.statuses).map(([id, value]) => {
    const step = model.byId.get(id);
    const note = !step ? 'not in the flow (ignored)' : step.final ? 'final' : '';
    return [step ? id : c.dim(plain(id)), value === null || value === undefined ? c.dim('—') : plain(mappingLabel(value)), { text: note, style: c.dim }];
  });
  printLines(table(rows, { head: ['STEP', 'JIRA STATUS', ''], maxWidth: terminalWidth() }));
  if (!view.tracked) {
    print();
    print(
      c.dim(
        launcherText(
          paths,
          `Flow "${model.name}" is not tracked in Jira. Track it by mapping a step (\`dfl tracker map <step> <status>\`), ` +
            'or without status changes with `dfl tracker map --none`.',
        ),
      ),
    );
  } else if (Object.values(view.statuses).every((value) => value === null || value === undefined)) {
    print();
    print(c.dim("No step changes the Jira status: dfl records each task, its params and branch, and leaves the ticket's status alone."));
  }
}

/** Wizard choices besides the statuses (whose values are `status:<id>`). */
const KEEP = 'keep';
const NONE = 'none';
const TYPE = 'type';

/**
 * The interactive mapping: one select per step (keep / a status of the projects / none / type a
 * name), then one write under the lock and the table.
 */
async function mapWizard(paths: ProjectPaths, model: FlowModel, steps: readonly StepInfo[], check: boolean): Promise<void> {
  const view = mapView(readTrackerConfigRaw(paths) ?? {}, model);
  intro(`Jira statuses of flow "${model.name}"`);
  if (!view.tracked) {
    const ok = await confirm({ message: `Flow "${model.name}" is not tracked in Jira yet. Track it?`, initialValue: true });
    if (!ok) {
      outro('Nothing changed.');
      return;
    }
  }
  let catalog: StatusCatalog | undefined;
  let cfg: TrackerConfig | undefined;
  try {
    cfg = loadTrackerConfig(paths);
  } catch (error) {
    logWarning(`Jira statuses not loaded: ${errorMessage(error)}`);
  }
  if (cfg && check) {
    const spin = spinner();
    spin.start(`Reading the statuses of ${cfg.jira.projectKeys.join(', ')}`);
    const read = await fetchStatusCatalog(cfg);
    if ('problem' in read) {
      spin.error('Jira statuses not loaded');
      logWarning(launcherText(paths, `${read.problem}. You can still type status names.`));
    } else {
      spin.stop(`${plural(read.statuses.length, 'status', 'statuses')} in ${plain(read.projects.join(', '))}`);
      catalog = read;
    }
  }

  const edits: StatusEdit[] = [];
  for (const step of steps) {
    const current = view.statuses[step.id];
    const choice = await select<string>({
      message: `${step.title} ${c.dim(`(${step.id}${step.final ? ', final' : ''})`)}`,
      options: [
        { value: KEEP, label: `keep: ${mappingLabel(current)}` },
        ...(catalog?.statuses ?? []).map((s) => ({ value: `status:${s.id}`, label: plain(s.name), ...(s.categoryKey ? { hint: plain(s.categoryKey) } : {}) })),
        { value: NONE, label: "none – don't change the Jira status at this step" },
        { value: TYPE, label: 'type a status name…' },
      ],
      initialValue: KEEP,
      maxItems: 12,
    });
    if (choice === KEEP) continue;
    if (choice === NONE) {
      edits.push({ step: step.id, value: null });
      continue;
    }
    if (choice === TYPE) {
      const typed = (
        await text({
          message: `Status for ${step.id} (a name or id:<status id>; empty keeps it)`,
          validate: (value) => typedStatusProblem(value, catalog),
        })
      ).trim();
      if (typed !== '') {
        const target = parseStatusArg(typed);
        const found = target && catalog ? findStatus(catalog.statuses, target) : undefined;
        edits.push({ step: step.id, value: target && found && 'name' in target ? { name: mappingName(found) } : target });
      }
      continue;
    }
    const status = catalog?.statuses.find((s) => `status:${s.id}` === choice);
    if (status) edits.push({ step: step.id, value: { name: mappingName(status) } });
  }

  if (edits.length === 0 && view.tracked) {
    outro('Nothing changed.');
    return;
  }
  const { result, cfg: written } = await writeStatusEdits(paths, model.name, edits);
  printEditNotes(paths, model, result, written);
  printMapping(paths, model, false);
  outro(result.created ? `Flow "${model.name}" is now tracked in Jira.` : `Saved ${TRACKER_FILE_LABEL}.`);
}

/** Prompt validation of a typed status: parseable, and known when the statuses were loaded. */
function typedStatusProblem(value: string, catalog: StatusCatalog | undefined): string | undefined {
  if (value.trim() === '') return undefined;
  let target: StatusTarget | null;
  try {
    target = parseStatusArg(value);
  } catch (error) {
    return errorMessage(error);
  }
  if (!target || !catalog || findStatus(catalog.statuses, target)) return undefined;
  return `${unknownStatusError(target, catalog).message} Pick "none" or a listed status, or run the command with --no-check.`;
}

function targetLabel(target: StatusTarget): string {
  return 'name' in target ? target.name : `id:${target.id}`;
}

// ---------------------------------------------------------------------------
// field
// ---------------------------------------------------------------------------

function registerField(tracker: CommandUnknownOpts, ctx: CliContext): void {
  tracker
    .command('field')
    .description('Write a task param (e.g. branch, prUrl) to a Jira field, or list the mapped fields')
    .argument('[param]', 'task param name')
    .argument('[field]', 'Jira custom field id (customfield_10042) or name, or none')
    .option('--none', 'stop writing <param> to Jira')
    .option('--list', 'list the mapped fields (other arguments are ignored)')
    .option('--json', 'print JSON: { fields }')
    .option('--no-check', 'do not check the field in Jira')
    .action(async (param, field, opts) => {
      const paths = projectFor(ctx);
      if (readTrackerConfigRaw(paths) === undefined) throw notConfiguredError();
      if (param === undefined || opts.list) {
        if (opts.none) throw invalidOptions(opts.list ? 'Pass either --list or --none, not both.' : '--none needs the param: `dfl tracker field <param> --none`.');
        printFields(paths, opts.json === true);
        return;
      }
      if (opts.none && field !== undefined) throw invalidOptions(`Pass either a field or --none for "${param}", not both.`);
      const remove = opts.none === true || field?.trim().toLowerCase() === 'none';
      if (!remove) assertValidParamName(param);
      if (!remove && field === undefined) {
        throw invalidOptions(`Missing the Jira field for "${param}".`, 'Pass its id (customfield_10042) or name: `dfl tracker field <param> <field>`.');
      }
      const target = remove ? undefined : await resolveField(paths, field!, opts.check);
      const changed = await locked(paths, () => {
        const raw = readTrackerConfigRaw(paths);
        if (!raw) throw notConfiguredError();
        const edited = setFieldMapping(raw, param, target?.id);
        if (edited) writeTrackerConfigRaw(paths, raw);
        return edited;
      });
      if (opts.json) {
        printFields(paths, true);
        return;
      }
      if (remove) print(changed ? `${c.green(sym.ok)} ${param} is no longer written to Jira.` : c.dim(`${param} is not written to Jira; nothing changed.`));
      else print(`${c.green(sym.ok)} ${param} ${c.dim(sym.arrow)} ${c.bold(plain(target!.label))}${changed ? '' : c.dim(' (unchanged)')}`);
      print();
      printFields(paths, false);
    });
}

/**
 * The custom field `input` names (an id, or a field name looked up in Jira), checked to hold
 * single-line text unless `check` is false. Without a credential (or offline) an id is accepted
 * with a warning; a name cannot be looked up then.
 */
async function resolveField(paths: ProjectPaths, input: string, check: boolean): Promise<{ id: string; label: string }> {
  const value = input.trim();
  const isId = CUSTOM_FIELD_RE.test(value);
  const notAnId = (why: string): DflError =>
    new DflError(`"${value}" is not a custom field id such as customfield_10042, and ${why}.`, {
      hint: 'Pass the field id (Jira shows it in the field configuration), or its name with a working `dfl tracker login`.',
      code: 'INVALID_OPTIONS',
    });
  if (!check) {
    if (!isId) throw notAnId('--no-check does not look up field names');
    return { id: value, label: value };
  }
  const cfg = requireTrackerConfig(paths);
  const catalog = await fetchFieldCatalog(cfg);
  if ('problem' in catalog) {
    if (!isId) throw notAnId(`dfl could not look it up in Jira: ${catalog.problem}`);
    warning(launcherText(paths, `Not checked against Jira: ${catalog.problem}.`));
    return { id: value, label: value };
  }
  let field = isId ? catalog.find((f) => f.id === value) : undefined;
  if (!isId) {
    const named = catalog.filter((f) => f.custom && f.name.toLowerCase() === value.toLowerCase());
    if (named.length > 1) {
      throw new DflError(`Several Jira fields are named "${value}": ${named.map((f) => f.id).join(', ')}.`, {
        hint: 'Pass the id of the one you mean.',
        code: 'INVALID_OPTIONS',
      });
    }
    field = named[0];
  }
  const usable = catalog.filter((f) => f.custom && fieldProblem(f) === undefined).map(fieldLabel);
  if (!field) {
    throw new DflError(`Jira has no custom field ${isId ? value : `named "${value}"`}.`, {
      hint: `Single-line text and URL fields: ${usable.join(', ') || '(none)'}. Pass --no-check to map an id anyway.`,
      code: 'TRACKER_FIELD_UNKNOWN',
    });
  }
  const problem = fieldProblem(field);
  if (problem) {
    throw new DflError(`${fieldLabel(field)} ${problem}: dfl writes task params as single-line text.`, {
      hint: `Use a single-line text or URL field: ${usable.join(', ') || '(none)'}.`,
      code: 'TRACKER_FIELD_TYPE',
    });
  }
  return { id: field.id, label: fieldLabel(field) };
}

/** `dfl tracker field` without changes: `param | field` (or JSON `{ fields }`). */
function printFields(paths: ProjectPaths, json: boolean): void {
  const raw = readTrackerConfigRaw(paths) ?? {};
  const fields = isPlainObject(raw['fields']) ? raw['fields'] : {};
  if (json) {
    printJson({ fields });
    return;
  }
  const rows = Object.entries(fields).map(([param, id]) => [plain(param), plain(String(id))]);
  if (rows.length === 0) {
    print(c.dim(launcherText(paths, 'No task param is written to a Jira field. Add one with `dfl tracker field <param> <field>` (e.g. branch).')));
    return;
  }
  printLines(table(rows, { head: ['PARAM', 'JIRA FIELD'], maxWidth: terminalWidth() }));
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function invalidOptions(message: string, hint?: string): DflError {
  return new DflError(message, { ...(hint !== undefined ? { hint } : {}), code: 'INVALID_OPTIONS' });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
