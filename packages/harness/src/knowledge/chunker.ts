import { extname } from 'node:path';
import type {
  KnowledgeAcl,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeLocation,
  KnowledgeSourceKind,
} from '@agent-env/shared';
import { knowledgeChunkUri } from '@agent-env/shared';
import { sha256Hex, stableChunkId } from './hash.js';
import { approxTokenCount } from './tokenize.js';

export interface ChunkerInput {
  collectionId: string;
  documentId: string;
  title: string;
  text: string;
  location: Omit<KnowledgeLocation, 'headingPath'> & {
    headingPath?: string[];
  };
  sourceKind: KnowledgeSourceKind;
  acl: KnowledgeAcl;
  /** Target child size in approximate tokens. */
  childTokens?: number;
  parentTokens?: number;
  overlapTokens?: number;
}

export interface ChunkerResult {
  parents: KnowledgeChunk[];
  children: KnowledgeChunk[];
}

function buildContextPrefix(input: {
  relPath?: string;
  title: string;
  headingPath: readonly string[];
}): string {
  const parts = [
    input.relPath ? `File: ${input.relPath}` : undefined,
    `Title: ${input.title}`,
    input.headingPath.length > 0
      ? `Section: ${input.headingPath.join(' > ')}`
      : undefined,
  ].filter(Boolean);
  return parts.join('\n');
}

function splitLinesWithOffsets(text: string): Array<{
  line: string;
  lineNo: number;
}> {
  const lines = text.split(/\r?\n/);
  return lines.map((line, i) => ({ line, lineNo: i + 1 }));
}

function makeChunk(args: {
  collectionId: string;
  documentId: string;
  kind: 'parent' | 'child';
  ordinal: number;
  text: string;
  contextPrefix: string;
  location: KnowledgeLocation;
  acl: KnowledgeAcl;
  parentId?: string;
  metadata?: Record<string, unknown>;
}): KnowledgeChunk {
  const contentHash = sha256Hex(args.text);
  const id = stableChunkId(
    args.documentId,
    args.kind,
    args.ordinal,
    contentHash,
  );
  const indexedText = args.contextPrefix
    ? `${args.contextPrefix}\n\n${args.text}`
    : args.text;
  return {
    id,
    documentId: args.documentId,
    collectionId: args.collectionId,
    kind: args.kind,
    parentId: args.parentId,
    contextPrefix: args.contextPrefix,
    text: args.text,
    indexedText,
    location: args.location,
    contentHash,
    tokenCount: approxTokenCount(indexedText),
    acl: args.acl,
    metadata: args.metadata ?? {},
  };
}

/**
 * Structure-aware chunking:
 * - Markdown: split on ATX headings into parent sections, then window children
 * - Code/text: sliding windows with overlap
 */
export function chunkDocument(input: ChunkerInput): ChunkerResult {
  const childTokens = input.childTokens ?? 220;
  const parentTokens = input.parentTokens ?? 900;
  const overlapTokens = input.overlapTokens ?? 40;
  const baseHeading = input.location.headingPath ?? [];

  if (
    input.sourceKind === 'markdown' ||
    input.location.relPath?.toLowerCase().endsWith('.md')
  ) {
    return chunkMarkdown(input, {
      childTokens,
      parentTokens,
      overlapTokens,
      baseHeading,
    });
  }
  return chunkPlain(input, {
    childTokens,
    parentTokens,
    overlapTokens,
    baseHeading,
  });
}

function chunkMarkdown(
  input: ChunkerInput,
  opts: {
    childTokens: number;
    parentTokens: number;
    overlapTokens: number;
    baseHeading: readonly string[];
  },
): ChunkerResult {
  const lines = splitLinesWithOffsets(input.text);
  type Section = {
    headingPath: string[];
    startLine: number;
    endLine: number;
    body: string[];
  };
  const sections: Section[] = [];
  let current: Section = {
    headingPath: [...opts.baseHeading],
    startLine: 1,
    endLine: 1,
    body: [],
  };
  const stack: Array<{ level: number; title: string }> = [];

  const flush = (endLine: number): void => {
    const body = current.body.join('\n').trim();
    if (!body) return;
    sections.push({
      headingPath: [...current.headingPath],
      startLine: current.startLine,
      endLine,
      body: current.body,
    });
  };

  for (const { line, lineNo } of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush(lineNo - 1);
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        stack.pop();
      }
      stack.push({ level, title });
      current = {
        headingPath: [...opts.baseHeading, ...stack.map((s) => s.title)],
        startLine: lineNo,
        endLine: lineNo,
        body: [line],
      };
      continue;
    }
    if (current.body.length === 0) current.startLine = lineNo;
    current.body.push(line);
    current.endLine = lineNo;
  }
  flush(lines.length === 0 ? 1 : lines[lines.length - 1]!.lineNo);

  if (sections.length === 0) {
    return chunkPlain(input, opts);
  }

  const parents: KnowledgeChunk[] = [];
  const children: KnowledgeChunk[] = [];
  let parentOrdinal = 0;
  let childOrdinal = 0;

  for (const section of sections) {
    const sectionText = section.body.join('\n').trim();
    if (!sectionText) continue;
    // Oversized sections: split into parent-sized windows.
    const parentWindows = windowText(sectionText, section.startLine, {
      maxTokens: opts.parentTokens,
      overlapTokens: opts.overlapTokens,
    });
    for (const win of parentWindows) {
      const contextPrefix = buildContextPrefix({
        relPath: input.location.relPath,
        title: input.title,
        headingPath: section.headingPath,
      });
      const location: KnowledgeLocation = {
        sourceUri: input.location.sourceUri,
        relPath: input.location.relPath,
        startLine: win.startLine,
        endLine: win.endLine,
        startPage: input.location.startPage,
        endPage: input.location.endPage,
        headingPath: [...section.headingPath],
      };
      const parent = makeChunk({
        collectionId: input.collectionId,
        documentId: input.documentId,
        kind: 'parent',
        ordinal: parentOrdinal++,
        text: win.text,
        contextPrefix,
        location,
        acl: input.acl,
      });
      parents.push(parent);

      const childWindows = windowText(win.text, win.startLine, {
        maxTokens: opts.childTokens,
        overlapTokens: opts.overlapTokens,
      });
      for (const childWin of childWindows) {
        children.push(
          makeChunk({
            collectionId: input.collectionId,
            documentId: input.documentId,
            kind: 'child',
            ordinal: childOrdinal++,
            text: childWin.text,
            contextPrefix,
            location: {
              ...location,
              startLine: childWin.startLine,
              endLine: childWin.endLine,
            },
            acl: input.acl,
            parentId: parent.id,
          }),
        );
      }
    }
  }

  return { parents, children };
}

function chunkPlain(
  input: ChunkerInput,
  opts: {
    childTokens: number;
    parentTokens: number;
    overlapTokens: number;
    baseHeading: readonly string[];
  },
): ChunkerResult {
  const parents: KnowledgeChunk[] = [];
  const children: KnowledgeChunk[] = [];
  let parentOrdinal = 0;
  let childOrdinal = 0;
  const contextPrefix = buildContextPrefix({
    relPath: input.location.relPath,
    title: input.title,
    headingPath: opts.baseHeading,
  });
  const parentWindows = windowText(input.text, 1, {
    maxTokens: opts.parentTokens,
    overlapTokens: opts.overlapTokens,
  });
  for (const win of parentWindows) {
    const location: KnowledgeLocation = {
      sourceUri: input.location.sourceUri,
      relPath: input.location.relPath,
      startLine: win.startLine,
      endLine: win.endLine,
      startPage: input.location.startPage,
      endPage: input.location.endPage,
      headingPath: [...opts.baseHeading],
    };
    const parent = makeChunk({
      collectionId: input.collectionId,
      documentId: input.documentId,
      kind: 'parent',
      ordinal: parentOrdinal++,
      text: win.text,
      contextPrefix,
      location,
      acl: input.acl,
    });
    parents.push(parent);
    const childWindows = windowText(win.text, win.startLine, {
      maxTokens: opts.childTokens,
      overlapTokens: opts.overlapTokens,
    });
    for (const childWin of childWindows) {
      children.push(
        makeChunk({
          collectionId: input.collectionId,
          documentId: input.documentId,
          kind: 'child',
          ordinal: childOrdinal++,
          text: childWin.text,
          contextPrefix,
          location: {
            ...location,
            startLine: childWin.startLine,
            endLine: childWin.endLine,
          },
          acl: input.acl,
          parentId: parent.id,
        }),
      );
    }
  }
  return { parents, children };
}

function windowText(
  text: string,
  startLineBase: number,
  opts: { maxTokens: number; overlapTokens: number },
): Array<{ text: string; startLine: number; endLine: number }> {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];
  const windows: Array<{ text: string; startLine: number; endLine: number }> =
    [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let tokens = 0;
    while (end < lines.length) {
      const nextTokens = approxTokenCount(lines[end]!);
      if (tokens > 0 && tokens + nextTokens > opts.maxTokens) break;
      tokens += nextTokens;
      end += 1;
      if (tokens >= opts.maxTokens) break;
    }
    if (end === start) end = start + 1;
    const slice = lines.slice(start, end);
    windows.push({
      text: slice.join('\n'),
      startLine: startLineBase + start,
      endLine: startLineBase + end - 1,
    });
    if (end >= lines.length) break;
    // Step with overlap.
    let backTokens = 0;
    let nextStart = end;
    for (let i = end - 1; i >= start; i -= 1) {
      backTokens += approxTokenCount(lines[i]!);
      nextStart = i;
      if (backTokens >= opts.overlapTokens) break;
    }
    start = Math.max(nextStart, start + 1);
  }
  return windows;
}

export function inferSourceKind(path: string): KnowledgeSourceKind {
  switch (extname(path).toLowerCase()) {
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
    case '.py':
    case '.go':
    case '.rs':
    case '.java':
    case '.kt':
    case '.c':
    case '.cpp':
    case '.h':
    case '.hpp':
    case '.cs':
    case '.rb':
    case '.php':
    case '.sh':
    case '.ps1':
    case '.sql':
      return 'code';
    case '.json':
      return 'json';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.pdf':
      return 'pdf';
    case '.txt':
    case '.csv':
    case '.tsv':
    case '.log':
      return 'text';
    default:
      return 'other';
  }
}

export function citationFromChunk(
  chunk: KnowledgeChunk,
  document?: KnowledgeDocument,
): import('@agent-env/shared').KnowledgeCitation {
  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    collectionId: chunk.collectionId,
    title: document?.title ?? chunk.location.relPath ?? chunk.documentId,
    uri: knowledgeChunkUri(
      chunk.collectionId,
      chunk.documentId,
      chunk.id,
    ),
    sourceUri: chunk.location.sourceUri,
    startLine: chunk.location.startLine,
    endLine: chunk.location.endLine,
    startPage: chunk.location.startPage,
    endPage: chunk.location.endPage,
    headingPath: chunk.location.headingPath ?? [],
    excerpt: chunk.text.slice(0, 400),
  };
}
