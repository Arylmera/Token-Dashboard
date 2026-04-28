# Contributing

Thanks for considering a contribution! This is a small, dependency-free Node.js project — easy to run, easy to change.

## Running the tests

```bash
npm test
```

That's it. No `npm install`, no fixtures to download. All 75 tests run in a few seconds via Node's built-in test runner.

If you're fixing a bug, add a failing test first. If you're adding a feature, add a test that exercises the happy path.

## Running the dashboard locally

```bash
node --experimental-sqlite cli.js dashboard --no-open
```

Open http://127.0.0.1:8080 in your browser. The server re-scans every 5 seconds and pushes updates over Server-Sent Events, so you'll see changes without a hard refresh.

## Code style

- **Node built-ins only.** No `dependencies` in `package.json`. If you think a feature genuinely needs a third-party dependency, open an issue first to discuss — we weigh "is this worth the install friction" heavily.
- **SQL: parameter binding always.** Any template literal embedded in a SQL string interpolates only internal values (hardcoded column names, placeholder counts built from internal arrays). User-reachable values go through `?`.
- **Small focused files.** If a file is creeping past ~400 lines and accreting distinct concerns, split it.
- **JSDoc where it aids readability.** Not a hard requirement, but helpful on exported function signatures.
- **Comments explain *why*, not *what*.** The code already shows what.
- **ES modules (`"type": "module"`).** No CommonJS, no transpiler.

Component layout: `cli.js` (entry points) → `src/scanner.js` (JSONL → SQLite) → `src/db.js` (query helpers) → `src/server.js` (HTTP + SSE + `/api/*` routes) → `web/` (vanilla JS UI). See [`CLAUDE.md`](CLAUDE.md) for the short architecture overview. To add a new API route: add a handler branch in `src/server.js`, put the SQL in a helper in `src/db.js`, and add a test under `test/`.

## Opening a pull request

1. Fork the repo.
2. Create a branch: `git checkout -b feat/<short-description>` or `fix/<short-description>`.
3. Make the change. Add or update tests.
4. Run `npm test` — must be green.
5. Commit with a conventional-commit-style message: `feat: add X`, `fix: handle Y`, `docs: update Z`.
6. Push and open a PR against `main`. Describe the user-visible change and link to any relevant issue.

## Ideas that would genuinely help

- Broadening the Skills catalog scan to cover project-local `.claude/skills/` directories (closes the known limitation).
- A CSV or JSON export of any route.
- A session-filter UI (currently everything is all-time or implicit-"recent").
- A GitHub Actions workflow that runs the tests on push.

## What we're not looking for

- Adding a frontend framework. Vanilla JS is a feature.
- Adding telemetry, analytics, or any outbound HTTP for user data. This dashboard is local-only and will stay that way.

## License

By contributing, you agree your contribution is licensed under the [MIT License](LICENSE).
