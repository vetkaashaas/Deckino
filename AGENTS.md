# Deckino

Repo-wide rules. Subprojects add their own notes in `Deckino.App/AGENTS.md` etc.

## Local services

- Local infrastructure (databases etc.) runs in Docker containers, one `docker run` each.
  Don't install services natively, and don't add Docker Compose.
- PostgreSQL for Deckino.Api (dev db `deckino`, E2E db `deckino_e2e`, both created on API startup):

      docker run -d --name deckino-postgres --restart unless-stopped -e POSTGRES_USER=deckino -e POSTGRES_PASSWORD=deckino -p 55432:5432 -v deckino-pgdata:/var/lib/postgresql/data postgres:17

- Windows reserves ports 5058–5657 (Hyper-V), so the API uses 5880 (dev) and 5890 (E2E).

## Web platform

- Dev: `dotnet run --project Deckino.Api` plus `npm run dev` in `Deckino.Web` (Vite proxies `/api`).
- E2E: `npm run e2e` in `Deckino.Web` builds the site, starts the API on the E2E db, and writes
  `e2e-results/report` and `e2e-results/screenshots`. `BASE_URL=https://… npm run e2e` runs the same
  tests against a deployment.
- Deploy: `railway up --service deckino` from `Code/` (Railway project "Deckino", service + Postgres).

## Testing

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex
  features work. At the end of E2E tests, produce a verifiable and repeatable
  artifact (e.g. a report, screenshot, or exported file that can be re-generated
  and diffed).
- If you must test a system in isolation, first write down all the ways it could
  fail, then write the code.
