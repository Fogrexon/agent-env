import { useEffect, useMemo, useState } from 'react';
import { MarkdownView } from './MarkdownView';
import { ExpandablePreview, MarkdownReportReader } from './ReportReader';

export interface RunFileEntry {
  path: string;
  bytes: number;
  mime: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(mime: string, path: string): boolean {
  if (mime.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
}

function isMarkdown(mime: string, path: string): boolean {
  return mime === 'text/markdown' || path.toLowerCase().endsWith('.md');
}

function isHtml(mime: string, path: string): boolean {
  return (
    mime === 'text/html' ||
    path.toLowerCase().endsWith('.html') ||
    path.toLowerCase().endsWith('.htm')
  );
}

function isPdf(mime: string, path: string): boolean {
  return mime === 'application/pdf' || path.toLowerCase().endsWith('.pdf');
}

/** Prefer agent-authored report files over harness final.md dump. */
function pickPreferredReport(list: RunFileEntry[]): RunFileEntry | undefined {
  return (
    list.find((f) => f.path === 'workspace/report.html') ??
    list.find((f) => f.path === 'workspace/report.htm') ??
    list.find((f) => f.path === 'workspace/report.md') ??
    list.find((f) => f.path === 'final.md') ??
    list.find((f) => isHtml(f.mime, f.path) && /report/i.test(f.path)) ??
    list.find((f) => isMarkdown(f.mime, f.path))
  );
}

function fileUrl(runId: string, path: string, download = false): string {
  const encoded = path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const base = `/api/runs/${runId}/files/${encoded}`;
  return download ? `${base}?download=1` : base;
}

function assetBaseForFile(runId: string, filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  const dir = slash >= 0 ? filePath.slice(0, slash + 1) : '';
  return `/api/runs/${runId}/files/${dir}`;
}

function normalizeMd(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/**
 * Final report + artifact file browser.
 * `final.md` is the harness dump of agent finalText — same content as「最終結果」—
 * so we show one primary reader and avoid a duplicate preview.
 */
export function RunArtifactsPanel({
  runId,
  fallbackFinalText,
}: {
  runId: string;
  /** Live / snapshot finalText (same bytes eventually written to final.md). */
  fallbackFinalText?: string;
}) {
  const [files, setFiles] = useState<RunFileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [primaryPath, setPrimaryPath] = useState<string | null>(null);
  const [primaryText, setPrimaryText] = useState<string | null>(null);
  const [extraPath, setExtraPath] = useState<string | null>(null);
  const [extraText, setExtraText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPrimaryPath(null);
    setPrimaryText(null);
    setExtraPath(null);
    setExtraText(null);
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/files`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          if (!cancelled) {
            setError(body.error ?? `HTTP ${res.status}`);
            setFiles([]);
          }
          return;
        }
        const data = (await res.json()) as { files?: RunFileEntry[] };
        if (!cancelled) {
          const list = data.files ?? [];
          setFiles(list);
          const preferred = pickPreferredReport(list);
          setPrimaryPath(preferred?.path ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    if (!primaryPath) {
      setPrimaryText(null);
      return;
    }
    const entry = files.find((f) => f.path === primaryPath);
    if (!entry || !isMarkdown(entry.mime, entry.path)) {
      setPrimaryText(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(fileUrl(runId, primaryPath));
        if (!res.ok) return;
        const text = await res.text();
        if (!cancelled) setPrimaryText(text);
      } catch {
        if (!cancelled) setPrimaryText(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, primaryPath, files]);

  useEffect(() => {
    if (!extraPath || extraPath === primaryPath) {
      setExtraText(null);
      return;
    }
    const entry = files.find((f) => f.path === extraPath);
    if (!entry || !isMarkdown(entry.mime, entry.path)) {
      setExtraText(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(fileUrl(runId, extraPath));
        if (!res.ok) return;
        const text = await res.text();
        if (!cancelled) setExtraText(text);
      } catch {
        if (!cancelled) setExtraText(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, extraPath, primaryPath, files]);

  const primaryEntry = primaryPath
    ? files.find((f) => f.path === primaryPath)
    : undefined;

  const reportMarkdown = useMemo(() => {
    if (primaryEntry && isMarkdown(primaryEntry.mime, primaryEntry.path)) {
      if (primaryText !== null) return primaryText;
    }
    return fallbackFinalText?.trim() ? fallbackFinalText : null;
  }, [primaryEntry, primaryText, fallbackFinalText]);

  const reportAssetBase = primaryEntry
    ? assetBaseForFile(runId, primaryEntry.path)
    : `/api/runs/${runId}/files/workspace/`;

  const reportSourceLabel = primaryEntry
    ? primaryEntry.path
    : fallbackFinalText?.trim()
      ? '実行結果'
      : null;

  const extraEntry =
    extraPath && extraPath !== primaryPath
      ? files.find((f) => f.path === extraPath)
      : undefined;

  const extraIsDuplicate =
    extraEntry &&
    isMarkdown(extraEntry.mime, extraEntry.path) &&
    extraText !== null &&
    reportMarkdown !== null &&
    normalizeMd(extraText) === normalizeMd(reportMarkdown);

  const onSelectFile = (path: string) => {
    if (path === primaryPath) {
      setExtraPath(null);
      return;
    }
    // final.md is almost always the same as 最終結果 — treat as primary focus.
    if (path === 'final.md' && (primaryPath === 'final.md' || reportMarkdown)) {
      setExtraPath(null);
      return;
    }
    setExtraPath(path);
  };

  if (loading && !fallbackFinalText?.trim()) {
    return (
      <div className="artifacts">
        <h2>成果物</h2>
        <p className="muted">読み込み中…</p>
      </div>
    );
  }

  if (error && files.length === 0 && !fallbackFinalText?.trim()) {
    return (
      <div className="artifacts">
        <h2>成果物</h2>
        <p className="error">{error}</p>
      </div>
    );
  }

  return (
    <div className="artifacts">
      {primaryEntry && isHtml(primaryEntry.mime, primaryEntry.path) ? (
        <ExpandablePreview
          title="最終結果"
          toolbarExtra={
            <span className="report-source muted">{primaryEntry.path}</span>
          }
          modalChildren={
            <iframe
              className="artifact-html artifact-html-modal"
              title={primaryEntry.path}
              src={fileUrl(runId, primaryEntry.path)}
              sandbox=""
              referrerPolicy="no-referrer"
            />
          }
        >
          <iframe
            className="artifact-html"
            title={primaryEntry.path}
            src={fileUrl(runId, primaryEntry.path)}
            sandbox=""
            referrerPolicy="no-referrer"
          />
        </ExpandablePreview>
      ) : reportMarkdown ? (
        <MarkdownReportReader
          title={
            reportSourceLabel
              ? `最終結果 · ${reportSourceLabel}`
              : '最終結果'
          }
          content={reportMarkdown}
          assetBaseUrl={reportAssetBase}
        />
      ) : null}

      <h2>成果物</h2>
      {error ? <p className="error">{error}</p> : null}
      {files.length === 0 ? (
        <p className="muted">
          {loading ? '読み込み中…' : 'ファイルなし'}
        </p>
      ) : (
        <ul className="artifacts-list">
          {files.map((f) => {
            const isPrimary = f.path === primaryPath;
            const isFinalDump = f.path === 'final.md';
            const selected =
              extraPath === f.path || (isPrimary && !extraPath);
            return (
              <li key={f.path}>
                <button
                  type="button"
                  className={
                    selected ? 'artifact-name active' : 'artifact-name'
                  }
                  onClick={() => onSelectFile(f.path)}
                >
                  {f.path}
                  {isPrimary ? (
                    <span className="artifact-badge">レポート</span>
                  ) : isFinalDump ? (
                    <span className="artifact-badge muted-badge">
                      最終結果と同じ
                    </span>
                  ) : null}
                </button>
                <span className="artifact-meta">{formatBytes(f.bytes)}</span>
                <a
                  className="artifact-dl"
                  href={fileUrl(runId, f.path, true)}
                  download={f.path.split('/').pop()}
                >
                  DL
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {extraEntry && !extraIsDuplicate ? (
        <div className="artifact-preview">
          {isMarkdown(extraEntry.mime, extraEntry.path) &&
          extraText !== null ? (
            <ExpandablePreview
              title={`プレビュー · ${extraEntry.path}`}
              toolbarExtra={
                <a
                  className="artifact-dl"
                  href={fileUrl(runId, extraEntry.path, true)}
                  download={extraEntry.path.split('/').pop()}
                >
                  DL
                </a>
              }
              modalChildren={
                <MarkdownView
                  content={extraText}
                  className="markdown-view report-modal-md"
                  assetBaseUrl={assetBaseForFile(runId, extraEntry.path)}
                />
              }
            >
              <MarkdownView
                content={extraText}
                className="markdown-view output"
                assetBaseUrl={assetBaseForFile(runId, extraEntry.path)}
              />
            </ExpandablePreview>
          ) : isHtml(extraEntry.mime, extraEntry.path) ? (
            <ExpandablePreview
              title={`プレビュー · ${extraEntry.path}`}
              toolbarExtra={
                <a
                  className="artifact-dl"
                  href={fileUrl(runId, extraEntry.path, true)}
                  download={extraEntry.path.split('/').pop()}
                >
                  DL
                </a>
              }
              modalChildren={
                <iframe
                  className="artifact-html artifact-html-modal"
                  title={extraEntry.path}
                  src={fileUrl(runId, extraEntry.path)}
                  sandbox=""
                  referrerPolicy="no-referrer"
                />
              }
            >
              <iframe
                className="artifact-html"
                title={extraEntry.path}
                src={fileUrl(runId, extraEntry.path)}
                sandbox=""
                referrerPolicy="no-referrer"
              />
            </ExpandablePreview>
          ) : (
            <>
              <h3>プレビュー · {extraEntry.path}</h3>
              {isImage(extraEntry.mime, extraEntry.path) ? (
                <img
                  className="artifact-image"
                  src={fileUrl(runId, extraEntry.path)}
                  alt={extraEntry.path}
                />
              ) : isPdf(extraEntry.mime, extraEntry.path) ? (
                <p>
                  <a
                    href={fileUrl(runId, extraEntry.path)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    PDF を開く
                  </a>
                  {' · '}
                  <a href={fileUrl(runId, extraEntry.path, true)} download>
                    ダウンロード
                  </a>
                </p>
              ) : (
                <p className="muted">
                  この形式はプレビュー非対応です。DL から取得してください。
                </p>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
