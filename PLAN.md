# Plan: Wikidata merge-candidate app on Void

## Context

The repo (`mergers-and-acquisitions`, formerly "wikidata-merge-viewer") is currently a
**client-only** Vite+ / React 19 / TS 7 app. Its single page, `src/MergeCandidates.tsx`,
compares two Wikidata items and groups their labels/aliases/sitelinks/statements into
identical / similar / distinct / one-sided, flagging merge **blockers** — but only over
hand-authored dummy data (`EXAMPLES`). There is no database, no Wikidata fetching, no
candidate detection, and no merge-applying.

The goal is a real app that **finds, ranks, reviews, and (eventually) applies** Wikidata
merge candidates: a searchable/filterable/sortable list of candidate pairs with heuristic
confidence, a detail view per candidate (the existing comparison UI, on real data), and
background jobs that sync Wikidata and hunt for duplicates. OAuth (login with Wikidata)
and applying merges via [`wbmergeitems`](https://www.wikidata.org/w/api.php?action=help&modules=wbmergeitems)
come **last**.

### Decisions (confirmed with the user)

- **Backend/platform:** [Void](https://void.cloud/) — VoidZero's full-stack SDK + deploy
  platform for Vite apps, on Cloudflare. Gives us D1 database, queues, cron, KV, storage,
  auth (Better Auth), and file-based server routes, auto-provisioned from source.
- **Scope (first build):** video games (`P31 = Q7889`), matching the existing dummy data.
- **Database:** D1 (SQLite) via Drizzle — Void's zero-config default. Escape hatch to
  Postgres later is a `void.json` change (`"database": "pg"` + Hyperdrive).
- **Sequencing:** end-to-end skeleton first (scaffold → shared heuristics → DB → sync →
  hunt → list/detail on real data); OAuth + `wbmergeitems` are a later phase.

## Void SDK conventions (reference)

- **Server routes:** `routes/**/*.ts`, file→URL mapping, `[id]` params, `[...x]` catch-all.
  Export `GET`/`POST`/… via `defineHandler` from `void`; validation via
  `defineHandler.withValidator({...})` (Standard Schema). Middleware in `middleware/NN.name.ts`.
- **DB:** `import { db, eq, and, or, desc, like, inArray } from 'void/db'`; schema in
  `db/schema.ts` (barrel over `db/schema/`) using `sqliteTable/text/integer` from
  `void/schema-d1`; import tables from `@schema`. Migrations in `db/migrations/*.sql` via
  `void db generate` / `void db migrate` / `void db push` / `void db reset` / `void db status`.
- **Cron:** `crons/<name>.ts` → `export default defineScheduled(async (controller, env, ctx) => {…})`.
- **Queues:** `queues/<name>.ts` → `export default defineQueue<T>(async (batch, env) => {…})`.
- **Client:** `import { fetch } from 'void/client'` for type-safe API calls.
- **Auth (later):** Better Auth; config in `void.json` `auth` or `auth.ts` `defineAuth(...)`;
  server helpers `requireAuth/getUser/getSession` from `void/auth`; routes at `/api/auth/*`.
- **Deploy (later):** `void deploy` (Void-hosted or `--backend cloudflare`).

## Target directory layout

```
routes/api/candidates/index.ts        GET list (search/filter/sort/paginate)
routes/api/candidates/[id].ts          GET candidate + both items
routes/api/candidates/[id]/dismiss.ts  POST mark not-a-duplicate
routes/api/candidates/[id]/merge.ts    POST apply merge        (LATER: OAuth phase)
routes/api/sync.ts                     POST manual sync trigger (dev convenience)
db/schema.ts                           Drizzle schema (items, external_ids, merge_candidates, sync_state)
db/migrations/*.sql                    generated
crons/sync-wikidata.ts                 discover in-scope QIDs (SPARQL), enqueue fetches
crons/hunt-candidates.ts               periodic duplicate hunt (or trigger after sync)
queues/fetch-entities.ts               fetch entity JSON → map → upsert
queues/hunt-candidates.ts              score candidate pairs → upsert merge_candidates
src/lib/compare.ts                     EXTRACTED heuristics (isomorphic, shared by server+UI)
src/lib/wikidata.ts                    entity fetch, SPARQL, JSON→Item adapter, (later) wbmergeitems
src/pages/CandidatesList.tsx           list page
src/pages/CandidateDetail.tsx          detail page (wraps existing comparison view)
void.json                              Void project config
```

## Phase 0 — Scaffold Void + client routing

- Install the `void` CLI (verify: global npm, dev-dep, or `vpx void`; no `void` pkg present now).
- Create `void.json` (project name, database D1 default). Confirm local dev integrates with
  `vp dev` (Void defers dev to Vite; check `void`'s dev/preview story on first run).
- Add `react-router-dom`; wrap `src/main.tsx` with a router: `/` → list, `/candidates/:id` → detail.
- Keep the app building/green at every step (`vp check`, `vp test`, `pnpm build`).

## Phase 1 — Extract shared heuristics (pure refactor, no behavior change)

Move from `src/MergeCandidates.tsx` into **`src/lib/compare.ts`** (must stay DOM-free so
`routes/`, `queues/`, `crons/` can import it too):

- Types: `ValueType`, `Value`, `Item`, `Status`, `RowStatus`, `AnnotatedValue`, `Row`
  (`MergeCandidates.tsx:5-41`), plus `PROPERTY_LABELS` (`:45-69`).
- Functions: `normalize` (`:224`), `levenshtein` (`:233`), `stringSimilarity` (`:250`),
  `compareValues` (`:259`), `compareSets` (`:290`), `buildRows` (`:319`), `orderByAge` (`:478`).
- **New:** `scoreCandidate(a: Item, b: Item): { confidence: number; reasons: string[]; hasBlocker: boolean }`
  — builds on `buildRows`/`compareSets`. Confidence signals (highest→lowest):
  shared external-id value (very strong) → identical normalized label + same `P31` →
  high label/alias similarity + overlapping statements; subtract for description/sitelink
  blockers (already modeled by `Row.blocker`). Returns a 0–1 score + human-readable reasons.
- `MergeCandidates.tsx` now imports from the lib and takes `from`/`into` `Item`s as props;
  keep `EXAMPLES` moved to a fixtures module for tests + a dev story.
- Add **Vitest** unit tests (`src/lib/compare.test.ts`) using the former `EXAMPLES` as
  fixtures (also gives CI's `vp test` real tests to run).

## Phase 2 — Database schema + migrations

`db/schema.ts` (D1/SQLite via `void/schema-d1`):

- `items`: `qid` PK, `primaryLabel`, `primaryType` (P31 QID), `data` (JSON text = mapped
  `Item`), `lastSyncedAt`. Index on `primaryLabel`.
- `external_ids`: `qid`, `property`, `value`; index on `(property, value)` — the blocking
  key for shared-ID duplicate detection.
- `merge_candidates`: `id` PK, `fromQid`, `intoQid`, `confidence` (real), `status`
  (`open`/`dismissed`/`merged`), `reasons` (JSON), `hasBlocker`, `detectedAt`, `resolvedAt`,
  `resolution`; unique `(fromQid, intoQid)` (store the ordered pair via `orderByAge`).
- `sync_state`: scope type (`Q7889`), cursor/offset, `lastRunAt`.
- Generate + apply: `void db generate` → `void db migrate`; commit `db/migrations/*.sql`.

## Phase 3 — Wikidata adapter + sync jobs (real data in)

**Use QLever, not WDQS**, for SPARQL — dramatically faster, no query timeout, mirror tracks
Wikidata within hours. Port the proven patterns from **vglist** (see Reference below).

`src/lib/wikidata.ts`:

- **SPARQL client:** endpoint `https://qlever.dev/api/wikidata` (override via env
  `WIKIDATA_SPARQL_ENDPOINT`, WDQS `https://query.wikidata.org/sparql` as fallback). POST,
  `Content-Type: application/x-www-form-urlencoded` with `query=…`, `Accept:
application/sparql-results+json`. **QLever requires explicit `PREFIX` declarations on every
  query** (wd/wdt/p/ps/wikibase/rdfs/schema/skos) — WDQS injects them, QLever does not. Avoid
  Blazegraph-only features (`wikibase:label` service, named subqueries). Descriptive
  **User-Agent** with optional contact email (Wikimedia policy). ~1s inter-query delay; 429
  exponential backoff (4/8/16/32s); retry transient network errors.
- `queryScopeQids(offset, limit)` — driver population: `VALUES ?t { wd:Q7889 wd:Q21125433 }`
  (video game + free/libre video game), `?item wdt:P31 ?t; rdfs:label ?l.
FILTER(lang(?l)="en"||lang(?l)="mul")`, `ORDER BY ?item LIMIT/OFFSET` (paged; stable/disjoint).
- `hydrateChunk(qids)` — chunked (~250) via `VALUES ?item { wd:Q… }`:
  - **statements + external-ids in one query** using `?item ?propUrl ?value. ?prop
wikibase:directClaim ?propUrl.` — restricts to real `Pxxx` direct claims, dropping
    rdfs:label/schema:*/owl:sameAs noise. Parse value nodes: entity URI → item `Value`;
    literals → string/time/quantity/url/external-id by datatype; skip "unknown value" bnodes.
  - labels (en + `mul` via OPTIONAL + SAMPLE + GROUP BY), and — since the comparison UI needs
    them for blocker/cross-match detection — descriptions (`schema:description`), aliases
    (`skos:altLabel`), and sitelinks (`schema:about`/`schema:isPartOf`), at least for a small
    language set (en). (If pulling all of these via SPARQL proves heavy, fall back to
    `Special:EntityData/<QID>.json` to enrich a specific pair on demand.)
- `mapToItem(...)` — assemble the hydrated rows into the simplified `Item` model; map property
  values to `Value` with human labels resolved for item values.
  `crons/sync-wikidata.ts` (`defineScheduled`): page `queryScopeQids`, diff vs `items`, enqueue
  QID **chunks** to `queues/fetch-entities.ts`. (Cron enumerates; queues hydrate — this keeps
  each Worker invocation short and provides natural pacing/retry across messages.)
  `queues/fetch-entities.ts` (`defineQueue<{ qids: string[] }>`): `hydrateChunk` → `mapToItem`
  → upsert `items` + rebuild `external_ids`. One chunk ≈ one or two QLever POSTs; size chunks to
  stay within Worker CPU/subrequest limits.
  `routes/api/sync.ts` POST: manual trigger for local dev.

### Reference: vglist (`/Users/connorshea/code/vglist`)

- `lib/wikidata_sparql.rb` — QLever endpoint config, PREFIXES, POST client, 1s delay, 429
  backoff, WDQS env fallback. Mirror this in `wikidata.ts`.
- `script/dump_wikidata_games.rb` — the exact driver query (`Q7889`/`Q21125433`, en/`mul`
  label, paged), chunked `VALUES` hydration via `wikibase:directClaim`, value-node parsing,
  and network-retry/backoff. The template for `queryScopeQids`/`hydrateChunk`.
- Also: `lib/tasks/import/wikidata_import.rake`, `script/find_stale_wikidata_ids.rb`.

## Phase 4 — Candidate-hunting job

`queues/hunt-candidates.ts` (+ `crons/hunt-candidates.ts` to schedule it):

- **Blocking** to avoid O(n²): candidate pairs come from shared `external_ids` rows and
  from normalized-label + same-`primaryType` groups.
- For each pair, load both `items.data`, run `scoreCandidate`, upsert into `merge_candidates`
  (skip pairs already `dismissed`/`merged`). Store confidence, reasons, blocker flag.

## Phase 5 — API routes + frontend on real data

- `routes/api/candidates/index.ts` GET: query params `q` (label search), `status`,
  `minConfidence`, `sort` (`confidence`|`detectedAt`), pagination; Drizzle query.
- `routes/api/candidates/[id].ts` GET: return the candidate + both `Item`s; client renders
  via `buildRows`.
- `routes/api/candidates/[id]/dismiss.ts` POST: set `status='dismissed'`.
- `src/pages/CandidatesList.tsx`: table with search box, status filter, confidence sort,
  confidence badges, blocker indicator; links to detail. Uses `void/client` `fetch`.
- `src/pages/CandidateDetail.tsx`: fetch the pair, render `<MergeCandidates from into />`,
  add a "Dismiss" action; "Apply merge" button stubbed/disabled until Phase 6.

## Phase 6 — LATER: OAuth + apply merge (deferred, per user)

- Log in with Wikidata via Better Auth. **Risk:** Void docs only list built-in social
  providers (google/github); Wikidata/MediaWiki OAuth2 will likely need Better Auth's
  generic-OAuth mechanism via `auth.ts` `defineAuth(...)` — needs a short spike.
- `routes/api/candidates/[id]/merge.ts` POST: server-side call to `wbmergeitems` using the
  user's stored OAuth token (fetch CSRF token first; honor `Row.blocker` → require explicit
  `ignoreconflicts` opt-in); on success set `status='merged'`, `resolution`, `resolvedAt`.

## Phase 7 — LATER: reject a match by writing "different from" (needs OAuth)

Dismissing a candidate today only sets `status='dismissed'` locally, so the same pair can be
re-proposed elsewhere and by other editors. Add a stronger **"reject as not a duplicate"**
action that, using the logged-in user's OAuth token (so it depends on Phase 6), writes a
**`different from` (P1889)** statement on **both** items pointing at each other via
`wbcreateclaim` (or `wbsetclaim`). That makes the distinction the source of truth on Wikidata
itself, so the hunt job (which already reads P1889 in `scoreCandidate` → `isDeclaredDifferent`
and zeroes such pairs) will never resurface them — for us or anyone else. On success set
`status='rejected'` (or reuse `dismissed`) with `resolution` noting the P1889 edits. Honor
Wikidata etiquette: skip if a P1889 link already exists; batch the two edits; surface API
errors to the user.

## Phase 8 — LATER: gate the sync/hunt triggers

The list header's **"Run hunt"** and **"Sync property names"** buttons (and the
`POST /api/hunt`, `POST /api/properties/sync` routes) currently have no access control — anyone
hitting the deployed app could kick off background jobs. Once auth exists (Phase 6), make these
**admin-only** (or at least **dev-mode-only**, e.g. hidden/return 403 unless a `DEV`/role check
passes). The nightly/weekly crons remain the normal trigger in production; the buttons are a
convenience for privileged users.

## Risks / open items

- `void` CLI install path + how `void` local dev composes with `vp dev` — resolve in Phase 0.
- QLever/Wikidata etiquette: descriptive User-Agent, ~1s pacing, 429 backoff; QLever needs
  explicit PREFIXes and lacks Blazegraph extensions. WDQS is the env-switch fallback.
- Cloudflare Worker limits (CPU time, subrequest count) constrain queue chunk sizes — the
  cron-enumerates / queue-hydrates split keeps each invocation short.
- D1 ~10GB ceiling — fine for a curated video-game subset; Postgres is the escape hatch.
- Better Auth ↔ Wikidata OAuth is the least-certain piece (Phase 6, deferred).

## Verification

- `vp check` (fmt/lint/typecheck) and `vp test` green after each phase; `pnpm build` succeeds.
- Unit tests: `src/lib/compare.test.ts` proves the extraction is behavior-preserving and
  that `scoreCandidate` ranks known dup fixtures high and distinct pairs low.
- DB: `void db generate` + `void db migrate`, then inspect tables; trigger `POST /api/sync`
  locally and confirm `items`/`external_ids` populate.
- Hunt: run the hunt job; confirm `merge_candidates` rows with sensible confidence on known
  duplicate pairs and that blockers are flagged.
- UI: list page search/filter/sort works against real data; detail page renders the
  comparison from real items; dismiss updates status.
- Follow repo `CLAUDE.md`: `vp install` after pulling, `vp check` + `vp test` before done;
  commit migrations.
