# Changelog

All notable changes to `@vishin-pavel/dfl` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Include supported aliases in `dfl agents --json` without changing agent IDs or MCP config paths.
- Open-source community and governance documentation: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`, `NOTICE`, and `.github/SUPPORT.md`.
- GitHub Issue Forms (`bug_report.yml`, `feature_request.yml`, `agent_support.yml`, `config.yml`), Pull Request template, `CODEOWNERS`, `dependabot.yml`, `release.yml`, and PR dependency review workflow (`.github/workflows/dependency-review.yml`).
- Repository hygiene files: `.editorconfig`, `.gitattributes`, and `.nvmrc`.
- Consolidated `DFL_*` environment variables table, general troubleshooting guide, usage recipes, and status badges in `README.md`.

### Changed
- Migrated package publishing from GitHub Packages to public [npmjs.org](https://www.npmjs.com/package/@vishin-pavel/dfl) with provenance (`--provenance`, `id-token: write`) and removed the repository `.npmrc` registry override.
- Removed internal `(OWNER: ...)` agent comments from `src/` headers and updated stale documentation references in `docs/ARCHITECTURE.md` and `docs/design/fast-forward.md`.
- Expanded `package.json` `keywords`, enriched `author` metadata, and included `NOTICE` in published package files.

### Security
- Updated pinned dependencies in `package-lock.json` via `npm audit fix` to resolve 5 reported advisories (`handlebars`, `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `zod`, `vite`).

## [0.3.0] - 2026-10-09

### Added
- **Fast-forward runs** ([#6](https://github.com/vishin-pavel/dfl/pull/6)):
  - New built-in skill `/fast-forward` (`$fast-forward` in Codex) to run flow steps automatically until a target state (default: end of flow) becomes current, spawning one fresh sub-agent per step where supported and reporting every decision.
  - New CLI command `dfl fast-forward` and MCP tool `fast_forward` to start, resume, or stop a run.
  - Intent-only persistence in `.df/fast-forward.json` with progress, reachability, loop detection (4th visit stops the run), and refusal of unintended final states derived from flow history (`src/core/forward.ts`, `src/core/fastforward/`).
  - `fastForward` status block and autopilot instructions in `get_status`, move tools, and `dfl status`/`next`/`goto`/`reset` while a run is active.
  - Updated `dev` flow templates to log automatic acceptances as `(auto)`, record decisions in `## Fast-forward log`, mark unconfirmed numbers as `Source: assumed`, open draft PRs without reviewers, and pause before handing a Jira-tracked ticket to QA.

## [0.2.1] - 2026-10-08

### Changed
- **Task brief lifecycle in `dev` flow** ([#5](https://github.com/vishin-pavel/dfl/pull/5)):
  - `ship-task` now writes the complete task record into the pull request description and removes the committed task brief in the branch's final commit (keeping the brief only when there is no pull request).
  - Subsequent steps restore the brief on the task branch (never on the main branch) from git history (`git log --all --full-history`, PR commit fetch after squash merges, or partial rebuild from PR description) when work returns after shipping.

## [0.2.0] - 2026-10-07

### Added
- **Requirements-driven default `dev` flow** ([#3](https://github.com/vishin-pavel/dfl/pull/3)):
  - Shipped a single default flow `dev` (`classify-task` → `define-behavior` → `design-tech` → `implement-task` → `verify-task` → `ship-task`) with per-feature Gherkin `REQUIREMENTS.md`, living `TECH_DESIGN.md` screened against ISO/IEC 25010:2023, independent Dev QA, and PR handoff.
  - `dfl install` now defaults to `dev` and skips the template prompt when one template ships.
- **Jira task tracking** ([#2](https://github.com/vishin-pavel/dfl/pull/2)):
  - Committed `.df/tracker.json` configuration for Jira Cloud site/project keys, branch templates, param-to-custom-field mappings, and per-flow step-to-status mappings.
  - Hidden Jira issue entity property `dfl.run` storing exact step, params, and history tail so teammates on the same branch continue at the same step.
  - New CLI commands: `dfl task start <ref>`, `dfl tracker init|login|logout|check|map|field`, plus `--task` and `--set` on `status`/`next`/`goto`/`reset`.
  - New MCP tool `start_task` and `task`/`params` support on `get_status` and move tools; built-in `/init-task` skill rendered when `.df/tracker.json` exists.
  - Secure per-user credential storage in `~/.config/dfl/credentials.json` (mode `0600`) bound to the configured Jira origin.
- **Safe flow updates, export/import, and backups** ([#1](https://github.com/vishin-pavel/dfl/pull/1)):
  - Per-file digest tracking (`source.files`) to detect local edits before updating a flow.
  - `dfl flow export` (`.dfl.json` snapshots), `dfl flow import`, staged diff previews for `dfl flow pull` and `dfl flow import --force`, and automatic backups to `.df/.dfl-backups/`.

### Changed
- Retired the initial sample flow templates (`feature`, `bugfix`, `quick`), moving them to test fixtures; existing projects using them continue to work with `TEMPLATE_RETIRED` guidance and a one-time upgrade notice.

## [0.1.0] - 2026-09-30

### Added
- Initial release of `@vishin-pavel/dfl`:
  - xstate-driven development flow engine (`src/core/machine.ts`, `validate.ts`, `steps.ts`), Handlebars template rendering (`render.ts`, `vars.ts`), and project/personal `.df/` configuration.
  - Support for 9 coding agents (`claude`, `cursor`, `antigravity`, `codex`, `gemini`, `copilot`, `windsurf`, `opencode`, `kiro`) with ownership-tracked skill syncing and comment-preserving JSON/JSONC/TOML MCP config editing.
  - Built-in stdio MCP server (`dfl mcp`) exposing flow inspection, runtime state transitions, step authoring tools, and resources.
  - Interactive Ink + ELK terminal flow viewer (`dfl flow view`).
  - CLI subcommands for install/uninstall/update, flow and step management, variables, state transitions, and agent inspection.
  - CI and GitHub Packages publish workflows.

[Unreleased]: https://github.com/vishin-pavel/dfl/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/vishin-pavel/dfl/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/vishin-pavel/dfl/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/vishin-pavel/dfl/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vishin-pavel/dfl/releases/tag/v0.1.0
