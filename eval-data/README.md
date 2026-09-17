# Evaluation data

Labelled ground-truth item pairs for measuring **merge-detection accuracy** —
both the hand-written heuristic scorer (`src/lib/compare.ts`) today and any
ML/LLM assist later. These drive precision/recall metrics, model training/eval,
and regression tests, so a scoring change can be judged against a fixed benchmark
instead of by eye. See the "Evaluation datasets" section of `PLAN.md` for the
wider rationale.

## Layout

```
eval-data/
  merged-pairs/                 positive examples — pairs that ARE duplicates
    index.jsonl                 one JSON record per pair (the manifest)
    <SOURCE>_into_<TARGET>/
      <SOURCE>.pre.json         source item's full entity blob, pre-merge
      <TARGET>.pre.json         target item's full entity blob, pre-merge
      meta.json                 the pair's record (same shape as an index line)
  non-dupe-pairs/               negative examples — pairs that are NOT duplicates
    index.jsonl                 one JSON record per pair (the manifest)
    <A>_vs_<B>/                 (A/B ordered by QID number, lower first)
      <A>.json                  item A's full entity blob, current revision
      <B>.json                  item B's full entity blob, current revision
      meta.json                 the pair's record (same shape as an index line)
```

Each `*.pre.json` is the **full official Wikibase entity JSON** (labels, aliases,
descriptions, claims, sitelinks) exactly as `Special:EntityData` returns it — the
lossless form, richer than the app's internal `Item` shape, so it can be adapted
to whatever an evaluator needs.

### `meta.json` / index record fields

| field                         | meaning                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `label`                       | `"duplicate"` for a positive pair                               |
| `source`                      | merged-away QID (now a redirect on Wikidata)                    |
| `target`                      | surviving QID it was merged into                                |
| `sourceLabel` / `targetLabel` | en (or `mul`) label at the pre-merge revision                   |
| `sourcePreRevid`              | revision of `source` used for its blob (last state pre-merge)   |
| `targetPreRevid`              | revision of `target` used for its blob (last independent state) |
| `targetPostRevid`             | target's revision right after receiving the merge (the union)   |
| `mergedAt`                    | merge timestamp (UTC)                                           |
| `provenance`                  | how the pair was obtained (`wikidata-merge-redirect`)           |

## Positive examples — how they're built

When SOURCE is merged into TARGET on Wikidata, SOURCE becomes a redirect but
keeps its full page history, so the revision _just before_ the merge is its
complete pre-merge blob. The edit history records the merge explicitly
(`wbmergeitems-to` / `wbmergeitems-from` comments), so both items' last
independent states are recoverable and pinned by revision. (Pinning matters — a
redirected item fetched at HEAD silently resolves to its merge target.)

### Add new examples

Give the fetcher any QID touched by a merge (either the merged-away item or the
survivor — it auto-detects and resolves the pair):

```sh
pnpm eval:fetch-pairs Q131619317 Q130732355 …
```

It writes the `<SOURCE>_into_<TARGET>/` directory and appends to
`merged-pairs/index.jsonl`. Commit the new files. Good sources of positives:
merges you perform yourself, and any true duplicates you find on live Wikidata
(merge them, then run the fetcher on either QID).

## Negative examples

`non-dupe-pairs/` holds **non-duplicate** pairs, weighted toward _hard_
negatives — pairs that look mergeable (same label/type, shared blocking bucket)
but are genuinely different subjects: two different games sharing a title, an
original vs. its remake, a series vs. one entry, a game vs. its soundtrack/DLC.
Easy negatives (unrelated items) teach little. Negatives have no merge trail, so
each item is fetched at its current revision (`lastrevid` recorded in `meta.json`
for reproducibility). Scope is deliberately broad (not just games): people,
companies, products, films, albums, ships, taxa, etc.

Each record's `provenance` records where the pair came from:

- `hand-curated` — a pair a maintainer personally confirmed is distinct.
- `wikidata-p1889-different-from` — mined from Wikidata's **P1889 ("different
  from")** statements, which editors add precisely to separate commonly-confused
  items. Filtered to same-type, near-identical-label pairs (the confusable ones)
  and excludes scholarly-article / category / disambiguation items.
- `game-vs-common-word` — a video game vs the common noun/concept it is named
  after, sharing the exact same label (e.g. _Braid_ the game vs `braid` the
  pattern, _Spore_ vs the reproductive `spore`, _Portal_ vs a `portal` opening).
  Identical string, unrelated subject and `instance of` — a clean test that the
  scorer doesn't over-weight a matching label.

### Add new examples

Pass QIDs pairwise (the fetcher canonicalizes each pair's order). `--provenance`
tags where they came from; it defaults to `hand-curated`:

```sh
pnpm eval:fetch-nondupes Q4047343 Q1535818  Q140140365 Q213911
pnpm eval:fetch-nondupes -- --provenance wikidata-p1889-different-from Q719960 Q116783524 …
```

Good sources of hard negatives: pairs you personally confirm are distinct;
Wikidata P1889 "different from" pairs (query QLever for `?a wdt:P1889 ?b`,
Q-items only, ranked by label similarity + shared type); and — once the app is
running — the hunt's own **dismissed** candidates.

## Scoring the dataset

`pnpm eval:score` runs the current heuristic scorer (`src/lib/compare.ts`)
against every pair here and reports a confusion matrix, precision/recall/F1, and
each misclassified pair (with its confidence and the reasons that fed the score).
It reads the checked-in blobs only — no DB, no network — so it runs anywhere.

```sh
pnpm eval:score                     # confusion matrix + gate against the baseline
pnpm eval:score -- --verbose        # also print every pair, sorted by confidence
pnpm eval:score -- --threshold 0.5  # sweep the boundary (report-only, no gate)
pnpm eval:score -- --update-baseline # re-record the baseline after a deliberate change
```

**Pass/fail is a baseline-regression gate, not a demand for 100%.** The dataset
deliberately includes _hard positives the scorer can't yet catch_ — merges whose
two names genuinely differ (romanizations, married/maiden names, cross-catalog
astronomical designations, address↔building-name, native↔English). Those are the
point: they map where the label-similarity-heavy scorer is blind. So a perfect
score is neither expected nor the target.

Instead, `eval-data/score-baseline.json` records each pair's current
correct/incorrect verdict. A run exits **non-zero only on a true regression** — a
pair the baseline classified correctly that is now wrong. Newly-added pairs,
removed pairs, and newly-_fixed_ pairs are reported as warnings and never fail the
gate; fold them into the baseline with `--update-baseline` (then commit the
updated `score-baseline.json`) once you've eyeballed the change. A missing
baseline, or a non-default `--threshold`, disables gating (report-only).

The default threshold (0.4) mirrors the hunt's `MIN_CONFIDENCE`. Because the full
entity blobs carry real property datatypes, external identifiers are classified
exactly and `isIdentifierProp` is reproduced faithfully; the sync-only
`isMirroredIdProp` predicate isn't available offline, so only compare.ts's
hardcoded mirror-Wikidata floor applies (see the harness header for detail).
