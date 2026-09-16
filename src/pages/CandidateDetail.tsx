import { Link, useParams } from "react-router-dom";
import MergeCandidates from "../MergeCandidates";

// Placeholder detail page: for now it renders the example-driven comparison
// view. Phase 5 fetches the real pair from GET /api/candidates/:id and feeds
// the two items into <MergeCandidates from into />.
export default function CandidateDetail() {
  const { id } = useParams();
  return (
    <>
      <p style={{ padding: "0.75rem 1rem 0" }}>
        <Link to="/">← Back to candidates</Link> · candidate <code>{id}</code>
      </p>
      <MergeCandidates />
    </>
  );
}
