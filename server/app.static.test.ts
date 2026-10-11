// The built SPA's caching headers, against a stand-in client build. app.ts
// reads CLIENT_DIR at import, so the stand-in is set up in vi.hoisted, which
// runs before the (hoisted) static imports below.
import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { rmSync } from "node:fs";
import { app, cacheControlFor } from "./app.ts";

const dir = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mna-client-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>shell</title>");
  fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log(1)");
  fs.writeFileSync(path.join(dir, "favicon.ico"), "ico");
  process.env.CLIENT_DIR = dir;
  return dir;
});

afterAll(() => {
  delete process.env.CLIENT_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("cacheControlFor", () => {
  it("revalidates the shell, pins hashed assets, and gives the rest an hour", () => {
    expect(cacheControlFor("/", "text/html; charset=UTF-8")).toBe("no-cache");
    expect(cacheControlFor("/candidates/5", "text/html; charset=UTF-8")).toBe("no-cache");
    expect(cacheControlFor("/assets/index-q1xjeKGU.js", "text/javascript")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cacheControlFor("/assets/index-DW52dTMT.css", "text/css")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cacheControlFor("/favicon.ico", "image/x-icon")).toBe("public, max-age=3600");
  });
});

describe("static SPA caching headers", () => {
  it("makes the shell revalidate wherever it is served from", async () => {
    for (const path of ["/", "/index.html", "/candidates/5"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("shell");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("marks content-hashed assets immutable", async () => {
    const res = await app.request("/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("gives unhashed files a short lifetime", async () => {
    const res = await app.request("/favicon.ico");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("keeps API 404s out of the SPA fallback", async () => {
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
