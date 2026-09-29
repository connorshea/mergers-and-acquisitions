import { describe, expect, it } from "vite-plus/test";
import {
  coordinateDistance,
  coordinateTooltip,
  coordinateValue,
  formatCoordinate,
  formatMeters,
  geohackUrl,
  parseWktPoint,
} from "./coordinates.ts";

describe("formatCoordinate", () => {
  it("rounds to the stated precision, in hemisphere form", () => {
    expect(formatCoordinate(coordinateValue(51.5007292, -0.1246254, 0.0001))).toBe(
      "51.5007° N, 0.1246° W",
    );
    expect(formatCoordinate(coordinateValue(51.5007292, -0.1246254, 1))).toBe("52° N, 0°");
    expect(formatCoordinate(coordinateValue(52.4, -1.3, 1))).toBe("52° N, 1° W");
    expect(formatCoordinate(coordinateValue(-33.8568, 151.2153, 0.01))).toBe("33.86° S, 151.22° E");
  });

  it("uses about 5 decimals (≈1 m) with no precision, dropping trailing zeros", () => {
    expect(formatCoordinate(coordinateValue(51.50072919999999, -0.1246254))).toBe(
      "51.50073° N, 0.12463° W",
    );
    expect(formatCoordinate(coordinateValue(10.5, 20))).toBe("10.5° N, 20° E");
  });

  it("gives exactly 0° no hemisphere", () => {
    expect(formatCoordinate(coordinateValue(0, 0, 1))).toBe("0°, 0°");
    // Rounds to zero from the south: still no hemisphere, and no "-0".
    expect(formatCoordinate(coordinateValue(-0.00001, 5, 0.01))).toBe("0°, 5° E");
  });

  it("handles the antimeridian", () => {
    expect(formatCoordinate(coordinateValue(0, 180, 1))).toBe("0°, 180°");
    expect(formatCoordinate(coordinateValue(0, -180, 1))).toBe("0°, 180°");
    expect(formatCoordinate(coordinateValue(10, 190, 1))).toBe("10° N, 170° W");
    expect(formatCoordinate(coordinateValue(10, -179.99, 0.01))).toBe("10° N, 179.99° W");
  });

  it("names a non-Earth globe, keeping its 0–360° longitude", () => {
    const mars = coordinateValue(18.65, 226.2, 0.01, "Q111");
    expect(formatCoordinate(mars)).toBe("18.65° N, 226.2° E (Q111)");
    expect(formatCoordinate({ ...mars, globeLabel: "Mars" })).toBe("18.65° N, 226.2° E (Mars)");
  });
});

describe("coordinateTooltip", () => {
  it("gives the raw pair and the precision in metres", () => {
    expect(coordinateTooltip(coordinateValue(47.6062, -122.3321, 1 / 3600))).toBe(
      "47.6062, -122.3321 (±31 m)",
    );
    expect(coordinateTooltip(coordinateValue(47.6062, -122.3321))).toBe("47.6062, -122.3321");
  });
});

describe("geohackUrl", () => {
  it("links an Earth point", () => {
    expect(geohackUrl(coordinateValue(51.5, -0.12))).toBe(
      "https://geohack.toolforge.org/geohack.php?params=51.5_N_-0.12_E_globe:Earth",
    );
  });

  it("links another globe only once its name is known", () => {
    const mars = coordinateValue(18.65, 226.2, 0.01, "Q111");
    expect(geohackUrl(mars)).toBeNull();
    expect(geohackUrl({ ...mars, globeLabel: "Mars" })).toBe(
      "https://geohack.toolforge.org/geohack.php?params=18.65_N_226.2_E_globe:Mars",
    );
  });
});

describe("coordinateDistance / formatMeters", () => {
  it("measures great-circle distance", () => {
    // Big Ben → London Eye: about 400 m.
    const d = coordinateDistance(
      coordinateValue(51.5007292, -0.1246254),
      coordinateValue(51.5032973, -0.1195537),
    )!;
    expect(d).toBeGreaterThan(400);
    expect(d).toBeLessThan(500);
  });

  it("is null across globes", () => {
    expect(
      coordinateDistance(coordinateValue(1, 2), coordinateValue(1, 2, 0.1, "Q111")),
    ).toBeNull();
  });

  it("formats lengths", () => {
    expect(formatMeters(320.4)).toBe("320 m");
    expect(formatMeters(4230)).toBe("4.2 km");
    expect(formatMeters(48_400)).toBe("48 km");
  });
});

describe("parseWktPoint", () => {
  it("rejects a literal that isn't a point", () => {
    expect(parseWktPoint("LINESTRING(1 2, 3 4)")).toBeNull();
    expect(parseWktPoint("Point(a b)")).toBeNull();
  });
});
