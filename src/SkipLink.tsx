import { mainHeading } from "./lib/focus.ts";

// The first stop for a keyboard user: past the header and its nav (and, on the
// list, the filters) to the page's content. A page marks where that starts with
// `id="main-content"` (the list's result count); otherwise it's the <h1>.
// Focuses the target directly instead of following the hash, which would put
// "#main-content" in the URL.
export default function SkipLink() {
  return (
    <a
      className="skip-link"
      href="#main-content"
      onClick={(e) => {
        const target = document.getElementById("main-content") ?? mainHeading();
        if (!target) return;
        e.preventDefault();
        target.focus();
      }}
    >
      Skip to main content
    </a>
  );
}
