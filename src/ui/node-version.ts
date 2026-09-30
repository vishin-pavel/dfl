/**
 * Node.js version guard for the bin entry (src/cli.ts). This module must not import anything: it
 * runs before the rest of dfl (and its dependencies, which need newer Node APIs) is loaded.
 */

/** Oldest supported Node.js version (package.json `engines`). */
export const MIN_NODE_VERSION = '22.12.0';

/**
 * The error message for an unsupported Node.js version (`process.versions.node`), or null when the
 * version is supported (22.12 or newer).
 */
export function nodeVersionError(version: string): string | null {
  const [major = Number.NaN, minor = Number.NaN] = version.replace(/^v/, '').split('.').map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  const [minMajor, minMinor] = MIN_NODE_VERSION.split('.').map(Number) as [number, number];
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return null;
  return (
    `dfl needs Node.js ${minMajor}.${minMinor} or newer (found ${version.replace(/^v/, '')}). ` +
    `Upgrade Node.js (e.g. \`nvm install ${minMajor}\`) and run dfl again.`
  );
}
