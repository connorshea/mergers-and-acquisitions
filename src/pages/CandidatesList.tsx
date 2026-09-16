import { Link } from "react-router-dom";

// Placeholder list page. Phase 5 replaces this with a real table backed by
// GET /api/candidates (search / filter / sort / confidence badges).
export default function CandidatesList() {
  return (
    <main className="mc">
      <h1>Merge candidates</h1>
      <p>
        No candidates yet. Once Wikidata sync and duplicate-hunting are wired up, ranked merge
        candidates will appear here.
      </p>
      <p>
        <Link to="/candidates/demo">View the demo comparison →</Link>
      </p>
    </main>
  );
}
