# Token Dashboard — Remaining Work

Tracks what's outstanding after the Electron migration (Phases 1–5 landed on
the `electron` branch). Tick boxes as they're done.

## Verification

- [ ] **Visual smoke test** in `electron/` (`npm install && npm run dev`):
  - [ ] window opens frameless on Windows with native min/max/close buttons
        via `titleBarOverlay`; drag region works on the topbar
  - [ ] dashboard renders identically to the browser version
  - [ ] tray icon appears in the OS shell
  - [ ] tray title (macOS) / overlay icon (Windows) updates within ~1 s of a
        Claude Code session writing to `~/.claude/projects/`
  - [ ] external links open in the default browser, not in-window
- [ ] **Backend Python tests still green**: `python -m unittest discover tests`
- [ ] **Frontend bundle rebuild after JSX edits**: `cd frontend && npm run build`
      (or run `npm run dev` for watch mode)

## Packaging blockers

- [ ] **Convert `electron/build-resources/icon.png` to `icon.ico` + `icon.icns`.**
      `electron-builder` requires both for Win/Mac installers. Options:
  - Use a converter site (drag-drop)
  - Add `png-to-ico` + `iconz` as devDeps + a build script
  - ImageMagick: `magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico`
- [ ] **Stage backend exe for packaging.** Run
      `python electron/scripts/prepare-py.py` to populate `dist-py/`.
      `electron/package.json` ships `dist-py/` under `<resources>/py/`.
- [ ] **Build a real installer.** `cd electron && npm run build:win` (or
      `:mac` / `:linux`). Output goes to `electron/dist/`.

## Phase 5 polish (optional)

- [ ] Auto-launch on system startup (`app.setLoginItemSettings({...})`)
- [ ] Replace placeholder icon with a designed one
- [ ] Code signing certificates (Win Authenticode / mac Developer ID) — only
      needed for distribution outside personal use
- [ ] `tray.setImage` with the live overlay PNG on Windows so the tray icon
      itself shows the count (currently only the taskbar overlay does)
- [ ] Remove `unsafe-eval` from CSP — landed already since Babel-standalone
      was dropped; double-check there are no remaining eval call sites

## Future architecture options

- [ ] Replace the Python backend with a Node.js scanner so the desktop app
      has zero runtime deps. Out of scope for now — keep Python.
- [ ] Migrate the renderer's per-event full data refetch to incremental
      patches over SSE. Currently every scan event triggers a fresh
      `Promise.all` over 11 endpoints; a delta protocol would scale better
      for users with very large `~/.claude/projects/` trees.
- [ ] Move the canvas badge renderer out of the main `BrowserWindow` into a
      hidden offscreen window so the badge can update even when the
      dashboard window is minimised or closed.

## Cleanup

- [ ] Re-evaluate the `_open_app_window` Chromium-app probe in
      [`token_dashboard/__main__.py`](token_dashboard/__main__.py). With the
      Electron shell as the primary surface, that code path is only used by
      `cli.py dashboard` from a terminal — keep, but document as the
      "no-Electron" fallback.
- [ ] Update [`AUDIT.md`](AUDIT.md)'s pain-points section: most have been
      addressed (SSE fan-out, health endpoint, ready signal, port-conflict
      handling, pricing hot-reload, magic-number env overrides, offline
      vendor). Mark accordingly or archive the file.
