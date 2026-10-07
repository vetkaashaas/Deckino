# Deckino Web Platform & Backend Plan

> **Before starting each phase:** re-read it and check that every part is still relevant, given what earlier phases taught us and any change in requirements. Drop, change or defer anything that no longer fits, and update this plan before writing code.
>
> **Progress:** see the checklist under [Development Sequence](#development-sequence).

## Project Overview

Deckino is an MTG card scanning, collection, deck-building and sharing platform.

The existing Expo mobile application (`Deckino.App`) handles card scanning and on-device card recognition. This project covers the **web platform and backend/API that will power Deckino's online functionality**.

The backend will provide:

- User accounts and authentication
- MTG card catalogue (synced from Scryfall)
- Deck storage and management
- Binder (physical collection) storage and management
- A per-user wishlist
- Public deck sharing and search
- Public binder sharing via direct links
- Card pricing and price history
- Deck legality information
- Deck and binder import/export
- APIs consumed by the Deckino website

The backend must be designed so that the Expo application can integrate with it later.

## Explicitly Out of Scope

The following must NOT be implemented as part of this project:

- Mobile application API integration
- Mobile sync protocol
- Mobile offline synchronization
- Scan history storage
- Camera/scanner data on the server
- Card detection results on the server
- Card embeddings on the server
- YOLO inference on the server
- Goldfishing/game simulation
- Marketplace transactions
- Payments
- Buyer/seller communication
- User profiles beyond username attribution
- Email address changing
- Google OAuth
- X/Twitter OAuth
- Scryfall-syntax advanced card search
- Importing decks by scraping other websites' URLs

The mobile sync/API design can be considered during architectural decisions, but actual mobile synchronization endpoints should not be implemented.

---

# Technology Stack

## Backend

- .NET 10, ASP.NET Core, C#
- Entity Framework Core + Npgsql
- PostgreSQL (JSONB where appropriate, `pg_trgm` for name search)
- UUIDv7 primary keys via `Guid.CreateVersion7()`
- ASP.NET Core Identity for accounts (password hashing, email confirmation, password reset, lockout) with cookie authentication. Expose our own small auth endpoints built on `UserManager`/`SignInManager`. Don't use `MapIdentityApi`, because it has no username support and its emails can't be customised.
- REST API under `/api`

## Frontend

- React + TypeScript + Vite single-page app
- Built to static files and **served by the ASP.NET app** (one deployable, same origin, so no CORS and no cross-site cookies)
- In development, the Vite dev server proxies `/api` to ASP.NET
- ASP.NET injects OpenGraph meta tags for public deck/binder URLs so shared links show previews (Discord, WhatsApp, etc.)

## Project Structure

    Code/
    ├── Deckino.App        (existing Expo app)
    ├── Deckino.Toolbox    (existing training/data tool)
    ├── Deckino.Api        (new: ASP.NET Core backend)
    └── Deckino.Web        (new: React frontend + Playwright E2E tests)

`Deckino.Api` is a single project organised by folders (e.g. `Features/Decks`, `Features/Binders`, `Catalogue`, `Data`). It is deliberately not split into Application/Domain/Infrastructure projects. Split it out only when a second consumer appears (a separate worker or the mobile API).

The frontend must never receive EF Core entities directly. Endpoints return DTOs.

`Deckino.Toolbox` already contains a `ScryfallClient` and a `BulkDataSyncService`. They sync `oracle_cards` and `unique_artwork` into SQLite. Port the reusable parts (bulk-data metadata, the `updated_at` up-to-date check, streaming download and parsing) into `Deckino.Api`. Do not port the schema, and do not create a shared library for this yet.

## Hosting

Production hosting will use Railway.

    Internet
       |
    Deckino service (ASP.NET Core: API + static website + background jobs)
       |
    Railway PostgreSQL

- No Docker Compose.
- A single Dockerfile for the Railway service is fine (it needs both Node to build the frontend and the .NET SDK).
- Local development runs PostgreSQL in a single Docker container (see `AGENTS.md`).

## Email

- Until Phase 14, no email is sent. Every account email (verification link, password reset link) is written to the API log instead, in every environment including Railway, where it is read from the service logs. This is acceptable only while the site lives on the unlisted Railway URL with no real users.
- Phase 14 sends real email through Mailgun's HTTP API (Railway restricts outbound SMTP on non-Pro plans), using Deckino's own HTML templates.
- Features send email through one small Deckino interface (e.g. `IAccountEmails`). Phase 4 implements it with the log, Phase 14 adds Mailgun, so no feature code changes when sending goes live.

## Scryfall Compliance

- Use the bulk data endpoints for the catalogue, not per-card requests.
- Send the required `User-Agent` and `Accept` headers, and respect the rate limits for any per-card calls.
- Hotlink Scryfall image URIs. Do not re-host images, crop off the artist/copyright line, or put Scryfall data behind a paywall.
- Include the Wizards of the Coast Fan Content Policy notice in the site footer.

---

# Core Product Concepts

Deckino has four user-owned concepts:

1. Account
2. Deck: cards the user wants to play
3. Binder: cards the user physically owns
4. Wishlist: cards the user wants to acquire

These are deliberately different concepts.

## Account

- Private email address
- Password hash (managed by ASP.NET Core Identity)
- Public username
- Account metadata

The username is the public identity displayed alongside public decks and binders. The email address must never be exposed through public APIs.

## Deck

- Has an owner, a name and a format
- Private by default; can be made public
- Contains commander / mainboard / sideboard sections, stored as JSONB
- Public decks are searchable and viewable by link
- Will eventually be used by the mobile app for goldfishing

Deck cards do NOT represent physical cards owned by the user.

## Binder

- Has an owner and a name
- Contains one row per physical card (no quantity column)
- Can contain unlimited cards
- `IsPublic`: private by default. A public binder is viewable by link but not searchable.
- `IsSelling`: marks the binder as cards the user is willing to sell. This does NOT make it public.

## Wishlist

- One wishlist per user, private
- Entries mean "I want X copies of this exact printing"
- No condition, foil, language, purchase info or notes

---

# Development Approach

Every phase must leave behind something visibly usable on the website. Avoid phases that are only invisible backend work ("create 14 tables, repositories, DTOs"). Frame each phase around a user-visible capability, and let the backend support it.

## Definition of Done (every phase)

Per the repo's `AGENTS.md` testing rules:

1. The phase's **Visible Milestone** is covered by Playwright E2E tests in `Deckino.Web`, run against the real API and a real local PostgreSQL.
2. The E2E run produces a repeatable artifact: the Playwright HTML report plus a screenshot of each milestone step.
3. Ownership and privacy rules introduced in the phase are covered by E2E tests in that same phase. For example, user B gets a 404 when opening user A's private deck. This is not left for the final hardening phase.
4. EF migrations apply cleanly to an empty database.
5. The phase is deployed to Railway and the milestone works there.
6. No unit tests are written after the fact. If a piece must be tested in isolation (e.g. the legality rules), list its failure modes first, then write the code.

E2E tests use a small checked-in Scryfall fixture (a few hundred cards) loaded through the same sync code path. They must never download the full bulk file.

The coding agent completes and verifies each phase before starting the next one.

---

# Phase 1: Project Foundation

## Goal

A real website running locally and on Railway, with the ASP.NET API connected to PostgreSQL.

## Tasks

- Create `Deckino.Api` (ASP.NET Core, EF Core, Npgsql) and `Deckino.Web` (React + Vite + TypeScript).
- Configuration via `appsettings` and environment variables. Railway provides `DATABASE_URL`/`PORT`.
- EF Core migrations, applied on startup.
- UUIDv7 key generation.
- Basic error handling (ProblemDetails) and logging.
- Health check endpoint (`/api/health`, including a database check).
- ASP.NET serves the built frontend, with SPA fallback routing.
- Site shell: header, navigation skeleton (grown phase by phase), footer with the Fan Content Policy notice.
- Playwright set up with a first E2E test and the artifact output.
- Dockerfile and Railway service plus PostgreSQL provisioned and deployed.

## Visible Milestone

- A user can open the Deckino website (locally and on Railway) and see the application shell.
- `/api/health` reports healthy, including the database.
- The first E2E test passes and produces its report and screenshot.

---

# Phase 2: Scryfall Card Catalogue

## Goal

Deckino's own MTG card catalogue in PostgreSQL, synced from Scryfall. The website never depends on live Scryfall requests for normal browsing.

## Important Principle

Each Scryfall printing is a distinct card record. Lightning Bolt from Alpha, Revised and Secret Lair are three records. The Scryfall ID identifies the exact printing. The Oracle ID groups printings of the same card.

## Source

- The Scryfall `default_cards` bulk file: one entry per printing, in English or the printing's only language (roughly 110k records, about 500 MB of JSON).
- The file must be **stream-parsed**, never loaded into memory whole. Scryfall publishes it as gzipped JSON Lines (`jsonl_download_uri`, about 80 MB), which is read line by line straight from the download.
- **Paper only:** printings with `digital: true` (Arena/MTGO-only, Alchemy, "A-" rebalanced cards) are skipped.
- Some layouts (e.g. `reversible_card`) have no top-level `oracle_id`. In that case, take the Oracle ID from the first face.

## Data

Store as proper columns the fields that are queried or displayed often: Scryfall ID, Oracle ID, name, language, release date, layout, mana cost, mana value, type line, oracle text, power/toughness/loyalty, colors, color identity, keywords, set code/name/type, collector number, rarity, artist, flavor text, legalities, image URIs (including per-face images for double-faced cards), `full_art`, `promo`, `digital`, `finishes`, and the Scryfall prices (`usd`, `usd_foil`, `usd_etched`, `eur`, `eur_foil`, `tix`).

Do not keep a raw-JSON column. Every sync re-reads the whole bulk file, so using a new Scryfall field only takes a migration, and the next sync fills it in. A raw copy would roughly double the catalogue's storage for no benefit.

Do not store images. The website hotlinks the Scryfall image URIs.

## Synchronization

A hosted background service in the API process:

- On startup, and then every ~4 hours, checks the bulk-data metadata. It downloads and imports only when `updated_at` has changed (Scryfall refreshes bulk files roughly twice a day).
- Streams the file into a temp table with binary `COPY`, then upserts it in one statement: inserts new printings and updates only rows that changed. The whole import is one transaction (about 10 seconds and 150 MB of memory for the full file).
- **Never deletes card rows.** Decks, binders and wishlists reference Scryfall IDs. A printing that disappears upstream is flagged, not removed.
- Is idempotent, safe to rerun and recoverable after failure. A failed run leaves the previous catalogue intact, and the next run retries.
- Records each run (start, end, counts, error) in a `CatalogueSyncRun` table and in the logs.
- Can also be triggered manually in development.

## Default Printing

When Deckino needs a printing for a card and the user hasn't chosen one, it picks the latest printing that is:

- English
- Not full art
- Not Secret Lair (`sld`)
- Not a promo, oversized card, token, art-series card or memorabilia

If nothing qualifies, it falls back to the latest printing of any kind.

The same rule is used everywhere a printing is needed but the user didn't choose one: deck builder, binders, wishlist and imports.

The default printing is computed once per Oracle ID during sync and stored. All features read it from there, so the rule lives in exactly one place.

## Card Search

- Name search using `pg_trgm`. Results are grouped by Oracle card, so 300 Forest printings show up as one result.
- Basic filters: color, type, set.
- Tokens and art-series cards are hidden by default.
- The card page lists every printing.

## Visible Milestone

The database contains the current Scryfall catalogue, and the website has a working card browser where users can:

- Search cards
- View card details, rules text, set, rarity and artist
- Switch between printings
- See the Scryfall image (both faces for double-faced cards)
- See prices where Scryfall provides them (USD by default, with a USD/EUR toggle remembered in the browser)

---

# Phase 3: Design System

## Goal

Give Deckino its visual identity and a small set of shared components, so every later phase builds pages from them instead of styling each page by hand. This comes before Accounts because that phase adds many new pages (registration, login, account settings, confirmation dialogs).

## Visual Direction

- Agree on the direction with the user before building: mood, reference sites, how bold or restrained. Use the `frontend-design` skill to explore it.
- Start from the existing brand: the dark theme, purple-to-pink gradient and logo shared with the Expo app (`Deckino.App/src/theme.ts`). The site and the app should feel like one product.
- Card images are the hero content. The design should frame them, not compete with them.

### Ideas From the Previous Version

The earlier ASP.NET MVC site (`D:\Random Projects\CardChowerzzz\Deckino.Web`, Tailwind + DaisyUI) is a source of ideas, not a template. The new design is made from scratch.

- Keep: the Bricolage Grotesque (display, wordmark) + Lexend (body) font pairing; the near-black background with purple/pink accents (the app's `theme.ts` is the source of truth); one restrained ambient gradient-orb background for hero and auth pages.
- For later phases: the deck page header with the commander's blurred art fading into the page, plus format badge, colour pips and value metrics (Phase 5; the catalogue stores Scryfall's `art_crop` image since Phase 3, where the card page header already uses it); a foil shimmer on foil cards (Phases 5 and 7); the floating 3D card (Phase 13's Commander of the Day); dashboard stat cards and quick actions (Phase 12); deck overview grouped by card type with gallery/list views (Phase 5).
- Leave behind: Tailwind from a CDN, DaisyUI and inline styles; invented stats ("10K+ collectors"); trade/marketplace and "local-first" claims; stacking several animated effects on one page.

## Foundations

- Design tokens as CSS custom properties: colours, type scale, spacing, radii, shadows and motion.
- UI library: [Mantine](https://mantine.dev) (MIT licence, free for commercial use). `@mantine/core` and `@mantine/hooks` now; `@mantine/form` and `@mantine/notifications` when a phase first needs them.
- One Mantine theme carries the brand: the purple/pink colour scales, fonts, radii and spacing, in dark mode. Deckino's own tokens are exposed through Mantine's CSS variables, so custom components use the same values.
- Theme it properly rather than shipping Mantine's defaults, so the site looks like Deckino, not like a stock Mantine site.
- Mantine provides the behaviour and accessibility of the interactive pieces (keyboard, focus, positioning). Deckino-specific styling uses plain CSS (CSS modules or a stylesheet per component); no CSS-in-JS library.
- Responsive from the start: every component works at phone width (360px) and desktop.
- Accessibility: AA contrast, visible focus styles, full keyboard use, labelled form controls, and `prefers-reduced-motion` respected.

## Components

From Mantine, themed: page layout (`AppShell`, with a burger menu at phone width), buttons, segmented controls (e.g. USD/EUR), form inputs with labels, hints and errors, panels, badges, alerts, skeletons and the confirmation modal (needed for destructive actions such as deleting an account). Later phases use its Combobox/Autocomplete (deck builder card search), Popover (printing picker), Menu, Tabs, Tooltip and notifications.

Deckino's own components, built on the theme, each with its states (hover, focus, loading, error):

- Card image (fixed aspect ratio, placeholder while loading, rounded like a real card, never cropped)
- Mana and card symbols (Scryfall's SVGs)
- Price display (currency formatting, "no price" state) and the remembered USD/EUR toggle
- Empty state and error state patterns

## Restyle Existing Pages

The site shell, card browser and card page from Phases 1–2 are rebuilt on the components. The card page gets the art header (the card's `art_crop`, added to the catalogue in this phase), with the card image rising into it. Their E2E tests keep passing, with selectors updated only where the markup has to change.

## Style Guide

An unlinked `/styleguide` page shows the themed Mantine components and Deckino's own components in every state. It holds no data, so it ships to Railway too, where the design can be reviewed live. The E2E run screenshots it at desktop and phone width. This is the phase's repeatable artifact, and the reference for later phases.

## Visible Milestone

The site has a finished, consistent look. The card browser and card page are rebuilt on the components and work at phone width, including the navigation menu. `/styleguide` shows the whole component set.

---

# Phase 4: Accounts and Authentication

## Goal

Users can create Deckino accounts and securely log into the website.

## Required Functionality

Implement on top of ASP.NET Core Identity (UUIDv7 `Guid` keys, cookie auth):

- Registration (email, password, username)
- Email verification, which must be completed before the user can log in, plus "resend verification link"
- Login / logout
- Password reset via an emailed link
- Change password
- Change username
- Delete account. This permanently deletes the user and all their decks, binders and wishlist. It is needed for POPIA/GDPR and is required by Google Play once the mobile app has accounts.
- Rate limiting on login, registration and password-reset endpoints
- Responses that do not reveal whether an email is registered (no account enumeration)

Do NOT implement: change email, Google login, X login, or actual email sending (Phase 14).

## Account Emails (log only)

- Verification and password-reset messages go through the account-email interface, whose only implementation for now writes them to the log with a fixed, searchable prefix (e.g. `ACCOUNT EMAIL`), including the recipient and the full link.
- Links are built from a configured public base URL (`App:BaseUrl`), not from the request, so a forged `Host` header can't point a reset link elsewhere.
- Tokens are Identity's own (time-limited, single-use for password reset). The log contains live tokens, so Railway log access is effectively account access until Phase 14 removes the log sender in production.

## Username Rules

- 3–20 characters, letters, digits, `_` and `-`
- Unique, case-insensitive
- A small reserved list (`admin`, `deckino`, `support`, …)
- Changing a username is allowed. Nothing links by username (URLs use IDs), so nothing breaks.

Email is unique and case-insensitive.

## Visible Milestone

A visitor can:

1. Register
2. Verify their email (the E2E test reads the link from the API log)
3. Log in
4. See their username/account area
5. Change their username and password
6. Log out
7. Reset their password
8. Delete their account

---

# Phase 5: Decks

## Goal

Logged-in users can create, edit, save, view and delete decks.

## Deck Properties

    Deck
    ├── Id (UUIDv7)
    ├── OwnerId
    ├── Name
    ├── Format
    ├── IsPublic (default false)
    ├── Cards (JSONB)
    ├── CreatedAt
    └── UpdatedAt

## Supported Formats

A hardcoded list of paper formats, mapped to Scryfall legality keys: Standard, Pioneer, Modern, Legacy, Vintage, Pauper, Commander, plus "Casual" (no format rules). Arena-only formats (Brawl, Historic, Timeless) are deliberately excluded. There is no dynamic format management.

## Deck JSON

    {
      "commander": [ { "scryfallId": "…", "quantity": 1, "finish": "nonfoil" } ],
      "mainboard": [ { "scryfallId": "…", "quantity": 4, "finish": "foil" } ],
      "sideboard": []
    }

- Mapped to strongly typed C# records.
- Entries reference Scryfall IDs only. Full card objects are never stored in the deck.
- `finish` is `nonfoil`, `foil` or `etched`, matching Scryfall's `finishes` and price fields. A plain foil boolean can't represent etched cards or price them correctly.
- An entry is identified by `(scryfallId, finish)` within its section. "4x Forest A" and "3x Forest B" are separate entries, and so are "2x Forest A" and "2x foil Forest A".
- Cards added without choosing a printing use the default printing.
- The commander section allows up to two entries (partners, backgrounds).
- Validated on save, because the request comes from outside the trust boundary: every Scryfall ID must exist, quantities must be 1–99, and the deck is capped at 500 total entries.
- Concurrent edits from two tabs: the last write wins. This is accepted.

## CRUD

Create, edit, delete (permanent, no recycle bin), get, and list the user's decks. Every endpoint checks ownership. Another user's private deck returns 404.

## Visible Milestone

A logged-in user can create a deck, choose a format, search and add cards, set quantities, choose printings, set a commander, add sideboard cards, save, reload, edit, and delete it. "My Decks" lists their saved decks.

---

# Phase 6: Deck Legality

## Goal

Show users whether their deck complies with its format, as warnings that never block saving.

## Approach

- Banned, restricted and not-legal status per format comes straight from the Scryfall `legalities` data on each card. It is not maintained by hand.
- Deckino adds only the construction rules, through a small per-format rule table: deck size, sideboard maximum, copy limit, and singleton.
- Copy limits count by **Oracle ID across all printings and finishes**, not by entry.
- Basic lands and "any number of cards named…" cards are exempt from copy limits. Restricted cards are limited to 1.
- Commander checks: the commander must be eligible, every card must fit the commander's color identity, the deck must be singleton, and it must be the exact deck size.
- Legality is computed when the deck is read, not stored. Ban-list changes that arrive through the Scryfall sync apply automatically.

## Visible Milestone

A user builds an invalid deck and immediately sees specific warnings (banned card, not legal in format, too many copies, wrong deck size, color identity violation). A valid deck shows as legal.

---

# Phase 7: Binders and Owned Cards

## Goal

Users manage digital records of their physical cards, and can share a binder by link.

## Model

    Binder                     BinderCard (one per physical card)
    ├── Id                     ├── Id
    ├── OwnerId                ├── BinderId
    ├── Name                   ├── ScryfallId
    ├── IsPublic (false)       ├── Condition (NM/LP/MP/HP/DMG)
    ├── IsSelling (false)      ├── Finish (nonfoil/foil/etched)
    ├── CreatedAt              ├── Language
    └── UpdatedAt              ├── Notes
                               ├── CreatedAt
                               └── UpdatedAt

- There is no quantity column. Four physical copies are four rows. This leaves room for per-copy data later (signed, altered, purchase price, sale info).
- `Language` is a label for the physical card. `ScryfallId` always points to the catalogue printing, which is English or the printing's only language. A Japanese Lightning Bolt from 2X2 is the 2X2 printing with `Language = ja`, and it is priced like the English one.
- The UI groups identical rows (same printing, finish, condition and language) and shows a count. "Add 4 copies" creates 4 rows.
- Cards can be moved between binders, singly or as a selection (e.g. into a Selling binder).
- If the user doesn't pick a printing, the card is added with the default printing.
- Users can have unlimited binders.
- Ownership is checked on every endpoint.

## Public Binders

- `/binder/{id}` is viewable by anyone **only when `IsPublic` is true**. Otherwise it returns 404.
- Public binders do not appear in any search.
- The page shows the binder name, owner's username, cards with exact printing, condition, foil and count. Value is added in Phase 10.
- Selling binders display a clear "Cards for sale by {username}" banner. There is no checkout, offers, orders, payment or shipping.

## Visible Milestone

A logged-in user can create and name a binder, add physical cards with exact printings, condition, finish and notes, edit and remove individual cards, move cards to another binder, mark it Selling, and make it public. A logged-out visitor can open the public link. Another user cannot open a private binder.

---

# Phase 8: Wishlist and Deck-vs-Collection

## Goal

Users track cards they want, and can see what a deck is missing from their collection.

## Model

    WantedCard
    ├── Id
    ├── OwnerId
    ├── ScryfallId
    ├── Quantity
    ├── CreatedAt
    └── UpdatedAt

Each user has one private wishlist, with one row per printing (unique on `OwnerId, ScryfallId`). The user can choose a specific printing. If they don't, the default printing is used.

## Deck Comparison

- "Compare with my collection" counts the user's physical cards across **all** of their binders, Selling binders included.
- A card counts as owned when **any printing** with the same Oracle ID is in a binder. A Revised Bolt covers an Alpha Bolt slot.
- Each deck is compared on its own. Cards are not allocated across multiple decks.
- The result shows owned and missing counts per card and in total (e.g. Owned 71 / Missing 29).
- "Add missing to wishlist" adds the deck's chosen printing with the missing quantity, merging with existing entries.

## Visible Milestone

A user manages their wishlist (add, change quantity, remove), compares a deck against their binders, and adds the missing cards to the wishlist in one click.

---

# Phase 9: Public Decks and Search

## Goal

Public decks become a searchable, shareable part of the site.

## Public Decks

Decks are private by default. A public deck can be viewed by anyone, shared by link (`/deck/{id}`, with OpenGraph preview tags), and found through search.

A public deck page shows the deck name, "by {username}", format, commander, card list with images and card info, approximate value (from Scryfall prices), and legality.

Email addresses are never exposed.

## Search

- Searchable by deck name (trigram) and filterable by format, with paging, newest updated first.
- Returns only public decks. This is covered by E2E tests.

Not included: card-content search, public binder search, profiles, followers, likes or comments.

## Visible Milestone

A logged-out visitor can search public decks, filter by format, open a deck, and see its cards, owner username, value and legality. A private deck cannot be viewed by another user and never appears in search.

---

# Phase 10: Price History and Values

## Goal

Price history, price movement, and collection values throughout the site.

## Provider

- Phase 2 already provides current prices from Scryfall, which sources them daily from TCGplayer (USD), Cardmarket (EUR) and MTGO (TIX). That is the first provider. It is an API, so there is no scraping.
- All value calculations read the current price through one function, so another provider (e.g. one with ZAR coverage) can be added later in one place.
- Only add a second provider if Scryfall's coverage proves insufficient.

## Snapshots

    CardPriceSnapshot
    ├── ScryfallId
    ├── Provider
    ├── Date
    ├── Usd, UsdFoil, UsdEtched
    ├── Eur, EurFoil
    └── Tix

- One row per printing per day, written after each daily sync, and only for printings that have a price.
- Rolling 90 days. A daily job deletes older rows. This is roughly 10M rows at steady state, so keep an eye on Railway storage.
- Prices are stored in their native currency and never converted and overwritten. Converted display (e.g. ZAR) can be added later.

## Values and Movement

- Deck, binder, collection (all binders) and wishlist values use the exact printing and finish (`usd` / `usd_foil` / `usd_etched`, or the EUR equivalents) where a price exists.
- Values are shown in USD by default, with a USD/EUR toggle remembered in the browser. TIX is not shown.
- 24h / 7d / 30d movement and percentage change per card.
- Significant movers in a user's binders, e.g. "Your binders are up $82 this week. Lightning Bolt +24%". Shown on the website only; no email or push notifications.

## Visible Milestone

Cards show a 90-day price chart. Decks, binders and the wishlist show their value. Users can see recent movers in their collection.

---

# Phase 11: Deck and Binder Import/Export

## Goal

Users can move decks and collections between Deckino and other MTG tools.

## Approach

- Each format is one parser/writer behind a small interface. Provider-specific parsing stays out of controllers and deck logic.
- Import flow: parse the file, resolve each card to a Scryfall ID (exact printing when set code and collector number are given, otherwise the default printing), carry over quantity and foil, then show a **review step** where unresolved cards can be fixed or dropped. The deck or binder is only created after the user confirms.
- An importer never invents metadata the source doesn't have. For example, a missing condition stays unset or uses the default.

## Initial Formats

- Decks: plain-text decklists (Arena/MTGO style, e.g. `4 Lightning Bolt (2X2) 117 *F*`), plus Moxfield and Archidekt export files.
- Binders: a CSV format from a common collection app (e.g. ManaBox or Deckbox), plus Deckino's own CSV.
- Import is from files or pasted text only. URL imports would require scraping other sites.

## Visible Milestone

A user can export a deck and a binder, import a deck from plain text and from at least one external provider's file, import a binder from CSV, and fix unresolved cards before completing the import.

---

# Phase 12: Dashboard and Polish

## Goal

Pull the features together into a coherent site.

Navigation has grown phase by phase since Phase 1. This phase adds the logged-in dashboard (My Decks, My Binders, Wishlist, collection value, recent price changes) and a pass, built on the Phase 3 design system, over layout, empty states, loading and errors, and mobile-width rendering.

    Deckino
    ├── Decks (My Decks, Browse)
    ├── Binders
    ├── Wishlist
    ├── Cards
    └── Account

There are no social features (profiles, feeds, comments, followers, likes).

## Visible Milestone

A logged-in user lands on a useful dashboard. Every page works at phone width.

---

# Phase 13: Landing Page and Commander of the Day

## Goal

The home page sells Deckino to visitors, and has something worth coming back to every day.

## Landing Page

- `/` is the landing page for logged-out visitors. Logged-in users land on their dashboard (Phase 12), and the landing page remains reachable from the footer.
- Sections: a hero with clear calls to action (create an account, browse cards); the features (scanning app, decks, binders, wishlist, prices, sharing); app store links once the app is published; and screenshots of the real site.
- Built from the Phase 3 design system. Fast to load: no large libraries, below-the-fold images lazy-loaded.
- OpenGraph tags, so a shared link to the home page shows a proper preview.
- A pricing section or page only once paid tiers exist. It would be display-only; payments stay out of scope.

## Commander of the Day

- One commander per UTC day, the same for every visitor, picked from Deckino's own catalogue: a default printing that is legal in Commander and eligible as a commander.
- Commander eligibility uses the same rule as the Phase 6 legality checks. It lives in one place.
- Deterministic: a stable hash of the date picks from the sorted eligible Oracle IDs, so nothing is stored and every instance agrees. Cached in memory for the day.
- `GET /api/commander-of-the-day` returns the card summary.
- The widget: the full card image floating gently and tilting in 3D towards the pointer (on touch screens, a gentle idle motion), with a light glare effect. A double-faced commander can flip to its back face. It links to the card page.
- Done with CSS 3D transforms, with no 3D library. With `prefers-reduced-motion`, the card is shown still.
- The whole card image stays visible. Scryfall's terms don't allow cropping off the artist and copyright line.

## Visible Milestone

A logged-out visitor sees the landing page with its features, calls to action and the Commander of the Day, which floats and tilts and opens the card page. The E2E tests check that the commander is commander-legal, the same across requests on the same day, and still under reduced motion.

---

# Phase 14: Email Delivery (Mailgun)

## Goal

Account emails reach real inboxes as branded HTML emails, and live tokens no longer appear in production logs.

## Prerequisites

- A custom domain (also see Open Decisions). Mailgun needs a verified sending domain (SPF, DKIM and its other DNS records), and the email links should use the custom domain instead of the Railway URL.
- A Mailgun account with that domain verified. Its API key is stored as a Railway variable, never in the repo.

## Sending

- A Mailgun implementation of the account-email interface from Phase 4, calling Mailgun's HTTP API (`/v3/{domain}/messages`) through `IHttpClientFactory`.
- Configuration: `Mailgun:ApiKey`, `Mailgun:Domain`, `Mailgun:BaseUrl` (the US or EU API region, matching where the domain was created), and the From address (e.g. `Deckino <no-reply@…>`).
- Mailgun is used when it is configured. Development and E2E keep the log implementation, so tests never send real email.
- In Production the API refuses to start without Mailgun configured. This guarantees that the log sender, and the live tokens it writes, are gone from production.
- Send failures are logged without the token and never change the response the user gets (no account enumeration). The user can retry with "resend verification link" or "forgot password".

## HTML Templates

- Deckino's own templates, checked into `Deckino.Api`: email verification and password reset, plus a shared layout with the Deckino logo, brand colours and the footer.
- Every email is sent as HTML and as a plain-text alternative.
- Built for email clients: table layout, inline styles, no external CSS or scripts, and images from the public site URL.
- Values inserted into templates (username, links) are HTML-encoded.
- A development-only preview endpoint renders each template with sample data. The E2E run screenshots each one, which is this phase's repeatable artifact.

## Visible Milestone

On Railway, registering with a real email address delivers a branded verification email, and "forgot password" delivers a branded reset email. Both links work. The production logs no longer contain account links or tokens. In development and E2E, emails are still logged, and the template previews are captured as screenshots.

---

# Phase 15: Production Hardening

## Goal

Prepare the platform for real users. Ownership and privacy rules are already enforced and E2E-tested from the phase that introduced them. This phase reviews and fills gaps.

## Security Review

- Authentication cookies (Secure, HttpOnly, SameSite) and CSRF protection
- Authorization and ownership on every endpoint
- Input validation and payload size limits
- Rate limiting beyond the auth endpoints
- XSS (user-provided names and notes are rendered safely)
- No sensitive data in public responses (email, internal fields)
- Security headers

Invariants (re-verified by E2E):

- User A can never modify or view User B's private decks or binders, or their wishlist.
- Public binders are accessible only when explicitly public.
- Public deck search returns only public decks.

## Reliability

- Structured logging
- Monitoring of Scryfall sync and price snapshots (via `CatalogueSyncRun`, with stale-sync detection on the health endpoint)
- Railway health checks
- Database backups, with one test restore
- Production error diagnostics

---

# Future Work (Explicitly Deferred)

## Expo Mobile Integration

The mobile app will eventually use the API (auth, local SQLite, offline-first, two-way sync, conflict handling, sync cursors, local catalogue sync). This will get its own planning phase. Do not create endpoints just because the mobile app will need them.

Known mismatch to solve in that phase: the scanner recognises artwork and returns an **Oracle ID**, not an exact printing, while binders store exact printings. Scanned cards would be added with the default printing, which may be wrong. That phase will likely add a `PrintingConfirmed` flag to `BinderCard` and a "confirm printing" step. Nothing needs to be built for this now.

## Goldfishing

Goldfishing is a future mobile/web feature. Decks already store enough data for it. Game state stays local unless multiplayer or saved games become requirements.

## Marketplace

Buyer/seller discovery, offers, transactions, payment, shipping, orders, ratings and marketplace search. Selling binders are the only groundwork in this project.

## Social Features

Profiles, followers, likes, comments, discussions and activity feeds.

## Possible Small Extensions

- A public wishlist link (sharing want lists for trades)
- Multiple wishlists
- A second pricing provider and ZAR display conversion
- A display-only pricing page, once paid tiers exist

---

# Architectural Principles

1. **PostgreSQL is the source of truth for online data.** Website → API → PostgreSQL. The frontend never accesses the database directly.
2. **Scryfall is the catalogue source.** Deckino keeps its own synced copy and never depends on live Scryfall calls for normal operation.
3. **User data and catalogue data are separate.** `Card` (catalogue) and `Deck` / `BinderCard` / `WantedCard` (user data) are distinct, and user records never duplicate card metadata.
4. **Exact printings matter.** User data references Scryfall IDs, never names. Rules that are about "the same card" (copy limits, collection comparison) group by Oracle ID.
5. **Physical cards are individual records.** There is no quantity column on `BinderCard`.
6. **Decks are JSONB,** strongly typed through C# records and validated on save.
7. **UUIDv7 everywhere.** No sequential IDs.
8. **Catalogue rows are never deleted.** User data depends on them.
9. **Delete means delete** for decks, binders and accounts. There is no recycle bin.
10. **Private by default.** Selling status never makes a binder public.
11. **Public decks are searchable, linkable and viewable without login. Public binders are linkable and viewable without login, but not searchable.**
12. **Do not build the mobile API yet.**

---

# Development Sequence

Progress tracker. Tick a phase (with the date) only once it meets the Definition of Done, including the Railway deploy.

- [x] 1. Website + API + database foundation (deployed). Done 2026-10-06
- [x] 2. Card catalogue + card browser. Done 2026-10-06
- [ ] 3. Design system (visual identity, components, restyle Phases 1–2)
- [ ] 4. Accounts
- [ ] 5. Deck builder
- [ ] 6. Deck legality
- [ ] 7. Binders + public binder links
- [ ] 8. Wishlist + deck-vs-collection
- [ ] 9. Public decks + search
- [ ] 10. Price history + values
- [ ] 11. Import/export
- [ ] 12. Dashboard + polish
- [ ] 13. Landing page + Commander of the Day
- [ ] 14. Email delivery (Mailgun + HTML templates)
- [ ] 15. Production hardening
- Future: Expo API + sync, goldfishing, marketplace

Each phase produces a clearly visible improvement to the website and meets the Definition of Done before the next one starts.

---

# Open Decisions (resolve when the phase arrives)

- Domain name (Phase 14: Mailgun's sending domain and the email links need it) and Railway plan
- Which collection app's CSV format to support first (Phase 11)
