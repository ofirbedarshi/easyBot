#!/usr/bin/env bash
# Rebuild the local graphify knowledge graph from JS under src/, scripts/, and test/.
# Hard-coded --code-only and --no-label: never call a model or spend API tokens.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Do not pass through provider keys. Flags below are the real guard; this
# makes a later graphify default unable to auto-detect a backend.
unset OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY ANTHROPIC_API_KEY \
  DEEPSEEK_API_KEY KIMI_API_KEY CLAUDE_API_KEY \
  OPENAI_BASE_URL ANTHROPIC_BASE_URL GRAPHIFY_GEMINI_MODEL \
  GRAPHIFY_CLAUDE_CLI_MODEL OLLAMA_MODEL

# Always these flags. Do not add a backend, --mode deep, or community labeling.
EXTRACT_FLAGS=(--code-only)
CLUSTER_FLAGS=(--no-label)

if [[ "${EXTRACT_FLAGS[*]}" != *"--code-only"* ]]; then
  echo "refusing: extract must include --code-only" >&2
  exit 1
fi
if [[ "${CLUSTER_FLAGS[*]}" != *"--no-label"* ]]; then
  echo "refusing: cluster-only must include --no-label" >&2
  exit 1
fi

ensure_path() {
  if [[ -f "${HOME}/.local/bin/env" ]]; then
    # shellcheck source=/dev/null
    source "${HOME}/.local/bin/env"
  fi
  export PATH="${HOME}/.local/bin:${PATH:-}"
}

ensure_uv() {
  if command -v uv >/dev/null 2>&1; then
    return
  fi
  echo "Installing uv (needed for graphifyy)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  ensure_path
  if ! command -v uv >/dev/null 2>&1; then
    echo "uv install failed; install uv then re-run." >&2
    exit 1
  fi
}

ensure_graphify() {
  if command -v graphify >/dev/null 2>&1; then
    return
  fi
  echo "Installing graphifyy (PyPI package; CLI is graphify)..."
  uv tool install graphifyy
  ensure_path
  if ! command -v graphify >/dev/null 2>&1; then
    echo "graphify install failed; run: uv tool install graphifyy" >&2
    exit 1
  fi
}

ensure_path
ensure_uv
ensure_graphify

echo "Building code-only graph (no LLM)..."
graphify extract . "${EXTRACT_FLAGS[@]}"
graphify cluster-only . "${CLUSTER_FLAGS[@]}"
graphify export wiki

if [[ ! -f graphify-out/graph.json ]]; then
  echo "graphify-out/graph.json was not written" >&2
  exit 1
fi

echo "Done. Query with: graphify query \"<question>\""
echo "Wiki: graphify-out/wiki/index.md  (graphify-out/ is gitignored)"
