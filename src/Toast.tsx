// A one-off confirmation shown after a navigation, e.g. "Languages saved" on
// returning from Settings. The message rides in the history entry's state
// (`navigate(to, { state: { toast } })`); this shows it and, after a few
// seconds or on dismiss, replaces the entry without it, so going back or
// reloading doesn't show it again.
import { useEffect } from "react";
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

  const dismiss = () => void navigate(pathname + search, { replace: true, state: null });

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(
      () => void navigate(pathname + search, { replace: true, state: null }),
      TOAST_MS,
    );
    return () => clearTimeout(timer);
  }, [message, navigate, pathname, search]);

  if (!message) return null;
  return (
    <div className="toast" role="status">
      <span className="toast-icon" aria-hidden="true">
        ✓
      </span>
      {message}
      <button type="button" className="toast-close" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
