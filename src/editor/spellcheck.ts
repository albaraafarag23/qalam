// Live spelling and grammar check. The checking itself happens in Rust (src-tauri/src/spell.rs
// and grammar.rs); this plugin decides what to send and draws the result as underlines. It also
// shows the suggestions of the opt-in Claude check, which stay until their text is edited.
//
// - Underlines are inline decorations on whole words, mapped through every edit, so they
//   stay on the right word while a re-check is pending (research/grammarly.md).
// - Only paragraphs that changed are re-checked, once typing pauses.
// - The word being typed isn't underlined until the cursor leaves it.
// - Nothing is replaced while an input method is composing.

import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

/** A problem in a paragraph, as UTF-16 offsets into its text. */
export interface Issue {
  from: number;
  to: number;
  kind: "spelling" | "grammar" | "claude";
  /** Grammar: what's wrong, and fixes for from..to ("" removes it). */
  message?: string;
  replacements?: string[];
}

/** What an underline carries, for the suggestions card. */
export interface Underline {
  from: number;
  to: number;
  text: string;
  kind: Issue["kind"];
  message?: string;
  replacements?: string[];
}

export interface SpellcheckOptions {
  check(paragraphs: string[]): Promise<Issue[][]>;
  /** How long typing must pause before changed paragraphs are re-checked. */
  delay?: number;
  /** Paragraphs per request: a long document is checked in batches, nearest the cursor first. */
  batch?: number;
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
  /** A problem left un-underlined because it's still being typed. */
  held: Range | null;
  /** Ignored for this session: misspelt words, and grammar problems by their text. */
  ignored: Set<string>;
}

type Meta =
  | { type: "sent"; blocks: { pos: number; text: string }[] }
  | { type: "results"; issues: Issue[][] }
  | { type: "failed" }
  | { type: "release" }
  | { type: "enable"; on: boolean }
  | { type: "ignore"; key: string }
  | { type: "claude"; blocks: { pos: number; text: string; issues: Issue[] }[] };

/** Ignoring a misspelt word ignores it everywhere; other problems, wherever that text recurs. */
const ignoreKey = (kind: Issue["kind"], text: string) => (kind === "spelling" ? text : `${kind}:${text}`);
const CLASSES = { spelling: "misspelt", grammar: "grammar-issue", claude: "claude-issue" };
const isClaude = (spec: { kind?: string }) => spec.kind === "claude";

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

const contains = (r: Range, pos: number) => pos >= r.from && pos <= r.to;

/** Replaces the underlines in the checked paragraphs whose text hasn't changed since. */
function applyResults(prev: SpellState, doc: PMNode, results: Issue[][], cursorWord: Range | null): SpellState {
  // Only what's being typed is held back, not a problem the cursor was merely moved into.
  const typing = cursorWord && prev.lastEdit !== null && contains(cursorWord, prev.lastEdit) ? cursorWord : null;
  let decorations = prev.decorations;
  let held: Range | null = null;
  prev.inflight.forEach(({ pos, text }, i) => {
    const node = doc.nodeAt(pos);
    // Edited again while being checked: it's already queued for another check.
    if (!node?.isTextblock || blockText(node) !== text) return;
    const start = pos + 1;
    // Claude's suggestions belong to the opt-in check, not to this one: they stay.
    decorations = decorations.remove(decorations.find(start, pos + node.nodeSize - 1, (spec) => !isClaude(spec)));
    const underlines: Underline[] = (results[i] ?? [])
      .map((m) => ({ ...m, from: start + m.from, to: start + m.to, text: text.slice(m.from, m.to) }))
      .filter((u) => !prev.ignored.has(ignoreKey(u.kind, u.text)));
    const shown = underlines.filter((u) => {
      if (!typing || !(contains(u, typing.from) || contains(u, typing.to))) return true;
      held = { from: Math.min(u.from, typing.from), to: Math.max(u.to, typing.to) };
      return false;
    });
    decorations = decorations.add(doc, shown.map((u) => Decoration.inline(u.from, u.to, { class: CLASSES[u.kind] }, u)));
  });
  return { ...prev, decorations, inflight: [], held };
}

export function spellcheck(options: SpellcheckOptions): Plugin<SpellState> {
  const delay = options.delay ?? 300;
  const batch = options.batch ?? 40;
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
        if (tr.docChanged) {
          const changed = changedBlocks(tr);
          if (next.enabled) next.pending = unique([...next.pending, ...changed]);
          // A Claude suggestion whose text was edited no longer applies.
          const stale = changed.flatMap((pos) => {
            const node = tr.doc.nodeAt(pos);
            if (!node) return [];
            return next.decorations
              .find(pos + 1, pos + node.nodeSize - 1, isClaude)
              .filter((d) => tr.doc.textBetween(d.from, d.to, undefined, LEAF) !== d.spec.text);
          });
          if (stale.length) next.decorations = next.decorations.remove(stale);
        }

        const meta = tr.getMeta(spellcheckKey) as Meta | undefined;
        switch (meta?.type) {
          case "sent":
            return { ...next, inflight: meta.blocks, pending: next.pending.filter((p) => !meta.blocks.some((b) => b.pos === p)) };
          case "results":
            return next.enabled ? applyResults(next, tr.doc, meta.issues, wordAtCursor(newState)) : next;
          case "failed":
            return { ...next, inflight: [] };
          case "release": {
            // The cursor left the held word: check its paragraph again to underline it.
            const $pos = tr.doc.resolve(Math.min(next.held?.from ?? 0, tr.doc.content.size));
            const pos = $pos.parent.isTextblock && $pos.depth > 0 ? $pos.before() : null;
            return { ...next, held: null, lastEdit: null, pending: pos === null ? next.pending : unique([...next.pending, pos]) };
          }
          case "enable":
            return { ...next, enabled: meta.on, decorations: next.decorations.remove(next.decorations.find(undefined, undefined, (spec) => !isClaude(spec))), inflight: [], held: null, lastEdit: null, pending: meta.on ? allBlocks(tr.doc) : [] };
          case "claude": {
            let decorations = next.decorations;
            for (const { pos, text, issues } of meta.blocks) {
              const node = tr.doc.nodeAt(pos);
              if (!node?.isTextblock || blockText(node) !== text) continue;
              const start = pos + 1;
              decorations = decorations.remove(decorations.find(start, pos + node.nodeSize - 1, isClaude));
              const underlines = issues
                .map((m) => ({ ...m, from: start + m.from, to: start + m.to, text: text.slice(m.from, m.to) }))
                .filter((u) => !next.ignored.has(ignoreKey(u.kind, u.text)));
              decorations = decorations.add(tr.doc, underlines.map((u) => Decoration.inline(u.from, u.to, { class: CLASSES.claude }, u)));
            }
            return { ...next, decorations };
          }
          case "ignore": {
            const gone = next.decorations.find(undefined, undefined, (spec) => ignoreKey(spec.kind, spec.text) === meta.key);
            return { ...next, ignored: new Set(next.ignored).add(meta.key), decorations: next.decorations.remove(gone) };
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
        const head = view.state.selection.head;
        const blocks = [...state.pending]
          .sort((a, b) => Math.abs(a - head) - Math.abs(b - head))
          .slice(0, batch)
          .map((pos) => ({ pos, node: view.state.doc.nodeAt(pos) }))
          .filter((b): b is { pos: number; node: PMNode } => !!b.node?.isTextblock)
          .map((b) => ({ pos: b.pos, text: blockText(b.node) }));
        send({ type: "sent", blocks });
        let results: Issue[][];
        try {
          results = await options.check(blocks.map((b) => b.text));
        } catch (e) {
          console.warn("spellcheck:", e);
          send({ type: "failed" });
          return;
        }
        // Don't change the text's markup under an input method; try again shortly.
        while (view.composing) await new Promise((r) => setTimeout(r, 100));
        send({ type: "results", issues: results });
      }

      schedule(0);
      return {
        update(view, prevState) {
          const state = spellcheckKey.getState(view.state)!;
          if (state.held && view.state.selection !== prevState.selection && !contains(state.held, view.state.selection.head)) {
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

/** The underline at a position, if there is one. */
export function underlineAt(state: EditorState, pos: number): Underline | null {
  const found = spellcheckKey.getState(state)?.decorations.find(pos, pos)[0];
  return found ? { ...(found.spec as Underline), from: found.from, to: found.to } : null;
}

export const spellcheckEnabled = (state: EditorState) => spellcheckKey.getState(state)?.enabled ?? false;
export const setSpellcheck = (tr: Transaction, on: boolean) => tr.setMeta(spellcheckKey, { type: "enable", on } satisfies Meta);
/** Positions and texts of the textblocks a range covers, for sending to a checker. */
export function blocksIn(doc: PMNode, from: number, to: number): { pos: number; text: string }[] {
  const out: { pos: number; text: string }[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) out.push({ pos, text: blockText(node) });
    return !node.isTextblock;
  });
  return out;
}

/** Shows Claude's suggestions for the given paragraphs (replacing earlier ones there). */
export const showClaudeSuggestions = (tr: Transaction, blocks: { pos: number; text: string; issues: Issue[] }[]) =>
  tr.setMeta(spellcheckKey, { type: "claude", blocks } satisfies Meta);

export const ignoreUnderline = (tr: Transaction, u: Underline) => tr.setMeta(spellcheckKey, { type: "ignore", key: ignoreKey(u.kind, u.text) } satisfies Meta);
