// A short description of how two similar text values differ, e.g.
// "Teen Angels - La Despedida" vs "Teen Angels: La Despedida" →
// "Punctuation difference only · 92% match".

import { stringSimilarity } from "./compare.ts";

// What a difference could be down to, each with the transform that erases it.
const DIFFERENCE_KINDS: { name: string; erase: (s: string) => string }[] = [
  { name: "case", erase: (s) => s.toLowerCase() },
  { name: "accents", erase: (s) => s.normalize("NFD").replace(/\p{M}/gu, "") },
  // Romanized long vowels: Hepburn's "ō" is often typed "ou" or "oo" ("Jōgai"
  // vs "Jougai"), likewise "ū"/"uu" and "ā"/"aa".
  {
    name: "romanization",
    erase: (s) =>
      s
        .normalize("NFD")
        .replace(/\u0304/g, "")
        .normalize("NFC")
        .replace(/o[ou]/g, "o")
        .replace(/uu/g, "u")
        .replace(/aa/g, "a"),
  },
  { name: "punctuation", erase: (s) => s.replace(/[\p{P}\p{S}]/gu, "") },
  { name: "spacing", erase: (s) => s.replace(/\s+/g, "") },
];

/**
 * A one-line caption for two similar values: which kinds of difference account
 * for all of it ("Punctuation difference only", "Case, accents, and
 * punctuation difference only"), and the match
 * percentage when it's below 100. Null when the strings are equal.
 */
export function describeDifference(a: string, b: string): string | null {
  if (a === b) return null;
  const eraseAll = (s: string, except?: string) =>
    DIFFERENCE_KINDS.reduce((acc, k) => (k.name === except ? acc : k.erase(acc)), s);
  let kinds: string[] = [];
  if (eraseAll(a) === eraseAll(b)) {
    // A kind is needed if erasing everything else still leaves a difference.
    kinds = DIFFERENCE_KINDS.map((k) => k.name).filter(
      (name) => eraseAll(a, name) !== eraseAll(b, name),
    );
    // Punctuation often swallows its spacing (" - " vs ": "); name just the punctuation.
    if (kinds.includes("punctuation")) kinds = kinds.filter((k) => k !== "spacing");
  }
  const parts: string[] = [];
  if (kinds.length > 0) {
    const list =
      kinds.length <= 2
        ? kinds.join(" and ")
        : `${kinds.slice(0, -1).join(", ")}, and ${kinds.at(-1)}`;
    parts.push(`${list[0].toUpperCase()}${list.slice(1)} difference only`);
  }
  const pct = Math.round(stringSimilarity(a, b) * 100);
  if (pct < 100) parts.push(`${pct}% match`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
