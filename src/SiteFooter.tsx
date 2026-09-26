// The site-wide footer: the source repository and the app's edits on Wikidata
// (Recent Changes filtered to this OAuth consumer's tag). Rendered once, after
// the routes, so every page gets it.
export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <a
        href="https://github.com/connorshea/mergers-and-acquisitions"
        target="_blank"
        rel="noreferrer"
      >
        Source code on GitHub
      </a>
      <span className="site-footer-sep" aria-hidden="true">
        {" · "}
      </span>
      <a
        href="https://www.wikidata.org/w/index.php?tagfilter=OAuth+CID%3A+19397&enhanced=1&title=Special%3ARecentChanges&urlversion=2"
        target="_blank"
        rel="noreferrer"
      >
        View Recent Changes from this app
      </a>
    </footer>
  );
}
