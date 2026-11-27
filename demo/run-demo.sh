#!/usr/bin/env bash
set -euo pipefail

# 1-command frictionless sandbox launcher for dfl (devFlow).
# Copies examples/demo-repo into an isolated temp workspace so your git tree stays clean,
# verifies Node >= 22.12, and runs `dfl status` + `dfl flow view` in <30 seconds.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEMO_SRC="${REPO_ROOT}/examples/demo-repo"

MODE="print"
EXTRA_VIEW_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --print)
      MODE="print"
      ;;
    --interactive)
      MODE="interactive"
      ;;
    --ascii|--lr)
      EXTRA_VIEW_ARGS+=("$arg")
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ./demo/run-demo.sh [--print | --interactive] [--ascii] [--lr]

Runs dfl (devFlow) against an isolated temporary copy of examples/demo-repo
so your own repository stays completely untouched.

Options:
  --print        Run `dfl status` and `dfl flow view --print --zoom 1` (default)
  --interactive  Launch the interactive Ink + ELKjs `dfl flow view` TUI (requires TTY)
  --ascii        Render the DAG with pure ASCII box characters
  --lr           Render the DAG left-to-right
  -h, --help     Show this help message
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (use --help for usage)" >&2
      exit 2
      ;;
  esac
done

# 1. Guard: Node.js >= 22.12 required by @vishin-pavel/dfl
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed. dfl requires Node.js >= 22.12." >&2
  echo "Install via nvm: nvm install 22 && nvm use 22" >&2
  exit 1
fi

NODE_VER_RAW="$(node -v)"
NODE_VER="${NODE_VER_RAW#v}"
NODE_MAJOR="${NODE_VER%%.*}"
NODE_REST="${NODE_VER#*.}"
NODE_MINOR="${NODE_REST%%.*}"

if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 12) )); then
  echo "Error: Found Node.js ${NODE_VER_RAW}, but @vishin-pavel/dfl requires Node.js >= 22.12." >&2
  echo "Upgrade with nvm: nvm install 22 && nvm use 22" >&2
  exit 1
fi

if [[ ! -d "${DEMO_SRC}/.df" ]]; then
  echo "Error: Pre-initialized sandbox not found at ${DEMO_SRC}/.df" >&2
  exit 1
fi

# 2. Copy sandbox into an isolated temp workspace (auto-cleaned on exit)
TMP_WS="$(mktemp -d "${TMPDIR:-/tmp}/dfl-sandbox.XXXXXX")"
cleanup() {
  rm -rf "${TMP_WS}"
}
trap cleanup EXIT

cp -R "${DEMO_SRC}/." "${TMP_WS}/"
(
  cd "${TMP_WS}"
  git init -q
  git config user.email "sandbox@dfl.local"
  git config user.name "DFL Sandbox"
)

# 3. Resolve dfl binary (prefer global dfl, else npx --yes @vishin-pavel/dfl)
run_dfl() {
  if command -v dfl >/dev/null 2>&1; then
    (cd "${TMP_WS}" && dfl "$@")
  else
    (cd "${TMP_WS}" && npx --yes --quiet @vishin-pavel/dfl "$@")
  fi
}

echo "==> dfl (devFlow) Sandbox — Node ${NODE_VER_RAW} | Workspace: ${TMP_WS}"
echo ""
echo "==> Running sample CHK-1.2 unit tests (node --test):"
(cd "${TMP_WS}" && node --test)
echo ""
echo "==> Running: dfl status"
run_dfl status
echo ""

if [[ "${MODE}" == "interactive" && -t 0 && -t 1 ]]; then
  echo "==> Launching interactive TUI: dfl flow view ${EXTRA_VIEW_ARGS[*]:-}"
  run_dfl flow view ${EXTRA_VIEW_ARGS[@]+"${EXTRA_VIEW_ARGS[@]}"}
else
  echo "==> Running: dfl flow view --print --zoom 1 ${EXTRA_VIEW_ARGS[*]:-}"
  run_dfl flow view --print --zoom 1 ${EXTRA_VIEW_ARGS[@]+"${EXTRA_VIEW_ARGS[@]}"}
fi
