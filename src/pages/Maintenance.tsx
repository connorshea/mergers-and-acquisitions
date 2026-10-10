import { LogoMark } from "../Logo.tsx";

// Shown in place of every route while the database is being migrated, so
// nobody reviews or edits against data that is about to move. It makes no API
// calls (the server may be mid-migration). Toggled by MAINTENANCE in main.tsx.
export default function Maintenance() {
  return (
    <>
      <title>Down for maintenance · M&amp;A: A Wikidata Merge Assistant</title>
      <main className="mc maintenance">
        <h1 className="list-title">
          <LogoMark />
          <span className="list-title-text">
            M&amp;A
            <span className="list-title-sub">A Wikidata Merge Assistant</span>
          </span>
        </h1>
        <h2>Down for maintenance</h2>
        <p>
          The database is being migrated, so reviewing and merging candidates is paused for now.
          Please check back soon.
        </p>
      </main>
    </>
  );
}
