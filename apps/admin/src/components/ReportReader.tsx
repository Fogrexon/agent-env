import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { MarkdownView } from './MarkdownView';

/**
 * Inline preview with an expand control that opens a full-viewport reader modal.
 * Used for final agent output and artifact markdown/html previews.
 */
export function ExpandablePreview({
  title,
  children,
  modalChildren,
  toolbarExtra,
}: {
  title: string;
  children: ReactNode;
  /** Defaults to `children` when omitted. */
  modalChildren?: ReactNode;
  toolbarExtra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      previouslyFocused.current?.focus?.();
    };
  }, [open, close]);

  return (
    <div className="expandable-preview">
      <div className="expandable-preview-toolbar">
        <h2 className="expandable-preview-title">{title}</h2>
        <div className="expandable-preview-actions">
          {toolbarExtra}
          <button
            type="button"
            className="btn-expand"
            onClick={() => setOpen(true)}
          >
            拡大
          </button>
        </div>
      </div>
      <div className="expandable-preview-inline">{children}</div>

      {open
        ? createPortal(
            <div
              className="report-modal-root"
              role="presentation"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) close();
              }}
            >
              <div
                className="report-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
              >
                <header className="report-modal-header">
                  <h2 id={titleId} className="report-modal-title">
                    {title}
                  </h2>
                  <button
                    ref={closeRef}
                    type="button"
                    className="btn-modal-close"
                    onClick={close}
                  >
                    閉じる
                    <kbd>Esc</kbd>
                  </button>
                </header>
                <div className="report-modal-body">
                  {modalChildren ?? children}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Markdown report with clamped inline preview + roomy reader modal. */
export function MarkdownReportReader({
  title,
  content,
  assetBaseUrl,
}: {
  title: string;
  content: string;
  assetBaseUrl?: string;
}) {
  return (
    <ExpandablePreview
      title={title}
      modalChildren={
        <MarkdownView
          content={content}
          className="markdown-view report-modal-md"
          assetBaseUrl={assetBaseUrl}
        />
      }
    >
      <MarkdownView
        content={content}
        className="markdown-view output"
        assetBaseUrl={assetBaseUrl}
      />
    </ExpandablePreview>
  );
}
