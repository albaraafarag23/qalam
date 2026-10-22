# Obsidian 1.14.4: how its spellcheck works

**Studied:** 2026-10-22, from the official Linux release (`obsidian-1.14.4.asar` from
github.com/obsidianmd/obsidian-releases). The code was read statically and never run. REA 6.7.0
`analyze-javascript-application` inventoried the bundle but parsed none of its 38 files: it rejected
their bytes as invalid UTF-8 and flagged 368 integrity mismatches. The bundle is ordinary minified
JavaScript (not encrypted), so the findings below come from reading `main.js` (the Electron main
process) and `app.js` (the editor) directly.
Only techniques are recorded here. No Obsidian code is copied into Qalam.

## What it does

Obsidian has **no spellchecker of its own**. It switches on the one built into Chromium and decorates the menu.

1. **Turn it on per window.** Every `BrowserWindow` is created with `webPreferences.spellcheck: true`.
   The editor (CodeMirror 6) gets `spellcheck="true|false"`, `autocorrect="on"` and
   `autocapitalize="on"` from the user's setting. CodeMirror's own default is `spellcheck="false"`.
2. **Languages.** `session.setSpellCheckerLanguages(langs)`. The list is filtered against
   `session.availableSpellCheckerLanguages`, and if it's empty, it falls back to `[app.getLocale()]`.
   On macOS it uses the system checker, which detects the language automatically, so the setting is hidden there.
   On Windows and Linux, Chromium downloads Hunspell `.bdic` dictionaries from Google's servers on first use.
3. **Suggestions.** The main process listens to `webContents.on("context-menu")`, which delivers
   `misspelledWord` and `dictionarySuggestions`, and forwards them over IPC to the editor. The editor
   builds its own menu:
   - at most **6** suggestions, each one calling `webContents.replaceMisspelling(word)`
   - "No suggestions…" (disabled) when the list is empty
   - "Add to dictionary": `session.addWordToSpellCheckerDictionary(word)`, then `replaceMisspelling(word)`
     to clear the underline at once
4. **Not checking code.** The syntax highlighter adds the attribute `spellcheck="false"` to the spans of
   code-like tokens. Chromium skips them, so code, URLs and the like are never underlined.
5. **Direction.** RTL is **one global setting** (`rightToLeft`): the whole editor gets `dir="rtl"`.
   There's no per-paragraph direction.

## What this means for Qalam

- **We can't do the same thing.** Tauri isn't Chromium. WebKitGTK on Linux uses Enchant and WebView2
  on Windows uses the Windows checker, and neither gives us `misspelledWord` / `dictionarySuggestions`
  or lets us control the dictionaries. Arabic support in both is unreliable. We already set
  `spellcheck="false"` because we draw our own underlines, and that remains the right choice.
- **Worth adopting:**
  - **Excluded ranges.** The checker skips text the writer didn't mean as words: URLs, e-mail
    addresses, numbers, and later code marks. For us this is a filter in the checker, not an HTML attribute.
  - **Menu shape.** ≤ 6 suggestions, a disabled "no suggestions" row, and "Add to dictionary" clearing
    the underline immediately. This is a familiar, proven layout.
  - **Language fallback.** If nothing is chosen, use the system locale. Qalam's version: detect each
    word's script (Arabic vs Latin) and check it against the matching dictionary. This needs no setting at all.
- **Where Qalam is already ahead:** Obsidian's RTL is all or nothing. Qalam's per-paragraph direction
  (`src/editor/direction.ts`) handles mixed Arabic and English documents, which Obsidian can't.
