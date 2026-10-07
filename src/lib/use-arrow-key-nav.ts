import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Left / Right arrow keys as page-level shortcuts for Prev / Next links. Pass
 * `undefined` for a direction that's unavailable (first or last pair), and the
 * key falls through to the browser.
 *
 * The keys are left alone wherever they already mean something: with a
 * modifier held (Alt+Left is browser Back), while typing in a field, while a
 * modal dialog is open, and inside anything that scrolls horizontally (a wide
 * comparison table on a narrow screen).
 */
export function useArrowKeyNav(prevHref: string | undefined, nextHref: string | undefined) {
  const navigate = useNavigate();
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.target instanceof Element && usesArrowKeys(e.target)) return;
      const href = e.key === "ArrowLeft" ? prevHref : nextHref;
      if (!href) return;
      e.preventDefault();
      void navigate(href);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [prevHref, nextHref, navigate]);
}

function usesArrowKeys(target: Element): boolean {
  if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) {
    return true;
  }
  for (let el: Element | null = target; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth) continue;
    const { overflowX } = getComputedStyle(el);
    if (overflowX === "auto" || overflowX === "scroll") return true;
  }
  return false;
}
