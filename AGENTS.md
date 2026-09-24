# Deckino

Repo-wide rules. Subprojects add their own notes in `Deckino.App/AGENTS.md` etc.

## Testing

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex
  features work. At the end of E2E tests, produce a verifiable and repeatable
  artifact (e.g. a report, screenshot, or exported file that can be re-generated
  and diffed).
- If you must test a system in isolation, first write down all the ways it could
  fail, then write the code.
