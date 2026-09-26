import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth-context.ts";
import { loginUrl } from "../lib/auth-url.ts";
import { FetchError } from "../lib/client.ts";
import { normalizeLanguages } from "../lib/languages.ts";
import { listHref } from "../lib/list-state.ts";
import AuthBar from "../AuthBar.tsx";
import { LogoMark } from "../Logo.tsx";
import type { ToastState } from "../Toast.tsx";

// Languages offered as checkboxes; anything else goes in the free-text field.
const COMMON_LANGUAGES = [
  "en",
  "de",
  "fr",
  "es",
  "it",
  "pt",
  "nl",
  "sv",
  "da",
  "nb",
  "fi",
  "pl",
  "cs",
  "hu",
  "ru",
  "uk",
  "tr",
  "ar",
  "he",
  "ja",
  "zh",
  "ko",
  "id",
  "vi",
];

const displayNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" });
  } catch {
    return null;
  }
})();

/** "de" → "German", falling back to the bare code. */
function languageName(code: string): string {
  try {
    return displayNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

// The logged-in user's preferences. For now that's the languages they read,
// which the candidate list uses to hide pairs they couldn't review (see
// src/lib/languages.ts).
export default function Settings() {
  const { user, loading, configured } = useAuth();

  return (
    <>
      <title>Settings · M&amp;A: A Wikidata Merge Assistant</title>
      <div className="detail-top">
        <nav className="detail-nav">
          <Link className="detail-back" to={listHref()}>
            <LogoMark />← Back to candidates
          </Link>
          <AuthBar />
        </nav>
      </div>
      <main className="mc settings">
        <h1>Settings</h1>
        {loading ? (
          <p className="list-msg">Loading…</p>
        ) : user ? (
          <LanguageSettings key={user.id} saved={user.languages} />
        ) : (
          <p className="list-msg">
            {configured ? (
              <>
                <a href={loginUrl("/settings")}>Log in</a> to choose your settings.
              </>
            ) : (
              "Login isn't configured on this server, so there are no settings to change."
            )}
          </p>
        )}
      </main>
    </>
  );
}

function LanguageSettings({ saved }: { saved: string[] }) {
  const { saveLanguages } = useAuth();
  const navigate = useNavigate();
  const [checked, setChecked] = useState(() => saved.filter((l) => COMMON_LANGUAGES.includes(l)));
  const [other, setOther] = useState(() =>
    saved.filter((l) => !COMMON_LANGUAGES.includes(l)).join(", "),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const languages = normalizeLanguages([
    ...COMMON_LANGUAGES.filter((l) => checked.includes(l)),
    ...other.split(/[\s,]+/),
  ]);
  const invalid = other
    .split(/[\s,]+/)
    .filter((code) => code && normalizeLanguages([code]).length === 0);
  const dirty = languages.join(",") !== saved.join(",");

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await saveLanguages(languages);
    } catch (e: unknown) {
      setError(e instanceof FetchError ? e.message : "Saving failed. Try again.");
      setBusy(false);
      return;
    }
    // Back to the list the user came from, minus a `lang=any` override, so
    // the languages just saved take effect.
    const back = new URL(listHref(), window.location.origin);
    back.searchParams.delete("lang");
    const toast: ToastState = {
      toast:
        languages.length > 0
          ? `Languages saved: ${languages.map(languageName).join(", ")}`
          : "Languages cleared: the list isn’t filtered",
    };
    void navigate(back.pathname + back.search, { state: toast });
  }

  return (
    <form
      className="settings-card"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="settings-card-head">
        <h2>Languages you read</h2>
        <p className="settings-help">
          The candidate list filters pairs where either side is in a language you don't read. If
          nothing is selected here, the list shows everything.
        </p>
      </div>
      <fieldset className="settings-languages">
        <legend className="visually-hidden">Common languages</legend>
        {COMMON_LANGUAGES.map((code) => (
          <label key={code} className="settings-language">
            <input
              type="checkbox"
              checked={checked.includes(code)}
              onChange={(e) =>
                setChecked((c) => (e.target.checked ? [...c, code] : c.filter((l) => l !== code)))
              }
            />
            <span className="settings-language-name" title={languageName(code)}>
              {languageName(code)}
            </span>
            <span className="settings-code">{code}</span>
          </label>
        ))}
      </fieldset>
      <label className="field settings-other">
        <span>Other languages (Wikidata language codes, comma-separated)</span>
        <input
          className="creator-input"
          type="text"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          placeholder="e.g. eo, ca, pt-br"
          aria-invalid={invalid.length > 0 || undefined}
          aria-describedby="settings-other-hint"
        />
      </label>
      <p id="settings-other-hint" className="settings-help">
        {invalid.length > 0
          ? `Not language codes, ignored: ${invalid.join(", ")}`
          : languages.length > 0
            ? `Filtering to: ${languages.map(languageName).join(", ")}`
            : "No languages chosen: the list isn’t filtered."}
      </p>
      <div className="settings-actions">
        {error && (
          <span className="list-msg is-error" role="alert">
            {error}
          </span>
        )}
        <button type="submit" className="btn-primary" disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
