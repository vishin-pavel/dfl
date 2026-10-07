import { fileURLToPath } from 'node:url';
import type * as PathsModule from '../../src/core/paths.js';

/**
 * The flow templates dfl shipped before "dev" (feature, bugfix, quick), kept as test fixtures: many
 * tests need small, stable flows with branches, variables and a template source.
 */
export const FIXTURE_FLOWS_DIR = fileURLToPath(new URL('../fixtures/flows/', import.meta.url));

/**
 * vi.mock factory of `src/core/paths.js` that points flowTemplatesDir() at {@link FIXTURE_FLOWS_DIR};
 * everything else stays real. Use it as
 * `vi.mock('../src/core/paths.js', async (original) => (await import('./helpers/fixture-templates.js')).fixtureTemplatesPaths(original));`
 * (vi.mock is hoisted above the imports, so the helper is imported inside the factory).
 */
export async function fixtureTemplatesPaths(importOriginal: () => Promise<unknown>): Promise<typeof PathsModule> {
  const actual = (await importOriginal()) as typeof PathsModule;
  return { ...actual, flowTemplatesDir: () => FIXTURE_FLOWS_DIR };
}
