# Plan: Wikidata merge-candidate app on Toolforge

## Goal

A full-stack web app that **finds, ranks, reviews, and (eventually) applies**
Wikidata merge candidates — pairs of items that look like duplicates of the same
real-world subject. It gives an editor a searchable, sortable list of candidate
pairs with a heuristic confidence score, a side-by-side comparison view per
candidate (labels / aliases / sitelinks / statements grouped into identical /
similar / distinct / one-sided, with merge **blockers** flagged), and background
jobs that keep a local mirror of the relevant Wikidata slice fresh and hunt it
for duplicates.

**Scope:** **video game items only for now.** The data model, sync jobs, and hunt
are deliberately built to scale to **all non-scholarly Wikidata items** in the
near future — the item scope is a query filter, not a structural assumption, so
widening it should be a data/config change rather than a rewrite.

## Platform & stack

Runs on **[Wikimedia Toolforge]** — the mission-appropriate, free home for a
Wikidata-editing tool, with first-class access to Wikimedia OAuth and a MariaDB
(ToolsDB) instance.

[Wikimedia Toolforge]: https://wikitech.wikimedia.org/wiki/Portal:Toolforge

- **Language/runtime:** TypeScript on **Node.js 24** (pinned via `engines.node`; CI and the Toolforge buildpack both read it).
- **Web server:** **Hono**, served with `@hono/node-server`. Serves the built SPA
  and mounts the JSON API under `/api`.
- **Client:** **React 19** single-page app, built with **Vite+** (`vp`), routed
  with react-router.
- **ORM / DB:** **Drizzle** on **MariaDB**. MariaDB is driven through Drizzle's
  **MySQL dialect** (`drizzle-orm/mysql-core` + `mysql2`) — there is no dedicated
  `mariadb` dialect, and MariaDB is wire/SQL-compatible with MySQL. ToolsDB now;
  a Trove MariaDB on Cloud VPS later if the full-graph data outgrows ToolsDB's
  soft cap. Staying on one dialect keeps that future move a data migration, not a
  rewrite.
- **SPARQL:** all Wikidata queries go through the **QLever** mirror
  (`https://qlever.dev/api/wikidata`), never WDQS — far faster, no query timeout.

(Migrated off Void/Cloudflare Workers + D1/SQLite; see the `migrate/toolforge`
branch history. MariaDB-specific notes — `utf8mb4_bin` collation, the custom JSON
column type, `datetime` handling — live in `CLAUDE.md`.)

## Repository layout

```
server/        Hono app (app.ts, index.ts) + routers (candidates, edits,
               actions, sync-routes); auth/ (OAuth login, sessions, tokens);
               the Wikidata edit client (wikidata-client.ts); the Drizzle
               handle (db.ts) + connection config (db-config.ts); shared sync
               write paths (*-sync.ts); the hunt (hunt.ts).
jobs/          Toolforge scheduled jobs (hunt.ts, sync-*.ts), run via node
               (native TS type-stripping) and declared in jobs.yaml.
db/            MySQL-dialect schema (schema.ts), seed script (seed.ts), and
               drizzle-kit migrations (migrations/).
src/           React SPA — pages/ (CandidatesList, CandidateDetail), the
               comparison UI (MergeCandidates.tsx), and DOM-free libraries in
               src/lib/ (compare + scoreCandidate, the dump→Item adapter in
               wikidata.ts, the QLever client in sparql.ts, the typed API
               client in client.ts).
```

## Data pipeline

1. **Seed** (`db/seed.ts`, a one-off Toolforge job in prod) — bulk-load the
   in-scope items from a Wikidata dump into `items` (+ their `external_ids`). This
   is the initial mirror; the dump omits descriptions, which a sync backfills.
2. **Sync jobs** (scheduled, `jobs/sync-*.ts` over the shared `server/*-sync.ts`
   write paths) keep the mirror useful:
   - `sync-properties` — every property's label, datatype, and formatter URL, so
     the UI shows names instead of bare `Pxxx` ids and turns external-id values
     into links.
   - `sync-entity-labels` — English (falling back to `mul`) labels for the items
     _referenced_ by our items' statements (genre, platform, developer, …).
   - `sync-descriptions` — English descriptions for our items (used in the
     comparison view and for merge-blocker detection).

   The two entity-oriented syncs **enumerate the QID set from our own DB** and
   look values up in chunked `VALUES` queries — this is the pattern that keeps
   them O(n) and safe when the item scope widens (the old "let QLever derive the
   set" queries timed out).

3. **Hunt** (`jobs/hunt.ts` → `server/hunt.ts`, nightly) — scan → block → score →
   upsert in a single pass: group items into blocking buckets (shared external
   ids, matching labels/types), score each candidate pair with the heuristics in
   `src/lib/compare.ts`, and upsert into `merge_candidates`. A guard leaves
   human-resolved rows (`dismissed` / `merged`, or one mid-`merging`) untouched
   on re-run.
4. **Review** (the SPA) — browse/filter/sort candidates, open a pair to compare,
   dismiss false positives (dismissals persist across re-hunts).
5. **Apply** — perform the actual merge (`wbmergeitems`), or record a
   "different from" (P1889) claim, on Wikidata on the logged-in editor's
   behalf (`server/edits.ts` over `server/wikidata-client.ts`), with an audit
   row per attempt in `wikidata_edits`.

## Authentication — Wikimedia OAuth

Login is **through Wikimedia OAuth 2.0**, so that:

- only authenticated Wikimedia editors can resolve candidates, and
- **merge actions are performed on the logged-in user's behalf**, under their own
  account and edit history — never a shared bot/service account.

This is the gate for step 5 of the pipeline: the app holds each user's OAuth
grant (encrypted at rest) and uses it to call the Wikidata Action API
(`wbmergeitems`, `wbcreateclaim`) as that user. Toolforge is a supported OAuth
consumer environment, which is part of why it's the deployment target. See
README "Authentication" and "Editing Wikidata" for the consumer setup, the
merge semantics (conflict overrides are opt-in per kind, the candidate takes a
`merging` claim so it can't be submitted twice), and the audit trail.

## ML / LLM-assisted evaluation (planned, advisory-only)

The hunt's confidence score is hand-written heuristics. A later assist is an
**ML model or LLM that evaluates a candidate pair** — judging how likely two
items are the same subject, to **re-rank** candidates and **automatically discard
obvious false positives** before they reach the human review queue.

Hard constraint: this is **strictly advisory**. It augments the heuristic score
and prunes noise; it **never acts on a user's behalf and never writes to
Wikidata**. Every actual merge still goes through a human via OAuth (see above).
The model's failure modes are all recoverable — a wrong "reject" only hides a
candidate, a wrong "keep" only leaves one for a human to dismiss — so it stays a
best-effort filter, degrading gracefully (fall back to the heuristic score) when
unavailable, and is never a hard gate on its own.

Where the model runs — options, cheapest first:

- **Wikimedia LiftWing hosted LLMs** — LiftWing (the ML serving platform /
  ORES successor) now hosts general open-weight LLMs (Qwen3-class) behind an
  OpenAI-compatible API at `api.wikimedia.org`, **free and effectively unlimited
  from Toolforge**. The strongest first thing to prototype: no cost, already
  reachable from where we run, standard client. Caveat: **experimental, no SLA,
  endpoints may change** — hence advisory-only and graceful-degradation above.
  Note: LiftWing's _pre-hosted_ model catalog is **not** usable here — it's all
  revision/article scoring (revert-risk, article-quality, …); `revertrisk-wikidata`
  is edit-vandalism detection on a revision, **not** item-pair matching. And
  hosting a custom dedup model on LiftWing is a heavy, WMF-reviewed process, not
  worth it for this.
- **External LLM API** (Claude / OpenAI) from the job/server — stronger and more
  stable than the experimental open models, at a per-call cost.
- **Embedding-based similarity** on labels/descriptions as a cheap local
  pre-filter, with or without an LLM on top.

## Evaluation datasets (needed)

To measure and improve merge-detection accuracy — for the heuristic scorer now
and any ML/LLM assist later — we need **labelled ground-truth pairs**, both
positive and negative. These drive precision/recall metrics, model
training/eval, and regression tests so a scoring change can be judged against a
fixed benchmark instead of by eyeballing.

- **Positive set — pairs that are/were duplicates:**
  - **Already-merged items.** A Wikidata merge turns the merged-away item into a
    **redirect** to the surviving item, so historical merges are mineable: collect
    redirected QIDs and their targets (with the pre-merge revision recoverable
    from history for a realistic "how it looked before merge" example). This is
    the largest, cheapest source of true positives.
  - **Active dupes found on live Wikidata** — pairs the maintainer spots that
    genuinely should be merged but haven't been. Smaller, hand-curated, but
    valuable current examples.
- **Negative set — pairs that are NOT duplicates:** confirmed-distinct items,
  weighted toward **hard negatives** — pairs that _look_ mergeable (same
  label/type, shared blocking bucket) but are genuinely different subjects: two
  different games sharing a title, an original vs. its remake/remaster, a series
  vs. one entry, a game vs. its soundtrack/DLC. Easy negatives (unrelated items)
  teach the model little; the hunt's own **dismissed** candidates are a natural,
  continuously-growing source of exactly these hard negatives.

Store these as a versioned, checked-in fixture (QID pairs + label + provenance),
kept scope-appropriate as the item scope widens. Beware leakage/bias: the
already-merged positives skew toward "mergers editors actually found," so pair
them with the hard negatives above so the benchmark rewards precision, not just
recall.

Tooling for the positive set exists: `scripts/fetch-merge-pairs.ts`
(`pnpm eval:fetch-pairs Qxxx …`) takes any QID touched by a merge, reads the
`wbmergeitems-to/from` audit trail to resolve the (source, target) pair, and
saves both items' **pre-merge** full entity blobs plus a `meta.json` (labels,
pinned revids, who/when merged) under `eval-data/merged-pairs/`. Pinning the
revision is essential — a now-redirected item fetched at HEAD silently resolves
to its merge target. The negative set still needs building (seed it from
dismissed candidates).

## Deployment (Toolforge)

- **Web service:** the Build Service (Cloud Native Buildpacks, Node) —
  `toolforge webservice buildservice start`. Serves at `<tool>.toolforge.org`.
- **Jobs:** `jobs.yaml` (`toolforge jobs load`) declares the scheduled
  `sync-properties` / `sync-entity-labels` / `sync-descriptions` (weekly) and
  `hunt` (nightly, with extra memory/CPU), plus a one-off seed/initial-load job.
  Set the Build Service `image` name in `jobs.yaml` before loading.
- **DB:** a ToolsDB database created with the **`utf8mb4_bin`** collation,
  connected with the tool's `replica.my.cnf` credentials.

## Roadmap

- [x] Core app: schema, seed, sync jobs, hunt, review SPA — migrated to
      Node/Hono/Drizzle+MariaDB and verified locally.
- [ ] Deploy to Toolforge (build service, ToolsDB, load `jobs.yaml`, one-off seed).
- [x] **Wikimedia OAuth** login (sessions, encrypted token storage, gated routes).
- [x] Apply-merge / "different from" edits on the user's behalf (issue #5).
- [ ] Widen the item scope beyond video games toward all non-scholarly items.
- [ ] **ML/LLM-assisted, advisory-only** candidate evaluation (re-rank + auto-drop
      obvious false positives); prototype on LiftWing's free hosted LLMs first.
- [ ] **Labelled eval datasets** — positive pairs (mined from Wikidata merge
      redirects + hand-found live dupes) and hard negatives (confirmed non-dupes,
      seeded from dismissed candidates) for accuracy metrics, training, and tests.
