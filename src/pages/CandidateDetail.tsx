import { useState } from "react";
import { Link } from "react-router-dom";
import MergeCandidates from "../MergeCandidates";
import { orderByAge } from "../lib/compare";
import { EXAMPLES } from "../lib/fixtures";

// Placeholder detail page: for now it drives the comparison view from the
// hand-authored fixtures with an example switcher. Phase 5 fetches the real
// pair from GET /api/candidates/:id and feeds those items into MergeCandidates.
export default function CandidateDetail() {
  const [exampleIdx, setExampleIdx] = useState(0);
  const example = EXAMPLES[exampleIdx];
  const [from, into] = orderByAge(example.a, example.b);

  return (
    <>
      <p style={{ padding: "0.75rem 1rem 0" }}>
        <Link to="/">← Back to candidates</Link>
      </p>
      <nav className="examples" aria-label="Example pairs" style={{ padding: "0 1rem" }}>
        {EXAMPLES.map((ex, i) => (
          <button
            key={ex.name}
            className={i === exampleIdx ? "is-active" : undefined}
            onClick={() => setExampleIdx(i)}
            aria-pressed={i === exampleIdx}
          >
            {ex.name}
          </button>
        ))}
      </nav>
      <MergeCandidates from={from} into={into} />
    </>
  );
}
