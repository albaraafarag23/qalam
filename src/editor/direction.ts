import { Plugin, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

// Arabic letters (incl. presentation forms) vs Latin letters: the first strong one
// decides the direction, the same rule dir="auto" uses.
const STRONG = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿A-Za-z]/;
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export function textDirection(text: string): "rtl" | "ltr" | null {
  const first = text.match(STRONG)?.[0];
  return !first ? null : ARABIC.test(first) ? "rtl" : "ltr";
}

/** The direction at the cursor: its paragraph's own, or for an empty one, the text before it. */
export function directionAt(state: EditorState): "rtl" | "ltr" | null {
  const { $from } = state.selection;
  const own = textDirection($from.parent.textContent);
  if (own) return own;
  let previous: "rtl" | "ltr" | null = null;
  state.doc.nodesBetween(0, $from.before(), (node) => {
    if (node.isTextblock) previous = textDirection(node.textContent) ?? previous;
    return !node.isTextblock;
  });
  return previous;
}

const LIST_NODES = new Set(["bullet_list", "ordered_list", "list_item"]);

// Every list, list item and text block gets an explicit dir from its own text:
// - dir="auto" can't be used on lists: the browser skips descendants that carry their
//   own dir (every paragraph does), so a list would never see its Arabic text.
// - An empty line or list takes the direction of the text before it, so pressing Enter
//   after Arabic keeps the cursor on the right instead of jumping left until you type.
// Recomputed on every change.
export const blockDirection = new Plugin({
  props: {
    decorations(state) {
      const decorations: Decoration[] = [];
      let previous: "rtl" | "ltr" | null = null;
      state.doc.descendants((node, pos) => {
        if (!node.isTextblock && !LIST_NODES.has(node.type.name)) return;
        const own = textDirection(node.textContent);
        const dir = own ?? previous;
        if (node.isTextblock && own) previous = own;
        if (dir) decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir }));
      });
      return DecorationSet.create(state.doc, decorations);
    },
  },
});
