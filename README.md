# M&A: A Wikidata Merge Assistant

Compares two Wikidata items and groups their labels, aliases, sitelinks and
statements into identical / similar / distinct / one-sided, flagging anything
that would block a merge. Currently runs on dummy data in
`src/MergeCandidates.tsx` (`EXAMPLES`).

## Toolchain

Built with React 19 + TypeScript 7 on the [Vite+](https://viteplus.dev) unified
toolchain (the `vp` CLI), managed with [pnpm](https://pnpm.io). Installing
dependencies runs `vp config`, which wires up the git pre-commit hook.

## Development

```sh
pnpm install   # install deps and set up git hooks
pnpm dev       # start the dev server
```

## Commands

```sh
pnpm build     # type-check and build for production (tsc -b && vp build)
pnpm preview   # preview the production build locally
```

Formatting, linting, testing, and type-checking go through the `vp` CLI directly:

```sh
vp fmt         # format with Oxfmt
vp lint        # lint with Oxlint (react, unicorn, oxc, typescript plugins)
vp check       # format, lint, and type-check in one pass
vp test        # run tests with Vitest
```
