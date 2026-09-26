import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth-context.ts";
import { fetch, FetchError } from "../lib/client.ts";
import { listHref } from "../lib/list-state.ts";
import { wikiPageUrl } from "../lib/wiki.ts";
import type { LeaderboardPeriod, LeaderboardResponse } from "../lib/api-types.ts";
import AuthBar from "../AuthBar.tsx";
import { LogoMark } from "../Logo.tsx";

const PERIODS: { value: LeaderboardPeriod; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "30d", label: "Last 30 days" },
];

// Who has resolved the most pairs through the app: merges first, then pairs
// marked "different from". Counted server-side from the edit audit table (see
// server/leaderboard.ts). The period lives in the URL so a view can be linked.
export default function Leaderboard() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const period: LeaderboardPeriod = params.get("period") === "30d" ? "30d" : "all";
  // The last response or failure, with the period it was for, so switching
  // periods shows "Loading…" rather than the other period's table.
  const [loaded, setLoaded] = useState<{
    period: LeaderboardPeriod;
    data?: LeaderboardResponse;
    error?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/leaderboard", { query: { period } })
      .then((res) => {
        if (!cancelled) setLoaded({ period, data: res as LeaderboardResponse });
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setLoaded({
            period,
            error: e instanceof FetchError ? `Request failed (${e.status}).` : "Request failed.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  const current = loaded?.period === period ? loaded : null;
  const entries = current?.data?.entries;
  // Standard competition ranking: users tied on both counts share a rank.
  const ranks: number[] = [];
  entries?.forEach((e, i) => {
    const prev = entries[i - 1];
    ranks.push(
      prev && prev.merges === e.merges && prev.differentFrom === e.differentFrom
        ? ranks[i - 1]
        : i + 1,
    );
  });

  return (
    <>
      <title>Leaderboard · M&amp;A: A Wikidata Merge Assistant</title>
      <div className="detail-top">
        <nav className="detail-nav">
          <Link className="detail-back" to={listHref()}>
            <LogoMark />← Back to candidates
          </Link>
          <AuthBar />
        </nav>
      </div>
      <main className="mc leaderboard">
        <div className="leaderboard-head">
          <h1>Leaderboard</h1>
          <nav className="period-toggle" aria-label="Period">
            {PERIODS.map((p) => (
              <Link
                key={p.value}
                to={p.value === "all" ? "/leaderboard" : `/leaderboard?period=${p.value}`}
                aria-current={p.value === period ? "page" : undefined}
              >
                {p.label}
              </Link>
            ))}
          </nav>
        </div>
        <p className="settings-help">
          Merges and different-from edits applied on Wikidata for each user. Make sure to always
          make responsible edits!
        </p>
        {current?.error ? (
          <p className="list-msg is-error" role="alert">
            {current.error}
          </p>
        ) : !entries ? (
          <p className="list-msg">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="list-msg">
            {period === "30d" ? "No edits in the last 30 days." : "No edits yet."}
          </p>
        ) : (
          <div className="ledger-wrap">
            <table className="ledger leaderboard-table">
              <thead>
                <tr>
                  <th scope="col" className="col-rank">
                    #
                  </th>
                  <th scope="col">User</th>
                  <th scope="col" className="col-count">
                    Merges
                  </th>
                  <th scope="col" className="col-count">
                    Marked different
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={e.userId} className={e.userId === user?.id ? "is-you" : undefined}>
                    <td className="col-rank">{ranks[i]}</td>
                    <td>
                      <a
                        href={wikiPageUrl(`User:${encodeURIComponent(e.username)}`)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {e.username}
                      </a>
                      {e.userId === user?.id && <span className="auth-badge">you</span>}
                    </td>
                    <td className="col-count">{e.merges.toLocaleString()}</td>
                    <td className="col-count">{e.differentFrom.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
