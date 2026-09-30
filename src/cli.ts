#!/usr/bin/env node
// Checked before anything else is loaded: dfl's dependencies fail on older Node with a cryptic
// SyntaxError. The guard module has no imports; the CLI itself is imported only afterwards.
// stdout stays untouched (it carries JSON-RPC for `dfl mcp`).
import { nodeVersionError } from './ui/node-version.js';

const versionError = nodeVersionError(process.versions.node);
if (versionError !== null) {
  process.stderr.write(`✖ ${versionError}\n`);
  process.exit(1);
}

const { runCli } = await import('./run.js');
process.exitCode = await runCli(process.argv);
