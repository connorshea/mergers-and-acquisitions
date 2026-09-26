// Router for /api/settings — the logged-in user's preferences. Reading them
// needs no route of its own: they ride on the session user (/api/auth/me).
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db.ts";
import { type AuthEnv, requireUser } from "./auth/session.ts";
import { users } from "../db/schema.ts";
import type { UserSettings } from "../src/lib/api-types.ts";
import { normalizeLanguages } from "../src/lib/languages.ts";

export const settings = new Hono<AuthEnv>();

settings.use("*", requireUser);

// PUT /api/settings — replace the user's settings. `languages` is normalized
// (see normalizeLanguages); an empty list turns the language filter off.
settings.put("/", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const raw = (body as { languages?: unknown } | null)?.languages;
  if (!Array.isArray(raw)) {
    return c.json({ error: "Expected { languages: string[] }" }, 400);
  }
  const languages = normalizeLanguages(raw);
  await db
    .update(users)
    .set({ languages })
    .where(eq(users.id, c.get("user")!.id));
  const payload: UserSettings = { languages };
  return c.json(payload);
});
