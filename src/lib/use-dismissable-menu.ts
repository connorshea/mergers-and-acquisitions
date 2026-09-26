import { type RefObject, useEffect } from "react";

/**
 * A native <details> menu doesn't dismiss on an outside click or Escape the way
 * a real dropdown should — wire both up. Handlers read `ref.current` live so
 * they stay correct across re-renders; they no-op when the menu is closed or
 * not rendered.
 */
export function useDismissableMenu(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const menu = ref.current;
      if (menu?.open && !menu.contains(e.target as Node)) menu.open = false;
    }
    function onKeyDown(e: KeyboardEvent) {
      const menu = ref.current;
      if (e.key === "Escape" && menu?.open) {
        menu.open = false;
        menu.querySelector<HTMLElement>("summary")?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref]);
}
