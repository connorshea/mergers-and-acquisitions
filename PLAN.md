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

- **Language/runtime:** TypeScript on **Node.js** (>= 20).
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
server/        Hono app (index.ts) + routers (candidates, actions, sync-routes);
               the Drizzle handle (db.ts) + connection config (db-config.ts);
               shared sync write paths (*-sync.ts); the hunt (hunt.ts).
jobs/          Toolforge scheduled jobs (hunt.ts, sync-*.ts), run via tsx and
               declared in jobs.yaml.
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
   human-resolved rows (`dismissed` / `merged`) untouched on re-run.
4. **Review** (the SPA) — browse/filter/sort candidates, open a pair to compare,
   dismiss false positives (dismissals persist across re-hunts).
5. **Apply** (future — see below) — perform the actual merge on Wikidata on the
   logged-in editor's behalf.

## Authentication — Wikimedia OAuth (planned)

Log in to the service **through Wikimedia OAuth**, so that:

- only authenticated Wikimedia editors can review candidates, and
- **merge actions are performed on the logged-in user's behalf**, under their own
  account and edit history — never a shared bot/service account.

This is the gate for step 5 of the pipeline (applying merges): the app holds each
user's OAuth grant and uses it to call the Wikidata Action API (e.g.
`wbmergeitems`) as that user. Toolforge is a supported OAuth consumer environment,
which is part of why it's the deployment target. Until this lands the app is
review-only (find / rank / compare / dismiss); nothing writes back to Wikidata.

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
- [ ] **Wikimedia OAuth** login + apply-merge on the user's behalf.
- [ ] Widen the item scope beyond video games toward all non-scholarly items.
