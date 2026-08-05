import { createHash } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function stableDocumentId(collectionId: string, relPath: string): string {
  return sha256Hex(`${collectionId}::${relPath.replace(/\\/g, '/')}`).slice(
    0,
    24,
  );
}

export function stableChunkId(
  documentId: string,
  kind: string,
  ordinal: number,
  contentHash: string,
): string {
  return sha256Hex(`${documentId}:${kind}:${ordinal}:${contentHash}`).slice(
    0,
    28,
  );
}
