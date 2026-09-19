# M&A: A Wikidata Merge Assistant

![M&A: A Wikidata Merge Assistant](screenshot.png)

Compares two Wikidata items and groups their labels, aliases, sitelinks and
statements into identical / similar / distinct / one-sided, flagging anything
that would block a merge. Currently runs on dummy data in
`src/MergeCandidates.tsx` (`EXAMPLES`).

## Toolchain

React 19 + TypeScript 7 SPA on the [Vite+](https://viteplus.dev) unified toolchain
(the `vp` CLI), a [Hono](https://hono.dev) (Node) API server, and
[Drizzle](https://orm.drizzle.team) on **MariaDB**. Managed with
[pnpm](https://pnpm.io); designed to run on [Wikimedia Toolforge](https://wikitech.wikimedia.org/wiki/Help:Toolforge).

## Development

Needs a local MariaDB. On macOS:

```sh
brew install mariadb && brew services start mariadb
# Homebrew MariaDB uses unix_socket auth for root, so connect as your own user
# (no -u root). The utf8mb4_bin collation is required — see the note below.
mariadb -e "CREATE DATABASE mergers CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
  CREATE USER 'mergers'@'localhost' IDENTIFIED BY 'mergers';
  GRANT ALL ON mergers.* TO 'mergers'@'localhost';"
```

The database is created with the **`utf8mb4_bin`** collation (not the usual
`utf8mb4_unicode_ci`): every string column inherits it, so comparisons are exact
(case- and accent-sensitive). This is correct for external identifiers — two IDs
that differ only in case are genuinely different — and restores the binary
comparison the original SQLite schema used. Candidate search still folds case,
because it lowercases both sides explicitly (`lower(primary_label) LIKE …`). On
Toolforge, create the ToolsDB database with the same `COLLATE utf8mb4_bin`.

```sh
cp .env.example .env   # local DB defaults match the setup above
pnpm install
pnpm db:migrate        # apply migrations
pnpm seed              # seed from seed-data/wikidata_games.json (SEED_LIMIT=2000 for a slice)
pnpm dev               # Vite SPA (proxying /api) + the Hono server on :8000
```

## Commands

```sh
pnpm build             # build the SPA to dist/client (vp build)
pnpm start             # run the production server (serves API + dist/client)

pnpm db:generate       # generate a migration from db/schema.ts (drizzle-kit)
pnpm db:migrate        # apply pending migrations
pnpm seed              # load the dump into the DB

pnpm job:hunt          # run the duplicate-candidate hunt once
pnpm job:sync-properties / :sync-entity-labels / :sync-descriptions
pnpm job:prune-sessions # delete expired login sessions
```

Formatting, linting, testing, and type-checking go through the `vp` CLI directly:

```sh
vp check       # format, lint, and type-check in one pass
vp test        # run tests with Vitest (DB-backed tests are skipped unless DB_TEST=1)
```

### DB-backed tests

The `*.db.test.ts` files under `server/` exercise the API routes and the hunt
against a real MariaDB. They are skipped by default because they **truncate
every table** between tests. To run them, point them at a dedicated database
(the name must contain `test`; the migrations are applied automatically):

```sh
mariadb -e "CREATE DATABASE test_mergers CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;"
DB_TEST=1 DB_NAME=test_mergers vp test
```

(The `mergers` user created above can already create `test_*` databases.) CI runs
them against a MariaDB service container, together with a from-scratch migration
run and a schema-drift check — see `.github/workflows/ci.yml`.

## Authentication

Login is **Wikimedia OAuth 2.0** (authorization code + PKCE, confidential
client). Anyone can browse candidates; dismissing/reopening needs a login, and
the hunt / reset / sync triggers are limited to the user ids in `ADMIN_USERS`.
Merges (when they land) run under the logged-in user's own account. With none of
the `OAUTH_*` variables set the app runs read-only and the login link is hidden.

1. Register a consumer at
   [Special:OAuthConsumerRegistration/propose/oauth2](https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose/oauth2)
   on meta.wikimedia.org: OAuth 2.0, **not** owner-only, callback URL exactly
   `<BASE_URL>/api/auth/callback`, applicable projects `wikidatawiki` (and
   `testwikidatawiki` for dev), grants "Basic rights" + "Edit existing pages".
   Consumers that request edit grants are approved by hand, which can take a few
   days; an owner-only consumer works for the owner immediately in the meantime.
2. Set the variables listed under `# --- authentication` in `.env.example`
   (`.env` locally; `toolforge envvars create` on Toolforge). `SESSION_SECRET`
   signs the login-state cookie; `TOKEN_ENC_KEY` encrypts the stored OAuth
   tokens; `BASE_URL` is the public origin (cookies are `Secure` iff https).
3. Put your own central user id in `ADMIN_USERS` to see the hunt/maintenance
   controls.

Session cookies are `HttpOnly; SameSite=Lax`, the DB stores only their hash, and
state-changing API calls must carry a same-origin `Sec-Fetch-Site`/`Origin`. The
nightly `prune-sessions` job deletes expired sessions.

## Deploying to Toolforge

Build the image (`toolforge build`), apply migrations and seed as one-off jobs,
start the web service (`toolforge webservice buildservice start`; runs the
`Procfile` `web` process), and load the schedule with `toolforge jobs load
jobs.yaml` (set the image name in `jobs.yaml` first). The DB is a ToolsDB MariaDB
database, created with `CHARACTER SET utf8mb4 COLLATE utf8mb4_bin` (see the
collation note above); connection details come from the tool's credentials via
the `DB_*` env vars.

The server checks the schema before it binds its port (`server/preflight.ts`):
if the database has fewer migrations applied than `db/migrations` contains, it
logs `DB schema is behind: N migrations in db/migrations, M applied.` and exits
with status 1, so run the migrate job before (re)starting the web service after a
deploy that adds a migration. An unreachable database is retried a few times and
then also exits, leaving the restart to Kubernetes.
