"""Build the PyInstaller backend and stage it under dist-py/ for electron-builder.

Run from repo root:
    python electron/scripts/prepare-py.py

What it does:
  1. Runs `pyinstaller --clean --noconfirm token-dashboard.spec` (cwd = repo root).
  2. Copies the resulting `dist/token-dashboard*` into `<repo>/dist-py/`.
electron/package.json's `build.extraResources` ships dist-py/ under
`<resources>/py/` in the packaged app, where main.js looks for it.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
DIST = REPO / "dist"
STAGE = REPO / "dist-py"


def ensure_pyinstaller() -> None:
    try:
        subprocess.check_call([sys.executable, "-m", "PyInstaller", "--version"], stdout=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("PyInstaller not found — install with: pip install pyinstaller", file=sys.stderr)
        sys.exit(1)


def build() -> None:
    print("[prepare-py] running pyinstaller…")
    subprocess.check_call(
        [sys.executable, "-m", "PyInstaller", "--clean", "--noconfirm", "token-dashboard.spec"],
        cwd=str(REPO),
    )


def stage() -> None:
    if not DIST.exists():
        print(f"[prepare-py] expected {DIST} after pyinstaller — bailing", file=sys.stderr)
        sys.exit(2)
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)
    matches = list(DIST.glob("token-dashboard*"))
    if not matches:
        print(f"[prepare-py] no token-dashboard* artefacts in {DIST}", file=sys.stderr)
        sys.exit(3)
    for src in matches:
        dst = STAGE / src.name
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        print(f"[prepare-py] staged {dst.relative_to(REPO)}")


def main() -> None:
    ensure_pyinstaller()
    build()
    stage()
    print(f"[prepare-py] dist-py ready at {STAGE}")


if __name__ == "__main__":
    main()
