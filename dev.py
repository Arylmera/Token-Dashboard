"""Dev runner: starts esbuild watch + dashboard with auto-reload.

  python3 dev.py

Edit *.py / *.json -> backend restarts.
Edit frontend/src/** -> esbuild rebuilds dist/app.js -> browser auto-reloads.

Stdlib only. Ctrl-C stops both children.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FRONTEND = ROOT / "frontend"


def _spawn(argv: list[str], cwd: Path, env: dict[str, str]) -> subprocess.Popen:
    kwargs: dict = {"cwd": str(cwd), "env": env}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    return subprocess.Popen(argv, **kwargs)


def _terminate(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            proc.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
        else:
            proc.terminate()
        proc.wait(timeout=4)
    except (subprocess.TimeoutExpired, OSError, ValueError):
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:
            pass


def _ensure_node_modules() -> None:
    if not (FRONTEND / "node_modules").exists():
        print("dev: installing frontend deps (one-time)…")
        npm = "npm.cmd" if os.name == "nt" else "npm"
        subprocess.check_call([npm, "install"], cwd=str(FRONTEND))


def main() -> int:
    _ensure_node_modules()

    npm = "npm.cmd" if os.name == "nt" else "npm"
    env = os.environ.copy()
    env["TOKEN_DASHBOARD_DEV"] = "1"

    print("dev: starting esbuild watch (frontend)…")
    fe = _spawn([npm, "run", "dev"], FRONTEND, env)

    print("dev: starting dashboard (--reload)…")
    backend_argv = [
        sys.executable,
        "-m",
        "token_dashboard",
        "dashboard",
        "--reload",
        "--keep-console",
        "--no-auto-exit",
    ]
    if "--no-open" in sys.argv[1:]:
        backend_argv.append("--no-open")
    be = _spawn(backend_argv, ROOT, env)

    try:
        while True:
            time.sleep(0.5)
            if be.poll() is not None:
                print(f"dev: backend exited ({be.returncode}); stopping")
                break
            if fe.poll() is not None:
                print(f"dev: esbuild exited ({fe.returncode}); stopping")
                break
    except KeyboardInterrupt:
        print("\ndev: stopping")
    finally:
        _terminate(fe)
        _terminate(be)
    return 0


if __name__ == "__main__":
    sys.exit(main())
