import { describe, expect, it } from "vite-plus/test";
import { app } from "./app.ts";

describe("security headers", () => {
  // No session cookie, so neither request touches the database.
  it.each(["/", "/api/auth/me"])("sends the Content-Security-Policy on %s", async (path) => {
    const res = await app.request(path);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });
});
