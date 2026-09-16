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
Wikidata merge candidates, scoped to video games. Built on [Void](https://void.cloud/)
(Cloudflare Workers + D1) with a Vite+ / React 19 SPA client. Server code lives in
`routes/`, `queues/`, `crons/`; the DB schema is `db/schema.ts`; shared, DOM-free
heuristics (comparison + `scoreCandidate`) are in `src/lib/compare.ts`; the
Wikidata dump→`Item` adapter is `src/lib/wikidata.ts`.

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

The sandbox blocks writes to the usual global cache dirs, so `vp`, `void`,
`pnpm`, and `git commit` (via the pre-commit hook, which runs `vp check --fix`)
fail unless these are redirected into the writable `$TMPDIR` first:

```sh
export npm_config_cache="$TMPDIR/npm-cache" \
       npm_config_devdir="$TMPDIR/node-gyp" \
       WRANGLER_LOG_PATH="$TMPDIR/wrangler-logs"
```

Set those before any `git commit`, `pnpm add`, `vp check/test`, or `void db …`
command. Other sandbox notes:

- Run the binaries directly (`node_modules/.bin/vp`, `node_modules/.bin/void`),
  not `pnpm run <script>` — pnpm's `prepare`/verify steps try to write to
  `.git/config` and fail under the sandbox.
- `vp dev`, `pnpm build`, and `/usr/bin/time -l` do **not** work in-sandbox
  (miniflare dev registry / git write / `sysctl` are all blocked). They work on
  the user's machine; don't use them here or hand them to the user as a
  sandbox verification step.
- macOS has no `timeout`; use `perl -e 'alarm N; exec @ARGV' <cmd>` and redirect
  `< /dev/null` for anything that might prompt.
- `void db execute --file <path>` resolves `<path>` relative to the repo root,
  not as an absolute path.
