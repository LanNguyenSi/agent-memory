// Markdown-aware chunking of a memory body for chunked embeddings
// (schema v3: the `chunks` + `chunk_vec` tables in index-store.ts).
//
// Why: the per-memory document vector embeds name + description + body
// cut at 8,000 chars, so text deeper than that in a long memory is
// invisible to semantic search. Chunking gives every part of the body its
// own vector; a memory then scores by its best chunk (see the merge in
// src/embed/indexer.ts's semanticSearch).
//
// Rules (pinned by tests/chunking.test.ts):
// - split the body at markdown block boundaries: headings, top-level
//   list items (`- `, `* `, `1. ` at column 0), blank-line paragraphs;
// - merge adjacent pieces up to CHUNK_TARGET_CHARS; a chunk never ENDS on
//   a dangling heading (the heading moves to the next chunk with its
//   content; at the very end of the body there is no next chunk, and the
//   trailing heading section is kept as the last chunk, never dropped);
// - a single piece longer than CHUNK_MAX_CHARS is split further at a
//   line boundary, then a sentence boundary, then (last resort, e.g. one
//   huge line with no break at all) hard at the cap; CHUNK_MAX_CHARS is
//   a HARD upper bound on EVERY chunk: a carried heading run that no
//   longer fits together with the next piece is emitted as one
//   heading-only chunk of its own;
// - no body text is ever lost: every non-whitespace character of the
//   body lies inside some chunk;
// - a fenced code block (``` or ~~~) is one atomic piece: the boundaries
//   inside it never split, and it is only split further when the block
//   alone exceeds CHUNK_MAX_CHARS;
// - an empty (or whitespace-only) body produces zero chunks; a body that
//   fits after merging produces exactly one chunk.
//
// Every returned chunk satisfies `body.slice(offset, offset + text.length)
// === text` (trailing whitespace trimmed), so a caller can point a user at
// the matching region of the file.

// Chunk sizes are deliberately fixed constants, not env knobs: the
// semantic score is a max over chunks, so chunk size only trades recall
// granularity against embed cost, and a per-corpus tuning knob would not
// change which texts are findable at all.
const CHUNK_TARGET_CHARS = 1500;
const CHUNK_MAX_CHARS = 3000;

// Version of the chunking algorithm. Bump it whenever chunk boundaries
// change (a rule change in chunkBody, or CHUNK_TARGET_CHARS /
// CHUNK_MAX_CHARS): rebuildIndex stamps it in the index and re-chunks every
// memory when the stored stamp is missing or differs, so existing indexes do
// not keep chunks cut by the old chunker.
const CHUNKER_VERSION = 1;

// One chunk of a memory body, as produced by chunkBody: `index` is its
// 0-based position in the body, `offset` the character offset of its first
// character into the RAW body, `text` the chunk itself.
interface MemoryChunk {
  index: number;
  offset: number;
  text: string;
}

// A body range that must stay together through the merge pass. `heading`
// marks a piece whose first line is a heading, so the merge can avoid
// ending a chunk with a heading that got separated from its content.
interface Piece {
  start: number;
  end: number;
  heading: boolean;
}

// A line beginning with 1-6 `#` followed by whitespace or line end.
const HEADING_RE = /^#{1,6}(\s|$)/;
// A top-level list item at column 0: `- `, `* ` or `1. `. Indented list
// items (nested under a parent item) are NOT boundaries.
const TOP_LEVEL_ITEM_RE = /^(?:[-*]|\d+\.)\s/;
// Opening/closing line of a fenced code block.
const FENCE_RE = /^\s*(?:```|~~~)/;
// Sentence end candidates for splitting a single over-long line.
const SENTENCE_BREAK_RE = /[.!?)\]]\s+/g;

function isBlank(text: string): boolean {
  return text.trim() === '';
}

// Cuts the body into atomic pieces at block boundaries, each piece a
// contiguous [start, end) range of the body.
function splitPieces(body: string): Piece[] {
  const pieces: Piece[] = [];
  let pieceStart = -1;
  let pieceHeading = false;
  let inFence = false;
  const close = (end: number): void => {
    if (pieceStart >= 0) {
      pieces.push({ start: pieceStart, end, heading: pieceHeading });
      pieceStart = -1;
      pieceHeading = false;
    }
  };
  let pos = 0;
  while (pos < body.length) {
    const nl = body.indexOf('\n', pos);
    const lineEnd = nl === -1 ? body.length : nl + 1;
    const text = body.slice(pos, nl === -1 ? body.length : nl);
    if (FENCE_RE.test(text)) {
      // A fence line is a boundary in its own right (the block becomes one
      // atomic piece), and it toggles the in-fence state that suppresses
      // every other boundary check below.
      if (!inFence) {
        close(pos);
        pieceStart = pos;
        inFence = true;
      } else {
        inFence = false;
        close(lineEnd);
      }
    } else if (!inFence && isBlank(text)) {
      close(pos);
    } else if (!inFence && (HEADING_RE.test(text) || TOP_LEVEL_ITEM_RE.test(text))) {
      close(pos);
      pieceStart = pos;
      pieceHeading = HEADING_RE.test(text);
    } else if (pieceStart < 0) {
      pieceStart = pos;
    }
    pos = lineEnd;
  }
  close(body.length);
  return pieces;
}

// Position just past the END of the last sentence break inside
// [from, until), or -1 when the window holds none. A break near the end of
// the window is the desired one: it fills the chunk up to the cap.
function lastSentenceBreak(body: string, from: number, until: number): number {
  const window = body.slice(from, until);
  let cut = -1;
  let m: RegExpExecArray | null;
  SENTENCE_BREAK_RE.lastIndex = 0;
  while ((m = SENTENCE_BREAK_RE.exec(window)) !== null) {
    cut = from + m.index + m[0].length;
  }
  return cut;
}

// Split one piece longer than CHUNK_MAX_CHARS: prefer line boundaries,
// then sentence boundaries inside a single over-long line, then a hard
// cut at the cap (only reachable for content with no break at all).
function splitOversizedPiece(body: string, p: Piece): Piece[] {
  const parts: Piece[] = [];
  let start = p.start;
  let pos = p.start;
  const push = (from: number, to: number): void => {
    // Only the first sub-piece can still be "the heading" of the original
    // piece; the rest are plain continuation content.
    parts.push({ start: from, end: to, heading: parts.length === 0 && p.heading });
  };
  while (pos < p.end) {
    const nl = body.indexOf('\n', pos);
    const lineEnd = nl === -1 || nl >= p.end ? p.end : nl + 1;
    if (lineEnd - pos > CHUNK_MAX_CHARS) {
      // The line alone busts the cap: flush what came before it, then cut
      // the line itself.
      if (pos > start) push(start, pos);
      let cutStart = pos;
      while (lineEnd - cutStart > CHUNK_MAX_CHARS) {
        const windowEnd = cutStart + CHUNK_MAX_CHARS;
        let cut = lastSentenceBreak(body, cutStart, windowEnd);
        if (cut <= cutStart) cut = windowEnd;
        push(cutStart, cut);
        cutStart = cut;
      }
      start = cutStart;
      pos = lineEnd;
      continue;
    }
    if (lineEnd - start > CHUNK_MAX_CHARS) {
      push(start, pos);
      start = pos;
    }
    pos = lineEnd;
  }
  if (p.end > start) push(start, p.end);
  return parts;
}

function splitOversized(body: string, pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    if (p.end - p.start <= CHUNK_MAX_CHARS) out.push(p);
    else out.push(...splitOversizedPiece(body, p));
  }
  return out;
}

// Merge adjacent pieces into chunks of about CHUNK_TARGET_CHARS.
function mergePieces(body: string, pieces: Piece[]): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  // Emit the body range [first.start, last.end) as one chunk (trailing
  // whitespace trimmed; a whitespace-only range produces nothing).
  const emitRange = (first: Piece, last: Piece): void => {
    const text = body
      .slice(first.start, last.end)
      .replace(/\s+$/, '');
    if (text !== '') chunks.push({ index: chunks.length, offset: first.start, text });
  };
  // A heading at the very end of a chunk is separated from the content
  // it introduces, so hand it (and any other trailing headings) to the
  // next chunk instead - unless the chunk is nothing but headings.
  // Returns the carried heading pieces (always a run of headings, and
  // every non-carried piece of `list` was emitted as a chunk).
  const emit = (list: Piece[]): Piece[] => {
    let n = list.length;
    while (n > 1 && list[n - 1].heading) n--;
    emitRange(list[0], list[n - 1]);
    return list.slice(n);
  };
  let cur: Piece[] = [];
  for (const p of pieces) {
    if (cur.length === 0) {
      cur = [p];
      continue;
    }
    if (p.end - cur[0].start <= CHUNK_TARGET_CHARS) {
      cur.push(p);
      continue;
    }
    cur = emit(cur).concat([p]);
    // CHUNK_MAX_CHARS is a HARD upper bound on every chunk: the carried
    // heading run was prepended to p without a size check, and a run of
    // long heading pieces (each <= CHUNK_MAX_CHARS after splitOversized)
    // plus p can span more than the cap. The carried pieces are headings
    // already separated from their content, so emit the whole run as one
    // (merged) chunk of its own and start the next chunk at p; p alone
    // never exceeds the cap.
    while (
      cur.length > 1 &&
      cur[cur.length - 1].end - cur[0].start > CHUNK_MAX_CHARS
    ) {
      emitRange(cur[0], cur[cur.length - 2]);
      cur = cur.slice(-1);
    }
  }
  // End of body: every piece still in `cur` must be emitted. The trailing
  // headings a mid-body emit() would have carried forward cannot move to
  // a next chunk here because there is none - dropping them (the old
  // behavior) loses body text, e.g. a final `## Rules\nNever push to
  // main.` section. Their span is <= CHUNK_MAX_CHARS: every way `cur`
  // gets built (single piece, push under the target, capped concat above)
  // keeps it within the cap.
  if (cur.length > 0) emitRange(cur[0], cur[cur.length - 1]);
  return chunks;
}

// Chunk a memory body per the rules in the module comment. Returns chunks
// in body order with 0-based `index`, char `offset`, and `text`.
function chunkBody(body: string): MemoryChunk[] {
  if (!body || isBlank(body)) return [];
  return mergePieces(body, splitOversized(body, splitPieces(body)));
}

module.exports = {
  chunkBody,
  CHUNK_TARGET_CHARS,
  CHUNK_MAX_CHARS,
  CHUNKER_VERSION,
};
