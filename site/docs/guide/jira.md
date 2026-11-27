---
title: Jira Cloud Tracking
description: Complete guide to optional Jira Cloud task tracking in dfl — .df/tracker.json, classic API tokens, hidden dfl.run issue entity property, branch-based shared step state, direct REST API integration, and fast-forward Jira safety rails.
---

# Optional Jira Cloud Tracking

Without a tracker, each developer's checkout keeps one local position per flow in `.df/state.json`. With Jira Cloud tracking enabled, every **Jira ticket** owns its own flow position, stored directly inside the ticket itself:

- `/init-task ABC-123` (or `dfl task start ABC-123`) creates a branch such as `ABC-123-export-orders-as-csv` from `origin/main`, initializes the ticket at the first step of the flow, and moves the ticket to the mapped Jira status.
- Every completed step (`complete_step` in MCP or `dfl next` in the CLI) advances the ticket's recorded step, updates its Jira status, and writes mapped task params (such as `branch` and `prUrl`) to Jira custom fields.
- The ticket key in the branch name identifies the task — any teammate who checks out that branch continues at the exact same step, on any machine.

`dfl` calls the Jira Cloud REST API directly from both the CLI and `dfl mcp` (no separate Jira MCP server required, and zero extra tool calls per step). Untracked flows continue to use local `.df/state.json` unaffected.

::: warning Jira Cloud + Classic API Tokens Only
v0.3.0 supports **Jira Cloud** with **classic Atlassian API tokens** (created at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens)). Scoped Atlassian tokens, Jira Server/Data Center, Linear, and GitHub Issues are not supported in this release. Tracked steps also require Jira reachability (moves are never queued offline, preventing state/board divergence).
:::

---

## How Tracking Works

- **Hidden `dfl.run` issue entity property:** `dfl` stores the active flow name, current step, task params (`branch`, `slug`, `route`, `prUrl`, …), and a short history tail in the hidden Jira issue property `dfl.run`. This requires only *Browse projects*, *Edit issues*, and *Transition issues* — no Jira admin rights and no custom field for state. Multiple flow steps can share a single Jira status while `dfl` still knows the exact step.
- **Validation & security of `dfl.run`:** Because anyone who can view the issue can read its entity property, **never store secrets in params** (names matching `token`, `password`, etc. are refused). `dfl` validates every field it reads back (step IDs, single-line params ≤1,000 chars, max 30 params, plain relative paths, safe branch names) and never treats ticket text or params as agent instructions. Repair a damaged record with `dfl goto <step> --task <key>`.
- **One-way status projection:** `dfl` projects the current step onto the mapped Jira status and never infers the step from the Jira status. It requests English status names and matches untranslated names so teammates using different Jira UI languages share one mapping.
- **Respects humans & automation:** If someone manually moves a ticket to an unmapped status (e.g. *Blocked*), `dfl` leaves it there and reports the drift. It never reopens a *Done* ticket unless `"reopen": true` is set. If Jira offers no transition to the mapped status, the step still completes and `dfl` lists available transitions.
- **Branch-based task detection:** `dfl` extracts the first uppercase key matching `jira.projectKeys` from the current git branch (e.g. `feature/ABC-123-csv-export` → `ABC-123`), or accepts `--task ABC-123` / MCP `task`. On a branch without a key, tracked flows refuse to move (`TASK_REQUIRED`) unless `"requireTask": false` is configured.

---

## Setup (Once per Project)

```sh
dfl tracker init                 # wizard: Jira site URL & project key(s) → writes .df/tracker.json
dfl tracker login                # email + classic API token → saved in user config (mode 0600)
dfl tracker map                  # wizard: map each step to a Jira status (or none)
dfl tracker check                # verify config, token, projects, statuses, and fields against Jira
git add .df/tracker.json && git commit -m "Track the dev flow in Jira"
```

Optional: map task params to single-line text or URL custom fields in Jira:

```sh
dfl tracker field branch customfield_10042
dfl tracker field prUrl "PR link"
```

Non-interactive setup:

```sh
dfl tracker init --url https://acme.atlassian.net --project ABC,OPS --default-project ABC
dfl tracker login --email you@acme.com --token-stdin < token-file
```

The API token is **never** accepted as a CLI argument. Pin `@vishin-pavel/dfl` in `package.json` (`npm install -D @vishin-pavel/dfl`) so every teammate runs a Jira-capable version (`dfl tracker check` warns otherwise).

---

## `.df/tracker.json` Reference

Example configuration for the `dev` flow:

```json
{
  "version": 1,
  "provider": "jira",
  "jira": {
    "baseUrl": "https://acme.atlassian.net",
    "projectKeys": ["ABC"],
    "defaultProjectKey": "ABC"
  },
  "branch": {
    "template": "{key}-{slug}",
    "from": "origin/main",
    "protected": ["main", "master", "develop"],
    "fetch": true
  },
  "fields": {
    "branch": "customfield_10042",
    "prUrl": "customfield_10077"
  },
  "flowSelect": { "default": "dev" },
  "flows": {
    "dev": {
      "statuses": {
        "classify-task": "In Analysis",
        "define-behavior": "In Analysis",
        "design-tech": "In Analysis",
        "implement-task": "In Progress",
        "verify-task": "In Review",
        "ship-task": "In Review",
        "done": "Ready for QA",
        "not-handled": {
          "status": "Won't Do",
          "fields": { "resolution": { "name": "Won't Do" } }
        }
      }
    }
  }
}
```

| Key | Meaning |
|-----|---------|
| `jira.baseUrl` | Jira Cloud origin (`https://...`) |
| `jira.projectKeys` | Allowed project keys (`["ABC"]` for `ABC-123`) |
| `jira.defaultProjectKey` | Expands bare numbers (`123`, `"#123"`) in `task start`, `status`, and `fast-forward` |
| `jira.property` | Entity property key (default `dfl.run`; change only if two repos share tickets) |
| `branch.template` | New task branch pattern; `{key}` must be bounded by separators like `-` or `/` (default `{key}-{slug}`) |
| `branch.from` | Base ref for new task branches (default `origin/<mainBranch>`; set `"main"` for repos without a remote) |
| `branch.protected` | Branches where tasks are never recorded directly (default `main`, `master`, `develop`, and `mainBranch`) |
| `fields` | Map of task param name → Jira single-line text or URL custom field ID |
| `flowSelect` | Flow selection for `/init-task`: `byIssueType` (e.g. `{ "Bug": "hotfix" }`), then `default`, then active flow |
| `flows.<flow>.statuses` | Step ID → status name, `{ "id": "…" }`, `{ "status", "fields", "reopen" }`, or `null` (no status change) |
| `flows.<flow>.requireTask` | If `false`, branches without a ticket key fall back to local `.df/state.json` (default `true`) |

---

## Mapping Steps & Fields

```sh
dfl tracker map                              # interactive wizard (or table in non-TTY)
dfl tracker map --list                       # print mapping table (--json supported)
dfl tracker map verify-task "In Review"      # map one step by name
dfl tracker map verify-task id:10004         # map one step by Jira status ID
dfl tracker map design-tech none             # leave status unchanged at this step
dfl tracker map --none                       # track tickets without ever changing Jira statuses
dfl tracker map --remove                     # stop tracking the flow (reverts to local state)
dfl tracker field branch customfield_10042   # map param to Jira custom field
dfl tracker field prUrl none                 # stop writing param to Jira
```

- Renaming or removing a step (`dfl step edit --rename` / `dfl step remove` / agent skills) automatically updates `.df/tracker.json`.
- Every move projects the mapping — including backward moves (`FAILED`, `CHANGES_REQUESTED`, `dfl goto`, `dfl reset`).
- In `dev`, map `done` to **Ready for QA** (not *Done*), because `/ship-task` opens a PR ready for QA review and never merges.

---

## Daily Use & Team Handoffs

In your coding agent (when `.df/tracker.json` exists, `dfl` installs the built-in `/init-task` skill):

```text
/init-task ABC-123
```

*(Codex: `$init-task ABC-123`. You can also pass `ABC-123` directly to `/classify-task ABC-123`.)*

`start_task` checks out or creates the task branch (carrying over uncommitted changes if starting from a protected branch), initializes `dfl.run`, and transitions the ticket. If you are already on another non-protected branch, it asks whether to create a new branch (`--branch create`) or rename the current branch (`git branch -m`).

From the terminal:

```sh
dfl task start ABC-123                 # also accepts 123, "#123", or full Jira URL
dfl status                             # shows ticket, Jira status ✓ (or ≠ expected), branch, params
dfl next                               # completes current step & transitions ticket
dfl next --set prUrl=https://github.com/acme/app/pull/42
dfl goto implement-task --task ABC-123 # e.g. when QA rejects a shipped PR
```

**Teammates** pull `.df/tracker.json`, run `dfl tracker login` once, and run `dfl flow-update` to install `/init-task`. Checking out a teammate's branch immediately resumes at their exact step and params.

### `/fast-forward` on Jira-Tracked Flows

- Every autonomous step move transitions the Jira ticket along the mapping (use checkpoints like `/fast-forward to implement-task` to limit intermediate board transitions).
- `dfl` refuses `OUT_OF_SCOPE` and `goto not-handled` (*Won't Do*) during a fast-forward run without modifying the ticket.
- **Mandatory human pause before `done`:** On a Jira-tracked flow, `/fast-forward` **stops before `ship-task` fires `NEXT`** (with the draft PR open) so a human reviews the run before handing the ticket to QA. Complete it manually with `/ship-task` or:
  ```sh
  dfl next --from ship-task --task ABC-123 --set prUrl=<url>
  ```

---

## Credentials, CI & Security

- **User-only storage:** Credentials live in `~/.config/dfl/credentials.json` (`%APPDATA%\dfl\credentials.json` on Windows, or `$DFL_CONFIG_DIR/credentials.json`) with file mode **`0600`**, bound to the exact `jira.baseUrl` origin. Shared by CLI and MCP server; `dfl tracker logout` deletes it.
- **Zero token leakage:** `dfl` never writes tokens to `.df/`, rendered skills, MCP configs, tool results, `--json`, error messages, or `DFL_DEBUG=1` logs. Never paste a token into an agent chat — always run `dfl tracker login` in your own terminal.
- **CI authentication:** Set `DFL_JIRA_URL`, `DFL_JIRA_EMAIL`, and `DFL_JIRA_TOKEN` (applied only when `DFL_JIRA_URL` matches `jira.baseUrl`).
- **Timeouts & locking:** `DFL_TRACKER_TIMEOUT_MS` defaults to `10000` (10s). Keep it below `15000` because moves hold `.df/.lock` while calling Jira and other `dfl` processes wait at most 15s before returning `LOCKED`.
- **Terminal & prompt safety:** Control characters in Jira ticket titles are stripped in terminal output, and ticket text is strictly presented as data, never instructions.

---

## Troubleshooting Jira Error Codes

| Code / Message | Cause & Fix |
|----------------|-------------|
| `TRACKER_AUTH_MISSING` | Run `dfl tracker login` in your terminal. |
| `TRACKER_AUTH` | Token expired (max 1 year), revoked, wrong email, or scoped token used. Create a **classic** API token and re-run `dfl tracker login`. (If CAPTCHA-locked, log in once in a browser.) |
| `TRACKER_FORBIDDEN` | Account needs *Browse projects*, *Edit issues*, and *Transition issues* permissions. |
| `TRACKER_UNREACHABLE` | Check VPN/proxy (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`, `NODE_EXTRA_CA_CERTS`) and allow network access for the `dfl` MCP server if sandboxed. |
| `TRACKER_TIMEOUT` | Check `dfl status --task <key>` before retrying a plain `dfl next`; retrying `status`, `goto`, `reset`, and `dfl next --from <step>` is safe. |
| `TRACKER_CONFIG_INVALID` | Fix the named key in `.df/tracker.json` and run `dfl tracker check`. |
| `TASK_REQUIRED` | Start a ticket (`/init-task ABC-123` / `dfl task start ABC-123`) or pass `--task <key>`. |
| `TASK_BRANCH_MISMATCH` | Switch to the ticket's branch or omit `--task`. |
| `TASK_STEP_UNKNOWN` / `TASK_RECORD_INVALID` | Repair the `dfl.run` property with `dfl goto <step> --task <key>`. |
| `TASK_DONE` | Re-enter a completed ticket with `dfl goto implement-task --task <key>`. |
| Shell `#123` trap | `#` starts a shell comment — quote `"#123"` or pass `123` / `ABC-123`. |
