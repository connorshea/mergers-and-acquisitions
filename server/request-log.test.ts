import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { requestLog } from "./request-log.ts";

describe("requestLog", () => {
  it("prints method, path, status and duration, without the query string", async () => {
    const lines: string[] = [];
    const app = new Hono();
    app.use(
      "*",
      requestLog((line) => lines.push(line)),
    );
    app.get("/api/auth/callback", (c) => c.text("ok"));
    app.get("/api/boom", () => {
      throw new Error("boom");
    });
    await app.request("/api/auth/callback?code=secret&state=xyz");
    await app.request("/api/boom");
    await app.request("/api/missing");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^GET \/api\/auth\/callback 200 \d+ms$/);
    expect(lines[0]).not.toContain("secret");
    expect(lines[1]).toMatch(/^GET \/api\/boom 500 \d+ms$/);
    expect(lines[2]).toMatch(/^GET \/api\/missing 404 \d+ms$/);
  });
});
