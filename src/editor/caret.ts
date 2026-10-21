import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/**
 * Where to draw the cursor, measured from the letter just before it (its trailing edge:
 * right in English, left in Arabic). ProseMirror's coordsAtPos reports the end of a line
 * past the trailing gap, and in WebKitGTK returns all zeros at the end of Arabic text.
 */
function caretSpot(view: EditorView, pos: number) {
  const { node, offset } = view.domAtPos(pos);
  let text: Text | null = null;
  let index = 0;
  if (node.nodeType === Node.TEXT_NODE) {
    text = node as Text;
    index = offset;
  } else {
    const before = node.childNodes[offset - 1];
    if (before?.nodeType === Node.TEXT_NODE) {
      text = before as Text;
      index = text.length;
    } else if (node.childNodes[offset]?.nodeType === Node.TEXT_NODE) {
      text = node.childNodes[offset] as Text;
      index = 0;
    }
  }
  const el = text ? text.parentElement! : (node as HTMLElement);
  const style = getComputedStyle(el);
  const rtl = style.direction === "rtl";
  const fontSize = parseFloat(style.fontSize) || 17;

  if (text && text.length) {
    const range = document.createRange();
    const after = index === 0; // at the start: measure the next letter, use its leading edge
    if (after) range.setStart(text, 0), range.setEnd(text, 1);
    else range.setStart(text, index - 1), range.setEnd(text, index);
    const rects = range.getClientRects();
    const r = rects[rects.length - 1] ?? range.getBoundingClientRect();
    if (r.height) {
      const trailingEdge = rtl ? r.left : r.right;
      const leadingEdge = rtl ? r.right : r.left;
      return { x: after ? leadingEdge : trailingEdge, top: r.top, bottom: r.bottom, fontSize };
    }
  }
  // Empty line: the start edge of the block, at the height of one line.
  const block = el.closest("p, h1, h2, li") ?? el;
  const r = block.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(block).lineHeight) || fontSize * 1.75;
  return { x: rtl ? r.right : r.left, top: r.top, bottom: r.top + lineHeight, fontSize };
}

// Qalam draws its own cursor. The native one is as tall as the whole line box, and the
// Arabic fonts have very tall line metrics (room for حركات), so it came out oversized.
// This one is sized to the text (about the height of the letters, bigger in headings),
// blinks softly, and glides to its new position instead of jumping.
export const softCaret = new Plugin({
  view(view) {
    const host = view.dom.parentElement!; // the page, which is position: relative
    const caret = document.createElement("div");
    caret.className = "soft-caret";
    caret.hidden = true;
    host.appendChild(caret);

    // Like the native cursor, hide while another window has focus.
    let windowFocused = true;
    const onWindowBlur = () => { windowFocused = false; update(); };
    const onWindowFocus = () => { windowFocused = true; update(); };

    const place = () => {
      const { selection } = view.state;
      if (!selection.empty || document.activeElement !== view.dom || !windowFocused) {
        caret.hidden = true;
        return;
      }
      const spot = caretSpot(view, selection.head);
      if (!spot) {
        caret.hidden = true;
        return;
      }
      const box = host.getBoundingClientRect();
      const height = Math.min(spot.bottom - spot.top, spot.fontSize * 1.3);
      const top = spot.top - box.top + (spot.bottom - spot.top - height) / 2;
      caret.hidden = false;
      caret.style.height = `${height}px`;
      caret.style.transform = `translate(${spot.x - box.left - 1}px, ${top}px)`;
    };

    // On each change: place the cursor, keep it solid while typing, then blink again. Measure
    // once more shortly after, because text can still shift as a font finishes loading
    // (WebKitGTK doesn't reliably report when that happens).
    let settle: number | undefined;
    const update = () => {
      place();
      caret.classList.remove("blink");
      void caret.offsetWidth;
      caret.classList.add("blink");
      clearTimeout(settle);
      settle = window.setTimeout(place, 150);
    };

    view.dom.addEventListener("focus", update);
    view.dom.addEventListener("blur", update);
    window.addEventListener("resize", update);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
    // Text changes width when a font finishes loading (first use, or switching the Arabic font).
    document.fonts.addEventListener("loadingdone", update);
    update();
    return {
      update,
      destroy() {
        view.dom.removeEventListener("focus", update);
        view.dom.removeEventListener("blur", update);
        window.removeEventListener("resize", update);
        window.removeEventListener("blur", onWindowBlur);
        window.removeEventListener("focus", onWindowFocus);
        document.fonts.removeEventListener("loadingdone", update);
        clearTimeout(settle);
        caret.remove();
      },
    };
  },
});
