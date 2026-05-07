"""Stdlib dev reloader. Spawns the dashboard as a subprocess and restarts it
when any watched file's mtime changes. No third-party deps."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

WATCH_GLOBS = ("**/*.py", "**/*.json")
POLL_INTERVAL = 0.5


def _snapshot(root: Path) -> dict[str, float]:
    snap: dict[str, float] = {}
    for pattern in WATCH_GLOBS:
        for p in root.glob(pattern):
            try:
                snap[str(p)] = p.stat().st_mtime
            except OSError:
                pass
    return snap


def _spawn(child_argv: list[str], env: dict[str, str]) -> subprocess.Popen:
    return subprocess.Popen(child_argv, env=env)


def _terminate(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            proc.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
        else:
            proc.terminate()
        proc.wait(timeout=3)
    except (subprocess.TimeoutExpired, OSError, ValueError):
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:
            pass


def run_with_reload(child_argv: list[str], watch_root: Path) -> int:
    """Block until interrupted. Restart child whenever a watched file changes."""
    env = os.environ.copy()
    env["TOKEN_DASHBOARD_RELOAD_CHILD"] = "1"

    popen_kwargs = {}
    if os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]

    print(f"Token Dashboard: reload mode — watching {watch_root}")
    proc = subprocess.Popen(child_argv, env=env, **popen_kwargs)
    last = _snapshot(watch_root)

    try:
        while True:
            time.sleep(POLL_INTERVAL)

            if proc.poll() is not None:
                code = proc.returncode
                print(f"Token Dashboard: child exited ({code}); waiting for file change to retry…")
                while True:
                    time.sleep(POLL_INTERVAL)
                    cur = _snapshot(watch_root)
                    if cur != last:
                        last = cur
                        break
                print("Token Dashboard: change detected — restarting")
                proc = subprocess.Popen(child_argv, env=env, **popen_kwargs)
                continue

            cur = _snapshot(watch_root)
            if cur != last:
                changed = [k for k in cur if cur.get(k) != last.get(k)] + [k for k in last if k not in cur]
                last = cur
                print(f"Token Dashboard: change detected ({len(changed)} file(s)) — restarting")
                _terminate(proc)
                proc = subprocess.Popen(child_argv, env=env, **popen_kwargs)
    except KeyboardInterrupt:
        print("\nToken Dashboard: stopping")
        _terminate(proc)
        return 0
