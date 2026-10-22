// Find and replace that understands Arabic: by default it ignores حركات and tatweel (so مدرسة
// finds مَدْرَسَة), treats the forms of alif and of final ya as one letter (أ إ آ ٱ ا, ى ي),
// and ignores case in English. Matches are highlighted; one of them is the current one.

import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

export interface FindOptions {
  ignoreMarks: boolean;
  letterForms: boolean;
  matchCase: boolean;
}

interface Match {
  from: number;
  to: number;
}

interface FindState {
  query: string;
  options: FindOptions;
  matches: Match[];
  current: number;
  decorations: DecorationSet;
}

export const findKey = new PluginKey<FindState>("find");

const MARK = /[ً-ٰٟـ]/;
const FORMS: Record<string, string> = { "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي" };

/** The text as it's compared, and for each of its characters the index it came from. */
export function normalise(text: string, options: FindOptions): { text: string; from: number[] } {
  let out = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text[i];
    if (options.ignoreMarks && MARK.test(c)) continue;
    if (options.letterForms) c = FORMS[c] ?? c;
    if (!options.matchCase) c = c.toLowerCase();
    for (const ch of c) {
      out += ch; // a few letters lower-case to two characters (İ); each remembers where it came from
      from.push(i);
    }
  }
  return { text: out, from };
}

function findAll(doc: PMNode, query: string, options: FindOptions): Match[] {
  const needle = normalise(query, options).text;
  if (!needle) return [];
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, "￼");
    const hay = normalise(text, options);
    let at = hay.text.indexOf(needle);
    while (at >= 0) {
      const start = hay.from[at];
      // The match ends after its last character, and after any حركات that follow it.
      let end = hay.from[at + needle.length - 1] + 1;
      while (end < text.length && options.ignoreMarks && MARK.test(text[end])) end++;
      matches.push({ from: pos + 1 + start, to: pos + 1 + end });
      at = hay.text.indexOf(needle, at + needle.length);
    }
    return false;
  });
  return matches;
}

function build(doc: PMNode, query: string, options: FindOptions, near: number): FindState {
  const matches = findAll(doc, query, options);
  let current = matches.findIndex((m) => m.from >= near);
  if (current < 0) current = matches.length ? 0 : -1;
  return { query, options, matches, current, decorations: paint(doc, matches, current) };
}

function paint(doc: PMNode, matches: Match[], current: number) {
  return DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? "find-match find-current" : "find-match" })),
  );
}

type Meta = { query: string; options: FindOptions } | { step: 1 | -1 } | { close: true };

const DEFAULTS: FindOptions = { ignoreMarks: true, letterForms: true, matchCase: false };

export const findPlugin = new Plugin<FindState>({
  key: findKey,
  state: {
    init: () => ({ query: "", options: DEFAULTS, matches: [], current: -1, decorations: DecorationSet.empty }),
    apply(tr, prev, _old, state) {
      const meta = tr.getMeta(findKey) as Meta | undefined;
      if (meta && "close" in meta) return { ...prev, query: "", matches: [], current: -1, decorations: DecorationSet.empty };
      if (meta && "query" in meta) return build(state.doc, meta.query, meta.options, state.selection.from);
      if (meta && "step" in meta && prev.matches.length) {
        const current = (prev.current + meta.step + prev.matches.length) % prev.matches.length;
        return { ...prev, current, decorations: paint(state.doc, prev.matches, current) };
      }
      // The text changed: search again, staying near the same place.
      if (tr.docChanged && prev.query) return build(state.doc, prev.query, prev.options, prev.matches[prev.current] ? tr.mapping.map(prev.matches[prev.current].from) : state.selection.from);
      return prev;
    },
  },
  props: { decorations: (state) => findKey.getState(state)?.decorations },
});

export const findState = (state: EditorState) => findKey.getState(state)!;

export const search = (tr: Transaction, query: string, options: FindOptions) => tr.setMeta(findKey, { query, options } satisfies Meta);
export const stopSearching = (tr: Transaction) => tr.setMeta(findKey, { close: true } satisfies Meta);

/** Moves to the next (1) or previous (-1) match and selects it, scrolled into view. */
export function step(state: EditorState, dir: 1 | -1): Transaction | null {
  const s = findState(state);
  if (!s.matches.length) return null;
  const current = (s.current + dir + s.matches.length) % s.matches.length;
  const m = s.matches[current];
  return state.tr.setMeta(findKey, { step: dir } satisfies Meta).setSelection(TextSelection.create(state.doc, m.from, m.to)).scrollIntoView();
}

/** Replaces the current match and moves to the next one. */
export function replaceCurrent(state: EditorState, replacement: string): Transaction | null {
  const s = findState(state);
  const m = s.matches[s.current];
  if (!m) return null;
  return state.tr.insertText(replacement, m.from, m.to).scrollIntoView();
}

/** Replaces every match, as one undo step. Returns how many. */
export function replaceAll(state: EditorState, replacement: string): { tr: Transaction; count: number } | null {
  const s = findState(state);
  if (!s.matches.length) return null;
  const tr = state.tr;
  for (let i = s.matches.length - 1; i >= 0; i--) {
    const m = s.matches[i];
    if (replacement) tr.insertText(replacement, m.from, m.to);
    else tr.delete(m.from, m.to);
  }
  return { tr, count: s.matches.length };
}
