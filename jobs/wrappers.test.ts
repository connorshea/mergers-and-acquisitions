// The thin scheduled jobs: each wraps one server function (covered by the
// server/*.db.test.ts suites), so these only check the log line, the exit
// code, and the partial-failure warning that still exits 0.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { expectConsole, quietLogs } from "../test/console.ts";
import type { runHunt } from "../server/hunt.ts";
import type { runItemCreationSync } from "../server/item-creations.ts";
import type { runOutsideMergeSync } from "../server/outside-merges.ts";
import type { runSitelinkRedirectSync } from "../server/sitelink-redirects.ts";
import type { runEntityLabelsSync } from "../server/entity-labels-sync.ts";
import type { fetchAllProperties } from "../src/lib/sparql.ts";
import type { syncProperties } from "../server/properties-sync.ts";
import type { syncClassAncestors } from "../server/class-ancestors.ts";
import type { syncPlaceAncestors } from "../server/place-ancestors.ts";
import type { pruneExpiredSessions } from "../server/auth/session.ts";
import type { recheckLoggedInUsers } from "../server/auth/profile-recheck.ts";

const m = vi.hoisted(() => ({
  runHunt: vi.fn<typeof runHunt>(),
  runItemCreationSync: vi.fn<typeof runItemCreationSync>(),
  runOutsideMergeSync: vi.fn<typeof runOutsideMergeSync>(),
  runSitelinkRedirectSync: vi.fn<typeof runSitelinkRedirectSync>(),
  runEntityLabelsSync: vi.fn<typeof runEntityLabelsSync>(),
  fetchAllProperties: vi.fn<typeof fetchAllProperties>(),
  syncProperties: vi.fn<typeof syncProperties>(),
  syncClassAncestors: vi.fn<typeof syncClassAncestors>(),
  syncPlaceAncestors: vi.fn<typeof syncPlaceAncestors>(),
  pruneExpiredSessions: vi.fn<typeof pruneExpiredSessions>(),
  recheckLoggedInUsers: vi.fn<typeof recheckLoggedInUsers>(),
  poolEnd: vi.fn<() => Promise<void>>(),
}));

vi.mock("../server/db.ts", () => ({ db: {}, pool: { end: m.poolEnd } }));
vi.mock("../server/hunt.ts", () => ({ runHunt: m.runHunt }));
vi.mock("../server/item-creations.ts", () => ({ runItemCreationSync: m.runItemCreationSync }));
vi.mock("../server/outside-merges.ts", () => ({ runOutsideMergeSync: m.runOutsideMergeSync }));
vi.mock("../server/sitelink-redirects.ts", () => ({
  runSitelinkRedirectSync: m.runSitelinkRedirectSync,
}));
vi.mock("../server/entity-labels-sync.ts", () => ({ runEntityLabelsSync: m.runEntityLabelsSync }));
vi.mock("../src/lib/sparql.ts", () => ({ fetchAllProperties: m.fetchAllProperties }));
vi.mock("../server/properties-sync.ts", () => ({ syncProperties: m.syncProperties }));
vi.mock("../server/class-ancestors.ts", () => ({ syncClassAncestors: m.syncClassAncestors }));
vi.mock("../server/place-ancestors.ts", () => ({ syncPlaceAncestors: m.syncPlaceAncestors }));
vi.mock("../server/auth/session.ts", () => ({ pruneExpiredSessions: m.pruneExpiredSessions }));
vi.mock("../server/auth/profile-recheck.ts", () => ({
  recheckLoggedInUsers: m.recheckLoggedInUsers,
}));

const { main: hunt } = await import("./hunt.ts");
const { main: resolveCreations } = await import("./resolve-creations.ts");
const { main: resolveMerges } = await import("./resolve-merges.ts");
const { main: resolveSitelinks } = await import("./resolve-sitelinks.ts");
const { main: syncEntityLabels } = await import("./sync-entity-labels.ts");
const { main: syncPropertiesJob } = await import("./sync-properties.ts");
const { main: syncPlaceAncestorsJob } = await import("./sync-place-ancestors.ts");
const { main: pruneSessions } = await import("./prune-sessions.ts");

// Reset before quietLogs() installs its console spy, which a reset would undo.
beforeEach(() => {
  vi.resetAllMocks();
  m.poolEnd.mockResolvedValue(undefined);
});
quietLogs();

const boom = new Error("boom");

/** Each job fails the same way when the function it wraps throws. */
describe.each([
  ["hunt", hunt, m.runHunt],
  ["resolve-creations", resolveCreations, m.runItemCreationSync],
  ["resolve-merges", resolveMerges, m.runOutsideMergeSync],
  ["resolve-sitelinks", resolveSitelinks, m.runSitelinkRedirectSync],
  ["sync-entity-labels", syncEntityLabels, m.runEntityLabelsSync],
  ["sync-properties", syncPropertiesJob, m.fetchAllProperties],
  ["sync-place-ancestors", syncPlaceAncestorsJob, m.syncPlaceAncestors],
  ["prune-sessions", pruneSessions, m.pruneExpiredSessions],
])("%s", (name, main, wrapped) => {
  it("exits 1 and logs the error when the run throws", async () => {
    wrapped.mockRejectedValue(boom);
    const error = expectConsole("error");
    expect(await main()).toBe(1);
    expect(error).toHaveBeenCalledWith(`${name}: failed`, boom);
  });
});

describe("hunt", () => {
  it("logs the stats and exits 0", async () => {
    m.runHunt.mockResolvedValue({
      pairs: 10,
      scored: 9,
      upserted: 8,
      deleted: 1,
      pruned: 2,
      failed: 0,
    });
    expect(await hunt()).toBe(0);
    expect(console.log).toHaveBeenCalledWith(
      "hunt: 10 pairs, 9 scored, 8 upserted, 1 deleted, 2 pruned, 0 failed",
    );
  });
});

describe("resolve-creations / resolve-merges", () => {
  it("exit 0 on success", async () => {
    expect(await resolveCreations()).toBe(0);
    expect(await resolveMerges()).toBe(0);
  });
});

describe("resolve-sitelinks", () => {
  const sitelinkStats = { titles: 3, checked: 3, redirects: 1, pruned: 0 };

  it("exits 0 quietly when every wiki resolved", async () => {
    m.runSitelinkRedirectSync.mockResolvedValue({ ...sitelinkStats, failedWikis: [] });
    const warn = expectConsole("warn");
    expect(await resolveSitelinks()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns about the failed wikis but still exits 0", async () => {
    m.runSitelinkRedirectSync.mockResolvedValue({
      ...sitelinkStats,
      failedWikis: ["enwiki", "dewiki"],
    });
    const warn = expectConsole("warn");
    expect(await resolveSitelinks()).toBe(0);
    expect(warn).toHaveBeenCalledWith("resolve-sitelinks: skipped enwiki, dewiki after errors");
  });
});

describe("sync-entity-labels", () => {
  it("logs the count and exits 0", async () => {
    m.runEntityLabelsSync.mockResolvedValue({ synced: 42, failed: 0 });
    const warn = expectConsole("warn");
    expect(await syncEntityLabels()).toBe(0);
    expect(console.log).toHaveBeenCalledWith("sync-entity-labels: upserted 42 entity labels");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns about skipped QIDs but still exits 0", async () => {
    m.runEntityLabelsSync.mockResolvedValue({ synced: 40, failed: 2 });
    const warn = expectConsole("warn");
    expect(await syncEntityLabels()).toBe(0);
    expect(warn).toHaveBeenCalledWith("sync-entity-labels: skipped 2 QIDs after repeated failures");
  });
});

describe("sync-properties", () => {
  const fetched: Awaited<ReturnType<typeof fetchAllProperties>> = [];

  beforeEach(() => {
    m.fetchAllProperties.mockResolvedValue(fetched);
    m.syncProperties.mockResolvedValue(12);
  });

  it("syncs the fetched properties, then the class ancestors, and exits 0", async () => {
    m.syncClassAncestors.mockResolvedValue({ classes: 3, rows: 7, failed: 0 });
    const warn = expectConsole("warn");
    expect(await syncPropertiesJob()).toBe(0);
    expect(m.syncProperties).toHaveBeenCalledWith(fetched);
    expect(vi.mocked(console.log).mock.calls).toEqual([
      ["sync-properties: upserted 12 property labels"],
      ["sync-properties: wrote 7 ancestor rows for 3 classes"],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns about failed classes but still exits 0", async () => {
    m.syncClassAncestors.mockResolvedValue({ classes: 3, rows: 5, failed: 1 });
    const warn = expectConsole("warn");
    expect(await syncPropertiesJob()).toBe(0);
    expect(warn).toHaveBeenCalledWith("sync-properties: skipped 1 classes after repeated failures");
  });

  it("exits 1 when the class-ancestor rebuild throws", async () => {
    m.syncClassAncestors.mockRejectedValue(boom);
    const error = expectConsole("error");
    expect(await syncPropertiesJob()).toBe(1);
    expect(error).toHaveBeenCalledWith("sync-properties: failed", boom);
  });
});

describe("sync-place-ancestors", () => {
  it("logs the counts and exits 0", async () => {
    m.syncPlaceAncestors.mockResolvedValue({ places: 3, rows: 7, failed: 0 });
    const warn = expectConsole("warn");
    expect(await syncPlaceAncestorsJob()).toBe(0);
    expect(console.log).toHaveBeenCalledWith(
      "sync-place-ancestors: wrote 7 ancestor rows for 3 places",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns about failed places but still exits 0", async () => {
    m.syncPlaceAncestors.mockResolvedValue({ places: 3, rows: 5, failed: 2 });
    const warn = expectConsole("warn");
    expect(await syncPlaceAncestorsJob()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "sync-place-ancestors: skipped 2 places after repeated failures",
    );
  });
});

describe("prune-sessions", () => {
  it("prunes, re-checks, closes the pool and exits 0", async () => {
    m.pruneExpiredSessions.mockResolvedValue({ sessions: 4, tokens: 1 });
    m.recheckLoggedInUsers.mockResolvedValue({ checked: 5, blocked: 1, skipped: 0 });
    expect(await pruneSessions()).toBe(0);
    expect(vi.mocked(console.log).mock.calls).toEqual([
      ["prune-sessions: deleted 4 expired session(s) and 1 orphaned token row(s)"],
      ["prune-sessions: re-checked 5 logged-in account(s), 1 now blocked, 0 skipped"],
    ]);
    expect(m.poolEnd).toHaveBeenCalledOnce();
  });

  it("exits 1 when the re-check throws", async () => {
    m.pruneExpiredSessions.mockResolvedValue({ sessions: 0, tokens: 0 });
    m.recheckLoggedInUsers.mockRejectedValue(boom);
    const error = expectConsole("error");
    expect(await pruneSessions()).toBe(1);
    expect(error).toHaveBeenCalledWith("prune-sessions: failed", boom);
  });
});
