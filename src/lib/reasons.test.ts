import { describe, expect, it } from "vite-plus/test";
import { capIdReason } from "./reasons.ts";

describe("capIdReason", () => {
  it("splits an identifier list past the cap", () => {
    expect(
      capIdReason("shares external identifier: P1, Steam application ID, P3, P4, P5", 3),
    ).toEqual({
      prefix: "shares external identifier",
      shown: ["P1", "Steam application ID", "P3"],
      hidden: ["P4", "P5"],
    });
    expect(capIdReason("shares account/social identifier: P1, P2", 1)).toMatchObject({
      shown: ["P1"],
      hidden: ["P2"],
    });
  });

  it("leaves short lists and other reasons alone", () => {
    expect(capIdReason("shares external identifier: P1, P2, P3", 3)).toBeNull();
    expect(capIdReason("identical label", 3)).toBeNull();
    expect(capIdReason("one item references the other (P1, P2, P3, P4)", 3)).toBeNull();
  });
});
