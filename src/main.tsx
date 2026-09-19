import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import RouteErrorBoundary from "./ErrorBoundary.tsx";
import CandidateDetail from "./pages/CandidateDetail.tsx";
import CandidatesList from "./pages/CandidatesList.tsx";
import "./merge-candidates.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <RouteErrorBoundary>
        <Routes>
          <Route path="/" element={<CandidatesList />} />
          <Route path="/candidates/:id" element={<CandidateDetail />} />
        </Routes>
      </RouteErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
