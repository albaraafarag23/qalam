import type { Command, EditorState } from "prosemirror-state";

// The Arabic diacritics (حركات) Qalam offers, in toolbar order.
export const HARAKAT = [
  { id: "fatha", mark: "َ", name: "فتحة", key: "1" },
  { id: "damma", mark: "ُ", name: "ضمة", key: "2" },
  { id: "kasra", mark: "ِ", name: "كسرة", key: "3" },
  { id: "sukun", mark: "ْ", name: "سكون", key: "4" },
  { id: "shadda", mark: "ّ", name: "شدة", key: "5" },
  { id: "fathatan", mark: "ً", name: "تنوين فتح", key: "6" },
  { id: "dammatan", mark: "ٌ", name: "تنوين ضم", key: "7" },
  { id: "kasratan", mark: "ٍ", name: "تنوين كسر", key: "8" },
] as const;

const SHADDA = "ّ";
const SUKUN = "ْ";
// One vowel per letter: the short vowels, sukun and the tanween exclude each other.
const VOWELS = new Set(["ً", "ٌ", "ٍ", "َ", "ُ", "ِ", SUKUN]);
// Unicode canonical combining classes, so marks are always stored in the standard order
// (the order NFC uses) and text compares and searches the same however it was typed.
const COMBINING_CLASS: Record<string, number> = {
  "ً": 27, "ٌ": 28, "ٍ": 29, "َ": 30, "ُ": 31, "ِ": 32, "ّ": 33, "ْ": 34,
};
const MARK = /[ً-ْ]/;
const ARABIC_LETTER = /[ء-غف-يٱ-ۓۺ-ۼ]/;

/** The marks after applying `mark` to a letter that already carries `existing`. */
export function applyHaraka(existing: string, mark: string): string {
  const marks = new Set(existing);
  if (marks.has(mark)) {
    marks.delete(mark); // pressing the active mark again removes it
  } else if (mark === SHADDA) {
    marks.delete(SUKUN); // a doubled letter can't also be silent
    marks.add(SHADDA);
  } else {
    for (const v of VOWELS) marks.delete(v);
    if (mark === SUKUN) marks.delete(SHADDA);
    marks.add(mark);
  }
  return [...marks].sort((a, b) => COMBINING_CLASS[a] - COMBINING_CLASS[b]).join("");
}

/** The Arabic letter just before the cursor and the marks already on it, if any. */
function letterBeforeCursor(state: EditorState) {
  const { $from, empty } = state.selection;
  if (!empty) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  let i = before.length;
  while (i > 0 && MARK.test(before[i - 1])) i--;
  if (i === 0 || !ARABIC_LETTER.test(before[i - 1])) return null;
  const marks = before.slice(i);
  return { marks, from: $from.pos - marks.length, to: $from.pos };
}

/** Which marks the letter before the cursor carries (for lighting up the buttons). */
export function activeHarakat(state: EditorState): string {
  return letterBeforeCursor(state)?.marks ?? "";
}

export function setHaraka(mark: string): Command {
  return (state, dispatch) => {
    const letter = letterBeforeCursor(state);
    if (!letter) return false;
    if (dispatch) {
      const marks = applyHaraka(letter.marks, mark);
      const tr = marks
        ? state.tr.insertText(marks, letter.from, letter.to)
        : state.tr.delete(letter.from, letter.to);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export const clearHarakat: Command = (state, dispatch) => {
  const letter = letterBeforeCursor(state);
  if (!letter || !letter.marks) return false;
  if (dispatch) dispatch(state.tr.delete(letter.from, letter.to).scrollIntoView());
  return true;
};
