import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import RouteErrorBoundary from "./ErrorBoundary.tsx";
import { AuthProvider } from "./lib/auth.tsx";
import CandidateDetail from "./pages/CandidateDetail.tsx";
import CandidatesList from "./pages/CandidatesList.tsx";
import Settings from "./pages/Settings.tsx";
import "./merge-candidates.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <RouteErrorBoundary>
          <Routes>
            <Route path="/" element={<CandidatesList />} />
            <Route path="/candidates/:id" element={<CandidateDetail />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </RouteErrorBoundary>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
