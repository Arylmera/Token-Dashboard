#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js was not found on PATH." >&2
    echo "Install Node.js 22.5 or newer from https://nodejs.org/ and try again." >&2
    exit 1
fi

exec node --experimental-sqlite cli.js dashboard "$@"
