// Automatic English punctuation: when a paragraph is finished, the offline model suggests
// each word's capitalisation and the punctuation after it. Suggestions only ever add:
// they capitalise letters the writer left lower-case and add missing . , ? after words.
// Nothing the writer typed is removed or lower-cased.

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const EDGE_START = /^[^\p{L}\p{N}]*/u;
const EDGE_END = /[^\p{L}\p{N}]*$/u;
const POST = /[.,?]+$/;

export interface Word {
  offset: number; // where the word starts in the paragraph text
  text: string;
}

export function words(paragraph: string): Word[] {
  return [...paragraph.matchAll(/\S+/g)].map((m) => ({ offset: m.index!, text: m[0] }));
}

/** Only English paragraphs are punctuated: no Arabic letters, and some Latin ones. */
export function isEnglish(paragraph: string): boolean {
  return !ARABIC.test(paragraph) && /[A-Za-z]/.test(paragraph);
}

/** The word as the model reads it: lower-case, without surrounding punctuation. */
export function modelInput(word: string): string {
  return word.replace(EDGE_START, "").replace(EDGE_END, "").toLowerCase();
}

/**
 * Merges the model's form of a word into what the writer typed, adding only:
 * capitals where the model has them, and trailing . , ? when the word has none.
 */
export function mergeWord(typed: string, suggested: string): string {
  const lead = typed.match(EDGE_START)![0];
  const trail = typed.slice(lead.length).match(EDGE_END)![0];
  const core = typed.slice(lead.length, typed.length - trail.length);
  if (!core || !suggested) return typed;

  const suggestedPunct = suggested.match(POST)?.[0] ?? "";
  const suggestedCore = suggested.slice(0, suggested.length - suggestedPunct.length);
  // Acronyms ("a.m.", "U.S.") are skipped: inserting dots inside a word is too risky to
  // do automatically. So capitals only apply when the letters line up one to one.
  let newCore = core;
  if (suggestedCore.length === core.length && suggestedCore.toLowerCase() === core.toLowerCase()) {
    newCore = [...core].map((c, i) => (suggestedCore[i] !== suggestedCore[i].toLowerCase() ? suggestedCore[i] : c)).join("");
  }
  const newTrail = trail || (suggestedCore.includes(".") ? "" : suggestedPunct);
  return lead + newCore + newTrail;
}

export interface WordEdit {
  offset: number;
  length: number;
  text: string;
}

/** The edits to make to a paragraph, given the model's form of each of its words. */
export function edits(paragraph: string, suggestions: string[]): WordEdit[] {
  const ws = words(paragraph);
  if (ws.length !== suggestions.length) return [];
  const out: WordEdit[] = [];
  ws.forEach((w, i) => {
    const merged = mergeWord(w.text, suggestions[i]);
    if (merged !== w.text) out.push({ offset: w.offset, length: w.text.length, text: merged });
  });
  return out;
}
