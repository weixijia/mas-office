#!/usr/bin/env bash
# Integration check: the REAL server and runtime with SCRIPTED fake backends (no real Claude Code or Codex
# session, no subscription use), driven by the Swift client (`MASOfficeChecks --integration`).
#
#   apps/mac/scripts/integration-check.sh                       the client check
#   apps/mac/scripts/integration-check.sh --app <MAS Office.app> --self-check <report.json>
#   apps/mac/scripts/integration-check.sh --app <MAS Office.app> --render <dir> [--fixture <workspace>]
#   apps/mac/scripts/integration-check.sh --render <dir> [--fixture <workspace>]     renders only (debug build)
#   apps/mac/scripts/integration-check.sh --supervision [--fixture <workspace>]    inbox / agent page intents
#
# The orchestration (daemon on a pipe, handshake, stop by closing stdin) is in integration-check.mjs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/../../.."
exec node "$here/integration-check.mjs" "$@"
