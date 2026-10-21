import type { EditorState, Transaction } from "prosemirror-state";

const MARK = /[ً-ْ]/;
const MARKS_G = /[ً-ْ]/g;

export const stripMarks = (s: string) => s.replace(MARKS_G, "");

/** A letter (or any non-mark character) with the marks that follow it. */
interface Unit {
  char: string;
  offset: number; // offset of the character itself
  marks: string;
}

function units(text: string): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (MARK.test(ch) && out.length) out[out.length - 1].marks += ch;
    else if (!MARK.test(ch)) out.push({ char: ch, offset: i, marks: "" });
  }
  return out;
}

/** Splits units into words: runs of non-space characters. */
function words(us: Unit[]): Unit[][] {
  const out: Unit[][] = [];
  let current: Unit[] = [];
  for (const u of us) {
    if (/\s/.test(u.char)) {
      if (current.length) out.push(current);
      current = [];
    } else current.push(u);
  }
  if (current.length) out.push(current);
  return out;
}

export interface MarkEdit {
  from: number; // offset just after the letter
  to: number; // end of the letter's current marks
  marks: string; // the marks it should carry
}

/**
 * Lines up the AI's result with the original text and returns the marks to add. Only bare
 * letters get marks: a letter that already carries any (typed, corrected or accepted
 * earlier) is never changed. Words whose letters the AI changed are left alone and counted
 * in `skipped`, so a single altered word never costs the rest of the paragraph.
 */
export function alignMarks(original: string, result: string): { edits: MarkEdit[]; skipped: number } {
  const a = words(units(original));
  const b = words(units(result));
  if (a.length !== b.length) return { edits: [], skipped: a.length };

  const edits: MarkEdit[] = [];
  let skipped = 0;
  a.forEach((wordA, i) => {
    const wordB = b[i];
    const same = wordA.length === wordB.length && wordA.every((u, j) => u.char === wordB[j].char);
    if (!same) {
      skipped++;
      return;
    }
    wordA.forEach((u, j) => {
      const marks = wordB[j].marks;
      if (!u.marks && marks) {
        const from = u.offset + 1;
        edits.push({ from, to: from + u.marks.length, marks });
      }
    });
  });
  return { edits, skipped };
}

/** One paragraph to send: its full text for context, and the part the marks may go in. */
export interface Target {
  start: number; // document position of the paragraph's first character
  text: string;
  from: number; // selection range inside the paragraph, as offsets into `text`
  to: number;
}

/**
 * The paragraphs to diacritize: the one the cursor is in, or every paragraph the
 * selection touches. Whole paragraphs are sent so Claude sees the full sentence (case
 * endings depend on it), but only letters inside the selection get marks.
 */
export function targets(state: EditorState): Target[] {
  const { from, to, empty } = state.selection;
  const out: Target[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const start = pos + 1;
    // One character per position: inline leaves (images, line breaks) become U+FFFC.
    const text = state.doc.textBetween(start, start + node.content.size, undefined, "￼");
    if (!/[ء-ي]/.test(text)) return false;
    out.push({
      start,
      text,
      from: empty ? 0 : Math.max(0, from - start),
      to: empty ? text.length : Math.min(text.length, to - start),
    });
    return false;
  });
  return out;
}

/** Applies the marks from Claude's results to the document, inside each target's range. */
export function applyResults(state: EditorState, ts: Target[], results: string[]) {
  const all: { pos: number; end: number; marks: string }[] = [];
  let skipped = 0;
  ts.forEach((t, i) => {
    const { edits, skipped: s } = alignMarks(t.text, results[i]);
    skipped += s;
    for (const e of edits) {
      // The letter itself sits at offset e.from - 1; it must be inside the selection.
      if (e.from - 1 >= t.from && e.from - 1 < t.to) all.push({ pos: t.start + e.from, end: t.start + e.to, marks: e.marks });
    }
  });
  // Last edit first, so earlier positions stay valid.
  all.sort((x, y) => y.pos - x.pos);
  let tr: Transaction = state.tr;
  for (const e of all) tr = e.marks ? tr.insertText(e.marks, e.pos, e.end) : tr.delete(e.pos, e.end);
  return { tr, changed: all.length, skipped };
}

const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/**
 * The paragraph as it will read after applying, with each changed word highlighted.
 * Whole words, never single letters: wrapping a letter in its own element stops the
 * browser joining it to its neighbours, and the word falls apart (عَ ا يِ ش).
 */
export function previewHtml(t: Target, result: string): string {
  const byLetter = new Map<number, MarkEdit>();
  for (const e of alignMarks(t.text, result).edits) {
    if (e.from - 1 >= t.from && e.from - 1 < t.to) byLetter.set(e.from - 1, e);
  }
  // The text after applying, plus for each output character whether it belongs to a
  // changed word.
  let after = "";
  const changedAt: boolean[] = [];
  for (let i = 0; i < t.text.length; i++) {
    const e = byLetter.get(i);
    const piece = e ? t.text[i] + e.marks : t.text[i];
    after += piece;
    for (const _ of piece) changedAt.push(!!e);
    if (e) i = e.to - 1; // skip the old marks
  }
  return after
    .split(/(\s+)/)
    .reduce<{ html: string; pos: number }>(
      ({ html, pos }, part) => {
        const changed = /\S/.test(part) && changedAt.slice(pos, pos + part.length).some(Boolean);
        return {
          html: html + (changed ? `<span class="changed">${escape(part)}</span>` : escape(part)),
          pos: pos + part.length,
        };
      },
      { html: "", pos: 0 },
    ).html;
}
