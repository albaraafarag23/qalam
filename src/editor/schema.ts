import { Schema, type NodeSpec } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";

// Every block gets dir="auto": the browser picks right-to-left or left-to-right from
// the block's first strong letter, so Arabic and English paragraphs each flow the
// right way with no toggle. Mixed text inside one paragraph is handled by the
// Unicode bidi algorithm.
function withAutoDir(spec: NodeSpec, tag: string): NodeSpec {
  return { ...spec, toDOM: () => [tag, { dir: "auto" }, 0] };
}

const nodes = basic.spec.nodes
  .update("paragraph", withAutoDir(basic.spec.nodes.get("paragraph")!, "p"))
  .update("heading", {
    ...basic.spec.nodes.get("heading")!,
    toDOM: (node) => ["h" + node.attrs.level, { dir: "auto" }, 0],
  });

// Lists take their direction from the listDirection plugin (see direction.ts), not dir="auto".
export const schema = new Schema({
  nodes: addListNodes(nodes, "paragraph block*", "block"),
  marks: basic.spec.marks,
});
