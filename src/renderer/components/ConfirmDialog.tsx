import { useEffect, useRef } from "react";

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shared destructive-action confirm (UI overhaul): one modal owns the
 * irreversible-delete UX so no delete fires on a single misclick.
 * Cancel is the safe default (autofocused); Esc also cancels.
 */
export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: Props): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="pt-modal-backdrop"
      onClick={() => {
        if (!busy) {
          onCancel();
        }
      }}
    >
      <div
        className="pt-modal pt-confirm"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="pt-section-head">
          <h3>{title}</h3>
        </div>
        <p className="pt-sub">{body}</p>
        <div className="pt-modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="pt-btn"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="pt-btn pt-btn-danger-solid"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
