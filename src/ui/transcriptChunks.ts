/** 32-bit FNV-1a over a string's UTF-16 code units. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * The transcript's blocks in chunks of about 64. A chunk starts at a block whose id hashes to a multiple of 64, so where
 * one starts depends only on that block: adding or removing a block changes only the chunk that holds it, and a chunk
 * keyed by its first block's id keeps its key.
 */
export function chunkBlocks<T extends { id: string }>(blocks: T[]): T[][] {
  const chunks: T[][] = [];
  blocks.forEach((b, i) => {
    if (i === 0 || fnv1a(b.id) % 64 === 0) chunks.push([b]);
    else chunks[chunks.length - 1].push(b);
  });
  return chunks;
}
