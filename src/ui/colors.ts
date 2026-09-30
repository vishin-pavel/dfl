/**
 * Colour palette for CLI output. picocolors already honours NO_COLOR / FORCE_COLOR and TTY
 * detection; `--no-color` passed to `runCli` switches the palette off for that run.
 */
import pc from 'picocolors';

export type Colors = ReturnType<typeof pc.createColors>;

/** The active palette (an ESM live binding: always import it, never copy it). */
export let c: Colors = pc;

/** `false` disables colours; `undefined` restores picocolors' own detection. */
export function setColorEnabled(enabled: boolean | undefined): void {
  c = enabled === undefined ? pc : pc.createColors(enabled);
}
