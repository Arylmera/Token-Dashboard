"""Generate a placeholder 256x256 app icon (PNG) without third-party deps.

Run from repo root:
    python electron/scripts/gen-icon.py

Drops `electron/build-resources/icon.png`. Convert to .ico (Windows) and
.icns (macOS) using your favorite tool — electron-builder needs both
for production installers. See electron/README.md.
"""
from __future__ import annotations

import os
import struct
import sys
import zlib
from pathlib import Path

W = H = 256
BG = (10, 10, 10, 255)
FG = (255, 255, 255, 255)


def is_T(x: int, y: int) -> bool:
    # Crossbar
    if 60 <= y < 92 and 48 <= x < 208:
        return True
    # Stem
    if 112 <= x < 144 and 60 <= y < 200:
        return True
    return False


def encode_png(width: int, height: int) -> bytes:
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type: None
        for x in range(width):
            r, g, b, a = FG if is_T(x, y) else BG
            raw.extend((r, g, b, a))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    return png


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "build-resources" / "icon.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    data = encode_png(W, H)
    out.write_bytes(data)
    print(f"wrote {out}: {len(data):,} bytes")


if __name__ == "__main__":
    main()
