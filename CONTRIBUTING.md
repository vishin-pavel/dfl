# Contributing to `dfl`

Thank you for your interest in contributing to `@vishin-pavel/dfl`! This guide covers local development setup, codebase conventions, testing, adding new capabilities, pull request expectations, and the maintainer release process.

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- **Development & Build**: **Node.js `>=22.18`** (or `>=24.11`). `tsdown` 0.23 cannot load `tsdown.config.ts` on older Node versions. A `.nvmrc` file (`22.18`) is included at the repository root.
- **Runtime compatibility**: The built CLI (`dist/cli.mjs`) supports **Node.js `>=22.12`**, enforced at startup in `src/cli.ts` via `src/ui/node-version.ts`. Do not rely on Node APIs added after `22.12` without a runtime check or fallback.
- **Operating systems**: Developed and tested in CI on macOS and Linux. Native Windows is not covered by CI (WSL works like Linux).

## Local Setup

```sh
git clone https://github.com/vishin-pavel/dfl.git
cd dfl
npm ci
npm run check
```

Available npm scripts:

| Script | What it runs |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (TypeScript 7 strict typecheck) |
| `npm test` | `vitest run` (full Vitest suite across `test/**/*.test.{ts,tsx}`) |
| `npm run test:watch` | `vitest` (interactive watch mode) |
| `npm run build` | `tsdown` (bundles `src/cli.ts` to `dist/cli.mjs`) |
| `npm run dev` | `tsdown --watch` |
| `npm run check` | `npm run typecheck && npm test && npm run build` |

To run the locally built CLI:

```sh
node dist/cli.mjs --help
```

## Repository Layout

| Path | Purpose |
|---|---|
| `src/cli.ts`, `src/run.ts`, `src/program.ts` | CLI entrypoint (Node version guard), error/exit runner, and Commander program wiring |
| `src/commands/` | CLI subcommands (`agents`, `fastforward`, `flow`, `install`, `mcp`, `shared`, `state`, `step`, `task`, `tracker`, `vars`) |
| `src/core/` | Flow model, xstate machine, Handlebars rendering, sync/manifest/ownership, git helpers, file locking, atomic fsx, bundle export/import, `fastforward/`, and `tracker/` (Jira integration) |
| `src/agents/` | Supported coding-agent adapters (`registry.ts`), comment-preserving JSON/JSONC/TOML MCP config editors (`mcp-config.ts`), and `types.ts` |
| `src/mcp/` | Stdio MCP server (`server.ts`), tool handlers (`tools.ts`), and authoring guide (`guide.ts`) |
| `src/tui/` | Ink TUI flow viewer (`FlowView.tsx`, `run-flow-view.tsx`) and ELK graph layout/canvas renderer (`graph/`) |
| `src/ui/` | Colors, exit codes, formatting, Node version check, output helpers, `@clack/prompts` wrappers, and tables |
| `templates/` | Shipped `dev` flow (`templates/flows/dev/`), global partial (`templates/partials/flow-context.hbs`), and 5 built-in skills (`templates/skills/`) |
| `test/` | Vitest test suites, test helpers (`test/helpers/`), and retired sample flow fixtures (`test/fixtures/flows/`) |
| `scripts/` | Zero-dependency release helper (`scripts/publish-tag.mjs`) |
| `docs/` | [ARCHITECTURE.md](docs/ARCHITECTURE.md) (module contracts & design), [AGENTS.md](docs/AGENTS.md) (per-agent research), and `docs/design/` |

## Coding Conventions

- **Strict TypeScript ESM**: `"type": "module"`, `moduleResolution: "nodenext"`, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, and `isolatedModules` (`tsconfig.json`).
- **Import paths**: Always use explicit `.js` extensions on relative imports (for example, `import { DflError } from './errors.js';`), matching `nodenext` resolution.
- **Formatting**: 2-space indentation, single quotes, UTF-8, LF line endings, final newline (enforced via `.editorconfig` and `.gitattributes`).
- **Error handling**: Throw `DflError` with a machine-readable code and actionable `hint` for user-facing errors. Avoid raw `console.log` in `src/`; use the helpers in `src/ui/output.ts`.
- **Security hygiene**:
  - Never shell out with interpolated strings — use `execFile` / `execFileSync` with argument arrays and `--` separators (see `src/core/git.ts`).
  - Never log, render, or persist Jira credentials or tokens in project files, MCP output, or debug logs (see `src/core/tracker/credentials.ts` and `src/core/tracker/http.ts`).
  - Keep `elkjs` external in `dist/cli.mjs` (never inline EPL-2.0 code into the MIT bundle; see `NOTICE`).

## Testing Guide

Run the full test suite with `npm test`, or a single file with:

```sh
npx vitest run test/packaging.test.ts
```

### Test Helpers

- `test/helpers/project.ts` — Creates isolated temporary project directories with `.df/` fixtures and cleans them up after each test.
- `test/helpers/fake-jira.ts` — Local in-process HTTP fake for the Jira Cloud REST API so tracker tests run deterministically without touching the network.
- `test/helpers/fixture-templates.ts` — Mocks `flowTemplatesDir` to point at `test/fixtures/flows/` (`feature`, `bugfix`, `quick`) for tests that exercise retired sample templates.

### Packaging & Documentation Invariants (`test/packaging.test.ts`)

`test/packaging.test.ts` enforces several invariants that run in CI:

1. **README links**: Every relative link in `README.md` MUST point to a file listed in `package.json#files` (`dist/**/*.mjs`, `templates`, `README.md`, `LICENSE`, `NOTICE`). Links to repository-only files such as `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`, `.github/SUPPORT.md`, `docs/AGENTS.md`, and `docs/ARCHITECTURE.md` MUST use absolute GitHub URLs (`https://github.com/vishin-pavel/dfl/blob/main/...`).
2. **Required docs links**: `README.md` must continue to link to `docs/AGENTS.md` and `docs/ARCHITECTURE.md` on GitHub.
3. **Workflow assertions**: `test/packaging.test.ts` verifies the action major versions (`actions/checkout@v7`, `actions/setup-node@v7`) in `.github/workflows/ci.yml` and `.github/workflows/publish.yml`, as well as the dist-tag and publish steps in `publish.yml`.
4. **Shipped templates**: Only `templates/flows/dev/` ships in the npm tarball; retired sample flows stay under `test/fixtures/flows/`.

## Common Extension Points

### Adding a New Coding-Agent Adapter

1. Research the agent's skill directory path, slash-command invocation syntax, MCP config path/format (JSON, JSONC, or TOML), and detection signals. Document findings in `docs/AGENTS.md`.
2. Add the agent ID and adapter definition in `src/agents/types.ts` and `src/agents/registry.ts`.
3. If the agent uses a new MCP config layout, add or extend the comment-preserving editor in `src/agents/mcp-config.ts`.
4. Add tests covering detection, skill sync, MCP config editing, and uninstall in `test/` (see `test/agents.test.ts` and `test/mcp-config.test.ts`).
5. Update `README.md` (Supported agents table) and `package.json` `keywords` if appropriate.

### Adding a CLI Command

1. Implement the command module or subcommand under `src/commands/` and register it in `src/program.ts`.
2. Keep business logic in `src/core/` so CLI and MCP share the same implementation.
3. Support `--json` where appropriate and use `DflError` with clear `hint` messages.
4. Add tests in `test/` using `buildProgram()` (see `test/cli.test.ts`).
5. Document the command in `README.md` under Command reference.

### Adding an MCP Tool

1. Implement the pure project operation in `src/mcp/tools.ts` (calling `src/core/`).
2. Register the tool, Zod input schema, and description in `src/mcp/server.ts`.
3. Ensure cross-process locking (`.df/.lock`) and tracker/fast-forward invariants are respected.
4. Add end-to-end MCP client/server tests in `test/mcp.test.ts`.
5. Update `README.md` (MCP server section) and `docs/ARCHITECTURE.md` §7.

## Pull Request & Commit Guidelines

- Keep pull requests focused on a single feature, fix, or documentation update.
- Write clear commit messages describing **what** changed and **why**.
- Include unit or integration tests for behavioral changes and bug fixes.
- Update `README.md`, `docs/ARCHITECTURE.md` (if contracts change), and the `[Unreleased]` section of `CHANGELOG.md` for user-visible changes.
- Run `npm run check` locally before opening or updating a PR and confirm all checks pass.

## Release & Versioning Process (Maintainers)

`dfl` follows [Semantic Versioning](https://semver.org/). While on `0.x`, minor releases (`0.y.0`) may introduce new features or workflow changes; patch releases (`0.y.z`) contain bug fixes and non-breaking improvements.

### Standard Release

1. Update `CHANGELOG.md`: move entries from `[Unreleased]` into a new `[X.Y.Z] - YYYY-MM-DD` section and add the GitHub compare link at the bottom.
2. Run `npm run check` and verify `npm pack --dry-run` contains only intended files.
3. Bump the version and push the tag:
   ```sh
   npm version patch   # or minor / major
   git push --follow-tags
   ```
4. `.github/workflows/publish.yml` triggers on the pushed `v*` tag (and on published GitHub Releases), validates that the tag matches `package.json`, runs `npm ci`, `npm run typecheck`, and `npm test`, selects the dist-tag via `scripts/publish-tag.mjs` (`latest` for stable releases), and publishes to `https://registry.npmjs.org` with `--provenance`.
5. Create a GitHub Release for `vX.Y.Z` (auto-categorized notes are configured in `.github/release.yml`).

### Prerelease

```sh
npm version prerelease --preid rc
git push --follow-tags
```

`scripts/publish-tag.mjs` automatically publishes prerelease versions (and any GitHub Release marked as a prerelease) under the `next` dist-tag so users can test via `npm install -g @vishin-pavel/dfl@next` without affecting `latest`.

### npmjs.org Publishing Authentication

`.github/workflows/publish.yml` grants `id-token: write` and passes `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`, supporting either:

- **npm Trusted Publishing (OIDC, recommended)**: Configure this repository (`vishin-pavel/dfl`) and workflow (`publish.yml`) as a Trusted Publisher on `npmjs.org` — no long-lived token required.
- **Granular Access Token**: Add an `NPM_TOKEN` repository secret in GitHub Actions with publish permission for `@vishin-pavel/dfl`.

## License

By contributing to `dfl`, you agree that your contributions will be licensed under the [MIT License](LICENSE).
