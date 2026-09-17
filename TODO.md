# TODO

Deferred fixes and follow-ups. Newest first.

## Date precision is dropped on the dump/query path (year dates show as `YYYY-01-01`)

**Symptom:** a year-precision publication date (P577) — e.g. Q55616112, whose
P577 is `1987` — is displayed and compared as a full date `1987-01-01`, not as a
year.

**Root cause:** the dump/query path (`script/dump_wikidata_games.rb`) fetches the
truthy value via `wdt:P577`, and Wikidata's RDF normalizes a year-precision date
to `1987-01-01T00:00:00Z` on that predicate. The actual precision
(`wikibase:timePrecision` = 9 for year, 10 month, 11 day) lives only on the
statement's _value node_ (`p:P577 / psv:P577 / wikibase:timePrecision`), which the
query never reads — so the precision is lost at ingest and can't be recovered from
the stored value. (Confirmed against QLever: `wdt:` → `1987-01-01T00:00:00Z`,
value node → `timePrecision 9`.)

The **eval path** (`scripts/eval-score.ts`, from full entity JSON) already carries
precision as the reduced form `+1987-00-00T00:00:00Z` (month/day `00`), and
`compareValues`' `time` case in `src/lib/compare.ts` already reads that `00`
convention. Only the dump path is wrong.

**Fix:** make the dump path produce the same reduced form the Wikibase JSON uses.

1. In `script/dump_wikidata_games.rb`, fetch `wikibase:timePrecision` for
   time-valued statements (join through `p:`/`psv:` to the value node) and truncate
   the normalized date to its precision: precision ≤ 9 → `YYYY-00-00`, 10 →
   `YYYY-MM-00`, 11 → keep the day. Emit the reduced value string.
2. `src/lib/wikidata.ts` `classifyValue` then passes the reduced `time` value
   through unchanged; `compare.ts` already handles it.
3. Fix `displayValue` in `src/MergeCandidates.tsx` so a reduced date renders
   cleanly (`1987-00-00` → `1987`, `1987-05-00` → `1987-05`) instead of the
   literal `00` parts.
4. Requires a re-sync of the games dump to reclassify already-stored dates.
