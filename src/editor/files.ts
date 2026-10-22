// Turning the editor's document into a file and back.
//
// .qalam: the document exactly as the editor holds it (headings, lists, bold, حركات), as JSON.
// .docx: Word, see the end of this file.
// .txt: plain text. Paragraphs are separated by a blank line; a single line break inside a
// paragraph stays a line break; list items are written "- item" or "1. item".

import { DOMParser as PMDOMParser, type Node as PMNode, type Schema } from "prosemirror-model";

export type FileKind = "qalam" | "docx" | "text";

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

/** A block as text: a paragraph or heading as is, a list as one line per item, a table as one
    line per row with cells separated by tabs. */
function blockToText(node: PMNode, depth: number): string {
  if (node.isTextblock) return blockText(node);
  if (node.type.name === "page_break") return "";
  if (node.type.name === "table") {
    const rows: string[] = [];
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => cells.push(blockToText(cell, depth).replace(/\n+/g, " ")));
      rows.push(cells.join("\t"));
    });
    return rows.join("\n");
  }
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
  return fileName ? fileName.replace(/\.(qalam|docx|txt)$/i, "") : "Untitled";
}

// ---- Word (.docx) ----
// Reading uses mammoth (BSD-2): Word → HTML → the editor's schema. Each paragraph's direction
// comes from its text, as everywhere in Qalam, so nothing is lost by not reading Word's flag.
// Writing uses docx (MIT): Arabic paragraphs are marked right-to-left (w:bidi), Arabic runs as
// right-to-left text (w:rtl), and the Arabic font goes in Word's "complex script" slot, which
// Word uses for Arabic letters.


const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LATIN = /[A-Za-z]/;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function fromDocx(schema: Schema, base64: string): Promise<{ doc: PMNode; lossy: boolean }> {
  const { default: mammoth } = await import("mammoth");
  const bytes = base64ToBytes(base64);
  const result = await mammoth.convertToHtml(
    { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer },
    {
      // Word's title and headings become Qalam's two heading levels.
      styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh", "p[style-name='Heading 3'] => h2:fresh"],
      ignoreEmptyParagraphs: false,
    },
  );
  const html = new DOMParser().parseFromString(`<body>${result.value}</body>`, "text/html");
  // Anything Qalam can't show would be lost by saving over the file; the caller then saves a
  // copy instead. Text, headings, lists, images and tables all come in, so nothing is flagged
  // today; this is where a new unsupported part (text boxes, footnotes…) would be detected.
  const lossy = false;
  return { doc: PMDOMParser.fromSchema(schema).parse(html.body), lossy };
}

export interface DocxOptions {
  /** The Arabic font's name as Word knows it, e.g. "Amiri". */
  arabicFont: string;
  latinFont: string;
  /** A page number at the bottom of each page: 123, ١٢٣, or none. */
  pageNumbers?: "none" | "western" | "arabic-indic";
}

/** The widest an image may be in Word: the text width of an A4 page with normal margins. */
const MAX_IMAGE_WIDTH = 600;

interface PreparedImage { type: "png" | "jpg" | "gif" | "bmp"; data: Uint8Array; width: number; height: number }

/** An image ready for Word: its pixel size (shrunk to fit the page) and a format Word reads
    (WebP and others are converted to PNG). */
async function prepareImage(src: string): Promise<PreparedImage | null> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const scale = Math.min(1, MAX_IMAGE_WIDTH / img.naturalWidth);
  const width = Math.round(img.naturalWidth * scale);
  const height = Math.round(img.naturalHeight * scale);
  const mime = /^data:(image\/[a-z+]+);base64,/.exec(src)?.[1];
  const native = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/bmp": "bmp" } as const;
  if (mime && mime in native) {
    return { type: native[mime as keyof typeof native], data: base64ToBytes(src.slice(src.indexOf(",") + 1)), width, height };
  }
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  const png = canvas.toDataURL("image/png");
  return { type: "png", data: base64ToBytes(png.slice(png.indexOf(",") + 1)), width, height };
}

export async function toDocx(doc: PMNode, options: DocxOptions): Promise<string> {
  const docx = await import("docx");
  const { Document, Packer, Paragraph, TextRun, ImageRun, PageBreak, Table, TableRow, TableCell, WidthType, HeadingLevel, LevelFormat, AlignmentType, Footer, PageNumber, NumberFormat } = docx;
  const font = { ascii: options.latinFont, hAnsi: options.latinFont, cs: options.arabicFont };

  const images = new Map<string, PreparedImage | null>();
  const sources: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "image") sources.push(node.attrs.src);
  });
  for (const src of sources) if (!images.has(src)) images.set(src, await prepareImage(src));

  const runs = (block: PMNode) => {
    const out: (InstanceType<typeof TextRun> | InstanceType<typeof ImageRun>)[] = [];
    block.forEach((child) => {
      if (child.type.name === "hard_break") {
        out.push(new TextRun({ break: 1 }));
        return;
      }
      if (child.type.name === "image") {
        const image = images.get(child.attrs.src);
        if (image) {
          // A resized image keeps its proportions at the width chosen in Qalam.
          const width = child.attrs.width ? Math.min(child.attrs.width, MAX_IMAGE_WIDTH) : image.width;
          const height = Math.round((image.height * width) / image.width);
          out.push(
            new ImageRun({
              type: image.type,
              data: image.data,
              transformation: { width, height },
              ...(child.attrs.alt ? { altText: { name: child.attrs.alt, description: child.attrs.alt, title: child.attrs.alt } } : {}),
            }),
          );
        }
        return;
      }
      if (!child.isText) return;
      const bold = child.marks.some((m) => m.type.name === "strong");
      const italics = child.marks.some((m) => m.type.name === "em");
      out.push(
        new TextRun({
          text: child.text!,
          font,
          bold,
          boldComplexScript: bold,
          italics,
          italicsComplexScript: italics,
          rightToLeft: ARABIC.test(child.text!),
        }),
      );
    });
    return out;
  };

  /** Right-to-left when the paragraph's first strong letter is Arabic, as in the editor. */
  const isRtl = (block: PMNode) => {
    for (const ch of block.textContent) {
      if (ARABIC.test(ch)) return true;
      if (LATIN.test(ch)) return false;
    }
    return false;
  };

  const ALIGN = { start: AlignmentType.START, center: AlignmentType.CENTER, end: AlignmentType.END, justify: AlignmentType.BOTH } as const;
  type Block = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;

  /** Word blocks for a node's children: paragraphs, list items, page breaks and tables. */
  const blocks = (node: PMNode, list?: { ordered: boolean; level: number }): Block[] => {
    const out: Block[] = [];
    node.forEach((child) => {
      if (child.isTextblock) {
        const heading =
          child.type.name === "heading" ? (child.attrs.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2) : undefined;
        out.push(
          new Paragraph({
            children: runs(child),
            heading,
            bidirectional: isRtl(child),
            ...(child.attrs.align ? { alignment: ALIGN[child.attrs.align as keyof typeof ALIGN] } : {}),
            ...(child.attrs.spacing ? { spacing: { line: Math.round(240 * Number(child.attrs.spacing)) } } : {}),
            ...(list ? (list.ordered ? { numbering: { reference: "qalam-numbers", level: list.level } } : { bullet: { level: list.level } }) : {}),
          }),
        );
      } else if (child.type.name === "page_break") {
        out.push(new Paragraph({ children: [new PageBreak()] }));
      } else if (child.type.name === "table") {
        const rows: InstanceType<typeof TableRow>[] = [];
        child.forEach((row, _o, r) => {
          const cells: InstanceType<typeof TableCell>[] = [];
          row.forEach((cell) => {
            const content = blocks(cell);
            cells.push(new TableCell({ children: content.length ? content : [new Paragraph({})], columnSpan: cell.attrs.colspan, rowSpan: cell.attrs.rowspan }));
          });
          rows.push(new TableRow({ children: cells, tableHeader: r === 0 && row.firstChild?.type.name === "table_header" }));
        });
        // An Arabic table runs right to left, as in the editor.
        out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, visuallyRightToLeft: isRtl(child) }));
      } else if (child.type.name === "bullet_list" || child.type.name === "ordered_list") {
        out.push(...blocks(child, { ordered: child.type.name === "ordered_list", level: list ? Math.min(list.level + 1, 8) : 0 }));
      } else {
        out.push(...blocks(child, list));
      }
    });
    return out;
  };
  const paragraphs = blocks(doc);

  const document = new Document({
    styles: { default: { document: { run: { font, size: 24, sizeComplexScript: 28 } } } },
    numbering: {
      config: [
        {
          reference: "qalam-numbers",
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
          })),
        },
      ],
    },
    sections: [
      {
        children: paragraphs,
        ...(options.pageNumbers && options.pageNumbers !== "none"
          ? {
              properties: {
                page: {
                  pageNumbers: { start: 1, formatType: options.pageNumbers === "arabic-indic" ? NumberFormat.HINDI_NUMBERS : NumberFormat.DECIMAL },
                },
              },
              footers: {
                default: new Footer({
                  children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font })] })],
                }),
              },
            }
          : {}),
      },
    ],
  });
  return Packer.toBase64String(document);
}
