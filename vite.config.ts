import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";
import { voidPlugin } from "void";

// The Void plugin starts a project-wide file watcher whenever Vite actually
// runs. Under `vp test` that watcher exhausts macOS FSEvents streams in the
// sandbox (EMFILE). The unit tests are pure/DOM-free and don't need Void's
// virtual modules (@schema, void/db, void/client), so we drop voidPlugin during
// test runs. Revisit if we add route/SSR tests that need those to resolve.
const isTest = !!process.env.VITEST;

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // Drizzle-generated migration metadata is rewritten on every
    // `void db generate`, so leave it in its generated shape.
    ignorePatterns: ["db/migrations/meta/"],
  },
  lint: {
    // `plugins` overwrites Oxlint's default set, so keep the built-ins that are
    // on by default (unicorn, oxc, typescript) and add react (includes react-hooks).
    plugins: ["react", "unicorn", "oxc", "typescript"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: isTest ? [lazyPlugins(() => [react()])] : [voidPlugin(), lazyPlugins(() => [react()])],
});
