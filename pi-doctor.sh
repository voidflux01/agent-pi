#!/usr/bin/env bash
# ABOUTME: Portable entry point for the agent-pi health check.
# ABOUTME: The implementation lives in scripts/doctor.mjs so it can be tested and scripted.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/scripts/doctor.mjs" "$@"
