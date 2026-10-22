// Live spellcheck. The checking itself happens in Rust (src-tauri/src/spell.rs); this plugin
// decides what to send and draws the result as underlines.
//
// - Underlines are inline decorations on whole words, mapped through every edit, so they
//   stay on the right word while a re-check is pending (research/grammarly.md).
// - Only paragraphs that changed are re-checked, once typing pauses.
// - The word being typed isn't underlined until the cursor leaves it.
// - Nothing is replaced while an input method is composing.

import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

/** UTF-16 offsets of a misspelt word within a paragraph's text. */
export interface Misspelling {
  from: number;
  to: number;
}

export interface SpellcheckOptions {
  check(paragraphs: string[]): Promise<Misspelling[][]>;
  /** How long typing must pause before changed paragraphs are re-checked. */
  delay?: number;
}

interface Range {
  from: number;
  to: number;
}

interface SpellState {
  enabled: boolean;
  decorations: DecorationSet;
  /** Positions just before paragraphs waiting to be checked. All positions here are
      mapped through every edit, so they stay right while the writer keeps typing. */
  pending: number[];
  /** Paragraphs sent to Rust, with the text sent, in the order sent. */
  inflight: { pos: number; text: string }[];
  /** Where the last edit happened, to tell the word being typed from one merely clicked into. */
  lastEdit: number | null;
  /** A misspelt word left un-underlined because it's still being typed. */
  held: Range | null;
  ignored: Set<string>;
}

type Meta =
  | { type: "sent"; blocks: { pos: number; text: string }[] }
  | { type: "results"; misspellings: Misspelling[][] }
  | { type: "failed" }
  | { type: "release" }
  | { type: "enable"; on: boolean }
  | { type: "ignore"; word: string };

export const spellcheckKey = new PluginKey<SpellState>("spellcheck");

// Leaf nodes (hard breaks) count as one character, so text offsets equal positions.
const LEAF = "￼";
const blockText = (node: PMNode) => node.textBetween(0, node.content.size, undefined, LEAF);

/** Positions before every textblock in the document. */
function allBlocks(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) out.push(pos);
    return !node.isTextblock;
  });
  return out;
}

/** Positions before the textblocks a transaction touched, in the new document. */
function changedBlocks(tr: Transaction): number[] {
  const out: number[] = [];
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const from = Math.min(rest.map(newStart, -1), tr.doc.content.size);
      const to = Math.min(rest.map(newEnd, 1), tr.doc.content.size);
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isTextblock) out.push(pos);
        return !node.isTextblock;
      });
    });
  });
  return out;
}

const unique = (positions: number[]) => [...new Set(positions)];

/** The word the cursor is in or touching. */
function wordAtCursor(state: EditorState): Range | null {
  const { $head, empty } = state.selection;
  if (!empty || !$head.parent.isTextblock) return null;
  const text = blockText($head.parent);
  const offset = $head.parentOffset;
  const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{M}'’]/u.test(c);
  if (!isWordChar(text[offset - 1]) && !isWordChar(text[offset])) return null;
  let start = offset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && isWordChar(text[end])) end++;
  return { from: $head.start() + start, to: $head.start() + end };
}

const sameRange = (a: Range | null, b: Range | null) => !!a && !!b && a.from === b.from && a.to === b.to;

/** Replaces the underlines in the checked paragraphs whose text hasn't changed since. */
function applyResults(prev: SpellState, doc: PMNode, results: Misspelling[][], cursorWord: Range | null): SpellState {
  // Only the word being typed is held back, not one the cursor was merely moved into.
  const typing = cursorWord && prev.lastEdit !== null && prev.lastEdit >= cursorWord.from && prev.lastEdit <= cursorWord.to ? cursorWord : null;
  let decorations = prev.decorations;
  let held: Range | null = null;
  prev.inflight.forEach(({ pos, text }, i) => {
    const node = doc.nodeAt(pos);
    // Edited again while being checked: it's already queued for another check.
    if (!node?.isTextblock || blockText(node) !== text) return;
    const start = pos + 1;
    decorations = decorations.remove(decorations.find(start, pos + node.nodeSize - 1));
    const words = (results[i] ?? [])
      .map((m) => ({ from: start + m.from, to: start + m.to, word: text.slice(m.from, m.to) }))
      .filter((m) => !prev.ignored.has(m.word));
    const shown = words.filter((m) => {
      if (!sameRange(m, typing)) return true;
      held = { from: m.from, to: m.to };
      return false;
    });
    decorations = decorations.add(doc, shown.map((m) => Decoration.inline(m.from, m.to, { class: "misspelt" }, { word: m.word })));
  });
  return { ...prev, decorations, inflight: [], held };
}

export function spellcheck(options: SpellcheckOptions): Plugin<SpellState> {
  const delay = options.delay ?? 300;
  let startEnabled = true;
  try { startEnabled = localStorage.getItem("qalam.spellcheck") !== "off"; } catch {}

  return new Plugin<SpellState>({
    key: spellcheckKey,
    state: {
      init: (_config, state) => ({
        enabled: startEnabled,
        decorations: DecorationSet.empty,
        pending: startEnabled ? allBlocks(state.doc) : [],
        inflight: [],
        lastEdit: null,
        held: null,
        ignored: new Set(),
      }),
      apply(tr, prev, _oldState, newState): SpellState {
        const map = (pos: number) => tr.mapping.map(pos);
        let next: SpellState = {
          ...prev,
          decorations: prev.decorations.map(tr.mapping, tr.doc),
          pending: prev.pending.map(map),
          inflight: prev.inflight.map((b) => ({ ...b, pos: map(b.pos) })),
          lastEdit: tr.docChanged ? newState.selection.head : prev.lastEdit === null ? null : map(prev.lastEdit),
          held: prev.held && { from: map(prev.held.from), to: map(prev.held.to) },
        };
        if (tr.docChanged && next.enabled) next.pending = unique([...next.pending, ...changedBlocks(tr)]);

        const meta = tr.getMeta(spellcheckKey) as Meta | undefined;
        switch (meta?.type) {
          case "sent":
            return { ...next, inflight: meta.blocks, pending: next.pending.filter((p) => !meta.blocks.some((b) => b.pos === p)) };
          case "results":
            return next.enabled ? applyResults(next, tr.doc, meta.misspellings, wordAtCursor(newState)) : next;
          case "failed":
            return { ...next, inflight: [] };
          case "release": {
            // The cursor left the held word: check its paragraph again to underline it.
            const $pos = tr.doc.resolve(Math.min(next.held?.from ?? 0, tr.doc.content.size));
            const pos = $pos.parent.isTextblock && $pos.depth > 0 ? $pos.before() : null;
            return { ...next, held: null, lastEdit: null, pending: pos === null ? next.pending : unique([...next.pending, pos]) };
          }
          case "enable":
            return { ...next, enabled: meta.on, decorations: DecorationSet.empty, inflight: [], held: null, lastEdit: null, pending: meta.on ? allBlocks(tr.doc) : [] };
          case "ignore": {
            const gone = next.decorations.find(undefined, undefined, (spec) => spec.word === meta.word);
            return { ...next, ignored: new Set(next.ignored).add(meta.word), decorations: next.decorations.remove(gone) };
          }
        }
        return next;
      },
    },
    props: {
      decorations: (state) => spellcheckKey.getState(state)!.decorations,
    },
    view(view) {
      let timer: number | undefined;
      const send = (meta: Meta) => view.dispatch(view.state.tr.setMeta(spellcheckKey, meta).setMeta("addToHistory", false));
      const schedule = (ms = delay) => {
        clearTimeout(timer);
        timer = window.setTimeout(run, ms);
      };

      async function run() {
        timer = undefined;
        const state = spellcheckKey.getState(view.state)!;
        if (!state.enabled || state.inflight.length || !state.pending.length) return;
        if (view.composing) return schedule();
        const blocks = state.pending
          .map((pos) => ({ pos, node: view.state.doc.nodeAt(pos) }))
          .filter((b): b is { pos: number; node: PMNode } => !!b.node?.isTextblock)
          .map((b) => ({ pos: b.pos, text: blockText(b.node) }));
        send({ type: "sent", blocks });
        let results: Misspelling[][];
        try {
          results = await options.check(blocks.map((b) => b.text));
        } catch (e) {
          console.warn("spellcheck:", e);
          send({ type: "failed" });
          return;
        }
        // Don't change the text's markup under an input method; try again shortly.
        while (view.composing) await new Promise((r) => setTimeout(r, 100));
        send({ type: "results", misspellings: results });
      }

      schedule(0);
      return {
        update(view, prevState) {
          const state = spellcheckKey.getState(view.state)!;
          if (state.held && view.state.selection !== prevState.selection && !sameRange(state.held, wordAtCursor(view.state))) {
            send({ type: "release" });
            return schedule(0);
          }
          if (view.state.doc !== prevState.doc && state.pending.length) schedule();
          else if (!state.inflight.length && state.pending.length && timer === undefined) schedule();
        },
        destroy() {
          clearTimeout(timer);
        },
      };
    },
  });
}

/** The underlined word at a position, if there is one. */
export function misspeltAt(state: EditorState, pos: number): (Range & { word: string }) | null {
  const found = spellcheckKey.getState(state)?.decorations.find(pos, pos)[0];
  return found ? { from: found.from, to: found.to, word: found.spec.word as string } : null;
}

export const spellcheckEnabled = (state: EditorState) => spellcheckKey.getState(state)?.enabled ?? false;
export const setSpellcheck = (tr: Transaction, on: boolean) => tr.setMeta(spellcheckKey, { type: "enable", on } satisfies Meta);
export const ignoreWord = (tr: Transaction, word: string) => tr.setMeta(spellcheckKey, { type: "ignore", word } satisfies Meta);
