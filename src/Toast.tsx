// A one-off confirmation shown after a navigation, e.g. "Languages saved" on
// returning from Settings. The message rides in the history entry's state
// (`navigate(to, { state: { toast } })`); this shows it and, after a few
// seconds or on dismiss, replaces the entry without it, so going back or
// reloading doesn't show it again.
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

const TOAST_MS = 4000;

/** History state that carries a toast message. */
export interface ToastState {
  toast: string;
}

export default function Toast() {
  const location = useLocation();
  const navigate = useNavigate();
  const message = (location.state as Partial<ToastState> | null)?.toast;
  const { pathname, search } = location;

  if (!message) return null;
  return (
    <ToastMessage
      // Keyed on the history entry, so each toast starts unpaused: one that
      // vanished under the pointer never fires mouseleave.
      key={location.key}
      message={message}
      onDismiss={() => void navigate(pathname + search, { replace: true, state: null })}
    />
  );
}

function ToastMessage({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  // Held open while the pointer is over it or focus is in it (WCAG 2.2.1), so
  // it can be read at any pace or reached to dismiss; it times out afresh once
  // both have left.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(onDismiss, TOAST_MS);
    return () => clearTimeout(timer);
  }, [paused, onDismiss]);

  return (
    <div
      className="toast"
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
    >
      <span className="toast-icon" aria-hidden="true">
        ✓
      </span>
      {message}
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
