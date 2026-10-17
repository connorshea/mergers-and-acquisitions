import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { mainHeading, restoreFocus } from "./lib/focus.ts";

// A client-side navigation loads no new document, so nothing tells a screen
// reader the page changed, and focus is left on a link that's no longer there.
// On each change of page (not of query string: the list's filters live there),
// move focus to the new page's <h1>, which reads it out and puts the next Tab
// at the top of the page. The detail page renders its heading only once the
// pair has loaded, so wait for it to appear. Focus the user has already moved
// somewhere is left alone.
export default function RouteFocus() {
  const { pathname } = useLocation();
  // Not on the first load: the browser handles a fresh document itself.
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const focusHeading = (): boolean => {
      const heading = mainHeading();
      if (!heading) return false;
      restoreFocus(heading, { preventScroll: true });
      return true;
    };
    if (focusHeading()) return;
    const observer = new MutationObserver(() => {
      if (focusHeading()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pathname]);
  return null;
}
