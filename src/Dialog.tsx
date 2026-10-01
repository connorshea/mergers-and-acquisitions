import { type ReactNode, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

// A minimal modal shell on the native <dialog>, portaled to <body> so it can be
// opened from inside a table row. showModal() does the accessibility work: the
// page behind goes inert (Tab stays inside), and screen readers get a modal.
// Focus moves to the dialog itself, so its title is announced and the next Tab
// reaches its first control; on close it returns to whatever had it before.
// Closes on backdrop click or Escape (callers pass a no-op `onClose` while a
// request is in flight).
export default function Dialog({
  title,
  wide,
  onClose,
  children,
}: {
  title: string;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // A layout effect, so the cleanup runs while the dialog is still in the DOM.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.focus();
    return () => {
      dialog.close();
      // The opener may be gone (a dismissed row, an action hidden by the edit).
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={ref}
      className={`modal${wide ? " is-wide" : ""}`}
      aria-labelledby={titleId}
      tabIndex={-1}
      // Escape: let the caller decide (it may be mid-request), not the browser.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // Chrome closes the dialog anyway on a second Escape with no click in
      // between, whatever the cancel handler says. Reopen it while it's still
      // rendered; the caller unmounts it to close it.
      onClose={() => {
        const dialog = ref.current;
        if (dialog?.isConnected && !dialog.open) dialog.showModal();
      }}
      // A click on the backdrop targets the dialog itself, outside its box.
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const box = e.currentTarget.getBoundingClientRect();
        const inside =
          e.clientX >= box.left &&
          e.clientX <= box.right &&
          e.clientY >= box.top &&
          e.clientY <= box.bottom;
        if (!inside) onClose();
      }}
    >
      <h2 id={titleId} className="modal-title">
        {title}
      </h2>
      {children}
    </dialog>,
    document.body,
  );
}
