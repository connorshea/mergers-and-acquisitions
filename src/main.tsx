import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import RouteErrorBoundary from "./ErrorBoundary.tsx";
import SiteFooter from "./SiteFooter.tsx";
import { AuthProvider } from "./lib/auth.tsx";
import CandidateDetail from "./pages/CandidateDetail.tsx";
import CandidatesList from "./pages/CandidatesList.tsx";
import Leaderboard from "./pages/Leaderboard.tsx";
import Maintenance from "./pages/Maintenance.tsx";
import Settings from "./pages/Settings.tsx";
import Toast from "./Toast.tsx";
import "./merge-candidates.css";

// While true, every route renders the maintenance page instead of the app (no
// API calls, no edits). Flip back once the database migration is done.
const MAINTENANCE = true;

createRoot(document.getElementById("root")!).render(
  MAINTENANCE ? (
    <StrictMode>
      <Maintenance />
      <SiteFooter />
    </StrictMode>
  ) : (
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <RouteErrorBoundary>
            <Routes>
              <Route path="/" element={<CandidatesList />} />
              <Route path="/candidates/:id" element={<CandidateDetail />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
            </Routes>
            <SiteFooter />
            <Toast />
          </RouteErrorBoundary>
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>
  ),
);
