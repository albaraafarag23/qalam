import "@fontsource/noto-serif/400.css";
import "@fontsource/noto-serif/700.css";
import "@fontsource/noto-serif/400-italic.css";
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "./fonts.css";
import "prosemirror-view/style/prosemirror.css";
import "./styles.css";

import { EditorState, Selection, type Command } from "prosemirror-state";
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, goToNextCell, isInTable, tableEditing } from "prosemirror-tables";
import { insertPageBreak, insertTable, setAlign, setSpacing, today } from "./editor/format";
import { ImageView } from "./editor/image";
import { findPlugin, findState, replaceAll, replaceCurrent, search, step, stopSearching } from "./editor/find";
import type { Node as PMNode } from "prosemirror-model";
import { EditorView } from "prosemirror-view";
import { baseKeymap, setBlockType, toggleMark } from "prosemirror-commands";
import { history, undo, redo, closeHistory } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { InputRule, inputRules, undoInputRule, wrappingInputRule, textblockTypeInputRule } from "prosemirror-inputrules";
import { splitListItem, liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list";
import { HIGHLIGHT_COLORS, TEXT_COLORS, TEXT_SIZES, schema } from "./editor/schema";
import { longSentences, longSentencesOn, readability, showLongSentences } from "./editor/readability";
import { blockDirection, directionAt, textDirection } from "./editor/direction";
import { softCaret } from "./editor/caret";
import { HARAKAT, activeHarakat, clearHarakat, setHaraka } from "./editor/harakat";
import { applyResults, previewHtml, targets, type Target } from "./editor/tashkeel";
import { applyMemory, emptyMemory, learn, recordApplied, type TashkeelMemory } from "./editor/memory";
import { edits as punctuationEdits, isEnglish, modelInput, words as splitWords } from "./editor/punctuation";
import { blocksIn, underlinesIn, ignoreUnderline, setSpellcheck, showClaudeSuggestions, spellcheck, spellcheckEnabled, underlineAt, type Issue, type Underline } from "./editor/spellcheck";
import { displayName, fromDocx, fromQalam, fromText, toDocx, toQalam, toText, type FileKind } from "./editor/files";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

const { nodes, marks } = schema;

const commands: Record<string, Command> = {
  h1: setBlockType(nodes.heading, { level: 1 }),
  h2: setBlockType(nodes.heading, { level: 2 }),
  p: setBlockType(nodes.paragraph),
  bold: toggleMark(marks.strong),
  italic: toggleMark(marks.em),
  underline: toggleMark(marks.underline),
  ul: wrapInList(nodes.bullet_list),
  ol: wrapInList(nodes.ordered_list),
};

// ---- Automatic English punctuation ----
// Pressing Enter at the end of an English paragraph queues it; once the model has
// answered, missing capitals and punctuation are added (see editor/punctuation.ts).
interface PunctuationJob {
  pos: number; // position just before the paragraph, kept up to date as the text changes
  text: string;
}
const punctuationJobs: PunctuationJob[] = [];
// American or British English spelling (and grammar dialect), chosen in Settings.
let englishVariant: "us" | "gb" = "us";
try { englishVariant = localStorage.getItem("qalam.english") === "gb" ? "gb" : "us"; } catch {}

let autoPunctuation = true;
try { autoPunctuation = localStorage.getItem("qalam.autoPunctuation") !== "off"; } catch {}

const notePunctuationJob: Command = (state) => {
  const { $from, empty } = state.selection;
  const text = $from.parent.textContent;
  if (autoPunctuation && empty && $from.parent.isTextblock && $from.parentOffset === $from.parent.content.size && isEnglish(text)) {
    punctuationJobs.push({ pos: $from.before(), text });
    setTimeout(runPunctuationJobs, 0);
  }
  return false; // let Enter do its normal work
};

// Arabic-Indic (٠-٩) and Persian (۰-۹) digits count as numbers too, so "١. " starts a
// numbered list when typing on an Arabic keyboard.
const DIGITS = "0-9\u0660-\u0669\u06F0-\u06F9";
function toNumber(digits: string): number {
  return Number(digits.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) & 0xf)));
}

/** The direction of the paragraph being typed in (an empty one follows the text before it). */
function typingDirection(state: EditorState, at: number): "rtl" | "ltr" | null {
  return textDirection(state.doc.resolve(at).parent.textContent) ?? lastTypedDirection ?? directionAt(state);
}

// Quotation marks: «…» in Arabic, “…” in English. Opening after a space or at the start.
const quotes = new InputRule(/"$/, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  const before = start > $start.start() ? state.doc.textBetween(start - 1, start) : "";
  const opening = !before || /[\s(\[{«“]/.test(before);
  const mark = typingDirection(state, start) === "rtl" ? (opening ? "«" : "»") : opening ? "“" : "”";
  return state.tr.insertText(mark, start, end);
});

// Digits typed in an Arabic paragraph become ٠-٩ when the writer chose that in Settings.
const arabicIndicDigits = new InputRule(/[0-9]$/, (state, match, start, end) => {
  if (arabicDigits !== "arabic-indic" || typingDirection(state, start) !== "rtl") return null;
  return state.tr.insertText(String.fromCharCode(0x0660 + Number(match[0])), start, end);
});

// Markdown-style shortcuts while typing: "# " heading, "- " bullets, "1. " / "١. " numbers.
const rules = inputRules({
  rules: [
    quotes,
    arabicIndicDigits,
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
    keymap({ Enter: notePunctuationJob }), // first, so it sees every Enter exactly once
    rules,
    // Tab moves between table cells (before the list keys below).
    keymap({ Tab: goToNextCell(1), "Shift-Tab": goToNextCell(-1), "Mod-Enter": insertPageBreak }),
    tableEditing(),
    findPlugin,
    longSentences,
    blockDirection,
    softCaret,
    spellcheck({ check: (paragraphs) => invoke<Issue[][]>("spell_check", { paragraphs, english: englishVariant }) }),
    history(),
    keymap({
      Backspace: undoInputRule, // right after «, “ or ١: back to what was typed
      "Mod-z": undo,
      "Mod-y": redo,
      "Mod-Shift-z": redo,
      "Mod-b": commands.bold,
      "Mod-i": commands.italic,
      "Mod-u": commands.underline,
      "Mod-]": () => (changeSize(1), true),
      "Mod-[": () => (changeSize(-1), true),
      "Mod-Shift-f": () => (setFocusMode(true), true),
      "Mod-Alt-1": commands.h1,
      "Mod-Alt-2": commands.h2,
      "Mod-Alt-0": commands.p,
      // Alt+1…8 put a حركة on the letter before the cursor, Alt+0 clears them.
      ...Object.fromEntries(HARAKAT.map((h) => [`Alt-${h.key}`, setHaraka(h.mark)])),
      "Alt-0": clearHarakat,
      "Mod-f": () => (openFind(false), true),
      "Mod-p": () => (printDocument(), true),
      "Mod-Shift-o": () => (toggleOutline(), true),
      "Mod-h": () => (openFind(true), true),
      // Files, as in every editor.
      "Mod-n": () => (newDocument(), true),
      "Mod-o": () => (openDocument(), true),
      "Mod-s": () => (saveDocument(), true),
      "Mod-Shift-s": () => (saveDocument(true), true),
      // Opens the spelling/grammar card for the underline at the cursor, from the keyboard.
      "Mod-.": () => openSpellCardAtCursor(),
      "Mod-Shift-g": () => (runDeepCheck(), true),
      "Mod-Shift-y": () => (showSynonyms(claudeButton), true),
      "Mod-Shift-t": () => {
        runTashkeel();
        return true;
      },
      Enter: splitListItem(nodes.list_item),
      Tab: sinkListItem(nodes.list_item),
      "Shift-Tab": liftListItem(nodes.list_item),
    }),
    keymap(baseKeymap),
  ],
});

let lastTypedDirection: "rtl" | "ltr" | null = null;

const view = new EditorView(document.getElementById("page")!, {
  state,
  attributes: { spellcheck: "false" }, // our own checker will draw the underlines
  nodeViews: { image: (node, view, getPos) => new ImageView(node, view, getPos) },
  // Typing an Arabic letter (e.g. right after switching keyboards) shows the Arabic tools.
  handleTextInput(_view, _from, _to, text) {
    lastTypedDirection = textDirection(text) ?? lastTypedDirection;
    return false;
  },
  // Images pasted or dragged in are kept inside the document.
  handlePaste(view, event) {
    const files = imageFiles(event.clipboardData?.files);
    if (!files.length) return false;
    insertImageFiles(files, view.state.selection.from);
    return true;
  },
  handleDrop(view, event) {
    const files = imageFiles((event as DragEvent).dataTransfer?.files);
    if (!files.length) return false;
    const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
    insertImageFiles(files, at?.pos ?? view.state.selection.from);
    return true;
  },
  dispatchTransaction(tr) {
    if (tr.selectionSet && !tr.docChanged) lastTypedDirection = null; // moved: go by the paragraph again
    for (const job of punctuationJobs) job.pos = tr.mapping.map(job.pos);
    view.updateState(view.state.apply(tr));
    if (tr.docChanged) {
      closeSpellCard();
      documentChanged();
      outlineChanged();
    }
    updateStatus();
  },
});

const harakatBar = document.getElementById("harakat")!;
HARAKAT.forEach((h, i) => {
  const btn = document.createElement("button");
  btn.className = "haraka";
  btn.dataset.mark = h.mark;
  btn.style.setProperty("--i", String(i)); // entrance stagger
  const glyph = btn.appendChild(document.createElement("span"));
  glyph.className = "glyph";
  glyph.textContent = "\u0628" + h.mark; // shown on ب, as in Arabic teaching books: بَ
  btn.title = `${h.name} (Alt+${h.key})`;
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    setHaraka(h.mark)(view.state, view.dispatch, view);
    view.focus();
  });
  harakatBar.appendChild(btn);
});

// The editable area is only as tall as the text, so a click on the empty part of the
// sheet (or the desk around it) would miss it. Put the cursor at the nearest text instead.
document.querySelector(".desk")!.addEventListener("mousedown", (e) => {
  const event = e as MouseEvent;
  if (event.button !== 0 || view.dom.contains(event.target as Node)) return;
  event.preventDefault();
  const box = view.dom.getBoundingClientRect();
  const left = Math.min(Math.max(event.clientX, box.left + 1), box.right - 1);
  const top = Math.min(Math.max(event.clientY, box.top + 1), box.bottom - 1);
  const pos = view.posAtCoords({ left, top })?.pos;
  const { doc, tr } = view.state;
  const selection = pos === undefined || event.clientY > box.bottom
    ? Selection.atEnd(doc)
    : Selection.near(doc.resolve(pos));
  view.dispatch(tr.setSelection(selection).scrollIntoView());
  view.focus();
});

document.querySelectorAll<HTMLButtonElement>("[data-cmd]").forEach((btn) => {
  btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the text selection
  btn.addEventListener("click", () => {
    commands[btn.dataset.cmd!](view.state, view.dispatch, view);
    view.focus();
  });
});

function updateStatus() {
  updateStyleLabel();
  updateReadability();
  const text = view.state.doc.textContent.trim();
  const words = text ? text.split(/\s+/).length : 0;
  document.getElementById("words")!.textContent = `${words} ${words === 1 ? "word" : "words"}`;

  const marks = activeHarakat(view.state);
  harakatBar.querySelectorAll<HTMLButtonElement>(".haraka").forEach((b) => {
    b.classList.toggle("active", marks.includes(b.dataset.mark!));
  });

  const dir = textDirection(view.state.selection.$from.parent.textContent);
  document.getElementById("dir")!.textContent = dir === "rtl" ? "العربية" : dir === "ltr" ? "English" : "";

  // Arabic tools (حركات, شكّل) only while writing Arabic.
  // Shown in an Arabic paragraph, right after typing an Arabic letter (even inside English
  // text), or on an empty line that follows Arabic.
  const arabic =
    dir === "rtl" || lastTypedDirection === "rtl" || (!dir && !lastTypedDirection && directionAt(view.state) === "rtl");
  const english = !arabic && (dir === "ltr" || lastTypedDirection === "ltr" || (!dir && directionAt(view.state) === "ltr"));
  // Switching language swaps the groups at once: both showing for a moment would make the
  // toolbar wrap and the page jump.
  showArabicTools(arabic, english);
  showEnglishTools(english, arabic);
}

// The language tools ease in, button by button, and ease out instead of vanishing. Hiding
// waits a moment so moving the cursor across a mixed document doesn't make them flicker.
function toolGroup(el: HTMLElement) {
  let hideTimer: number | undefined;
  /** `now`: hide at once, when the other language's tools take the place. */
  return (show: boolean, now = false) => {
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!show && now) {
      clearTimeout(hideTimer);
      hideTimer = undefined;
      el.hidden = true;
      el.classList.remove("leaving");
      return;
    }
    if (show) {
      clearTimeout(hideTimer);
      hideTimer = undefined;
      if (el.hidden || el.classList.contains("leaving")) {
        el.classList.remove("leaving");
        el.hidden = false;
      }
      return;
    }
    if (el.hidden || hideTimer !== undefined) return;
    if (reduceMotion) {
      el.hidden = true;
      return;
    }
    hideTimer = window.setTimeout(() => {
      el.classList.add("leaving");
      hideTimer = window.setTimeout(() => {
        el.hidden = true;
        el.classList.remove("leaving");
        hideTimer = undefined;
      }, 260);
    }, 350);
  };
}
const arabicTools = document.getElementById("arabic-tools")!;
const showArabicTools = toolGroup(arabicTools);
const showEnglishTools = toolGroup(document.getElementById("english-tools")!);

// The buttons are centred on their ink, not the font's line box, which would push marks
// against the button's edges. Marks above the letter share one baseline and marks below
// (ِ ٍ) another, so the ب stays level across each group.
function centerHarakat() {
  const ctx = document.createElement("canvas").getContext("2d")!;
  const glyphs = [...harakatBar.querySelectorAll<HTMLElement>(".glyph")];
  const style = getComputedStyle(glyphs[0]);
  ctx.font = `${style.fontSize} ${style.fontFamily}`;
  const letter = ctx.measureText("ب");
  const measured = glyphs.map((glyph) => ({ glyph, m: ctx.measureText(glyph.textContent!) }));
  for (const below of [false, true]) {
    const group = measured.filter(({ m }) => (m.actualBoundingBoxDescent > letter.actualBoundingBoxDescent + 1) === below);
    if (!group.length) continue;
    const ascent = Math.max(...group.map(({ m }) => m.actualBoundingBoxAscent));
    const descent = Math.max(...group.map(({ m }) => m.actualBoundingBoxDescent));
    const { fontBoundingBoxAscent: a, fontBoundingBoxDescent: d } = group[0].m;
    const dy = (ascent - descent) / 2 - (a - d) / 2;
    for (const { glyph } of group) glyph.style.setProperty("--dy", `${dy.toFixed(1)}px`);
  }
}

// Arabic document font: Amiri by default, Vazirmatn as the modern, flat alternative.
// Scheherazade only on Windows: Linux's WebKitGTK makes its words with حركات jump off the line.
const onWindows = navigator.userAgent.includes("Windows");
const ARABIC_FONTS = onWindows ? ["amiri", "vazirmatn", "scheherazade"] : ["amiri", "vazirmatn"];
const fontPicker = document.getElementById("arabic-font") as HTMLSelectElement;
if (!onWindows) fontPicker.querySelector('option[value="scheherazade"]')?.remove();
function setArabicFont(name: string) {
  if (!ARABIC_FONTS.includes(name)) name = "amiri";
  document.documentElement.dataset.arabicFont = name;
  fontPicker.value = name;
  try { localStorage.setItem("qalam.arabicFont", name); } catch {}
  const size = getComputedStyle(harakatBar.querySelector(".glyph")!).fontSize;
  document.fonts.load(`${size} ${getComputedStyle(document.documentElement).getPropertyValue("--arabic-font")}`, "بَ").then(centerHarakat);
}
let savedFont = "amiri";
try { savedFont = localStorage.getItem("qalam.arabicFont") ?? savedFont; } catch {}
setArabicFont(savedFont);
fontPicker.addEventListener("change", () => {
  setArabicFont(fontPicker.value);
  view.focus();
  view.dispatch(view.state.tr); // re-measure the cursor for the new font
});

// ---- Automatic تشكيل ----
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tashkeelBtn = $<HTMLButtonElement>("tashkeel");
const modePicker = $<HTMLSelectElement>("tashkeel-mode");
const preview = $("preview");
const settings = $<HTMLDialogElement>("settings");

try { modePicker.value = localStorage.getItem("qalam.tashkeelMode") ?? "light"; } catch {}
modePicker.addEventListener("change", () => {
  try { localStorage.setItem("qalam.tashkeelMode", modePicker.value); } catch {}
  view.focus();
});

let pending: { ts: Target[]; results: string[]; doc: typeof view.state.doc } | null = null;

// What Qalam has learned from the writer's corrections (editor/memory.ts).
let memory: TashkeelMemory | null = null;
async function loadMemory(): Promise<TashkeelMemory> {
  if (!memory) {
    const json = await invoke<string>("load_tashkeel_memory");
    try { memory = json ? { ...emptyMemory(), ...JSON.parse(json) } : emptyMemory(); } catch { memory = emptyMemory(); }
  }
  return memory!;
}
const saveMemory = () => invoke("save_tashkeel_memory", { json: JSON.stringify(memory) });

// Claude when there's an API key (best accuracy), otherwise the offline CATT model; if
// Claude fails (no internet, rate limit), fall back to offline automatically.
/** Removes every حركة in the selection, or in the paragraph at the cursor. */
function removeTashkeel() {
  const { from, to, empty, $from } = view.state.selection;
  const [start, end] = empty ? [$from.start(), $from.end()] : [from, to];
  const tr = view.state.tr;
  view.state.doc.nodesBetween(start, end, (node, pos) => {
    if (!node.isText) return;
    const text = node.text!;
    for (let i = text.length - 1; i >= 0; i--) {
      const at = pos + i;
      if (at >= start && at < end && /[\u064B-\u0652\u0670]/.test(text[i])) tr.delete(tr.mapping.map(at), tr.mapping.map(at + 1));
    }
  });
  if (tr.docChanged) view.dispatch(tr);
  else showDocState("لا توجد حركات هنا · No تشكيل here");
  view.focus();
}

async function runTashkeel() {
  if (tashkeelBtn.disabled) return;
  if (modePicker.value === "remove") return removeTashkeel();
  const ts = targets(view.state);
  if (!ts.length) {
    showNote("لا يوجد نص عربي هنا · No Arabic text here");
    return;
  }
  const mode = modePicker.value;
  const paragraphs = ts.map((t) => t.text);
  const mem = await loadMemory();
  if (learn(mem, paragraphs)) await saveMemory();
  tashkeelBtn.disabled = true;
  tashkeelBtn.textContent = "…";
  try {
    let results: string[] | null = null;
    let engine = "Claude";
    if (await invoke<boolean>("has_api_key")) {
      try {
        results = await invoke<string[]>("diacritize", { paragraphs, mode });
      } catch (e) {
        if (!(await invoke<boolean>("offline_model_installed"))) throw e;
        engine = `offline (Claude failed: ${e})`;
      }
    }
    if (!results) {
      if (!(await invoke<boolean>("offline_model_installed")) && !(await installOfflineModel())) return;
      results = await invoke<string[]>("diacritize_offline", { paragraphs, mode });
      if (engine === "Claude") engine = "offline";
    }
    results = results.map((r, i) => applyMemory(paragraphs[i], r, mem));
    showPreview(ts, results, mode === "light", engine);
  } catch (e) {
    showNote(String(e));
  } finally {
    tashkeelBtn.disabled = false;
    tashkeelBtn.textContent = "شكّل";
  }
}

/** Downloads the offline model after asking; resolves to whether it's now installed. */
async function installOfflineModel(): Promise<boolean> {
  const ok = await confirmInPreview(
    "تنزيل نموذج التشكيل · Download the offline تشكيل model?",
    "One-time download, 72 MB (CATT by Abjad AI, Apache-2.0). After that تشكيل works without internet.",
    "Download",
  );
  if (!ok) return false;
  const unlisten = await listen<{ received: number; total: number | null }>("model-download", ({ payload }) => {
    const mb = (n: number) => (n / 1e6).toFixed(0);
    $("preview-title").textContent = payload.total
      ? `Downloading… ${Math.round((100 * payload.received) / payload.total)}% (${mb(payload.received)} of ${mb(payload.total)} MB)`
      : `Downloading… ${mb(payload.received)} MB`;
  });
  try {
    showNote("Downloading…");
    await invoke("install_offline_model");
    return true;
  } finally {
    unlisten();
  }
}

/** Shows a question in the preview card with one action button; resolves on the choice. */
function confirmInPreview(title: string, note: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    showNote(title);
    $("preview-note").textContent = note;
    const accept = $<HTMLButtonElement>("preview-accept");
    const cancel = $<HTMLButtonElement>("preview-cancel");
    accept.textContent = action;
    accept.hidden = false;
    const done = (answer: boolean) => {
      accept.removeEventListener("click", yes, true);
      cancel.removeEventListener("click", no, true);
      accept.textContent = "قبول · Accept";
      resolve(answer);
    };
    const yes = (e: Event) => { e.stopImmediatePropagation(); done(true); };
    const no = (e: Event) => { e.stopImmediatePropagation(); closePreview(); done(false); };
    accept.addEventListener("click", yes, true);
    cancel.addEventListener("click", no, true);
  });
}

function showPreview(ts: Target[], results: string[], light: boolean, engine: string) {
  const { changed, skipped } = applyResults(view.state, ts, results);
  pending = { ts, results, doc: view.state.doc };
  $("preview-body").innerHTML = ts.map((t, i) => `<p>${previewHtml(t, results[i])}</p>`).join("");
  $("preview-title").textContent = changed
    ? "التشكيل المقترح"
    : light
      ? "لا تغييرات في الوضع الخفيف · Nothing to add in light mode. Try كامل."
      : "لا تغييرات مقترحة · Nothing to change";
  const source = engine === "Claude" ? "Claude" : engine === "offline" ? "Offline model" : `Offline model ${engine.slice("offline ".length)}`;
  $("preview-note").textContent =
    source +
    (skipped ? ` · ${skipped} ${skipped === 1 ? "word" : "words"} left as typed (the AI tried to change letters)` : "");
  $<HTMLButtonElement>("preview-accept").hidden = !changed;
  preview.hidden = false;
}

function closePreview() {
  preview.hidden = true;
  pending = null;
  pendingTransform = null;
  pendingAction = null;
  view.focus();
}

$("preview-accept").addEventListener("click", () => {
  if (pendingAction) {
    const action = pendingAction;
    pendingAction = null;
    if (action()) closePreview();
    return;
  }
  if (pendingTransform) {
    if (acceptTransform()) closePreview();
    return;
  }
  // If the text changed while the preview was open, the positions no longer line up.
  if (pending && pending.doc.eq(view.state.doc)) {
    const { tr } = applyResults(view.state, pending.ts, pending.results);
    view.dispatch(tr.scrollIntoView());
    // Remember what Qalam put in, so a later change by the writer is recognised as a correction.
    const texts = pending.ts.map((t) => view.state.doc.resolve(tr.mapping.map(t.start)).parent.textContent);
    if (memory) {
      recordApplied(memory, texts);
      saveMemory();
    }
  } else if (pending) showNote("The text changed meanwhile. Press شكّل again.");
  closePreview();
});
$("preview-cancel").addEventListener("click", closePreview);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !preview.hidden) closePreview();
});

tashkeelBtn.addEventListener("mousedown", (e) => e.preventDefault());
tashkeelBtn.addEventListener("click", () => runTashkeel());

function showNote(text: string) {
  $("preview-title").textContent = text;
  $("preview-note").textContent = "";
  $("preview-body").innerHTML = "";
  $<HTMLButtonElement>("preview-accept").hidden = true;
  pending = null;
  preview.hidden = false;
}

let punctuationBusy = false;
async function runPunctuationJobs() {
  if (punctuationBusy || !punctuationJobs.length) return;
  punctuationBusy = true;
  try {
    if (!(await invoke<boolean>("punctuation_model_installed")) && !(await offerPunctuationModel())) {
      punctuationJobs.length = 0;
      return;
    }
    while (punctuationJobs.length) {
      const job = punctuationJobs[0];
      const suggestions = await invoke<string[][]>("punctuate_offline", {
        paragraphs: [splitWords(job.text).map((w) => modelInput(w.text))],
      });
      punctuationJobs.shift();
      // Apply only if the paragraph is still exactly as it was when Enter was pressed.
      const node = view.state.doc.nodeAt(job.pos);
      if (!node || !node.isTextblock || node.textContent !== job.text) continue;
      const start = job.pos + 1;
      let tr = view.state.tr;
      for (const e of punctuationEdits(job.text, suggestions[0]).reverse()) {
        tr = tr.insertText(e.text, start + e.offset, start + e.offset + e.length);
      }
      if (tr.docChanged) view.dispatch(closeHistory(tr));
    }
  } catch (e) {
    punctuationJobs.length = 0;
    showNote(`Auto-punctuation: ${e}`);
  } finally {
    punctuationBusy = false;
  }
}

/** Asks once whether to download the English punctuation model; declining turns it off. */
async function offerPunctuationModel(): Promise<boolean> {
  const ok = await confirmInPreview(
    "Download the English punctuation model?",
    "One-time download, 210 MB (punct_cap_seg_en, Apache-2.0). It adds missing capitals and . , ? when you finish an English paragraph, without internet.",
    "Download",
  );
  if (!ok) {
    setAutoPunctuation(false);
    return false;
  }
  const unlisten = await listen<{ received: number; total: number | null }>("model-download", ({ payload }) => {
    const mb = (n: number) => (n / 1e6).toFixed(0);
    $("preview-title").textContent = payload.total
      ? `Downloading… ${Math.round((100 * payload.received) / payload.total)}% (${mb(payload.received)} of ${mb(payload.total)} MB)`
      : `Downloading… ${mb(payload.received)} MB`;
  });
  try {
    showNote("Downloading…");
    await invoke("install_punctuation_model");
    closePreview();
    return true;
  } finally {
    unlisten();
  }
}

const autoPunctButton = $<HTMLButtonElement>("auto-punct");
function setAutoPunctuation(on: boolean) {
  autoPunctuation = on;
  autoPunctButton.textContent = `Auto-punctuation: ${on ? "on" : "off"}`;
  try { localStorage.setItem("qalam.autoPunctuation", on ? "on" : "off"); } catch {}
}
setAutoPunctuation(autoPunctuation);
autoPunctButton.addEventListener("click", () => {
  setAutoPunctuation(!autoPunctuation);
  view.focus();
});

// ---- Spelling and grammar: the card for an underlined word ----
// Clicking (or right-clicking) an underline opens a small card under it. A misspelt word gets
// up to six suggestions, "Add to dictionary" and "Ignore"; a grammar problem gets its fixes,
// what's wrong, and "Ignore". The labels follow the text's language.
const spellCard = $("spell-card");
const spellSuggestions = $("spell-suggestions");
const spellNote = $("spell-note");
let spellTarget: Underline | null = null;

interface SpellSuggestions {
  words: string[];
  note: string | null;
}

function closeSpellCard() {
  spellCard.hidden = true;
  spellTarget = null;
}

function suggestionButton(label: string, onClick?: () => void) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.setAttribute("role", "menuitem");
  if (onClick) btn.addEventListener("click", onClick);
  else btn.disabled = true;
  return btn;
}

async function openSpellCard(target: Underline, anchor: DOMRect) {
  spellTarget = target;
  const arabic = textDirection(target.text) === "rtl";
  spellCard.dir = arabic ? "rtl" : "ltr";
  $("spell-add").textContent = arabic ? "أضف إلى القاموس" : "Add to dictionary";
  $("spell-add").hidden = target.kind !== "spelling";
  spellCard.classList.toggle("is-claude", target.kind === "claude");
  $("spell-ignore").textContent = arabic ? "تجاهل" : "Ignore";
  spellNote.hidden = true;
  spellCard.classList.toggle("is-grammar", target.kind === "grammar");
  if (target.kind !== "spelling") showSuggestions(target, { words: target.replacements ?? [], note: target.message ?? null }, arabic);
  else spellSuggestions.replaceChildren(suggestionButton("…"));
  spellCard.hidden = false;

  // Under the word, lined up with its start (its right edge for Arabic), kept on screen.
  const card = spellCard.getBoundingClientRect();
  const left = arabic ? anchor.right - card.width : anchor.left;
  spellCard.style.left = `${Math.max(8, Math.min(left, window.innerWidth - card.width - 8))}px`;
  const below = anchor.bottom + 6;
  spellCard.style.top = `${below + card.height > window.innerHeight - 8 ? anchor.top - card.height - 6 : below}px`;

  if (target.kind !== "spelling") return;
  const result = await invoke<SpellSuggestions>("spell_suggest", { word: target.text, english: englishVariant }).catch(() => ({ words: [], note: null }));
  if (spellTarget !== target) return; // closed or moved on meanwhile
  showSuggestions(target, result, arabic);
}

function showSuggestions(target: Underline, result: SpellSuggestions, arabic: boolean) {
  // An empty replacement removes the text ("discuss about" → remove "about" is shown as such).
  const label = (w: string) => (w ? w : arabic ? `احذف «${target.text}»` : `Remove “${target.text}”`);
  spellSuggestions.replaceChildren(
    ...(result.words.length
      ? result.words.map((w) => suggestionButton(label(w), () => replaceUnderlined(target, w)))
      : [suggestionButton(arabic ? "لا اقتراحات" : "No suggestions")]),
  );
  spellNote.textContent = result.note ?? "";
  spellNote.hidden = !result.note;
}

function replaceUnderlined(target: Underline, replacement: string) {
  closeSpellCard();
  const current = view.state.doc.textBetween(target.from, target.to);
  if (current === target.text) {
    const tr = replacement ? view.state.tr.insertText(replacement, target.from, target.to) : view.state.tr.delete(target.from, target.to);
    view.dispatch(tr);
  }
  view.focus();
}

function openSpellCardAt(event: MouseEvent): boolean {
  const el = (event.target as HTMLElement).closest?.(".misspelt, .grammar-issue, .claude-issue");
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  const target = el && at ? underlineAt(view.state, at.pos) : null;
  if (!el || !target) return false;
  openSpellCard(target, el.getBoundingClientRect());
  return true;
}

function openSpellCardAtCursor(): boolean {
  const target = underlineAt(view.state, view.state.selection.head);
  if (!target) return false;
  const start = view.coordsAtPos(target.from);
  const end = view.coordsAtPos(target.to);
  const anchor = new DOMRect(Math.min(start.left, end.left), start.top, Math.abs(end.left - start.left), start.bottom - start.top);
  openSpellCard(target, anchor).then(() => spellCard.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
  return true;
}

view.dom.addEventListener("click", (e) => {
  if (!openSpellCardAt(e)) closeSpellCard();
});
view.dom.addEventListener("contextmenu", (e) => {
  if (openSpellCardAt(e)) e.preventDefault();
});
$("spell-add").addEventListener("click", async () => {
  const target = spellTarget;
  closeSpellCard();
  if (!target) return;
  try {
    await invoke("spell_add_word", { word: target.text });
    view.dispatch(ignoreUnderline(view.state.tr, target));
  } catch (e) {
    console.warn(e);
  }
  view.focus();
});
$("spell-ignore").addEventListener("click", () => {
  const target = spellTarget;
  closeSpellCard();
  if (target) view.dispatch(ignoreUnderline(view.state.tr, target));
  view.focus();
});
spellCard.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor's selection
document.addEventListener("mousedown", (e) => {
  if (!spellCard.hidden && !spellCard.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".misspelt, .grammar-issue, .claude-issue")) closeSpellCard();
});
document.addEventListener("keydown", (e) => {
  // Up and down move between the card's choices when it was opened from the keyboard.
  if (!spellCard.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp") && spellCard.contains(document.activeElement)) {
    const buttons = [...spellCard.querySelectorAll<HTMLButtonElement>("button:not(:disabled):not([hidden])")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    e.preventDefault();
  }
  if (e.key === "Escape" && !spellCard.hidden) {
    closeSpellCard();
    view.focus();
  }
});
document.querySelector(".desk")!.addEventListener("scroll", closeSpellCard);

const spellcheckButton = $<HTMLButtonElement>("spellcheck-toggle");
function showSpellcheckButton() {
  spellcheckButton.textContent = `Spellcheck: ${spellcheckEnabled(view.state) ? "on" : "off"}`;
}
showSpellcheckButton();
spellcheckButton.addEventListener("click", () => {
  const on = !spellcheckEnabled(view.state);
  try { localStorage.setItem("qalam.spellcheck", on ? "on" : "off"); } catch {}
  view.dispatch(setSpellcheck(view.state.tr, on));
  closeSpellCard();
  showSpellcheckButton();
  view.focus();
});

// ---- Images ----
// Stored in the document as data URLs, so a .qalam file is complete on its own.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function insertImage(src: string, at?: number) {
  const image = schema.nodes.image.create({ src });
  const tr = at === undefined ? view.state.tr.replaceSelectionWith(image) : view.state.tr.insert(at, image);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

async function insertImageFiles(files: File[], at: number) {
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      showDocState(`${file.name} is larger than 20 MB. Please use a smaller image.`);
      continue;
    }
    insertImage(await readAsDataUrl(file), at);
    at += 1; // the next one goes after it
  }
}

async function pickAndInsertImage() {
  try {
    const src = await invoke<string | null>("pick_image", { current: docPath });
    if (src) insertImage(src);
  } catch (e) {
    showDocState(String(e).replace(/^Error: /, ""));
  }
}

// ---- Find and replace ----
const findBar = $("find-bar");
const findInput = $<HTMLInputElement>("find-input");
const replaceInput = $<HTMLInputElement>("replace-input");
const findOptions = () => ({
  ignoreMarks: $<HTMLInputElement>("find-marks").checked,
  letterForms: $<HTMLInputElement>("find-forms").checked,
  matchCase: $<HTMLInputElement>("find-case").checked,
});
function showFindCount() {
  const s = findState(view.state);
  $("find-count").textContent = !s.query ? "" : s.matches.length ? `${s.current + 1} / ${s.matches.length}` : "0";
}
function runSearch() {
  view.dispatch(search(view.state.tr, findInput.value, findOptions()));
  showFindCount();
}
function openFind(withReplace: boolean) {
  findBar.hidden = false;
  $("replace-row").hidden = !withReplace;
  const { from, to } = view.state.selection;
  const selected = view.state.doc.textBetween(from, to);
  if (selected && !selected.includes("\n") && selected.length < 100) findInput.value = selected;
  findInput.focus();
  findInput.select();
  runSearch();
}
function closeFind() {
  findBar.hidden = true;
  view.dispatch(stopSearching(view.state.tr));
  view.focus();
}
function goTo(dir: 1 | -1) {
  const tr = step(view.state, dir);
  if (tr) view.dispatch(tr);
  showFindCount();
}
findInput.addEventListener("input", runSearch);
for (const id of ["find-marks", "find-forms", "find-case"]) $(id).addEventListener("change", runSearch);
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") (e.preventDefault(), goTo(e.shiftKey ? -1 : 1));
});
replaceInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") (e.preventDefault(), $("replace-one").click());
});
findBar.addEventListener("keydown", (e) => {
  if (e.key === "Escape") (e.preventDefault(), closeFind());
});
$("find-next").addEventListener("click", () => goTo(1));
$("find-prev").addEventListener("click", () => goTo(-1));
$("find-close").addEventListener("click", closeFind);
$("replace-one").addEventListener("click", () => {
  const tr = replaceCurrent(view.state, replaceInput.value);
  if (tr) view.dispatch(tr);
  showFindCount();
});
$("replace-all").addEventListener("click", () => {
  const result = replaceAll(view.state, replaceInput.value);
  if (!result) return;
  view.dispatch(result.tr);
  showFindCount();
  showDocState(`Replaced ${result.count} · تم استبدال ${result.count}`);
});

// ---- Settings: Arabic digits and page numbers ----
let arabicDigits = "as-typed";
let pageNumbers = "auto";
try {
  arabicDigits = localStorage.getItem("qalam.arabicDigits") ?? arabicDigits;
  pageNumbers = localStorage.getItem("qalam.pageNumbers") ?? pageNumbers;
} catch {}
$<HTMLSelectElement>("arabic-digits").value = arabicDigits;
$<HTMLSelectElement>("page-numbers").value = pageNumbers;
$("arabic-digits").addEventListener("change", (e) => {
  arabicDigits = (e.target as HTMLSelectElement).value;
  try { localStorage.setItem("qalam.arabicDigits", arabicDigits); } catch {}
});
$("page-numbers").addEventListener("change", (e) => {
  pageNumbers = (e.target as HTMLSelectElement).value;
  try { localStorage.setItem("qalam.pageNumbers", pageNumbers); } catch {}
});
/** Page numbers for a Word file: none, 123, or ١٢٣ (automatic: when most of the text is Arabic). */
function pageNumberStyle(doc: PMNode): "none" | "western" | "arabic-indic" {
  if (pageNumbers === "none" || pageNumbers === "western") return pageNumbers;
  const text = doc.textContent;
  const arabic = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabic > latin ? "arabic-indic" : "western";
}

// ---- Outline: the document's headings, to jump between them ----
const outline = $("outline");
function renderOutline() {
  if (outline.hidden) return;
  const list = $("outline-list");
  const items: HTMLElement[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    const b = document.createElement("button");
    b.className = `level-${node.attrs.level}`;
    b.textContent = node.textContent || "…";
    b.dir = "auto";
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos + 1))).scrollIntoView());
      view.focus();
    });
    items.push(b);
    return false;
  });
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "outline-empty";
    p.textContent = "No headings yet. Make one with H1 or H2 (or type # and a space).";
    items.push(p);
  }
  list.replaceChildren(...items);
}
function toggleOutline() {
  outline.hidden = !outline.hidden;
  document.body.classList.toggle("with-outline", !outline.hidden);
  $("outline-toggle").textContent = outline.hidden ? "☰ Outline" : "☰ Hide outline";
  renderOutline();
}
$("outline-toggle").addEventListener("click", toggleOutline);
let outlineTimer: number | undefined;
function outlineChanged() {
  clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(renderOutline, 300);
}

// ---- Paragraph style (the menu that replaced H1 H2 ¶) ----
function updateStyleLabel() {
  const parent = view.state.selection.$from.parent;
  const label = parent.type.name === "heading" ? (parent.attrs.level === 1 ? "Heading" : "Subheading") : "Text";
  const el = document.getElementById("style-label");
  if (el && el.textContent !== label) el.textContent = label;
}
menuButton($("style-button"), $("style-menu"), (item) => run(commands[item.dataset.style!]));

// ---- Text: strikethrough, colour, highlight, size, clear ----
function applyMark(type: (typeof marks)[keyof typeof marks], attrs?: Record<string, unknown>) {
  const { from, to, empty } = view.state.selection;
  if (empty) return; // these apply to a selection
  let tr = view.state.tr.removeMark(from, to, type);
  if (attrs) tr = tr.addMark(from, to, type.create(attrs));
  view.dispatch(tr);
  view.focus();
}
function changeSize(step: 1 | -1) {
  const { from, to, empty, $from } = view.state.selection;
  if (empty) return;
  const current = (marks.size.isInSet($from.marks()) ?? marks.size.isInSet(view.state.doc.nodeAt(from)?.marks ?? []))?.attrs.scale ?? 1;
  const i = TEXT_SIZES.indexOf(current);
  const next = TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, (i < 0 ? 1 : i) + step))];
  applyMark(marks.size, next === 1 ? undefined : { scale: next });
  void to;
}
function swatches(boxId: string, colors: string[], type: typeof marks.color) {
  const box = $(boxId);
  const none = document.createElement("button");
  none.className = "none";
  none.title = "None · بلا";
  none.dataset.swatch = "";
  box.appendChild(none);
  for (const c of colors) {
    const b = document.createElement("button");
    b.style.background = c;
    b.title = c;
    b.dataset.swatch = c;
    box.appendChild(b);
  }
  box.addEventListener("mousedown", (e) => e.preventDefault());
  box.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-swatch]");
    if (!b) return;
    closeMenu($("text-menu"));
    applyMark(type, b.dataset.swatch ? { color: b.dataset.swatch } : undefined);
  });
}
swatches("text-colors", TEXT_COLORS, marks.color);
swatches("highlight-colors", HIGHLIGHT_COLORS, marks.highlight);
menuButton($("text-button"), $("text-menu"), (item) => {
  const action = item.dataset.text;
  if (action === "strike") run(toggleMark(marks.strike));
  else if (action === "bigger") changeSize(1);
  else if (action === "smaller") changeSize(-1);
  else if (action === "clear") {
    const { from, to } = view.state.selection;
    let tr = view.state.tr;
    for (const m of Object.values(marks)) tr = tr.removeMark(from, to, m);
    view.dispatch(tr);
    view.focus();
  }
});

// ---- Changes shown in the preview before they're applied (letters, spelling) ----
let pendingAction: (() => boolean) | null = null;
interface BlockChanges { pos: number; text: string; changes: { from: number; to: number; text: string }[] }

const escapeHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Shows each paragraph with its changes highlighted; Accept applies them all as one step. */
function showChanges(title: string, note: string, blocks: BlockChanges[]) {
  const withChanges = blocks.filter((b) => b.changes.length);
  showNote(title);
  $("preview-note").textContent = note;
  const body = $("preview-body");
  body.innerHTML = withChanges
    .map((b) => {
      let html = "";
      let at = 0;
      for (const c of b.changes) {
        html += escapeHtml(b.text.slice(at, c.from)) + `<span class="changed">${escapeHtml(c.text)}</span>`;
        at = c.to;
      }
      return `<p dir="auto">${html + escapeHtml(b.text.slice(at))}</p>`;
    })
    .join("");
  const doc = view.state.doc;
  pendingAction = () => {
    if (!doc.eq(view.state.doc)) {
      showNote("The text changed meanwhile. Ask again.");
      return false;
    }
    const tr = view.state.tr;
    for (const b of [...withChanges].reverse()) {
      for (const c of [...b.changes].reverse()) {
        const from = b.pos + 1 + c.from;
        tr.insertText(c.text, from, b.pos + 1 + c.to);
      }
    }
    view.dispatch(tr.scrollIntoView());
    return true;
  };
  $<HTMLButtonElement>("preview-accept").hidden = !withChanges.length;
}

// ---- Arabic tools: fix hamzas and endings (offline), إعراب (Claude) ----
async function fixLetters(hamza: boolean, endings: boolean) {
  const blocks = targetBlocks().filter((b) => /[\u0600-\u06FF]/.test(b.text));
  if (!blocks.length) return showDocState("لا يوجد نص عربي هنا · No Arabic text here");
  let unsure = 0;
  const results: BlockChanges[] = [];
  for (const b of blocks) {
    const r = await invoke<{ fixes: [number, number, string][]; unsure: number }>("fix_letters", { paragraph: b.text, hamza, endings });
    unsure += r.unsure;
    results.push({ ...b, changes: r.fixes.map(([from, to, text]) => ({ from, to, text })) });
  }
  const n = results.reduce((sum, b) => sum + b.changes.length, 0);
  const title = n ? `التصحيحات المقترحة (${n})` : "لا شيء يحتاج إلى تصحيح هنا · Nothing to fix here";
  const note = unsure ? `${unsure} ${unsure === 1 ? "كلمة تُركت" : "كلمات تُركت"} كما هي: تحتمل أكثر من صواب (مثل ان: أن أو إن)` : "تُصحَّح الكلمة فقط حين يكون صوابها واضحًا";
  showChanges(title, note, results);
}

/** The sentence at the cursor (or the selection), for إعراب. */
function sentenceAtCursor(): string {
  const { from, to, empty, $from } = view.state.selection;
  if (!empty) return view.state.doc.textBetween(from, to, " ");
  const text = $from.parent.textContent;
  const ends = /[.!؟?؛\n]/;
  // Right after a full stop the cursor belongs to the sentence that just ended.
  let at = $from.parentOffset;
  while (at > 0 && /[\s.!؟?؛]/.test(text[at - 1])) at--;
  let start = at;
  while (start > 0 && !ends.test(text[start - 1])) start--;
  let end = at;
  while (end < text.length && !ends.test(text[end])) end++;
  return text.slice(start, end + 1).trim();
}

async function runI3rab() {
  const sentence = sentenceAtCursor();
  if (!sentence || !/[\u0600-\u06FF]/.test(sentence)) return showDocState("ضع المؤشر في جملة عربية · Put the cursor in an Arabic sentence");
  if (sentence.split(/\s+/).length > 60) return showDocState("الجملة طويلة؛ حدّد جزءًا منها · Select a shorter part");
  showDocState("جارٍ الإعراب… · Parsing with Claude…");
  try {
    const words = await invoke<{ word: string; i3rab: string }[]>("i3rab", { sentence });
    showNote("الإعراب ✦");
    $("preview-note").textContent = sentence;
    $("preview-body").innerHTML = `<table class="i3rab">${words
      .map((w) => `<tr><td class="i3rab-word">${escapeHtml(w.word)}</td><td>${escapeHtml(w.i3rab)}</td></tr>`)
      .join("")}</table>`;
    showDocState();
  } catch (e) {
    claudeError(e);
  }
}

menuButton($("arabic-menu-button"), $("arabic-menu"), (item) => {
  const action = item.dataset.arabic;
  if (action === "hamza") fixLetters(true, false);
  else if (action === "endings") fixLetters(false, true);
  else if (action === "both") fixLetters(true, true);
  else if (action === "i3rab") runI3rab();
});

// ---- Fix spelling: every misspelt word in the paragraph, with its first suggestion ----
$("fix-spelling").addEventListener("mousedown", (e) => e.preventDefault());
$("fix-spelling").addEventListener("click", async () => {
  const blocks = targetBlocks();
  const results: BlockChanges[] = [];
  for (const b of blocks) {
    const node = view.state.doc.nodeAt(b.pos)!;
    const misspelt = underlinesIn(view.state, b.pos + 1, b.pos + node.nodeSize - 1).filter((u) => u.kind === "spelling");
    const changes: BlockChanges["changes"] = [];
    for (const u of misspelt) {
      const s = await invoke<SpellSuggestions>("spell_suggest", { word: u.text, english: englishVariant }).catch(() => null);
      if (s?.words[0]) changes.push({ from: u.from - b.pos - 1, to: u.to - b.pos - 1, text: s.words[0] });
    }
    results.push({ ...b, changes: changes.sort((x, y) => x.from - y.from) });
  }
  const n = results.reduce((sum, b) => sum + b.changes.length, 0);
  showChanges(n ? `Spelling fixes (${n})` : "No misspelt words here", "Each misspelt word gets its first suggestion. Check them before accepting.", results);
});

// ---- Readability (status bar): grade level for English, sentence length for Arabic ----
const readabilityButton = $<HTMLButtonElement>("readability");
let readabilityTimer: number | undefined;
function updateReadability() {
  clearTimeout(readabilityTimer);
  readabilityTimer = window.setTimeout(() => {
    const r = readability(view.state.selection.$from.parent.textContent);
    readabilityButton.hidden = !r;
    if (!r) return;
    const mark = longSentencesOn(view.state) ? " ●" : "";
    readabilityButton.textContent = r.language === "en" ? `Grade ${r.value} · ${r.label}${mark}` : `${r.value} كلمة للجملة · ${r.label}${mark}`;
  }, 250);
}
readabilityButton.addEventListener("click", () => {
  view.dispatch(showLongSentences(view.state.tr, !longSentencesOn(view.state)));
  updateReadability();
  view.focus();
});

// ---- Focus mode ----
function setFocusMode(on: boolean) {
  document.body.classList.toggle("focus-mode", on);
  $("focus-exit").hidden = !on;
  view.focus();
}
$("focus-toggle").addEventListener("click", () => setFocusMode(true));
$("focus-exit").addEventListener("click", () => setFocusMode(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("focus-mode") && !openMenus.size && spellCard.hidden && preview.hidden) setFocusMode(false);
});

// ---- Read aloud (the system's voices) ----
const readButton = $<HTMLButtonElement>("read-aloud");
readButton.addEventListener("mousedown", (e) => e.preventDefault());
let systemSpeaking = false;
readButton.addEventListener("click", async () => {
  const speech = window.speechSynthesis;
  if (!speech) {
    // Linux's web engine has no voices of its own: the system's speech service reads instead.
    if (systemSpeaking) {
      invoke("stop_speaking").catch(() => {});
      return;
    }
    const { from, to, empty, $from } = view.state.selection;
    const text = empty ? $from.parent.textContent : view.state.doc.textBetween(from, to, "\n");
    if (!text.trim()) return;
    systemSpeaking = true;
    readButton.textContent = "■ Stop";
    try {
      await invoke("speak", { text, lang: textDirection(text) === "rtl" ? "ar" : "en" });
    } catch (e) {
      showDocState(String(e).replace(/^Error: /, ""));
    } finally {
      systemSpeaking = false;
      readButton.textContent = "▶ Read aloud";
    }
    return;
  }
  if (speech.speaking) {
    speech.cancel();
    readButton.textContent = "▶ Read aloud";
    return;
  }
  const { from, to, empty, $from } = view.state.selection;
  const text = empty ? $from.parent.textContent : view.state.doc.textBetween(from, to, "\n");
  if (!text.trim()) return;
  const arabic = textDirection(text) === "rtl";
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = arabic ? "ar" : englishVariant === "gb" ? "en-GB" : "en-US";
  const voice = speech.getVoices().find((v) => v.lang.toLowerCase().startsWith(arabic ? "ar" : "en"));
  if (voice) utterance.voice = voice;
  else if (arabic) showDocState("No Arabic voice is installed; the system's default voice is used");
  utterance.onend = utterance.onerror = () => (readButton.textContent = "▶ Read aloud");
  readButton.textContent = "■ Stop";
  speech.speak(utterance);
});

// ---- Insert and Paragraph menus ----
const run = (command: Command) => {
  command(view.state, view.dispatch);
  view.focus();
};
const insertButton = $("insert-button");
insertButton.addEventListener("mousedown", () => {
  // Table rows and columns appear in the menu only when the cursor is in a table.
  $("table-items").hidden = !isInTable(view.state);
});
menuButton(insertButton, $("insert-menu"), (item) => {
  const arabic = (textDirection(view.state.selection.$from.parent.textContent) ?? directionAt(view.state)) === "rtl";
  const actions: Record<string, () => void> = {
    image: pickAndInsertImage,
    table: () => run(insertTable(3, 3)),
    "page-break": () => run(insertPageBreak),
    date: () => (view.dispatch(view.state.tr.insertText(today("gregorian", arabic))), view.focus()),
    hijri: () => (view.dispatch(view.state.tr.insertText(today("hijri", arabic))), view.focus()),
    "row-before": () => run(addRowBefore),
    "row-after": () => run(addRowAfter),
    "col-before": () => run(addColumnBefore),
    "col-after": () => run(addColumnAfter),
    "delete-row": () => run(deleteRow),
    "delete-col": () => run(deleteColumn),
    "delete-table": () => run(deleteTable),
  };
  actions[item.dataset.insert!]?.();
});
menuButton($("paragraph-button"), $("paragraph-menu"), (item) => {
  if (item.dataset.align) run(setAlign(item.dataset.align));
  else if (item.dataset.spacing) run(setSpacing(item.dataset.spacing));
});

// ---- Deep check with Claude (opt-in) ----
// For the grammar the built-in checks can't judge (agreement, كان الجو جميل اليوم, الذي/التي...).
// The writer asks for it on the paragraph at the cursor or on a selection; Claude's suggestions
// appear as dotted underlines with a reason, and nothing changes until one is accepted.
interface Correction { original: string; replacement: string; explanation: string }
const claudeButton = $<HTMLButtonElement>("claude-button");

/** Where each correction's text is in the paragraph (in order, so repeated words line up). */
function locate(text: string, corrections: Correction[]): Issue[] {
  const issues: Issue[] = [];
  let from = 0;
  for (const c of corrections) {
    let at = text.indexOf(c.original, from);
    if (at < 0) at = text.indexOf(c.original);
    if (at < 0) continue;
    issues.push({ from: at, to: at + c.original.length, kind: "claude", message: c.explanation, replacements: [c.replacement] });
    from = at + c.original.length;
  }
  return issues;
}

async function runDeepCheck() {
  const { from, to, empty, $from } = view.state.selection;
  const blocks = empty ? blocksIn(view.state.doc, $from.before($from.depth), $from.after($from.depth)) : blocksIn(view.state.doc, from, to);
  const toCheck = blocks.filter((b) => b.text.trim());
  if (!toCheck.length) return;
  claudeButton.disabled = true;
  showDocState("Checking with Claude…");
  try {
    const results = await invoke<Correction[][]>("deep_check", { paragraphs: toCheck.map((b) => b.text), english: englishVariant });
    const found = toCheck.map((b, i) => ({ ...b, issues: locate(b.text, results[i] ?? []) }));
    view.dispatch(showClaudeSuggestions(view.state.tr, found));
    const n = found.reduce((sum, b) => sum + b.issues.length, 0);
    showDocState(n ? `Claude suggests ${n} ${n === 1 ? "change" : "changes"}: click the dotted words` : "Claude found nothing to change here");
  } catch (e) {
    claudeError(e);
  } finally {
    claudeButton.disabled = false;
  }
}

/** A failed Claude request: without a key, Settings opens to add one. */
function claudeError(e: unknown) {
  const message = String(e).replace(/^Error: /, "");
  if (message.includes("API key")) openSettings("Add a Claude API key to use the ✦ tools. It's only used when you ask for one.");
  showDocState(message);
}

// The paragraphs a tool works on: the selection, or the paragraph at the cursor.
function targetBlocks() {
  const { from, to, empty, $from } = view.state.selection;
  const blocks = empty ? blocksIn(view.state.doc, $from.before($from.depth), $from.after($from.depth)) : blocksIn(view.state.doc, from, to);
  return blocks.filter((b) => b.text.trim());
}

// ---- ✦ Rewrite and translate (Claude), shown in the preview before anything changes ----
let pendingTransform: { blocks: { pos: number; text: string }[]; results: string[]; doc: PMNode } | null = null;
const TRANSFORM_TITLES: Record<string, string> = {
  formal: "Rewrite: more formal · أكثر رسمية",
  friendly: "Rewrite: friendlier · أكثر ودًّا",
  shorter: "Rewrite: shorter · أقصر",
  clearer: "Rewrite: clearer · أوضح",
  translate: "Translation · ترجمة",
};

async function runTransform(action: string) {
  const blocks = targetBlocks();
  if (!blocks.length) return;
  claudeButton.disabled = true;
  showDocState(action === "translate" ? "Translating with Claude…" : "Rewriting with Claude…");
  try {
    const results = await invoke<string[]>("transform", { paragraphs: blocks.map((b) => b.text), action, english: englishVariant });
    showNote(TRANSFORM_TITLES[action]);
    pendingTransform = { blocks, results, doc: view.state.doc };
    const body = $("preview-body");
    body.replaceChildren(
      ...results.map((r) => {
        const p = document.createElement("p");
        p.dir = "auto";
        p.textContent = r;
        return p;
      }),
    );
    $("preview-note").textContent = "✦ Claude · bold and italic inside these paragraphs aren't kept";
    $<HTMLButtonElement>("preview-accept").hidden = false;
    showDocState();
  } catch (e) {
    claudeError(e);
  } finally {
    claudeButton.disabled = false;
  }
}

/** Puts the accepted rewrite or translation in place of the paragraphs, one undo step.
    False when the text changed meanwhile (a note says so). */
function acceptTransform(): boolean {
  const t = pendingTransform!;
  pendingTransform = null;
  if (!t.doc.eq(view.state.doc)) {
    showNote("The text changed meanwhile. Ask again.");
    return false;
  }
  let tr = view.state.tr;
  for (let i = t.blocks.length - 1; i >= 0; i--) {
    const { pos } = t.blocks[i];
    const node = tr.doc.nodeAt(pos)!;
    const content: PMNode[] = [];
    t.results[i].split("\n").forEach((line, j) => {
      if (j) content.push(schema.nodes.hard_break.create());
      if (line) content.push(schema.text(line));
    });
    tr = tr.replaceWith(pos + 1, pos + node.nodeSize - 1, content);
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

menuButton(claudeButton, $("claude-menu"), (item) => {
  const action = item.dataset.action!;
  if (action === "check") runDeepCheck();
  else if (action === "synonyms") showSynonyms(claudeButton);
  else runTransform(action);
});

// ---- Case (English): Sentence case, Title Case, lowercase, UPPERCASE ----
const SMALL_WORDS = new Set(["a", "an", "the", "and", "but", "or", "nor", "for", "so", "yet", "as", "at", "by", "in", "of", "off", "on", "per", "to", "up", "via", "from", "into", "with", "over"]);
function changeCase(text: string, kind: string): string {
  if (kind === "upper") return text.toUpperCase();
  if (kind === "lower") return text.toLowerCase();
  if (kind === "sentence") {
    const lower = text.toLowerCase();
    return lower.replace(/(^\s*|[.!?]\s+)([a-z])/g, (_m, before: string, letter: string) => before + letter.toUpperCase());
  }
  // Title Case: every word capitalised except short joining words, which are capitalised
  // only at the start and end.
  const words = [...text.matchAll(/[A-Za-z][A-Za-z'’]*/g)];
  let out = text;
  words.forEach((m, i) => {
    const w = m[0];
    const small = SMALL_WORDS.has(w.toLowerCase()) && i > 0 && i < words.length - 1;
    const replaced = small ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase();
    out = out.slice(0, m.index!) + replaced + out.slice(m.index! + w.length);
  });
  return out;
}

/** Applies a case change to the selection (or the word at the cursor), keeping bold and italic. */
function applyCase(kind: string) {
  let { from, to } = view.state.selection;
  if (from === to) {
    const word = wordRange();
    if (!word) return;
    ({ from, to } = word);
  }
  const tr = view.state.tr;
  // Paragraph by paragraph; each text piece keeps its own bold/italic. Lengths don't change, so
  // positions stay valid as pieces are replaced.
  view.state.doc.nodesBetween(from, to, (block, blockPos) => {
    if (!block.isTextblock) return true;
    const start = Math.max(from, blockPos + 1);
    const end = Math.min(to, blockPos + block.nodeSize - 1);
    const whole = view.state.doc.textBetween(start, end, undefined, "\ufffc");
    const changed = changeCase(whole, kind);
    if (changed.length !== whole.length) return false; // a letter whose case is longer (ß): leave it
    block.forEach((child, childOffset) => {
      const childStart = blockPos + 1 + childOffset;
      const a = Math.max(start, childStart);
      const b = Math.min(end, childStart + child.nodeSize);
      if (!child.isText || a >= b) return;
      const piece = changed.slice(a - start, b - start);
      if (piece !== child.text!.slice(a - childStart, b - childStart)) tr.replaceWith(a, b, schema.text(piece, child.marks));
    });
    return false;
  });
  if (tr.docChanged) view.dispatch(tr);
  view.focus();
}

/** The word at the cursor (letters, حركات and apostrophes), if there is one. */
function wordRange(): { from: number; to: number; word: string } | null {
  const { $head } = view.state.selection;
  if (!$head.parent.isTextblock) return null;
  const text = $head.parent.textBetween(0, $head.parent.content.size, undefined, "\ufffc");
  const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{M}'’]/u.test(c);
  let start = $head.parentOffset;
  let end = start;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return null;
  return { from: $head.start() + start, to: $head.start() + end, word: text.slice(start, end) };
}

menuButton($("case-button"), $("case-menu"), (item) => applyCase(item.dataset.case!));

// ---- Punctuate (English, offline): the auto-punctuation model, on demand ----
$("punctuate").addEventListener("mousedown", (e) => e.preventDefault());
$("punctuate").addEventListener("click", () => {
  const english = targetBlocks().filter((b) => isEnglish(b.text));
  if (!english.length) return showDocState("No English text here");
  for (const b of english) punctuationJobs.push({ pos: b.pos, text: b.text });
  runPunctuationJobs();
  view.focus();
});

// ---- ✦ Synonyms (Claude): words that fit this sentence ----
const synonymMenu = $("synonym-menu");
menuItems(synonymMenu, (item) => {
  const target = JSON.parse(item.dataset.target!) as { from: number; to: number; word: string };
  if (view.state.doc.textBetween(target.from, target.to) === target.word) {
    view.dispatch(view.state.tr.insertText(item.dataset.word!, target.from, target.to));
  }
  view.focus();
});
async function showSynonyms(button: HTMLElement) {
  const target = wordRange();
  if (!target) return showDocState("Put the cursor in a word first · ضع المؤشر داخل كلمة");
  const sentence = view.state.selection.$head.parent.textContent;
  const anchor = view.coordsAtPos(target.from);
  const end = view.coordsAtPos(target.to);
  const rect = new DOMRect(Math.min(anchor.left, end.left), anchor.top, Math.abs(end.left - anchor.left), anchor.bottom - anchor.top);
  synonymMenu.dir = textDirection(target.word) === "rtl" ? "rtl" : "ltr";
  const note = document.createElement("p");
  note.className = "menu-empty";
  note.textContent = "…";
  synonymMenu.replaceChildren(note);
  openMenu(synonymMenu, rect, button);
  try {
    const words = await invoke<string[]>("synonyms", { word: target.word, sentence });
    if (synonymMenu.hidden) return;
    if (!words.length) {
      note.textContent = synonymMenu.dir === "rtl" ? "لا مرادفات" : "No synonyms";
      return;
    }
    synonymMenu.replaceChildren(
      ...words.map((w) => {
        const b = document.createElement("button");
        b.className = "synonym";
        b.textContent = w;
        b.dataset.word = w;
        b.dataset.target = JSON.stringify(target);
        b.setAttribute("role", "menuitem");
        return b;
      }),
    );
    synonymMenu.querySelector<HTMLButtonElement>("button")?.focus();
  } catch (e) {
    closeMenu(synonymMenu);
    claudeError(e);
  }
}


// ---- Settings: the Claude API key ----
async function refreshMemoryStatus() {
  const n = Object.keys((await loadMemory()).corrections).length;
  $("memory-status").textContent = n
    ? `Qalam has learned ${n} ${n === 1 ? "correction" : "corrections"} from you.`
    : "No corrections learned yet. Fix a word's حركات and Qalam will remember it.";
  $<HTMLButtonElement>("memory-forget").disabled = !n;
}
$("memory-forget").addEventListener("click", async () => {
  memory = emptyMemory();
  await saveMemory();
  refreshMemoryStatus();
});

async function refreshKeyStatus(message?: string) {
  const has = await invoke<boolean>("has_api_key");
  $("key-status").textContent = message ?? (has ? "✓ A key is saved." : "No key saved yet.");
  $<HTMLButtonElement>("key-remove").disabled = !has;
}
const englishPicker = $<HTMLSelectElement>("english-variant");
englishPicker.value = englishVariant;
englishPicker.addEventListener("change", () => {
  englishVariant = englishPicker.value === "gb" ? "gb" : "us";
  try { localStorage.setItem("qalam.english", englishVariant); } catch {}
  // Check everything again with the other dictionary.
  if (spellcheckEnabled(view.state)) view.dispatch(setSpellcheck(view.state.tr, true));
});

function openSettings(message?: string) {
  $<HTMLInputElement>("api-key").value = "";
  refreshKeyStatus(message);
  refreshMemoryStatus();
  settings.showModal();
}
$("open-settings").addEventListener("click", () => openSettings());
$("settings-close").addEventListener("click", () => settings.close());
$("key-save").addEventListener("click", async () => {
  const input = $<HTMLInputElement>("api-key");
  try {
    await invoke("set_api_key", { key: input.value });
    input.value = "";
    refreshKeyStatus("✓ Saved.");
  } catch (e) {
    refreshKeyStatus(String(e));
  }
});
$("key-remove").addEventListener("click", async () => {
  await invoke("clear_api_key");
  refreshKeyStatus("Key removed.");
});
settings.addEventListener("close", () => view.focus());

// ---- Documents: new, open, save, and keeping unsaved work safe ----
// The document's file, if it has one. A document is unsaved when it differs from what was last
// saved or opened; restored work counts as unsaved until it's saved.
let docPath: string | null = null;
let docName: string | null = null; // file name, with extension
let docKind: FileKind = "qalam";
let savedDoc = view.state.doc;
let restoredUnsaved = false;
// An opened Word file with parts Qalam can't keep yet (tables, images): saving makes a copy.
let keepOriginal = false;
const isDirty = () => restoredUnsaved || !view.state.doc.eq(savedDoc);

interface OpenedDocument { path: string; name: string; kind: FileKind; contents: string }
interface SavePath { path: string; name: string; kind: FileKind }
interface Backup { qalam: number; doc: unknown; path: string | null; name: string | null; kind: FileKind }

const docStatus = $("doc-status");
let shownDirty: boolean | null = null;
/** The window title and the status bar: "• رسالة — Qalam", "Unsaved changes". */
function showDocState(note?: string) {
  const dirty = isDirty();
  docStatus.textContent = note ?? (dirty ? (docPath ? "Unsaved changes" : "Not saved yet") : docPath ? "Saved" : "");
  docStatus.classList.toggle("is-dirty", dirty && !note);
  if (dirty !== shownDirty || note) {
    shownDirty = dirty;
    try {
      getCurrentWindow().setTitle(`${dirty ? "• " : ""}${displayName(docName)} — Qalam`).catch(() => {});
    } catch {} // outside Tauri (tests in a browser) there's no window to name
  }
}

// Unsaved work is copied to the app's data folder a couple of seconds after each change, so a
// crash or a forced close never loses it; the next start restores it.
let backupTimer: number | undefined;
function documentChanged() {
  showDocState();
  clearTimeout(backupTimer);
  backupTimer = window.setTimeout(() => {
    if (isDirty()) {
      const backup: Backup = { qalam: 1, doc: view.state.doc.toJSON(), path: docPath, name: docName, kind: docKind };
      invoke("save_backup", { json: JSON.stringify(backup) }).catch(() => {});
    } else {
      invoke("clear_backup").catch(() => {});
    }
  }, 2000);
}

/** Shows a document in the editor (with a fresh undo history). */
function loadDocument(doc: PMNode, file: { path: string | null; name: string | null; kind: FileKind }, unsaved = false, lossy = false) {
  view.updateState(EditorState.create({ doc, plugins: view.state.plugins }));
  ({ path: docPath, name: docName, kind: docKind } = file);
  savedDoc = doc;
  restoredUnsaved = unsaved;
  keepOriginal = lossy;
  shownDirty = null; // a new name for the window title
  rememberRecent(docPath, docName);
  lastTypedDirection = null;
  punctuationJobs.length = 0;
  closeSpellCard();
  updateStatus();
  showDocState();
  view.focus();
}

async function parseDocument(opened: OpenedDocument): Promise<{ doc: PMNode; lossy: boolean }> {
  if (opened.kind === "docx") return fromDocx(schema, opened.contents);
  return { doc: opened.kind === "qalam" ? fromQalam(schema, opened.contents) : fromText(schema, opened.contents), lossy: false };
}

/** Opens a document in the editor, with a note when a Word file had parts Qalam can't show. */
async function showOpened(opened: OpenedDocument) {
  const { doc, lossy } = await parseDocument(opened);
  loadDocument(doc, opened, false, lossy);
  if (lossy) showDocState("Tables in this Word file aren't shown yet. Saving will make a copy, so the original stays as it was.");
}

// Word font names for the Arabic fonts Qalam bundles (Word falls back if one isn't installed).
const WORD_ARABIC_FONTS: Record<string, string> = { amiri: "Amiri", vazirmatn: "Vazirmatn", scheherazade: "Scheherazade New" };

// "Save your changes?": resolves to whether it's fine to go on (saved, or the writer chose not to).
const unsavedDialog = $<HTMLDialogElement>("unsaved");
function confirmDiscard(): Promise<boolean> {
  if (!isDirty()) return Promise.resolve(true);
  $("unsaved-title").textContent = docName ? `Save changes to “${displayName(docName)}”?` : "Save this document?";
  unsavedDialog.showModal();
  return new Promise((resolve) => {
    const done = (answer: "save" | "discard" | "cancel") => {
      unsavedDialog.close();
      unsavedDialog.removeEventListener("cancel", onCancel);
      for (const [id, handler] of handlers) $(id).removeEventListener("click", handler);
      if (answer === "save") saveDocument().then(resolve);
      else resolve(answer === "discard");
    };
    const onCancel = (e: Event) => (e.preventDefault(), done("cancel"));
    const handlers: [string, () => void][] = [
      ["unsaved-save", () => done("save")],
      ["unsaved-discard", () => done("discard")],
      ["unsaved-cancel", () => done("cancel")],
    ];
    for (const [id, handler] of handlers) $(id).addEventListener("click", handler);
    unsavedDialog.addEventListener("cancel", onCancel);
  });
}

async function newDocument() {
  if (!(await confirmDiscard())) return;
  loadDocument(schema.topNodeType.createAndFill()!, { path: null, name: null, kind: "qalam" });
  invoke("clear_backup").catch(() => {});
}

async function openDocument() {
  if (!(await confirmDiscard())) return;
  try {
    const opened = await invoke<OpenedDocument | null>("open_document", { current: docPath });
    if (!opened) return;
    await showOpened(opened);
    invoke("clear_backup").catch(() => {});
  } catch (e) {
    showDocState(String(e).replace(/^Error: /, ""));
  }
}

/** Saves to the document's file, or asks where (always, for "Save as"). True once saved. */
async function saveDocument(saveAs = false): Promise<boolean> {
  try {
    if (!docPath || saveAs || keepOriginal) {
      const suggested = keepOriginal ? `${displayName(docName)} (Qalam).docx` : `${displayName(docName)}.${docKind === "docx" ? "docx" : "qalam"}`;
      const choice = await invoke<SavePath | null>("choose_save_path", { suggestedName: suggested, current: docPath });
      if (!choice) return false;
      ({ path: docPath, name: docName, kind: docKind } = choice);
      keepOriginal = false;
    }
    const doc = view.state.doc;
    if (docKind === "docx") {
      const arabicFont = WORD_ARABIC_FONTS[document.documentElement.dataset.arabicFont ?? "amiri"] ?? "Amiri";
      await invoke("write_document_base64", { path: docPath, base64: await toDocx(doc, { arabicFont, latinFont: "Noto Serif", pageNumbers: pageNumberStyle(doc) }) });
    } else {
      await invoke("write_document", { path: docPath, contents: docKind === "qalam" ? toQalam(doc) : toText(doc) });
    }
    savedDoc = doc;
    restoredUnsaved = false;
    shownDirty = null;
    rememberRecent(docPath, docName);
    invoke("clear_backup").catch(() => {});
    showDocState(docKind === "text" ? "Saved as plain text (headings, lists and bold aren't kept in .txt)" : "Saved");
    return true;
  } catch (e) {
    showDocState(String(e).replace(/^Error: /, ""));
    return false;
  }
}

// ---- Popup menus (File, ✦ Claude, case, synonyms) ----
// Opens under an anchor (a button or a word), lined up with its end edge when it's on the right
// half of the window; arrow keys move, Escape closes, a click outside closes.
const openMenus = new Set<HTMLElement>();
function openMenu(menu: HTMLElement, anchor: DOMRect, opener?: HTMLElement) {
  for (const m of openMenus) if (m !== menu) closeMenu(m);
  menu.hidden = false;
  openMenus.add(menu);
  opener?.setAttribute("aria-expanded", "true");
  menu.dataset.opener = opener?.id ?? "";
  const width = menu.offsetWidth;
  const left = anchor.left + anchor.width / 2 > window.innerWidth / 2 ? anchor.right - width : anchor.left;
  menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  menu.style.right = "auto";
  menu.style.top = `${anchor.bottom + 6}px`;
  menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}
function closeMenu(menu: HTMLElement) {
  menu.hidden = true;
  openMenus.delete(menu);
  if (menu.dataset.opener) document.getElementById(menu.dataset.opener)?.setAttribute("aria-expanded", "false");
}
function menuButton(button: HTMLElement, menu: HTMLElement, onPick: (item: HTMLButtonElement) => void) {
  button.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor's selection
  button.addEventListener("click", () => (menu.hidden ? openMenu(menu, button.getBoundingClientRect(), button) : closeMenu(menu)));
  menuItems(menu, onPick);
}
function menuItems(menu: HTMLElement, onPick: (item: HTMLButtonElement) => void) {
  menu.addEventListener("mousedown", (e) => e.preventDefault());
  menu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!item || item.disabled) return;
    closeMenu(menu);
    onPick(item);
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      e.preventDefault();
    } else if (e.key === "Escape") {
      closeMenu(menu);
      view.focus();
    }
  });
}
document.addEventListener("mousedown", (e) => {
  for (const menu of openMenus) {
    const opener = menu.dataset.opener ? document.getElementById(menu.dataset.opener) : null;
    if (!menu.contains(e.target as Node) && !opener?.contains(e.target as Node)) closeMenu(menu);
  }
});

// ---- Recent files (the last 8 opened or saved), at the bottom of the File menu ----
interface RecentFile { path: string; name: string }
function recentFiles(): RecentFile[] {
  try {
    return JSON.parse(localStorage.getItem("qalam.recent") ?? "[]");
  } catch {
    return [];
  }
}
function rememberRecent(path: string | null, name: string | null) {
  if (!path || !name) return;
  const list = [{ path, name }, ...recentFiles().filter((r) => r.path !== path)].slice(0, 8);
  try { localStorage.setItem("qalam.recent", JSON.stringify(list)); } catch {}
}
function forgetRecent(path: string) {
  try { localStorage.setItem("qalam.recent", JSON.stringify(recentFiles().filter((r) => r.path !== path))); } catch {}
}
function showRecentFiles() {
  const box = $("recent-files");
  const list = recentFiles().filter((r) => r.path !== docPath);
  box.replaceChildren();
  if (!list.length) return;
  box.appendChild(document.createElement("hr"));
  for (const r of list) {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.dataset.recent = r.path;
    b.title = r.path;
    const label = b.appendChild(document.createElement("span"));
    label.textContent = displayName(r.name);
    label.dir = "auto";
    box.appendChild(b);
  }
}
async function openRecent(path: string) {
  if (!(await confirmDiscard())) return;
  try {
    await showOpened(await invoke<OpenedDocument>("read_document", { path }));
    invoke("clear_backup").catch(() => {});
  } catch (e) {
    forgetRecent(path);
    showDocState(String(e).replace(/^Error: /, ""));
  }
}

function printDocument() {
  invoke("print_document").catch((e) => showDocState(String(e)));
}

// The File menu (the toolbar's document button).
$("file-button").addEventListener("mousedown", showRecentFiles);
menuButton($("file-button"), $("file-menu"), (item) => {
  const action = item.dataset.file;
  if (item.dataset.recent) openRecent(item.dataset.recent);
  else if (action === "new") newDocument();
  else if (action === "open") openDocument();
  else if (action === "print") printDocument();
  else if (action) saveDocument(action === "save-as");
});

// Closing the window: Qalam asks first if there are unsaved changes.
listen("close-requested", async () => {
  if (!(await confirmDiscard())) return;
  await invoke("clear_backup").catch(() => {});
  invoke("close_window");
});

// On start: a file Qalam was opened with (double-clicking a .qalam file), or else the unsaved
// work from last time.
(async () => {
  try {
    const path = await invoke<string | null>("startup_document");
    if (path) {
      await showOpened(await invoke<OpenedDocument>("read_document", { path }));
      return;
    }
    const json = await invoke<string | null>("load_backup");
    if (!json) return showDocState();
    const backup = JSON.parse(json) as Backup;
    loadDocument(schema.nodeFromJSON(backup.doc), backup, true);
    showDocState("Restored the work you hadn't saved");
  } catch (e) {
    console.warn("documents:", e);
    showDocState();
  }
})();

// The toolbar floats over the page and can wrap onto a second row in a narrow window; the page
// starts below it, whatever its height.
const toolbarEl = document.querySelector<HTMLElement>(".toolbar")!;
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--toolbar-h", `${toolbarEl.offsetHeight}px`);
}).observe(toolbarEl);

// ---- Light / dark ----
// Follows the system until the writer picks one with the ☾ / ☀ button; the choice is remembered.
const themeButton = $<HTMLButtonElement>("theme-toggle");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
function isDark() {
  const chosen = document.documentElement.dataset.theme;
  return chosen ? chosen === "dark" : systemDark.matches;
}
function showThemeButton() {
  themeButton.textContent = isDark() ? "☀" : "☾";
  themeButton.title = isDark() ? "Light mode" : "Dark mode";
  // The window's own title bar follows too (otherwise it stays light above a dark page).
  const chosen = document.documentElement.dataset.theme;
  try {
    getCurrentWindow().setTheme(chosen === "dark" || chosen === "light" ? chosen : null).catch(() => {});
  } catch {} // outside Tauri (tests in a browser)
}
try {
  const saved = localStorage.getItem("qalam.theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {}
showThemeButton();
systemDark.addEventListener("change", showThemeButton);
themeButton.addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("qalam.theme", next); } catch {}
  showThemeButton();
  view.focus();
});

updateStatus();
view.focus();
