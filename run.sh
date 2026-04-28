#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
    PY=python3
elif command -v python >/dev/null 2>&1; then
    PY=python
else
    echo "Python 3 was not found on PATH." >&2
    echo "Install it from https://www.python.org/downloads/ and try again." >&2
    exit 1
fi

exec "$PY" cli.py dashboard "$@"
