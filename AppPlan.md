# Deckino Mobile App and API Integration Plan

> **Status: in progress: A1 and A2 done (2026-10-13).** The choices made so far are under [Decisions](#decisions).
>
> **Before starting each phase:** re-read it and check that every part is still relevant, given what earlier phases taught us. Drop, change or defer anything that no longer fits, and update this plan before writing code.

## Goal

Bring `Deckino.App` from a scanner spike to the website's end product in your pocket: the same account, card catalogue, decks, binders, wishlist, prices and public decks, plus the one thing the website can't do: **scan a physical card and put it straight into a binder, deck or wishlist.**

`PLAN.md`, the website plan referred to below, is complete and was removed on 2026-10-12; it is in git history (commit da08220).

This plan covers both halves of that work: the app, and everything `Deckino.Api` needs to serve it. `PLAN.md` deliberately left the mobile API out ("Expo Mobile Integration" under its Future Work). That work lives here now.

## Where We Start (2026-10-12)

- Expo SDK 57, expo-router, two native tabs (Home, Scan), a dark theme shared with the website (`src/theme.ts`).
- On-device scanning works: the extractor finds the card's corners, the artwork recognizer returns an **Oracle ID + name** (with its top-K candidates), and a temporal voter locks the result. A shared photo can also be scanned (`shared-scan.tsx`).
- The app's only API call is the temporary training-capture upload (`POST /api/dev/training-captures`), behind a shared key.
- The API serves the website: cookie authentication only, and every feature endpoint the website needs (catalogue, decks, legality, binders, wishlist, collection prices, public decks, import/export).

---

# API Integration

## One API, Two Clients

- The app uses the same endpoints and DTOs as the website. There is no `/api/mobile` area and no separate mobile project. `Deckino.Api` stays one project, as `PLAN.md` says.
- New endpoints go in the feature folder they belong to (`Binders/`, `Cards/`…), and the website can use them too.
- An endpoint is added only when a phase below needs it and no existing one fits. Each phase lists its API changes, and the full list is under [API Changes by Phase](#api-changes-by-phase).
- All of `PLAN.md`'s rules still apply to these changes: ownership checks on every endpoint, 404 for someone else's private data, validation at the boundary, parameterised SQL, UUIDv7 keys, and Playwright tests kept green.

## Authentication

- The website keeps its cookie. The app gets **bearer tokens** from ASP.NET Identity's `AddBearerToken` (short-lived access token + refresh token, protected with the same data-protection keys already stored in PostgreSQL).
- A policy scheme picks the handler per request: an `Authorization: Bearer` header means bearer, anything else means cookie. Every endpoint that accepts the cookie accepts the token, with no per-endpoint changes.
- `POST /api/auth/token` runs exactly the website's login rules: verified email required, lockout, the same rate limit, the same response for unknown emails, wrong passwords and lockouts.
- Rate limits are per client IP, and many phones share one IP behind a mobile carrier's NAT. A3 checks the auth limits are loose enough for that; account lockout, not the IP limit, is what stops password guessing.
- `POST /api/auth/refresh` re-checks the user's security stamp, so changing the password or deleting the account ends the app's sessions on the next refresh.
- An access token whose user no longer exists is rejected (401), so a deleted account's last token can't create orphaned rows in the hour it has left.
- Bearer requests aren't open to CSRF (the browser never adds the header itself), so the cookie's CSRF handling stays as it is.
- The app keeps both tokens in `expo-secure-store` and refreshes silently. Logging out deletes them on the phone. Identity's bearer tokens can't be revoked one by one; a short access-token lifetime (e.g. 1 hour) limits the damage, and "log out everywhere" is a password change.

## Compatibility

Store apps stay on old versions for months, so the API mustn't break them.

- Changes to endpoints the app uses are **additive only**: new fields and new endpoints, never renamed or removed fields. Breaking changes get a new endpoint, and the old one stays until no supported app uses it.
- The app sends `X-Deckino-App-Version` on every request.
- `GET /api/app/config` returns the minimum supported app version. Older apps show an "Update Deckino" screen instead of failing in odd ways. The minimum is a Railway variable, raised only when an old endpoint is finally removed.
- No URL versioning (`/v1`) until the additive rule actually fails.

## Types

The app's request and response types are written by hand in `src/api/`, matching the website's `Deckino.Web/src/api.ts` and the C# records. Generating them from an OpenAPI document is worth it only if they start drifting.

## Server-Side Scanning Stays Out

Recognition stays on the phone. The server never runs the extractor or recognizer, never stores embeddings, and keeps no scan history. The scan tray (Phase A5) lives on the phone until the user saves it, and then becomes ordinary binder, deck or wishlist data.

The one exception is training photos, which become an opt-in, account-linked upload (Phase A3 and A10, and Training Data below).

## Sync

**Online-first.** The app reads and writes through the API, like the website, with TanStack Query caching what it has already seen. Only scanning works without a connection, and the scan tray waits on the phone until the API is reachable.

The local SQLite copy, two-way sync, sync cursors and conflict handling that `PLAN.md` imagined are deferred. They are a large, permanent cost (every feature built twice), and it isn't yet clear they're needed. Revisit after A9 if the online-first app proves painful in real use (shops with no signal are the likely case).

Concurrent edits from the app and the website follow the website's rule: the last write wins.

## API Changes by Phase

| Phase | Change |
|---|---|
| A1 | `GET /api/app/config` (minimum app version); version header logged |
| A2 | `illustration_id` in the catalogue; printings by artwork (falling back to the Oracle ID's default printing) |
| A3 | Bearer tokens alongside cookies; `POST /api/auth/token`, `POST /api/auth/refresh`; training captures signed in and linked to the user, shared key removed |
| A4 | none expected |
| A5 | `BinderCard.PrintingConfirmed` (migration, existing rows confirmed); batch add of different cards to a binder in one request; "Confirm printings" with the set strip on the website's binder page |
| A6 | none expected |
| A7 | "What do I have of these Oracle IDs" lookup (owned count, wishlist quantity, decks) |
| A8 | `/.well-known/assetlinks.json` for Android App Links |
| A10 | Training-capture opt-in honoured; dev-only endpoints confirmed absent in production |

## Testing the API Changes

- Every API change is exercised by the app's Maestro flows **and** keeps the website's Playwright suite green.
- Rules that only the bearer path has (token login, refresh after a password change, a token from user A can't reach user B's data) get Playwright API tests (`request` fixture, no browser), since they belong to the API, not the app.

---

# App Principles

1. **Android only** until the app is solid on Google Play. iOS comes later (see Future Work); nothing is built to block it, and nothing is built for it yet.
2. **Exact printings matter, but scanning stays forgiving** (see [Printings From a Scan](#printings-from-a-scan)). The app picks the most likely printing on its own, makes changing it a flick, and never pretends a guess was confirmed.
3. **Scanning is the hero.** The camera is never more than one tap away, and every flow that ends in "add a card" can start from it.
4. **Native feel, same product.** Material-style navigation, bottom sheets, haptics, the system share sheet and back gesture, but the same names, concepts, colours and card framing as the website. Card images are the hero content; the interface frames them.
5. **Every phase ends with something usable on the phone**, built as a preview APK.

## Design and UX

Like the website's Phase 3, the app gets its look settled once, early, and every later screen is built from it.

- **Direction:** the website's dark theme, purple-to-pink gradient, Bricolage Grotesque + Lexend, and its restrained ambient orbs. `src/theme.ts` stays the source of truth for both.
- **Components** (A1): card image, card tile (full-bleed art, as on the website), mana symbols, set symbols (Scryfall's SVGs, coloured by rarity), price, list rows with thumbnails, bottom sheets, empty and error states, skeletons, toast confirmations. `@expo/ui` for native controls (sheets, switches, pickers, menus), plain React Native for the rest.
- **Motion:** Reanimated for gestures and the scan tray, springs rather than timed animations, haptics on every scan lock and save. The system's reduce-motion setting is respected.
- **One-handed:** primary actions sit in the bottom half of the screen. The scanner's controls are reachable by the thumb holding the phone.
- **Accessibility:** TalkBack labels, 48dp touch targets, AA contrast, and layouts that hold at the largest system font.
- **Style guide:** a dev-only screen showing every component in every state, screenshotted by Maestro at a small and a large phone size. It is A1's repeatable artifact and the reference for later phases.
- Each phase that adds a screen agrees its layout with the user (sketch or screenshot) before it's built, using the `expo-native-ui` and `expo-animation` skills.

## Definition of Done (every phase)

1. The phase's milestone is covered by **Maestro** flows (the E2E tool Expo documents and runs in EAS Workflows; it drives the built app from outside, so it doesn't break with each React Native upgrade) on an Android emulator, against the real API on the E2E database (the same `deckino_e2e` setup and Scryfall fixture as the website's Playwright tests, and its dev endpoints, e.g. reading verification emails).
2. The run produces a repeatable artifact: Maestro's report plus a screenshot of each milestone step.
3. Camera flows are tested through the shared-photo path with checked-in fixture photos of fixture cards, since an emulator camera can't be driven reliably. The live camera is checked by hand on the phone.
4. Ownership and privacy rules introduced in the phase are tested in that phase.
5. `npm run typecheck` passes, and the website's Playwright suite stays green.
6. A preview APK is built (`scripts/build-android-release.ps1`), and any API change is deployed to Railway.

---

# Phase A1: App Shell and API Client

## Goal

The app talks to the Deckino API and has the navigation the rest of the plan fills in.

## API

- `GET /api/app/config` with the minimum supported app version.

## App

- API base URL per build (local dev API over the LAN / `adb reverse`, Railway for preview builds), from `EXPO_PUBLIC_*` config.
- One small API client (`fetch`, ProblemDetails errors, the version header) and TanStack Query for caching, loading and retry.
- The "Update Deckino" screen when the app is below the minimum version.
- Tabs: **Home, Cards, Scan, Collection, Decks**, with an avatar in every tab's top bar that opens Profile (A3). Empty screens are fine until their phase.
- The design system and style guide screen from [Design and UX](#design-and-ux).
- On-device storage for preferences and the scan tray: `expo-sqlite`'s key-value store (tokens go in `expo-secure-store` in A3).
- Maestro set up with the first flow and its artifact output.

## Visible Milestone

The app opens on the new tabs and reaches the API. Raising the minimum version shows the update screen. The style guide is screenshotted at two phone sizes. The first Maestro flow passes.

## As built

- `GET /api/app/config` returns `minimumVersion` (Railway variable `App__MinimumVersion`, default `0.0.0`). An `X-Deckino-App-Version` header adds `AppVersion` to every log line of that request. In Development, `PUT /api/dev/app/minimum-version` changes it until the API restarts, for the update flow.
- `src/api/`: one `fetch` client (15 s timeout, ProblemDetails messages, the server error's trace reference as on the website, the version header) and TanStack Query (retries only offline and 5xx). The API is `EXPO_PUBLIC_API_URL`, else https://deckino.com.
- Five native tabs. Every tab's top bar (and the scanner's) has the avatar, which opens Profile: signed out until A3, with About (version, server, Scryfall and Fan Content notices) and, in dev and E2E builds, the style guide. Collection and Decks show an empty state that points to Scan and Cards.
- The update screen covers the whole app when the API's minimum version is above the app's (offline counts as supported). It covers rather than replaces, so expo-router keeps its navigator for shared photos and links.
- Design system: Lexend and Bricolage Grotesque embedded by the `expo-font` plugin, tokens in `src/theme.ts` (fonts, type scale, rarity colours, the ambient glow), components in `src/components/ui.tsx` (screen, avatar, button, chip, empty, error, skeleton, list row), `card-visuals.tsx` (card image and tile, mana cost, rules text with symbols, set symbol in rarity colour) and `price-chart.tsx` (`react-native-svg`). The style guide is `src/app/styleguide.tsx`.
- Deferred to the phase that first needs them: the `expo-sqlite` key-value store (A3 preferences, A5 tray), toasts (A4, the first save), `@expo/ui` sheets for new screens (the card filters use a React Native modal sheet, which takes our own styling).
- Maestro: flows in `Deckino.App/.maestro`, run by `scripts/app-e2e.ps1` (the API on 5890 with the E2E database and fixture as for Playwright, the emulator, an E2E APK from `build-android-release.ps1 -E2E`: x86_64, `http://10.0.2.2:5890`, plain HTTP allowed in that build only). Reports and screenshots go to `Deckino.App/e2e-results/maestro`. The emulator is `deckino_e2e` on port 5680 (Hyper-V reserves the default ports; see `Deckino.App/AGENTS.md`); the small phone size is the same emulator at `wm size 720x1280`, density 320, where the flows found Home's button hidden behind the tabs (Home now scrolls). A scan isn't automated: the camera needs a real card and an adb-shared photo arrives unreadable, so scan-to-card is covered by Playwright (`/api/cards/by-artwork`) and on a phone.

---

# Phase A2: Card Catalogue and Scan-to-Card

## Goal

Browse the catalogue on the phone, and a scan finally leads somewhere: the card's page.

## API

- The catalogue stores each printing's `illustration_id` (per face for double-faced cards), filled by the next sync.
- A lookup from a recognized artwork to its printings: by `illustration_id`, falling back to the Oracle ID's default printing when the artwork has none. The printings come back with the one to preselect first, chosen by the same function as the default printing, so that rule still lives in one place.

## App

- Cards tab: name search with the website's filters (`/api/cards`), results grouped by card.
- Card page: image (both faces), rules text, set, rarity, artist, prices, every printing (`/api/cards/{id}/printings`), the 90-day price chart (`/api/cards/{id}/prices`).
- The recognizer reports which artwork it matched, not only the card: the export adds each prototype's `illustration_id` to `app-labels.json` (artwork schema bump, kept in sync with the Toolbox as usual).
- The scan result gets a "View card" action, opening the printing with that artwork.

## Visible Milestone

A user searches for a card and opens its page, or scans a card and taps through to the same page.

## As built

- `cards.illustration_ids uuid[]` (GIN index): every face's artwork, filled by the sync's upsert. The migration marks earlier sync runs superseded, so the next check re-imports the current bulk file and fills the column at once.
- `GET /api/cards/by-artwork?oracleId=&illustrationId=`: the card's printings with that artwork, ordered by the default-printing rule (`CatalogueSync.DefaultPrintingOrder`, now shared by both), so the first is the one to start on. No artwork, an unknown one or another card's gives the default printing alone; an unknown card is a 404. Playwright covers it (`catalogue.spec.ts`) and the app config (`foundation.spec.ts`).
- Toolbox: `app-labels.json` schema 2 adds `prototype_illustrations`, taken from the index's artwork ids (an illustration id, or `printing:…` when Scryfall has none). No artwork schema bump was needed: older labels still load and fall back to the default printing. The current model was re-exported with them (51,677 of 51,678 artworks).
- The recognizer's candidates and the voter's guesses carry `illustrationId`. The first locked frame's artwork stays for the lock (`useScannedPrinting`), and the result shows that printing's set and price with **View card**. The same works for a shared photo.
- Cards tab: name search (best match; most valuable without a name), filter chips for colors, mana value, rarity, type and sort, each opening a sheet, a two-column grid with endless scroll. The set filter and "include tokens and art cards" are left for later (a searchable set picker is a screen of its own).
- Card page: the card (tap or "Turn over" for both faces), each face's text with inline symbols, set symbol, set, number, rarity, year and artist, USD/EUR and foil prices, the price chart (up to 90 days), and every printing as a picture strip that switches the page.

---

# Phase A3: Accounts, Profile and Settings

## Goal

Users sign in to their Deckino account on the phone, and have one place for their account and the app's settings.

## API

- Bearer tokens next to the cookie, `POST /api/auth/token` and `POST /api/auth/refresh`, as described under [Authentication](#authentication).
- Playwright API tests for the bearer rules (see Testing the API Changes).
- Training captures require a signed-in user and record who sent them. The shared key (`TrainingCaptures__Key`, `EXPO_PUBLIC_TRAINING_UPLOAD_KEY`) is removed.

## App

- Log in, register, resend verification, forgot password, using the existing account endpoints. Verification and reset links open the website (or the app, once A8 adds App Links).
- Tokens in `expo-secure-store`, silent refresh, log out.

## Profile

Opened from the avatar in the top bar of every tab. Signed out, it shows "Sign in / Create account" above the same settings.

- **Header:** username, member since, and a summary of their Deckino: cards owned, decks, collection value.
- **Account:** change username, change password, sign out, **delete account** (Google Play requires it in-app, behind a confirmation that names what is deleted).
- **Preferences:** currency (USD/EUR), default binder for scans, default condition, language and finish for new cards, haptics on/off.
- **Scanner:** the existing scanner settings sheet's options that make sense to users (e.g. scan sound); the debug HUD and corner labels stay in dev builds only.
- **Privacy:** help improve recognition (training photos, opt-in, off by default from A10), what is stored and where.
- **About:** app version, Scryfall and Wizards of the Coast Fan Content Policy notices, privacy policy, open-source licences, send feedback.

Preferences live on the phone, like the website's currency choice lives in the browser. Server-side preferences come only if users ask why the two don't match.

## Note

Email is log-only until `PLAN.md` Phase 14. Real sign-ups from the app need Mailgun live, so Phase 14 must land before any public app build.

## Visible Milestone

A user registers or logs in, stays signed in across restarts, sees their profile, changes their username and preferences, logs out and can delete their account. Changing the password on the website signs the app out.

---

# Phase A4: Binders

## Goal

The user's binders on the phone, ready to receive scanned cards.

## API

None expected. The binder and collection-price endpoints already cover it.

## App

- Collection tab: binders list with values and recent movers (`/api/collection/prices`).
- Binder screen: cards grouped by printing, finish, condition and language with counts, value, search within the binder.
- Add a card by search, with the website's quick add (remembered condition, language and finish).
- Edit, remove, move a selection to another binder, rename, delete, Selling and Public switches, share the public link through the native share sheet.

## Visible Milestone

A user manages their binders on the phone as on the website. Another user's token can't open a private binder.

---

# Phase A5: Scan to Binder

## Goal

The headline feature: scan a stack of cards into a binder.

## API

- `BinderCard.PrintingConfirmed`. The migration marks existing rows confirmed (a person chose them). Cards added from the website, by search or by import stay confirmed. Only scanned cards the user didn't check arrive unconfirmed.
- Adding to a binder accepts a list of different cards in one request (today `POST /api/binders/{id}/cards` takes one card with a copy count), applied in one transaction.
- The website's binder page shows unconfirmed cards and offers "Confirm printings", the same picker as "Change printing".

## Printings From a Scan

The recognizer matches the **artwork**, so it already narrows the printing a lot: most artworks appear in a handful of sets, not dozens.

1. **Forgiving default:** the card goes in as the latest printing with that artwork (following `PLAN.md`'s default-printing rules among them: English, not promo, not Secret Lair…). The user can save without touching it.
2. **Set strip:** under the card in the tray, a horizontal strip of the printings that share the artwork, each as its **set symbol in rarity colour**, set code and year. A flick left or right changes the printing, the card image cross-fades, a light haptic marks each step, and the price updates. That is the whole interaction for the common case: look at the symbol on the physical card, flick to the matching one.
3. **Other artworks:** the end of the strip opens every other printing of the card, as pictures, filterable by set, for when the art is shared with a different version or was misread.
4. **Your card, magnified:** where the camera frame allows, the tray shows a zoomed crop of the scanned card's set-symbol corner next to the strip, so the user matches symbols on screen without picking the card up again. A5 checks whether the recognition frame is sharp enough, or a still photo at lock is needed.
5. **Confirmed or not:** flicking to a printing, or tapping the default's check mark, confirms it. Cards saved untouched are unconfirmed: they show a small dot in the binder, and "Confirm printings" walks through them with the same strip.

Reading the set symbol or collector number automatically (so the strip starts on the right one) is future work. Every confirmed scan is training data for it.

## Flow

1. From the Scan tab, choose a target (binder, remembered) in the bar above the camera, and scan.
2. Each locked card drops into the tray at the bottom of the camera with a haptic tick and a short slide-in. The same card held steady isn't added twice, and neither is one that loses its lock for a moment (glare, a wobble). Another copy needs the frame to be empty for a moment, or a tap on the tray's +1; it shows as ×2.
3. The tray is a collapsed strip of thumbnails while scanning. Swiping it up opens the full list, one row per card with the set strip, finish, condition and language (remembered defaults, changeable per row or for all).
4. Wrong guesses: swipe a row to remove it, or tap the name to choose another of the recognizer's top-K candidates or search by name.
5. "Add N cards to {binder}" saves the tray in one request, with the total value, and an undo toast that removes the cards it just added.

The tray is kept on the phone, so a session survives the app closing or losing signal.

## Visible Milestone

A user scans several cards (fixture photos in the E2E flow), fixes one printing and one wrong guess, and saves them to a binder. They appear with the right printings, and the unchecked ones show as unconfirmed in the app and on the website.

---

# Phase A6: Decks

## Goal

View and build decks on the phone, and scan cards into a deck.

## API

None expected. The deck, legality and printing endpoints already cover it.

## App

- Decks tab: My decks (art tiles, format, value, "Updated 2 days ago").
- Deck screen: art header, format badge, colour pips, stats strip, list and gallery views grouped by type, the legality chip with its reasons (`POST /api/decks/legality`).
- Editing as on the website: autosave (one save at a time, as on the website), add by search, quantities, commander, sideboard/maybeboard, change printing and finish, rename, format, public switch, delete.
- Scan to deck: the Phase A5 tray with a deck as the target (no condition or language, printing optional).

## Visible Milestone

A user builds a legal Commander deck on the phone, partly by scanning, and sees the same deck on the website.

---

# Phase A7: Wishlist and "Do I Own This?"

## Goal

The wishlist on the phone, and the scanner answers the question players ask at a shop or trade table.

## API

- One lookup answering, for a list of Oracle IDs: owned count across all binders (any printing, as in `PLAN.md` Phase 8), wishlist quantity, and which decks use it. Owner-only, capped list size.

## App

- Wishlist screen: add, change quantity, remove, value.
- Deck vs collection on the deck screen, with "Add missing to wishlist".
- A scan mode that, for each locked card, shows **owned ×N**, **on your wishlist**, **in deck X**, plus its price. Nothing is added in this mode.
- Scan to wishlist: the tray with the wishlist as the target.

## Visible Milestone

A user scans a card they own, one on their wishlist and one they don't have, and sees the right badge on each.

---

# Phase A8: Public Decks, Sharing and Links

## Goal

The public side of Deckino in the app.

## API

- `/.well-known/assetlinks.json` with the app's package name and signing-key fingerprint. Needs the custom domain from `PLAN.md` Phase 14.

## App

- Browse and search public decks, filter by format, open one, Copy to my decks.
- Android App Links so `/deck/{id}`, `/binder/{id}` and the account email links open in the app when it's installed.
- Export a deck or binder through the share sheet (`/api/decks/{id}/export`, `/api/binders/{id}/export`).
- Import a decklist from pasted text or a shared file, through the website's review step (`/import`).

## Visible Milestone

A shared deck link opens in the app, and a pasted decklist imports through the review step.

---

# Phase A9: Home and Polish

## Goal

The app feels finished.

## Tasks

- Home for a signed-in user, mirroring the website's dashboard: collection value, movers, recent decks and binders, a large Scan button, the Commander of the Day.
- Home for a signed-out user: what Deckino is, scan without an account (scan to card page only), sign in to save.
- A pass over loading, empty and error states, pull to refresh, haptics, accessibility labels, large-font layouts and reduced motion.
- Offline behaviour checked screen by screen: cached data shown, clear "you're offline" state, nothing lost.
- Performance: list virtualisation for big binders, image caching (`expo-image`), cold start time.

## Visible Milestone

Every screen holds up on a small phone, with large fonts, offline and online.

---

# Phase A10: Store Release

## Goal

Deckino on Google Play.

## API

- Training captures only accepted from users who opted in (the app sends the choice, the API checks it).
- Production review of the bearer path alongside `PLAN.md` Phase 15: token lifetimes, rate limits, dev endpoints absent.

## App

- EAS Build production profile, signing keys, versioning and an internal testing track.
- Store listing: screenshots, description, privacy policy and data-safety form (camera, account data, optional training photos).
- Training captures become **opt-in** in settings, off by default.
- The website's Google Play button goes live. The App Store button stays "Coming soon".
- Crash and error reporting.

## Prerequisites

`PLAN.md` Phase 14 (email) and 15 (production hardening) are done, and the custom domain exists.

## Visible Milestone

The app is installable from the Play Store's internal track, and a tester signs up and scans a card into a binder.

---

# Training Data

Every confirmed or corrected scan (tray edits in Phases A5–A7) is a labelled photo with an exact printing, which is exactly what the field-capture pipeline wants. Once captures are opt-in and tied to an account, these labels can be uploaded as `confirmed`/`corrected` identities without a separate labelling step. The rule stays: train only on human-confirmed labels, never on the model's guesses.

# Future Work (Deferred)

- **Printing recognition:** set symbol, collector number and frame read from the scan, so the tray picks the right printing on its own.
- **Bulk sorting mode:** rapid scanning of a whole box, with sorting hints (by colour, set or value).
- **Offline-first sync:** local SQLite copy of decks/binders with two-way sync, sync cursors and conflict handling, if online-first proves painful.
- **Goldfishing** on the phone, from saved decks.
- **iOS:** builds, App Store listing, Universal Links and an iOS Maestro run, once Android is live on Google Play.

# Development Sequence

When the user asks to commit and push, tick (with the date) every phase that work completes.

- [x] A1. App shell, design system + API client (2026-10-13)
- [x] A2. Card catalogue + scan-to-card (artwork → printings) (2026-10-13)
- [ ] A3. Accounts, profile + settings (bearer tokens, signed-in training captures)
- [ ] A4. Binders
- [ ] A5. Scan to binder (set strip, `PrintingConfirmed`, batch add)
- [ ] A6. Decks + scan to deck
- [ ] A7. Wishlist + "do I own this?" (ownership lookup)
- [ ] A8. Public decks, App Links, import/export
- [ ] A9. Home + polish
- [ ] A10. Store release

# Decisions

- Android only for now; iOS after the Play Store release.
- Maestro for the app's E2E tests.
- Scanned printings: forgiving. The latest printing with the scanned artwork is used by default, changed with the set strip, and flagged until confirmed.
- Five tabs (Home, Cards, Scan, Collection, Decks), with Profile behind the avatar in the top bar.
- Tokens: 1-hour access token, 30-day refresh token.

# Open Decisions

- Whether the set-symbol magnifier works from the recognition frame or needs a still photo at lock (A5).
