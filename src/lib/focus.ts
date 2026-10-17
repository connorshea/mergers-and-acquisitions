/**
 * Focus `el`, but only if focus has been lost: when the control a keyboard
 * user was on is removed or disabled, the browser drops focus to <body>, and
 * the next Tab starts over from the top of the page. Leaves focus alone if the
 * user has already moved it somewhere.
 */
export function restoreFocus(el: HTMLElement | null | undefined, options?: FocusOptions): void {
  if (!el?.isConnected) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  el.focus(options);
}

/** The page's main heading, which each page makes focusable (tabIndex -1). */
export function mainHeading(): HTMLElement | null {
  return document.querySelector<HTMLElement>("main h1");
}
