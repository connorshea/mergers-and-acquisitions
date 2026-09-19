import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";

// Plain Vite+ React SPA (no Void). The client is built to dist/client and, in
// production, served by the Hono server (server/index.ts). In dev, Vite serves
// the SPA and proxies the API to the Node server on :8000.
export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // Drizzle-generated migration metadata is rewritten on every
    // `drizzle-kit generate`, so leave it in its generated shape.
    ignorePatterns: ["db/migrations/"],
  },
  lint: {
    // `plugins` overwrites Oxlint's default set, so keep the built-ins that are
    // on by default (unicorn, oxc, typescript) and add react (includes
    // react-hooks) plus import (for the explicit-extension rule below).
    plugins: ["react", "unicorn", "oxc", "typescript", "import"],
    options: { typeAware: true, typeCheck: true },
    rules: {
      // Require explicit file extensions on relative imports so the server and
      // jobs can run under `node` type-stripping (no extensionless resolution),
      // while leaving bare package specifiers alone.
      "import/extensions": [
        "error",
        "ignorePackages",
        { ts: "always", tsx: "always", js: "always", jsx: "always" },
      ],
    },
  },
  test: {
    // DB-backed tests (*.db.test.ts) are opt-in via DB_TEST=1; the global setup
    // migrates the test database when they are on and is a no-op otherwise.
    globalSetup: ["./test/global-setup.ts"],
    // The DB tests share one database and truncate it between tests, so files
    // must not run concurrently when they are enabled.
    fileParallelism: process.env.DB_TEST !== "1",
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.PORT ?? 8000}`,
        changeOrigin: true,
      },
    },
  },
  plugins: [lazyPlugins(() => [react()])],
});
