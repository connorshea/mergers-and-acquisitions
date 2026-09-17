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
for reproducibility).

### Add new examples

Pass QIDs pairwise (the fetcher canonicalizes each pair's order):

```sh
pnpm eval:fetch-nondupes Q4047343 Q1535818  Q140140365 Q213911
```

Good sources of hard negatives: pairs you personally confirm are distinct, and —
once the app is running — the hunt's own **dismissed** candidates.
