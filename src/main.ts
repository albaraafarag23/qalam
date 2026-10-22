import "@fontsource/noto-serif/400.css";
import "@fontsource/noto-serif/700.css";
import "@fontsource/noto-serif/400-italic.css";
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "./fonts.css";
import "prosemirror-view/style/prosemirror.css";
import "./styles.css";

import { EditorState, Selection, type Command } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { EditorView } from "prosemirror-view";
import { baseKeymap, setBlockType, toggleMark } from "prosemirror-commands";
import { history, undo, redo, closeHistory } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { inputRules, wrappingInputRule, textblockTypeInputRule } from "prosemirror-inputrules";
import { splitListItem, liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list";
import { schema } from "./editor/schema";
import { blockDirection, directionAt, textDirection } from "./editor/direction";
import { softCaret } from "./editor/caret";
import { HARAKAT, activeHarakat, clearHarakat, setHaraka } from "./editor/harakat";
import { applyResults, previewHtml, targets, type Target } from "./editor/tashkeel";
import { applyMemory, emptyMemory, learn, recordApplied, type TashkeelMemory } from "./editor/memory";
import { edits as punctuationEdits, isEnglish, modelInput, words as splitWords } from "./editor/punctuation";
import { blocksIn, ignoreUnderline, setSpellcheck, showClaudeSuggestions, spellcheck, spellcheckEnabled, underlineAt, type Issue, type Underline } from "./editor/spellcheck";
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
    keymap({ Enter: notePunctuationJob }), // first, so it sees every Enter exactly once
    rules,
    blockDirection,
    softCaret,
    spellcheck({ check: (paragraphs) => invoke<Issue[][]>("spell_check", { paragraphs, english: englishVariant }) }),
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
      // Alt+1…8 put a حركة on the letter before the cursor, Alt+0 clears them.
      ...Object.fromEntries(HARAKAT.map((h) => [`Alt-${h.key}`, setHaraka(h.mark)])),
      "Alt-0": clearHarakat,
      // Files, as in every editor.
      "Mod-n": () => (newDocument(), true),
      "Mod-o": () => (openDocument(), true),
      "Mod-s": () => (saveDocument(), true),
      "Mod-Shift-s": () => (saveDocument(true), true),
      // Opens the spelling/grammar card for the underline at the cursor, from the keyboard.
      "Mod-.": () => openSpellCardAtCursor(),
      "Mod-Shift-g": () => (runDeepCheck(), true),
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
  // Typing an Arabic letter (e.g. right after switching keyboards) shows the Arabic tools.
  handleTextInput(_view, _from, _to, text) {
    lastTypedDirection = textDirection(text) ?? lastTypedDirection;
    return false;
  },
  dispatchTransaction(tr) {
    if (tr.selectionSet && !tr.docChanged) lastTypedDirection = null; // moved: go by the paragraph again
    for (const job of punctuationJobs) job.pos = tr.mapping.map(job.pos);
    view.updateState(view.state.apply(tr));
    if (tr.docChanged) {
      closeSpellCard();
      documentChanged();
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
  showArabicTools(arabic);
}

// The Arabic tools ease in, button by button, and ease out instead of vanishing. Hiding
// waits a moment so moving the cursor across a mixed document doesn't make them flicker.
const arabicTools = document.getElementById("arabic-tools")!;
let hideTimer: number | undefined;
function showArabicTools(show: boolean) {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (show) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
    if (arabicTools.hidden || arabicTools.classList.contains("leaving")) {
      arabicTools.classList.remove("leaving");
      arabicTools.hidden = false;
    }
    return;
  }
  if (arabicTools.hidden || hideTimer !== undefined) return;
  if (reduceMotion) {
    arabicTools.hidden = true;
    return;
  }
  hideTimer = window.setTimeout(() => {
    arabicTools.classList.add("leaving");
    hideTimer = window.setTimeout(() => {
      arabicTools.hidden = true;
      arabicTools.classList.remove("leaving");
      hideTimer = undefined;
    }, 260);
  }, 350);
}

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
async function runTashkeel() {
  if (tashkeelBtn.disabled) return;
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
  view.focus();
}

$("preview-accept").addEventListener("click", () => {
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

// ---- Deep check with Claude (opt-in) ----
// For the grammar the built-in checks can't judge (agreement, كان الجو جميل اليوم, الذي/التي...).
// The writer asks for it on the paragraph at the cursor or on a selection; Claude's suggestions
// appear as dotted underlines with a reason, and nothing changes until one is accepted.
interface Correction { original: string; replacement: string; explanation: string }
const deepCheckButton = $<HTMLButtonElement>("deep-check");

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
  deepCheckButton.disabled = true;
  showDocState("Checking with Claude…");
  try {
    const results = await invoke<Correction[][]>("deep_check", { paragraphs: toCheck.map((b) => b.text), english: englishVariant });
    const found = toCheck.map((b, i) => ({ ...b, issues: locate(b.text, results[i] ?? []) }));
    view.dispatch(showClaudeSuggestions(view.state.tr, found));
    const n = found.reduce((sum, b) => sum + b.issues.length, 0);
    showDocState(n ? `Claude suggests ${n} ${n === 1 ? "change" : "changes"}: click the dotted words` : "Claude found nothing to change here");
  } catch (e) {
    const message = String(e).replace(/^Error: /, "");
    if (message.includes("API key")) openSettings("Add a Claude API key to use the deep check. It's only used when you ask for a check.");
    showDocState(message);
  } finally {
    deepCheckButton.disabled = false;
  }
}
deepCheckButton.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
deepCheckButton.addEventListener("click", () => runDeepCheck());

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
  if (lossy) showDocState("Tables and images in this Word file aren't shown yet. Saving will make a copy, so the original stays as it was.");
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
      await invoke("write_document_base64", { path: docPath, base64: await toDocx(doc, { arabicFont, latinFont: "Noto Serif" }) });
    } else {
      await invoke("write_document", { path: docPath, contents: docKind === "qalam" ? toQalam(doc) : toText(doc) });
    }
    savedDoc = doc;
    restoredUnsaved = false;
    shownDirty = null;
    invoke("clear_backup").catch(() => {});
    showDocState(docKind === "text" ? "Saved as plain text (headings, lists and bold aren't kept in .txt)" : "Saved");
    return true;
  } catch (e) {
    showDocState(String(e).replace(/^Error: /, ""));
    return false;
  }
}

// The File menu (the toolbar's document button).
const fileButton = $<HTMLButtonElement>("file-button");
const fileMenu = $("file-menu");
function setFileMenu(open: boolean) {
  fileMenu.hidden = !open;
  fileButton.setAttribute("aria-expanded", String(open));
  if (open) {
    const r = fileButton.getBoundingClientRect();
    fileMenu.style.top = `${r.bottom + 6}px`;
    fileMenu.style.right = `${window.innerWidth - r.right}px`;
    fileMenu.querySelector<HTMLButtonElement>("button")?.focus();
  }
}
fileButton.addEventListener("click", () => setFileMenu(fileMenu.hidden));
fileMenu.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-file]")?.dataset.file;
  if (!action) return;
  setFileMenu(false);
  if (action === "new") newDocument();
  else if (action === "open") openDocument();
  else saveDocument(action === "save-as");
});
document.addEventListener("mousedown", (e) => {
  if (!fileMenu.hidden && !fileMenu.contains(e.target as Node) && !fileButton.contains(e.target as Node)) setFileMenu(false);
});
fileMenu.addEventListener("keydown", (e) => {
  const items = [...fileMenu.querySelectorAll<HTMLButtonElement>("button")];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    e.preventDefault();
  } else if (e.key === "Escape") {
    setFileMenu(false);
    view.focus();
  }
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
