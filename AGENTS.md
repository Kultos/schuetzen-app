# Repository Guidelines

## Project Structure & Module Organization

This dependency-free Node.js 24 application manages shooting competitions. Root modules contain the server and domain logic: `server.js` serves HTTP(S) routes, `db.js` owns SQLite access, and `auth.js`, `backups.js`, `archives.js`, and `privacy.js` handle focused concerns. `public/` contains browser assets. Put tests in `test/` as `*.test.js`. Runtime data, backups, archives, logs, and admin configuration belong in Git-ignored `data/`. Windows helpers are root-level `.bat` files.

## Build, Test, and Development Commands

Node.js 24 or later is required; no package installation or build step is needed.

- `node server.js` starts the application at `http://localhost:3000`.
- `start.bat` starts a visible server for Windows diagnostics.
- `npm test` runs the complete test suite serially via Node's built-in test runner.
- `npm run test:coverage` runs the same suite with experimental coverage output.
- `setup-windows.bat` configures the recommended Windows scheduled-task and firewall setup; use it only on the intended event machine.

Use `SCHUETZEN_DATA_DIR` for a disposable local data directory; never test against event data.

## Coding Style & Naming Conventions

Write CommonJS modules with `'use strict';`, `require('node:...')` for built-ins, `const` by default, and 2-space indentation. Use `camelCase` for functions and variables, `PascalCase` for domain objects (for example, `Shooters`), and lowercase filenames such as `backup-tool.js`. Keep validation explicit and UI changes in the relevant `public/` asset. No formatter or linter is configured; match surrounding code and avoid unrelated reformatting.

## Testing Guidelines

Use `node:test` and `node:assert/strict`. Name files `test/<feature>.test.js` and describe behavior in test names. Tests must use isolated temporary databases and clean up servers/files they start. Add regression coverage for changed validation, persistence, authorization, archive, backup, or privacy behavior, then run `npm test`.

## Commit & Pull Request Guidelines

Recent history uses short, imperative, sentence-case subjects, such as `Add live dashboard with TV display and automatic rankings`. Keep commits narrowly scoped and explain non-obvious data or security implications. Pull requests should state the user-visible change, tests, migration/backup impact, and linked issue when available. Include screenshots for UI changes and note required Windows setup or configuration.

## Security & Data Handling

Do not commit `data/`, SQLite files, exports, backups, certificates, passwords, or personal contact information. Preserve the privacy journal and backup checks when modifying restore, consent, deletion, or archival paths.
