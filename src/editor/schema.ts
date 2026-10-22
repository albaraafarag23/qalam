import { Schema, type NodeSpec } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { tableNodes } from "prosemirror-tables";

// Every block gets dir="auto": the browser picks right-to-left or left-to-right from
// the block's first strong letter, so Arabic and English paragraphs each flow the
// right way with no toggle. Mixed text inside one paragraph is handled by the
// Unicode bidi algorithm.
//
// Paragraphs and headings also carry their alignment (start, center, end, justify: start
// and end follow the paragraph's direction) and line spacing.

export const ALIGNMENTS = ["start", "center", "end", "justify", "kashida"] as const;
export const LINE_SPACINGS = ["1", "1.15", "1.5", "2"] as const;

const blockAttrs = { align: { default: null }, spacing: { default: null } };
// "kashida" is justified text; in Word it stretches Arabic letters (ـ) instead of the spaces.

function blockStyle(attrs: { align: string | null; spacing: string | null }) {
  const style = [attrs.align && `text-align: ${attrs.align === "kashida" ? "justify" : attrs.align}`, attrs.spacing && `line-height: ${Number(attrs.spacing) * 1.75}`]
    .filter(Boolean)
    .join("; ");
  return style ? { style } : {};
}

function parseBlockStyle(dom: HTMLElement) {
  const align = dom.style.textAlign;
  const known = (ALIGNMENTS as readonly string[]).includes(align) ? align : null;
  const lh = parseFloat(dom.style.lineHeight);
  const spacing = LINE_SPACINGS.find((s) => Math.abs(Number(s) * 1.75 - lh) < 0.01) ?? null;
  return { align: known, spacing };
}

const nodes = basic.spec.nodes
  .update("paragraph", {
    ...basic.spec.nodes.get("paragraph")!,
    attrs: blockAttrs,
    toDOM: (node) => ["p", { dir: "auto", ...blockStyle(node.attrs as never) }, 0],
    parseDOM: [{ tag: "p", getAttrs: (dom) => parseBlockStyle(dom as HTMLElement) }],
  })
  .update("heading", {
    ...basic.spec.nodes.get("heading")!,
    attrs: { level: { default: 1 }, ...blockAttrs },
    toDOM: (node) => ["h" + node.attrs.level, { dir: "auto", ...blockStyle(node.attrs as never) }, 0],
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
      tag: `h${level}`,
      getAttrs: (dom: HTMLElement) => ({ level: Math.min(level, 2), ...parseBlockStyle(dom) }),
    })),
  })
  // Images remember the width they were resized to (pixels; none = natural size, up to the page).
  .update("image", {
    ...basic.spec.nodes.get("image")!,
    attrs: { src: { validate: "string" }, alt: { default: null }, title: { default: null }, width: { default: null } },
    toDOM: (node) => ["img", { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title, ...(node.attrs.width ? { style: `width: ${node.attrs.width}px` } : {}) }],
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (dom) => {
          const img = dom as HTMLImageElement;
          const width = parseInt(img.style.width || img.getAttribute("width") || "", 10);
          return { src: img.getAttribute("src"), alt: img.getAttribute("alt"), title: img.getAttribute("title"), width: width > 0 ? width : null };
        },
      },
    ],
  })
  // A page break: the next block starts a new page when printed or saved to Word.
  .addToEnd("page_break", {
    group: "block",
    atom: true,
    selectable: true,
    toDOM: () => ["div", { class: "page-break", "data-page-break": "" }],
    parseDOM: [{ tag: "div[data-page-break]" }],
  } satisfies NodeSpec);

// Lists take their direction from the blockDirection plugin (see direction.ts).
export const schema = new Schema({
  nodes: addListNodes(nodes, "paragraph block*", "block").append(
    tableNodes({ tableGroup: "block", cellContent: "block+", cellAttributes: {} }),
  ),
  marks: basic.spec.marks
    .addToEnd("underline", {
      toDOM: () => ["u", 0],
      parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }],
    })
    .addToEnd("strike", {
      toDOM: () => ["s", 0],
      parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }, { style: "text-decoration=line-through" }],
    })
    // Text colour and highlight hold a colour from Qalam's palette (see TEXT_COLORS below).
    .addToEnd("color", {
      attrs: { color: {} },
      toDOM: (mark) => ["span", { style: `color: ${mark.attrs.color}`, "data-color": mark.attrs.color }, 0],
      parseDOM: [{ tag: "span[data-color]", getAttrs: (dom) => ({ color: (dom as HTMLElement).dataset.color }) }],
    })
    .addToEnd("highlight", {
      attrs: { color: {} },
      toDOM: (mark) => ["mark", { style: `background-color: ${mark.attrs.color}`, "data-highlight": mark.attrs.color }, 0],
      parseDOM: [{ tag: "mark", getAttrs: (dom) => ({ color: (dom as HTMLElement).dataset.highlight ?? "#fff2a8" }) }],
    })
    // Text size, relative to the document's (1 = normal).
    .addToEnd("size", {
      attrs: { scale: {} },
      toDOM: (mark) => ["span", { style: `font-size: ${mark.attrs.scale}em`, "data-size": String(mark.attrs.scale) }, 0],
      parseDOM: [{ tag: "span[data-size]", getAttrs: (dom) => ({ scale: Number((dom as HTMLElement).dataset.size) }) }],
    }),
});

/** The colours offered for text and highlights: readable on paper in light and dark mode. */
export const TEXT_COLORS = ["#c0392b", "#d35400", "#1f6f5c", "#2c6fbb", "#7d3c98", "#7f8c8d"];
export const HIGHLIGHT_COLORS = ["#fff2a8", "#c8f2d4", "#cde4ff", "#ffd6e7"];
export const TEXT_SIZES = [0.85, 1, 1.25, 1.5, 2];
