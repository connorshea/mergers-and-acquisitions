<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Mergers & Acquisitions — project notes

Full-stack app for finding, ranking, reviewing, and (eventually) applying
Wikidata merge candidates, scoped to video games. Runs on **Wikimedia Toolforge**:
a **Hono** (Node) web server + **Drizzle** on **MariaDB**, with a Vite+ / React 19
SPA client. (Migrated off Void/Cloudflare Workers+D1 — see the `migrate/toolforge`
branch history.)

Layout:

- `server/` — the Hono app (`index.ts`) and its routers (`candidates.ts`,
  `actions.ts`, `sync-routes.ts`); the Drizzle handle (`db.ts`) + connection
  config (`db-config.ts`); the shared sync write paths (`*-sync.ts`); and the
  hunt (`hunt.ts`, scan→score→upsert in one pass).
- `jobs/` — Toolforge scheduled jobs (`hunt.ts`, `sync-*.ts`), run via `tsx`.
  Declared in `jobs.yaml` (`toolforge jobs load`).
- `db/` — the MySQL-dialect schema (`schema.ts`), the seed script (`seed.ts`),
  and drizzle-kit migrations (`migrations/`, generated via `pnpm db:generate`).
- `src/` — the React SPA; DOM-free heuristics (comparison + `scoreCandidate`) in
  `src/lib/compare.ts`; the Wikidata dump→`Item` adapter in `src/lib/wikidata.ts`;
  the typed API client in `src/lib/client.ts`.

DB notes: MariaDB uses Drizzle's **MySQL dialect** (`mysql-core` + `mysql2`,
`mode: "default"`; drizzle-kit `dialect: "mysql"`) — there is no `mariadb` dialect.
JSON columns use a custom type that (de)serializes in the ORM layer, because mysql2
returns MariaDB `JSON` (a `LONGTEXT` alias) as a string. `datetime` columns are
`mode: "string"` paired with the driver's `dateStrings: true`. Local dev DB is
Homebrew MariaDB (`mergers`/`mergers`, utf8mb4); see `.env.example`.

## SPARQL: always use QLever, never WDQS

All SPARQL against Wikidata goes through the **QLever** mirror
(`https://qlever.dev/api/wikidata`) — it is dramatically faster than the
Wikidata Query Service and has no query timeout. Override with the
`WIKIDATA_SPARQL_ENDPOINT` env var; WDQS (`https://query.wikidata.org/sparql`)
is only a manual fallback, never the default. QLever requires explicit `PREFIX`
declarations on every query (wd/wdt/p/ps/wikibase/rdfs/schema/skos) and does not
support Blazegraph extensions (`wikibase:label` service, named subqueries). Send
a descriptive User-Agent, pace requests (~1s apart), and back off on 429.
`script/dump_wikidata_games.rb` (vendored from vglist) is the reference client.

## Running tooling inside the Claude Code sandbox

The sandbox blocks writes to the usual global cache dirs, so `vp`, `pnpm`, and
`git commit` (via the pre-commit hook, which runs `vp check --fix`) fail unless
these are redirected into the writable `$TMPDIR` first:

```sh
export npm_config_cache="$TMPDIR/npm-cache" \
       npm_config_devdir="$TMPDIR/node-gyp"
```

Set those before any `git commit`, `pnpm add`, or `vp check/test`. Other sandbox
notes:

- Run the binaries directly (`node_modules/.bin/vp`, `node_modules/.bin/drizzle-kit`),
  not `pnpm run <script>` — pnpm's `prepare`/verify steps try to write to
  `.git/config` and fail under the sandbox.
- `vp dev` / `pnpm dev` and `/usr/bin/time -l` do **not** work in-sandbox (Vite's
  dev watcher exhausts FSEvents; `sysctl` is blocked). They work on the user's
  machine; don't hand them to the user as a sandbox verification step.
- Anything that touches **MariaDB** (`pnpm db:migrate`, `pnpm seed`, `pnpm db:push`,
  running a job) needs a reachable DB, which the sandbox has none of — those run
  on the user's machine (local Homebrew MariaDB) or on Toolforge.
- `drizzle-kit generate` is offline (diffs the schema against `db/migrations/meta`),
  so it _does_ run in-sandbox; `migrate`/`push`/`studio` do not.
- macOS has no `timeout`; use `perl -e 'alarm N; exec @ARGV' <cmd>` and redirect
  `< /dev/null` for anything that might prompt.
