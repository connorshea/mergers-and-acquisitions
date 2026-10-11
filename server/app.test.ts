import { describe, expect, it } from "vite-plus/test";
import { app, MAX_API_BODY_BYTES } from "./app.ts";

describe("request body limit", () => {
  // Same-origin so the CSRF guard passes, no cookie so the session middleware
  // never touches the database; the limit answers before any route does.
  const headers = { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };

  it("refuses an oversized API body with a JSON 413", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languages: ["en".repeat(MAX_API_BODY_BYTES)] }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request body too large" });
  });

  it("lets a normal body through to the route", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ languages: ["en", "de"] }),
    });
    expect(res.status).toBe(401); // requireUser: the body was accepted
  });
});

describe("security headers", () => {
  // No session cookie, so neither request touches the database.
  it.each(["/", "/api/auth/me"])("sends the Content-Security-Policy on %s", async (path) => {
    const res = await app.request(path);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self';");
    expect(csp).toContain("font-src 'self';");
    expect(csp).not.toContain("fonts.googleapis.com");
    expect(csp).not.toContain("fonts.gstatic.com");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });
});
