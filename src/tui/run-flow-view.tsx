/**
 * `dfl flow view` entry (OWNER: tui agent). Loaded lazily via dynamic import.
 */
import type { FlowModel } from '../core/types.js';

export interface FlowViewOptions {
  /** Current step to highlight. */
  current?: string | undefined;
  zoom?: number | undefined;
  direction?: 'TB' | 'LR' | undefined;
  ascii?: boolean | undefined;
  /** Print the whole canvas and exit (also used automatically when stdin/stdout is not a TTY). */
  print?: boolean | undefined;
}

export async function runFlowView(model: FlowModel, options?: FlowViewOptions): Promise<void> {
  throw new Error('not implemented');
}
