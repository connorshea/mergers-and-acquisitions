// Integration tests for the settings route against a real MariaDB. Opt-in via
// DB_TEST=1 — see test/global-setup.ts.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { app } from "./app.ts";
import { pool } from "./db.ts";
import type { AuthMeResponse } from "../src/lib/api-types.ts";
import { DB_TEST, loginAs, SAME_ORIGIN, truncateAll } from "../test/db-helpers.ts";

const EDITOR_ID = 7;

describe.skipIf(!DB_TEST)("PUT /api/settings", () => {
  beforeEach(truncateAll);
  afterAll(() => pool.end());

  const put = (headers: Record<string, string>, body: unknown) =>
    app.request("/api/settings", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("saves normalized languages onto the session user", async () => {
    const headers = await loginAs(EDITOR_ID, "Editor");
    const res = await put(headers, { languages: ["DE", "en", "de", "bogus!", "mul"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ languages: ["de", "en"] });
    const me = (await (await app.request("/api/auth/me", { headers })).json()) as AuthMeResponse;
    expect(me.user?.languages).toEqual(["de", "en"]);
  });

  it("requires a login and a languages array", async () => {
    expect((await put(SAME_ORIGIN, { languages: ["en"] })).status).toBe(401);
    const headers = await loginAs(EDITOR_ID, "Editor");
    expect((await put(headers, { languages: "en" })).status).toBe(400);
  });
});
