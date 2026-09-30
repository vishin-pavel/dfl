/**
 * Shared types for dfl. Every module imports its domain types from here so
 * that independently written modules agree on shapes.
 */

export const AGENT_IDS = [
  'claude',
  'cursor',
  'antigravity',
  'codex',
  'gemini',
  'copilot',
  'windsurf',
  'opencode',
  'kiro',
] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Absolute paths of everything dfl reads or writes inside a project. */
export interface ProjectPaths {
  /** Absolute project root (the directory that contains `.df/`). */
  root: string;
  /** `<root>/.df` */
  dfDir: string;
  /** `<root>/.df/config.json` – committed project config. */
  configFile: string;
  /** `<root>/.df/local.json` – personal config (git-ignored). */
  localFile: string;
  /** `<root>/.df/state.json` – runtime flow state (git-ignored). */
  stateFile: string;
  /** `<root>/.df/installed.json` – manifest of files written outside `.df` (git-ignored). */
  manifestFile: string;
  /** `<root>/.df/.gitignore` */
  dfGitignoreFile: string;
  /** `<root>/.gitignore` */
  rootGitignoreFile: string;
  /** `<root>/.df/<flow>` */
  flowDir(flow: string): string;
  /** `<root>/.df/<flow>/flow.json` */
  flowFile(flow: string): string;
  /** `<root>/.df/<flow>/partials` */
  partialsDir(flow: string): string;
  /** `<root>/.df/<flow>/steps` */
  stepsDir(flow: string): string;
  /** `<root>/.df/<flow>/steps/<step>` */
  stepDir(flow: string, step: string): string;
}

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

/** `.df/config.json` (committed). */
export interface ProjectConfig {
  version: 1;
  /** Team default active flow. */
  activeFlow?: string | undefined;
  /** Team-recommended agents, pre-selected by `dfl install`. */
  agents?: AgentId[] | undefined;
  /** Project-scoped template variable values. */
  vars: Record<string, unknown>;
  /** Override of the MCP server launch command written into agent MCP configs. */
  mcp?: { command: string; args: string[] } | undefined;
}

/** `.df/local.json` (personal, git-ignored). */
export interface LocalConfig {
  version: 1;
  /** Personal override of the active flow. */
  activeFlow?: string | undefined;
  /** Agents this developer installs skills for. */
  agents?: AgentId[] | undefined;
  /** Personal template variable values. */
  vars: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Flow definition (`.df/<flow>/flow.json`)
// ---------------------------------------------------------------------------

export type VarScope = 'project' | 'personal';

export interface FlowVarDef {
  description?: string | undefined;
  default?: string | number | boolean | undefined;
  /** Where the value is stored: `project` → config.json, `personal` → local.json. Default `project`. */
  scope?: VarScope | undefined;
  /** When true, `dfl install` prompts for the value if it has no value and no default. */
  required?: boolean | undefined;
}

/** A transition value in flow.json: a target state key or an object form. */
export type FlowTransitionConfig = string | { target: string; description?: string | undefined };

/** A state node in flow.json. Only atomic and final states are supported. */
export interface FlowStateNodeConfig {
  description?: string | undefined;
  meta?: { title?: string | undefined; [key: string]: unknown } | undefined;
  on?: Record<string, FlowTransitionConfig> | undefined;
  type?: 'final' | undefined;
  [key: string]: unknown;
}

/** The xstate machine config stored in flow.json (flat: atomic + final states). */
export interface FlowMachineConfig {
  id?: string | undefined;
  initial: string;
  description?: string | undefined;
  /** Declaration order is the flow order (used by layout and ordering). */
  states: Record<string, FlowStateNodeConfig>;
  [key: string]: unknown;
}

/** Where a flow came from. */
export interface FlowSource {
  type: 'template' | 'git' | 'local' | 'created';
  /** Template name, git URL or local path. */
  ref?: string | undefined;
  /** Sub-path inside the git repository. */
  path?: string | undefined;
  /** Git ref (branch/tag/commit). */
  rev?: string | undefined;
}

export interface FlowDefinition {
  $schema?: string | undefined;
  /** Flow id; equals the directory name under `.df/`. */
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  version?: string | undefined;
  /** Prepended to step ids to form skill names. Default `''`. */
  skillPrefix?: string | undefined;
  vars?: Record<string, FlowVarDef> | undefined;
  source?: FlowSource | undefined;
  machine: FlowMachineConfig;
}

// ---------------------------------------------------------------------------
// Derived flow model
// ---------------------------------------------------------------------------

export interface FlowTransition {
  event: string;
  source: string;
  target: string;
  description?: string | undefined;
}

export interface StepInfo {
  /** State key == step directory name. */
  id: string;
  /** `skillPrefix + id` – the skill folder name and slash command. */
  skillName: string;
  /** `meta.title` or a title-cased id. */
  title: string;
  /** State `description` or `''`. */
  description: string;
  /** `type: "final"` – terminal marker, never has a skill. */
  final: boolean;
  /** Position in flow order (0-based). */
  index: number;
  /** Outgoing transitions in declaration order. */
  transitions: FlowTransition[];
  /** Incoming transitions (from any state, declaration order). */
  incoming: FlowTransition[];
  /** Absolute path of `.df/<flow>/steps/<id>` (may not exist for final states). */
  dir: string;
}

export interface FlowModel {
  def: FlowDefinition;
  name: string;
  title: string;
  description: string;
  /** Absolute `.df/<flow>` directory. */
  dir: string;
  initial: string;
  /** All states in flow order (see `orderStates`). */
  steps: StepInfo[];
  /** Lookup by id. */
  byId: Map<string, StepInfo>;
  /** All transitions in declaration order. */
  transitions: FlowTransition[];
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
  /** Step id the issue refers to, if any. */
  step?: string | undefined;
  /** File the issue refers to, if any (absolute). */
  file?: string | undefined;
}

// ---------------------------------------------------------------------------
// Runtime state (`.df/state.json`)
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  from: string;
  to: string;
  event: string;
  /** ISO timestamp. */
  at: string;
}

export interface FlowRuntimeState {
  flow: string;
  /** Current state key. */
  current: string;
  /** True when `current` is a final state. */
  done: boolean;
  /** Most recent first is NOT used: entries are chronological (oldest first), capped at 200. */
  history: HistoryEntry[];
  /** ISO timestamp of the last change. */
  updatedAt: string;
  /** Set when the stored state had to be repaired (e.g. the step was deleted). */
  repaired?: string | undefined;
}

export interface StateFile {
  version: 1;
  flows: Record<string, { current: string; history: HistoryEntry[]; updatedAt: string }>;
}

export interface TransitionResult {
  from: string;
  to: string;
  event: string;
  done: boolean;
  state: FlowRuntimeState;
}

// ---------------------------------------------------------------------------
// Templates and rendering
// ---------------------------------------------------------------------------

export interface StepRef {
  event: string;
  id: string;
  skillName: string;
  title: string;
  final: boolean;
  /**
   * Outgoing refs: the transition's description, else the target step's description.
   * Incoming refs: the transition's description only.
   */
  description?: string | undefined;
}

export interface StepContext {
  id: string;
  skillName: string;
  title: string;
  description: string;
  /** 0-based position. */
  index: number;
  /** 1-based position among non-final steps. */
  number: number;
  final: boolean;
  /** Outgoing transitions. */
  next: StepRef[];
  /** Incoming transitions. */
  prev: StepRef[];
}

export interface TemplateContext {
  project: { name: string; root: string };
  flow: {
    name: string;
    title: string;
    description: string;
    skillPrefix: string;
    initial: string;
    /** Non-final steps in flow order. */
    steps: StepContext[];
    /** Number of non-final steps. */
    stepCount: number;
  };
  /** The step being rendered; undefined for built-in skills. */
  step?: StepContext | undefined;
  vars: Record<string, unknown>;
  env: Record<string, string | undefined>;
  dfl: { version: string; mcpServer: string; cli: string };
}

export interface RenderedFile {
  /** Path relative to the skill directory, posix separators. */
  path: string;
  /** Rendered text content (for templates). */
  content?: string | undefined;
  /** Absolute source path to copy verbatim (for static files). */
  sourcePath?: string | undefined;
}

export interface RenderedSkill {
  /** Skill folder name == frontmatter `name` == slash command. */
  name: string;
  kind: 'step' | 'builtin';
  /** Step id for step skills. */
  stepId?: string | undefined;
  description: string;
  files: RenderedFile[];
}

// ---------------------------------------------------------------------------
// Agents, MCP and install manifest
// ---------------------------------------------------------------------------

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
}

export interface Manifest {
  version: 1;
  flow?: string | undefined;
  agents: AgentId[];
  /** Skill directories written by dfl (project-relative, posix). */
  skills: Array<{ agents: AgentId[]; name: string; dir: string; files: string[] }>;
  /** MCP config entries written by dfl. */
  mcp: Array<{ agents: AgentId[]; file: string; server: string }>;
}

export interface SyncReport {
  flow: string;
  agents: AgentId[];
  /** Skills installed, one entry per (skill dir). */
  skills: Array<{ name: string; dir: string; agents: AgentId[]; kind: 'step' | 'builtin' }>;
  /** Project-relative dirs removed because they are no longer wanted. */
  removed: string[];
  mcp: Array<{ file: string; agents: AgentId[]; changed: boolean }>;
  /** Agents with no project-level MCP support (manual instructions needed). */
  mcpManual: Array<{ agent: AgentId; instructions: string }>;
  warnings: string[];
}
