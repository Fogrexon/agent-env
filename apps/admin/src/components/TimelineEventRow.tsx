import { useEffect, useRef, useState } from 'react';
import type { AgentProgressEvent } from '@agent-env/shared';
import { MarkdownView } from './MarkdownView.js';

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function previewSnippet(text: string, max = 96): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}...`;
}

function streamTickerText(text: string, max = 220): string {
  const normalized = text.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return normalized.slice(-max);
}

function eventBody(event: AgentProgressEvent): string {
  return (
    event.message ??
    event.agentEvent?.text ??
    event.agentEvent?.errorMessage ??
    '-'
  );
}

function eventFullText(event: AgentProgressEvent): string {
  return event.agentEvent?.text ?? event.message ?? '';
}

function FoldToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className="event-toggle" onClick={onToggle}>
      {open ? 'Close' : 'Open'}
    </button>
  );
}

export function TimelineEventRow({
  event,
  runActive,
}: {
  event: AgentProgressEvent;
  runActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tickerRef = useRef<HTMLDivElement | null>(null);
  const [tickerOverflows, setTickerOverflows] = useState(false);
  const full = eventFullText(event);
  const payload = event.payload;
  const hasToolPayload = Boolean(
    payload &&
      (payload['config'] !== undefined ||
        payload['input'] !== undefined ||
        payload['tool'] !== undefined),
  );
  const isTextStream =
    event.kind === 'agent.event' &&
    Boolean(event.agentEvent?.text) &&
    !hasToolPayload;
  const live = Boolean(event.agentEvent?.partial) && runActive;
  const liveTicker = streamTickerText(full);
  const doneHint = previewSnippet(full) || eventBody(event);
  const isTerminal =
    event.kind === 'run.completed' || event.kind === 'run.failed';
  const terminalSummary =
    event.kind === 'run.completed'
      ? `completed${
          typeof payload?.['finalTextChars'] === 'number'
            ? ` / ${Number(payload['finalTextChars']).toLocaleString()} chars`
            : ''
        }`
      : previewSnippet(event.message ?? 'failed', 96) || 'failed';

  useEffect(() => {
    if (!live) {
      setTickerOverflows(false);
      return;
    }
    const el = tickerRef.current;
    if (!el) return;
    const measure = () => {
      setTickerOverflows(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [live, liveTicker]);

  return (
    <div
      className={`event kind-${event.kind.replace(/\./g, '-')}${
        live ? ' partial' : ''
      }${open ? ' expanded' : ''}`}
    >
      <div className="author">
        #{event.sequence} / {event.kind}
        {event.author ? ` / ${event.author}` : ''}
        {event.state ? ` / ${event.state}` : ''}
        {event.phase ? ` / ${event.phase}` : ''}
        {isTextStream || hasToolPayload ? (
          <FoldToggle open={open} onToggle={() => setOpen((v) => !v)} />
        ) : null}
        <span className="ts">
          {' '}
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {hasToolPayload ? (
        <div className="event-fold">
          <div className="event-fold-summary">
            {live ? (
              <span className="event-thinking-pulse" aria-hidden />
            ) : null}
            <span>{event.message ?? 'tool'}</span>
            {!open && payload?.['tool'] ? (
              <span className="event-fold-meta">
                {String(payload['tool'])}
              </span>
            ) : null}
          </div>
          {open ? (
            <div className="event-tool">
              {payload?.['input'] !== undefined ? (
                <pre className="event-json">
                  <span className="event-json-label">input</span>
                  {formatJson(payload['input'])}
                </pre>
              ) : null}
              {payload?.['config'] !== undefined ? (
                <pre className="event-json">
                  <span className="event-json-label">config</span>
                  {formatJson(payload['config'])}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : isTextStream ? (
        <div className={`event-fold${live ? ' is-live' : ''}`}>
          <div className="event-fold-summary">
            {live ? <span className="event-thinking-pulse" aria-hidden /> : null}
            {live ? (
              <div
                ref={tickerRef}
                className={`event-stream-ticker${
                  tickerOverflows ? '' : ' is-short'
                }`}
                title={liveTicker}
              >
                <span>{liveTicker}</span>
              </div>
            ) : (
              <span className="event-fold-delta">{doneHint}</span>
            )}
            <span className="event-fold-meta">
              {full.length.toLocaleString()} chars
            </span>
          </div>
          {open ? (
            <MarkdownView
              content={full}
              className="markdown-view compact event-fold-body"
            />
          ) : null}
        </div>
      ) : isTerminal ? (
        <div className="event-plain">{terminalSummary}</div>
      ) : (
        <div className="event-plain">{previewSnippet(eventBody(event), 120)}</div>
      )}
    </div>
  );
}
