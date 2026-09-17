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
    // on by default (unicorn, oxc, typescript) and add react (includes react-hooks).
    plugins: ["react", "unicorn", "oxc", "typescript"],
    options: { typeAware: true, typeCheck: true },
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
