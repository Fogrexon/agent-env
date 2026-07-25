import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function resolveAssetUri(
  src: string | undefined,
  assetBaseUrl?: string,
  transformImageUri?: (src: string) => string,
): string | undefined {
  if (!src) return src;
  if (transformImageUri) return transformImageUri(src);
  if (/^(https?:|data:|blob:|\/)/i.test(src)) return src;
  if (!assetBaseUrl) return src;
  const base = assetBaseUrl.endsWith('/') ? assetBaseUrl : `${assetBaseUrl}/`;
  return `${base}${src.replace(/^\.\//, '')}`;
}

export function MarkdownView({
  content,
  className,
  assetBaseUrl,
  transformImageUri,
}: {
  content: string;
  className?: string;
  /** Prefix for relative image/link paths (e.g. /api/runs/:id/files/workspace/). */
  assetBaseUrl?: string;
  transformImageUri?: (src: string) => string;
}) {
  if (!content.trim()) {
    return <div className={className ?? 'markdown-view empty'}>—</div>;
  }
  return (
    <div className={className ?? 'markdown-view'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) =>
          resolveAssetUri(url, assetBaseUrl, transformImageUri) ?? url
        }
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
