// Console helpers for tests whose code under test logs progress or expected
// failures, so CI output only shows what a test didn't ask for.
import { afterEach, beforeEach, vi } from "vite-plus/test";

/**
 * Silence console.log (progress lines) for every test in the calling suite,
 * and restore all spies after each test. Tests that expect a warning or error
 * spy on console.warn / console.error themselves and assert on the message.
 */
export function quietLogs(): void {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}

/** Spy on `method` with a no-op, so an expected message is checked rather than printed. */
export function expectConsole(method: "warn" | "error") {
  return vi.spyOn(console, method).mockImplementation(() => {});
}
