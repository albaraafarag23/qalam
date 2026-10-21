import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

// Arabic letters (incl. presentation forms) vs Latin letters: the first strong one
// decides the direction, the same rule dir="auto" uses.
const STRONG = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿A-Za-z]/;
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export function textDirection(text: string): "rtl" | "ltr" | null {
  const first = text.match(STRONG)?.[0];
  return !first ? null : ARABIC.test(first) ? "rtl" : "ltr";
}

const LIST_NODES = new Set(["bullet_list", "ordered_list", "list_item"]);

// dir="auto" can't be used on lists: the browser skips descendants that carry their own
// dir (every paragraph does), so a list would never see its Arabic text and stay
// left-to-right. Instead each list and item gets an explicit dir from its own text,
// recomputed on every change.
export const listDirection = new Plugin({
  props: {
    decorations(state) {
      const decorations: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        if (!LIST_NODES.has(node.type.name)) return;
        const dir = textDirection(node.textContent);
        if (dir) decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir }));
      });
      return DecorationSet.create(state.doc, decorations);
    },
  },
});
