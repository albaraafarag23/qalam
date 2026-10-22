// Turning the editor's document into a file and back.
//
// .qalam: the document exactly as the editor holds it (headings, lists, bold, حركات), as JSON.
// .txt: plain text. Paragraphs are separated by a blank line; a single line break inside a
// paragraph stays a line break; list items are written "- item" or "1. item".

import type { Node as PMNode, Schema } from "prosemirror-model";

export type FileKind = "qalam" | "text";

const FORMAT_VERSION = 1;

export function toQalam(doc: PMNode): string {
  return JSON.stringify({ qalam: FORMAT_VERSION, doc: doc.toJSON() });
}

export function fromQalam(schema: Schema, contents: string): PMNode {
  let data: { qalam?: number; doc?: unknown };
  try {
    data = JSON.parse(contents);
  } catch {
    throw new Error("This file isn't a Qalam document, or it's damaged.");
  }
  if (typeof data.qalam !== "number" || !data.doc) throw new Error("This file isn't a Qalam document.");
  if (data.qalam > FORMAT_VERSION) throw new Error("This document was saved by a newer Qalam. Please update Qalam to open it.");
  const doc = schema.nodeFromJSON(data.doc);
  doc.check(); // throws if the content doesn't fit the schema
  return doc;
}

/** A textblock's text, with hard breaks as line breaks. */
function blockText(node: PMNode): string {
  let out = "";
  node.forEach((child) => {
    out += child.isText ? child.text : child.type.name === "hard_break" ? "\n" : "";
  });
  return out;
}

/** A block as text: a paragraph or heading as is, a list as one line per item. */
function blockToText(node: PMNode, depth: number): string {
  if (node.isTextblock) return blockText(node);
  if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
    const start = node.attrs.order ?? 1;
    const indent = "  ".repeat(depth);
    const items: string[] = [];
    node.forEach((item, _offset, i) => {
      const marker = node.type.name === "bullet_list" ? "- " : `${start + i}. `;
      const parts: string[] = [];
      item.forEach((child, _o, j) => {
        if (child.isTextblock) parts.push(j === 0 ? blockText(child) : indent + "  " + blockText(child));
        else parts.push(blockToText(child, depth + 1));
      });
      items.push(indent + marker + parts.join("\n"));
    });
    return items.join("\n");
  }
  const parts: string[] = [];
  node.forEach((child) => parts.push(blockToText(child, depth)));
  return parts.join("\n\n");
}

export function toText(doc: PMNode): string {
  return blockToText(doc, 0) + "\n";
}

export function fromText(schema: Schema, text: string): PMNode {
  const { paragraph, hard_break } = schema.nodes;
  const normalised = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  // Blank lines separate paragraphs. A file with no blank lines at all has one paragraph per line.
  const parts = /\n[ \t]*\n/.test(normalised) ? normalised.split(/\n[ \t]*\n+/) : normalised.split("\n");
  const paragraphs = parts.map((part) => {
    const lines = part.split("\n");
    const content: PMNode[] = [];
    lines.forEach((line, i) => {
      if (i > 0) content.push(hard_break.create());
      if (line) content.push(schema.text(line));
    });
    return paragraph.create(null, content);
  });
  return schema.topNodeType.create(null, paragraphs.length ? paragraphs : [paragraph.create()]);
}

/** "رسالة.qalam" → "رسالة"; a name for a document that has none yet. */
export function displayName(fileName: string | null): string {
  return fileName ? fileName.replace(/\.(qalam|txt)$/i, "") : "Untitled";
}
