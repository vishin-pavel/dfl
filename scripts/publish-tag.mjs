#!/usr/bin/env node
/**
 * Prints the npm dist-tag a version is published under (used by .github/workflows/publish.yml):
 * `next` for a prerelease (`1.2.0-rc.1`, `2.0.0-beta.0`) or a GitHub release marked as prerelease,
 * `latest` otherwise (`1.2.0`, and `1.2.0+build.1`: build metadata is not a prerelease).
 *
 * npm 10 (Node 22) publishes a prerelease under `latest` when no `--tag` is given, which would make
 * `npm install @vishin-pavel/dfl` install the release candidate for everyone.
 *
 * Usage: node scripts/publish-tag.mjs <version> [--prerelease]
 */
import { pathToFileURL } from 'node:url';

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * @param {string} version package.json version
 * @param {{ prerelease?: boolean }} [options] prerelease: the GitHub release is marked as a prerelease
 * @returns {'next' | 'latest'}
 */
export function distTag(version, options = {}) {
  const match = SEMVER_RE.exec(version);
  if (!match) throw new Error(`"${version}" is not a semantic version (MAJOR.MINOR.PATCH[-pre][+build]).`);
  return match[4] !== undefined || options.prerelease === true ? 'next' : 'latest';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const version = args.find((arg) => !arg.startsWith('--'));
  try {
    if (version === undefined) throw new Error('Usage: node scripts/publish-tag.mjs <version> [--prerelease]');
    process.stdout.write(`${distTag(version, { prerelease: args.includes('--prerelease') })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
