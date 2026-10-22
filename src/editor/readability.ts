// How easy text is to read, and the long sentences that make it harder.
//
// English: the Flesch–Kincaid grade level (the US school grade that can read it comfortably).
// Arabic has no widely used equivalent formula, so for Arabic Qalam shows the average sentence
// length, the measure editors use most. In both, sentences over 30 words can be highlighted.

import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

export const LONG_SENTENCE = 30;
const SENTENCE_END = /[.!?؟…]+|\n/;

/** A rough English syllable count: vowel groups, minus a silent final e. */
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

function sentencesOf(text: string): string[] {
  return text.split(SENTENCE_END).map((s) => s.trim()).filter((s) => /\p{L}/u.test(s));
}

const wordsOf = (sentence: string) => sentence.split(/\s+/).filter((w) => /\p{L}/u.test(w));

export interface Readability {
  /** "en": a grade level; "ar": average words per sentence. */
  language: "en" | "ar";
  value: number;
  label: string;
}

export function readability(text: string): Readability | null {
  const sentences = sentencesOf(text);
  const words = sentences.flatMap(wordsOf);
  if (words.length < 8) return null;
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length > (text.match(/[A-Za-z]/g) ?? []).length;
  const perSentence = words.length / sentences.length;
  if (arabic) {
    const value = Math.round(perSentence);
    const label = value <= 15 ? "جمل قصيرة وسهلة" : value <= 25 ? "طول متوسط" : "جمل طويلة";
    return { language: "ar", value, label };
  }
  const perWord = words.reduce((n, w) => n + syllables(w), 0) / words.length;
  const grade = Math.max(1, Math.round(0.39 * perSentence + 11.8 * perWord - 15.59));
  const label = grade <= 6 ? "very easy" : grade <= 9 ? "easy" : grade <= 12 ? "fairly hard" : "hard";
  return { language: "en", value: grade, label };
}

// ---- Long sentences, highlighted on demand ----

export const longSentencesKey = new PluginKey<{ on: boolean; decorations: DecorationSet }>("longSentences");

function findLong(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, "￼");
    let start = 0;
    for (const part of text.split(new RegExp(`(${SENTENCE_END.source})`))) {
      const end = start + part.length;
      if (!SENTENCE_END.test(part) && wordsOf(part).length > LONG_SENTENCE) {
        const lead = part.length - part.trimStart().length;
        decorations.push(Decoration.inline(pos + 1 + start + lead, pos + 1 + end, { class: "long-sentence" }));
      }
      start = end;
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export const longSentences = new Plugin({
  key: longSentencesKey,
  state: {
    init: () => ({ on: false, decorations: DecorationSet.empty }),
    apply(tr, prev, _old, state) {
      const toggle = tr.getMeta(longSentencesKey) as boolean | undefined;
      const on = toggle ?? prev.on;
      if (!on) return { on, decorations: DecorationSet.empty };
      if (toggle !== undefined || tr.docChanged) return { on, decorations: findLong(state.doc) };
      return prev;
    },
  },
  props: { decorations: (state) => longSentencesKey.getState(state)?.decorations },
});

export const showLongSentences = (tr: Transaction, on: boolean) => tr.setMeta(longSentencesKey, on);
export const longSentencesOn = (state: EditorState) => longSentencesKey.getState(state)?.on ?? false;
