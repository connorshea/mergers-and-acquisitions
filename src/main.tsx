import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import MergeCandidates from "./MergeCandidates";
import "./merge-candidates.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MergeCandidates />
  </StrictMode>,
);
