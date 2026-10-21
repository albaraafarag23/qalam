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
import { HARAKAT, activeHarakat, clearHarakat, setHaraka } from "./editor/harakat";
import { applyResults, previewHtml, targets, type Target } from "./editor/tashkeel";
import { invoke } from "@tauri-apps/api/core";
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
      // Alt+1…8 put a حركة on the letter before the cursor, Alt+0 clears them.
      ...Object.fromEntries(HARAKAT.map((h) => [`Alt-${h.key}`, setHaraka(h.mark)])),
      "Alt-0": clearHarakat,
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

const view = new EditorView(document.getElementById("page")!, {
  state,
  attributes: { spellcheck: "false" }, // our own checker will draw the underlines
  dispatchTransaction(tr) {
    view.updateState(view.state.apply(tr));
    updateStatus();
  },
});

const harakatBar = document.getElementById("harakat")!;
for (const h of HARAKAT) {
  const btn = document.createElement("button");
  btn.className = "haraka";
  btn.dataset.mark = h.mark;
  btn.textContent = "\u0628" + h.mark; // shown on ب, as in Arabic teaching books: بَ
  btn.title = `${h.name} (Alt+${h.key})`;
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    setHaraka(h.mark)(view.state, view.dispatch, view);
    view.focus();
  });
  harakatBar.appendChild(btn);
}

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

let pending: { ts: Target[]; results: string[]; keepExisting: boolean; doc: typeof view.state.doc } | null = null;

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

function showPreview(ts: Target[], results: string[], keepExisting: boolean, engine: string) {
  const { changed, skipped } = applyResults(view.state, ts, results, keepExisting);
  pending = { ts, results, keepExisting, doc: view.state.doc };
  $("preview-body").innerHTML = ts.map((t, i) => `<p>${previewHtml(t, results[i], keepExisting)}</p>`).join("");
  $("preview-title").textContent = changed ? "التشكيل المقترح" : "لا تغييرات مقترحة · Nothing to change";
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
    view.dispatch(applyResults(view.state, pending.ts, pending.results, pending.keepExisting).tr.scrollIntoView());
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

// ---- Settings: the Claude API key ----
async function refreshKeyStatus(message?: string) {
  const has = await invoke<boolean>("has_api_key");
  $("key-status").textContent = message ?? (has ? "✓ A key is saved." : "No key saved yet.");
  $<HTMLButtonElement>("key-remove").disabled = !has;
}
function openSettings(message?: string) {
  $<HTMLInputElement>("api-key").value = "";
  refreshKeyStatus(message);
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

updateStatus();
view.focus();
