import { describe, expect, test } from "vite-plus/test";
import { describeDifference } from "./text-difference.ts";

describe("describeDifference", () => {
  test("names the kind of difference and the match", () => {
    expect(describeDifference("Teen Angels - La Despedida", "Teen Angels: La Despedida")).toBe(
      "Punctuation difference only · 92% match",
    );
    expect(describeDifference("Pokémon Red", "Pokemon Red")).toBe(
      "Accents difference only · 91% match",
    );
    expect(describeDifference("SimCity", "Sim City")).toBe("Spacing difference only · 88% match");
  });

  test("case alone is a 100% match, so the percentage is left out", () => {
    expect(describeDifference("DOOM", "Doom")).toBe("Case difference only");
  });

  test("combines kinds", () => {
    expect(describeDifference("Pokémon: Red", "pokemon red")).toBe(
      "Case, accents, and punctuation difference only · 83% match",
    );
  });

  test("romanized long vowels", () => {
    expect(
      describeDifference(
        "Sailor Moon S - Jougai Rantou!? Shuyaku Soudatsusen",
        "Sailor Moon S: Jōgai rantō!? Shuyaku sōdatsusen",
      ),
    ).toMatch(/^Case, romanization, and punctuation difference only · \d+% match$/);
  });

  test("a real difference gets just the match", () => {
    expect(describeDifference("Portal", "Portal 2")).toBe("75% match");
  });

  test("null for equal strings", () => {
    expect(describeDifference("Doom", "Doom")).toBeNull();
  });
});
