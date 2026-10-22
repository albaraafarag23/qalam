// Paragraph formatting, page breaks, tables and dates: the commands behind the Insert and
// Paragraph menus.

import { Selection, type Command, type EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { isInTable } from "prosemirror-tables";
import { schema } from "./schema";

/** Sets a paragraph attribute (align, spacing) on every paragraph and heading in the selection.
    Choosing the value a paragraph already has sets it back to the default. */
function setBlockAttr(name: "align" | "spacing", value: string): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const blocks: { pos: number; node: PMNode }[] = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === schema.nodes.paragraph || node.type === schema.nodes.heading) blocks.push({ pos, node });
      return !node.isTextblock;
    });
    if (!blocks.length) return false;
    if (dispatch) {
      const all = blocks.every((b) => b.node.attrs[name] === value);
      const tr = state.tr;
      for (const { pos, node } of blocks) tr.setNodeMarkup(pos, undefined, { ...node.attrs, [name]: all ? null : value });
      dispatch(tr);
    }
    return true;
  };
}

export const setAlign = (align: string) => setBlockAttr("align", align === "start" ? "start" : align);
export const setSpacing = (spacing: string) => setBlockAttr("spacing", spacing);

/** The alignment and spacing of the paragraph at the cursor, for showing which is on. */
export function blockFormat(state: EditorState): { align: string | null; spacing: string | null } {
  const parent = state.selection.$from.parent;
  return { align: parent.attrs.align ?? null, spacing: parent.attrs.spacing ?? null };
}

/** A page break after the current paragraph; the cursor goes to the paragraph after it. */
export const insertPageBreak: Command = (state, dispatch) => {
  if (isInTable(state)) return false;
  const { $from } = state.selection;
  const depth = $from.depth > 0 ? 1 : 0;
  const after = depth ? $from.after(depth) : $from.pos;
  if (dispatch) {
    const tr = state.tr.insert(after, [schema.nodes.page_break.create(), schema.nodes.paragraph.create()]);
    dispatch(tr.setSelection(Selection.near(tr.doc.resolve(after + 2))).scrollIntoView());
  }
  return true;
};

/** A table of the given size after the current paragraph, with the cursor in its first cell. */
export function insertTable(rows: number, cols: number): Command {
  return (state, dispatch) => {
    if (isInTable(state)) return false;
    const { table, table_row, table_header, table_cell, paragraph } = schema.nodes;
    const row = (header: boolean) =>
      table_row.create(null, Array.from({ length: cols }, () => (header ? table_header : table_cell).create(null, paragraph.create())));
    const node = table.create(null, [row(true), ...Array.from({ length: rows - 1 }, () => row(false))]);
    const { $from } = state.selection;
    const after = $from.depth > 0 ? $from.after(1) : $from.pos;
    if (dispatch) {
      const tr = state.tr.insert(after, node);
      dispatch(tr.setSelection(Selection.near(tr.doc.resolve(after + 3))).scrollIntoView());
    }
    return true;
  };
}

/** Today's date, Gregorian or Hijri (Umm al-Qura), in Arabic or English. */
export function today(calendar: "gregorian" | "hijri", arabic: boolean): string {
  const locale = arabic ? (calendar === "hijri" ? "ar-SA-u-ca-islamic-umalqura" : "ar-EG") : calendar === "hijri" ? "en-u-ca-islamic-umalqura" : "en-GB";
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(new Date());
}
