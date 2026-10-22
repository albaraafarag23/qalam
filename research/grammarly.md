# Grammarly browser extension 14.1339.0: how it draws live underlines

**Studied:** 2026-10-22, from the Chrome Web Store package (extension id `kbfnbcaeplbcioakkpcpgfkobkghlhen`).
The code was read statically and never run, and no Grammarly servers were contacted.
**Note:** Grammarly's terms of service forbid reverse engineering. The owner of this repo chose to study it
anyway, to learn techniques only. Nothing here is Grammarly code, and none of it may be copied into Qalam.
Everything below is a description of an approach, written in our own words.

## Method

- REA 6.7.0 `analyze-javascript-application` on the whole extension (676 files, 51 MB) ran out of its
  result-memory budget at file 601. Run again on the five files that handle highlighting, it parsed
  4 of them (1 skipped) and recovered **401 webpack modules** with their import graph.
- The modules found that way were then read directly. Webpack module ids, for reference:
  highlight collection `34141` (imports 15 modules), Range geometry provider `94318`,
  Quill Delta (`transformPosition`) `25358` (used by 6 modules), caret-from-point `55996`,
  textarea mirror `87366`, underline element `67836`.

## How it works

Grammarly doesn't own the text fields it checks: Gmail, Google Docs, plain `<textarea>`s. So it never
touches their DOM and draws everything in **its own overlay layer** (a shadow-DOM host appended to the
page) on top of the field.

1. **Offsets → boxes.** A mistake is a pair of plain-text offsets. A "text map" turns those into DOM positions,
   a `Range` is built on them, and `range.getClientRects()` gives one box per line fragment. So an underline
   that wraps onto two lines is two boxes. Boxes with zero width or height are dropped
   (the code logs them as "degenerate geometry"). A collapsed range next to a `<br>` falls back to the
   `<br>`'s bounding box.
2. **Client → overlay coordinates.** The boxes are converted to the overlay's own coordinate space
   (`clientToRelative`), so scrolling the page doesn't need a recalculation, only scrolling the field does.
3. **Only visible highlights get geometry.** It keeps every alert (`_allHighlightsData`) but builds Ranges
   only for those passing a visibility filter (`_visibleHighlights`). Ranges are released when an alert
   leaves the view.
4. **Throttled, batched updates.** Recalculations are queued by id, de-duplicated in a `Set`, and run on
   fixed clocks: layout at 10 Hz, geometry at 30 Hz, hover/active state at 30 Hz. They're triggered by the
   field's scroll stream and its size stream (`ResizeObserver`), not by every keystroke. A performance
   logger times each geometry pass.
5. **Underline element.** It's a plain absolutely-positioned `<div data-grammarly-part="underline">`
   with top, left, width and height from the box, plus a CSS animation when it appears. No canvas,
   no CSS Custom Highlight API.
6. **Following edits.** Edits are represented as **Quill Delta** operations (`retain`/`insert`/`delete`),
   and alert offsets are moved with `delta.transformPosition(offset)`. That keeps underlines on the right
   word while the server is still re-checking.
7. **IME / composition.** Between `compositionstart` and `compositionend`, it holds back attribute changes
   to the field and ignores the field's value. Touching the DOM mid-composition breaks input methods.
8. **`<textarea>`s.** Text inside a textarea has no DOM nodes to put a Range on, so it builds a hidden,
   transparent **mirror `<div>`** with the same font, padding and size, copies the text into it and
   measures that instead.
9. **Clicking a word.** It finds the text under the mouse with `caretPositionFromPoint` (Firefox), falling back
   to `caretRangeFromPoint` (WebKit/Chromium).

## What this means for Qalam

The key difference: **Qalam owns its editor.** Most of Grammarly's machinery exists to work around
not owning the text, and ProseMirror gives us each piece directly:

| Grammarly needs | Qalam already has |
| --- | --- |
| Overlay layer + Range→rect math (1, 2, 5) | `Decoration.inline(from, to, {class: "misspelt"})`: the browser draws the underline inside the text, wrapping included |
| Quill Delta to move alerts through edits (6) | `DecorationSet.map(tr.mapping, tr.doc)`: the same operation, built in |
| Text map from offsets to DOM (1) | ProseMirror positions are already document offsets |
| Mirror div for textareas (8) | n/a, there are no textareas |
| `caretPositionFromPoint` (9) | `view.posAtCoords()` |

Ideas worth taking:

- **Check only what's visible or changed.** Re-check only the paragraphs a transaction touched, plus visible
  ones on load. Never re-check the whole document per keystroke.
- **Throttle and batch.** Collect changed paragraphs and run the checker on a short timer (~300 ms after typing pauses),
  in Rust, off the UI thread, merging ids in a `Set`.
- **Respect composition.** Don't replace decorations while `view.composing` is true. Arabic and other IME
  input must never be interrupted.
- **Suggestions on demand.** Compute suggestions only when a word is clicked: spellbook takes 1–360 ms
  per Arabic word (see `spellcheck.md`). Underline cheaply, suggest lazily.
- **A gentle appearance animation** on new underlines, as Grammarly does, fits Qalam's motion style
  (respecting `prefers-reduced-motion`).
- **Arabic caveat Grammarly doesn't face:** decorations must wrap **whole words**. A `<span>` boundary in the
  middle of an Arabic word can break letter joining in some engines.
