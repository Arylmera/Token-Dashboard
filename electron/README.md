# Token Dashboard — Electron shell

Native desktop wrapper around the Python backend + React frontend.

## Dev

From this directory:

```bash
npm install
npm run dev
```

What happens:

1. `electron .` boots the main process (`main.js`).
2. Main process probes a free TCP port and spawns
   `python -m token_dashboard dashboard --no-open --no-scan` with
   `PORT=<probed>` and `HOST=127.0.0.1`.
3. Main process waits for the `TOKEN_DASHBOARD_READY {…}` line on stdout
   (or polls `/api/health` as a fallback). Timeout 15 s.
4. A `BrowserWindow` opens at the bound URL.
5. A `Tray` icon appears in the OS shell. On macOS the tray title shows
   today's billable tokens (e.g. `1.2k`); on Windows the tooltip carries
   the same info. Both refresh every 3 s.

`PYTHON=/path/to/python` overrides the interpreter probe.

## Build

```bash
# Step 1: build the PyInstaller backend exe (run from repo root).
pyinstaller --clean --noconfirm token-dashboard.spec
mkdir -p dist-py
cp dist/token-dashboard* dist-py/        # or dist/token-dashboard.exe on Windows

# Step 2: build the Electron app (this dir).
npm run build         # current OS only
npm run build:win
npm run build:mac
npm run build:linux
```

Output goes to `electron/dist/`.

The `extraResources` config in `package.json` ships the PyInstaller exe under
`<resources>/py/`; the main process picks it up automatically when
`app.isPackaged` is true.

## Layout

- `main.js` — process supervisor + window/tray.
- `preload.js` — exposes `window.td` to the renderer (`backendUrl`,
  `readyPayload`, `platform`).
- `package.json` — `electron-builder` config + scripts.

## Caveats

- Backend `/api/stream` SSE Hub supports multiple concurrent subscribers
  (added in Phase 2), so a future tray subscriber will not steal events
  from the main window.
- Windows taskbar overlay-icon (numeric badge) is not yet wired up — the
  tooltip carries the count for MVP. Phase 4 polish.
- Auto-launch on system startup is not configured. Phase 5.
