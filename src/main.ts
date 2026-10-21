import "@fontsource/noto-serif/400.css";
import "@fontsource/noto-serif/700.css";
import "@fontsource/noto-serif/400-italic.css";
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "./fonts.css";
import "prosemirror-view/style/prosemirror.css";
import "./styles.css";

import { EditorState, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { baseKeymap, setBlockType, toggleMark } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { inputRules, wrappingInputRule, textblockTypeInputRule } from "prosemirror-inputrules";
import { splitListItem, liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list";
import { schema } from "./editor/schema";
import { blockDirection, textDirection } from "./editor/direction";

const { nodes, marks } = schema;

const commands: Record<string, Command> = {
  h1: setBlockType(nodes.heading, { level: 1 }),
  h2: setBlockType(nodes.heading, { level: 2 }),
  p: setBlockType(nodes.paragraph),
  bold: toggleMark(marks.strong),
  italic: toggleMark(marks.em),
  ul: wrapInList(nodes.bullet_list),
  ol: wrapInList(nodes.ordered_list),
};

// Arabic-Indic (٠-٩) and Persian (۰-۹) digits count as numbers too, so "١. " starts a
// numbered list when typing on an Arabic keyboard.
const DIGITS = "0-9\u0660-\u0669\u06F0-\u06F9";
function toNumber(digits: string): number {
  return Number(digits.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) & 0xf)));
}

// Markdown-style shortcuts while typing: "# " heading, "- " bullets, "1. " / "١. " numbers.
const rules = inputRules({
  rules: [
    textblockTypeInputRule(/^(#{1,2})\s$/, nodes.heading, (m) => ({ level: m[1].length })),
    wrappingInputRule(/^\s*([-*•])\s$/, nodes.bullet_list),
    wrappingInputRule(
      new RegExp(`^\\s*([${DIGITS}]+)[.)\u066B]\\s$`),
      nodes.ordered_list,
      (m) => ({ order: toNumber(m[1]) }),
      (m, node) => node.childCount + node.attrs.order == toNumber(m[1]),
    ),
  ],
});

const state = EditorState.create({
  schema,
  plugins: [
    rules,
    blockDirection,
    history(),
    keymap({
      "Mod-z": undo,
      "Mod-y": redo,
      "Mod-Shift-z": redo,
      "Mod-b": commands.bold,
      "Mod-i": commands.italic,
      "Mod-Alt-1": commands.h1,
      "Mod-Alt-2": commands.h2,
      "Mod-Alt-0": commands.p,
      Enter: splitListItem(nodes.list_item),
      Tab: sinkListItem(nodes.list_item),
      "Shift-Tab": liftListItem(nodes.list_item),
    }),
    keymap(baseKeymap),
  ],
});

const view = new EditorView(document.getElementById("page")!, {
  state,
  attributes: { spellcheck: "false" }, // our own checker will draw the underlines
  dispatchTransaction(tr) {
    view.updateState(view.state.apply(tr));
    updateStatus();
  },
});

document.querySelectorAll<HTMLButtonElement>("[data-cmd]").forEach((btn) => {
  btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the text selection
  btn.addEventListener("click", () => {
    commands[btn.dataset.cmd!](view.state, view.dispatch, view);
    view.focus();
  });
});

function updateStatus() {
  const text = view.state.doc.textContent.trim();
  const words = text ? text.split(/\s+/).length : 0;
  document.getElementById("words")!.textContent = `${words} ${words === 1 ? "word" : "words"}`;

  const dir = textDirection(view.state.selection.$from.parent.textContent);
  document.getElementById("dir")!.textContent = dir === "rtl" ? "العربية" : dir === "ltr" ? "English" : "";
}

// Arabic document font: Scheherazade New by default, Amiri as the classic alternative.
const ARABIC_FONTS = ["scheherazade", "amiri"];
const fontPicker = document.getElementById("arabic-font") as HTMLSelectElement;
function setArabicFont(name: string) {
  if (!ARABIC_FONTS.includes(name)) name = "scheherazade";
  document.documentElement.dataset.arabicFont = name;
  fontPicker.value = name;
  try { localStorage.setItem("qalam.arabicFont", name); } catch {}
}
let savedFont = "scheherazade";
try { savedFont = localStorage.getItem("qalam.arabicFont") ?? savedFont; } catch {}
setArabicFont(savedFont);
fontPicker.addEventListener("change", () => {
  setArabicFont(fontPicker.value);
  view.focus();
});

updateStatus();
view.focus();
