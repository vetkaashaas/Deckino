# Deckino

Repo-wide rules. Subprojects add their own notes in `Deckino.App/AGENTS.md` etc.

## Git

- Never commit unless the user explicitly asks to commit the current changes.
- When asked, commit directly to `main`. Do not create feature branches.
- After committing, push to `origin` (`git push origin main`).
- Being asked to commit and push also means the user has tested the work locally and is happy to move on:
  tick every phase it completes in the Development Sequence of `AppPlan.md` (with the date) in the same commit.

## Local services

- Local infrastructure (databases etc.) runs in Docker containers, one `docker run` each.
  Don't install services natively, and don't add Docker Compose.
- PostgreSQL for Deckino.Api (dev db `deckino`, E2E db `deckino_e2e`, both created on API startup):

      docker run -d --name deckino-postgres --restart unless-stopped -e POSTGRES_USER=deckino -e POSTGRES_PASSWORD=deckino -p 55432:5432 -v deckino-pgdata:/var/lib/postgresql/data postgres:17

- Windows reserves ports 5058–5657 (Hyper-V), so the API uses 5880 (dev) and 5890 (E2E), and the Vite dev server 5870.

## Web platform

- Dev: F5 in Visual Studio, or `dotnet run --project Deckino.Api`. The "http" launch profile also starts Vite
  (`npm run dev`, port 5870, via SpaProxy) and opens the site; Vite proxies `/api` back to the API.
- E2E: `npm run e2e` in `Deckino.Web` builds the site, starts the API on the E2E db, and writes
  `e2e-results/report` and `e2e-results/screenshots`. `BASE_URL=https://… npm run e2e` runs the same
  tests against a deployment.
- Deploy: `.\scripts\deploy-railway.ps1` (wraps `railway up --service "Deckino Web"` from `Code/` and waits until live) (Railway project "Deckino", services "Deckino Web" + "Deckino Db"). Production: https://deckino.com
  (www.deckino.com redirects there; https://deckino-production.up.railway.app also still serves it).
  Always deploy with that script, not a bare `railway up`. It uploads the working tree as-is (uncommitted changes
  included). Under Windows PowerShell 5.1 it stops at once because the Railway CLI writes to stderr; run it from
  PowerShell 7 (`pwsh`) or, failing that, run its `railway up --service "Deckino Web" --detach` from bash and
  wait for `railway deployment list --service "Deckino Web" --json` to show SUCCESS, then check `/api/health`.
- App E2E: `.\scripts\app-e2e.ps1 -Build` builds the E2E APK, starts the E2E API and the Android emulator, and runs
  the Maestro flows in `Deckino.App/.maestro`; screenshots and reports land in `Deckino.App/e2e-results/maestro`.
  Running the app on the phone or the emulator (the emulator needs `-port 5680` on this PC): `Deckino.App/AGENTS.md`.
- Backups: Railway's scheduled backups of the "Deckino Db" volume, plus `bash scripts/test-db-restore.sh`, which
  dumps production over `railway ssh` into `data/backups/` and proves the dump restores (row counts per table).

## SQL

- Always pass values to SQL as parameters, never by building strings. With EF use LINQ, or
  `SqlQuery`/`ExecuteSqlAsync` with an interpolated string (each `{value}` becomes a parameter); with Npgsql
  directly, use `NpgsqlParameter`. `ExecuteSqlRawAsync`/`SqlQueryRaw` only for SQL with no values in it.
- Only identifiers (table and column names) can't be parameters. Those must come from constants in the code,
  never from input.
- A parameter used in a `LIKE`/`ILIKE` pattern still treats `%` and `_` as wildcards. Escape them when the
  user's text should match literally.

## Testing

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex
  features work. At the end of E2E tests, produce a verifiable and repeatable
  artifact (e.g. a report, screenshot, or exported file that can be re-generated
  and diffed).
- If you must test a system in isolation, first write down all the ways it could
  fail, then write the code.
