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
mariadb -u root -e "CREATE DATABASE mergers CHARACTER SET utf8mb4;
  CREATE USER 'mergers'@'localhost' IDENTIFIED BY 'mergers';
  GRANT ALL ON mergers.* TO 'mergers'@'localhost';"
```

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
```

Formatting, linting, testing, and type-checking go through the `vp` CLI directly:

```sh
vp check       # format, lint, and type-check in one pass
vp test        # run tests with Vitest
```

## Deploying to Toolforge

Build the image (`toolforge build`), apply migrations and seed as one-off jobs,
start the web service (`toolforge webservice buildservice start`; runs the
`Procfile` `web` process), and load the schedule with `toolforge jobs load
jobs.yaml` (set the image name in `jobs.yaml` first). The DB is a ToolsDB MariaDB
database; connection details come from the tool's credentials via the `DB_*` env
vars.
