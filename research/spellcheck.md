# Spellcheck for Qalam: open-source options, measured

**Studied:** 2026-10-22. Companion notes: [obsidian.md](obsidian.md) (Chromium's built-in checker) and
[grammarly.md](grammarly.md) (how live underlines are drawn).

## Recommendation

**Check in Rust with [`spellbook`](https://github.com/helix-editor/spellbook)** (pure-Rust Hunspell, from the Helix
editor, MPL-2.0), using **Ayaspell** for Arabic and **SCOWL en_US** for English. Pick the dictionary per word by its
script. Draw underlines as ProseMirror inline decorations. Add a small **rule list** for common Arabic mistakes
that Hunspell accepts.

Why not the alternatives:
- **The webview's own checker:** WebKitGTK (Enchant) and WebView2 (Windows) each behave differently, give
  JavaScript no word or suggestion data, and handle Arabic badly. Obsidian relies on Chromium's checker, which we don't have.
- **nspell (JavaScript):** it would run on the UI thread, and Ayaspell's large affix tables are slow and heavy in nspell.
- **libhunspell through a C binding:** works, but adds a C dependency to Windows builds, and spellbook already
  handles everything we tested.

## Measurements (spellbook 0.3.5, release build, this laptop)

| | Arabic (Ayaspell 3.5) | English (SCOWL en_US) |
| --- | --- | --- |
| Dictionary load | 104 ms | 21 ms |
| Check speed | **1.7 µs/word** (45,360 words in 77 ms) | 0.2 µs/word |
| Memory (whole process) | 49 MB | 7 MB |
| One suggestion list | 1 ms typical, **up to 360 ms** for long words | 10–40 ms |
| Words flagged in real prose | 2.8% (see below) | n/a |

Checking is effectively free, so a whole paragraph can be re-checked on each pause in typing. **Suggestions are not
free**, so compute them only when the writer opens a misspelt word, never ahead of time.

### Arabic quality (tested on our own sentences plus 5,656 words of Arabic prose)

- **حركات are ignored**, as they should be: `اسْمِي`, `الْبَرَاءِ`, `وَحِيدٌ` all pass (the dictionary's `IGNORE`
  line lists the marks). So typed or automatic تشكيل never produces false underlines.
- Prefixes and clitics work: `والمدرسة`, `بالمدرسة`, `المكتبات`.
- **Hamza errors are caught**, with good suggestions: `انا → أنا`, `انشاء → إنشاء`, `إستخدام → استخدام`.
  Same for `الذى → الذي`, `اللغه → اللغة`, `هاذا → هذا`, `الكتااب → الكتاب`, `سيارت → سيارة`.
- **What Hunspell lets through** (it reads them as a valid word plus a suffix): `ذالك`, `شيئ`, `مدرسه`.
  These need the rule layer below.
- **What it wrongly flags:** some valid words are missing from the dictionary, e.g. `فسيكتبونها`, `اللؤلؤة`, `اليانسون`, `داخ`.
  So "Add to dictionary" matters, and the correction memory we already have for تشكيل could also learn these.
- Colloquial words like `عايش` pass, which is right for a writer's tool. Flagging dialect should be optional.
- In mixed text, Latin-script words must go to the English dictionary. Most of the "flagged" words in the
  prose test were English or French words.

### English
Standard results: `recieve → receive`, `definately → definitely`, `teh → the`. SCOWL en_US flags British spellings
(`colour`), so offer en_GB as a choice later.

## Rule layer for Arabic: LanguageTool's lists

LanguageTool (LGPL-2.1) keeps Arabic lists of mistakes that a spellchecker can't catch, in
`languagetool-language-modules/ar/.../rules/ar/`:

| File | Entries | What it holds |
| --- | --- | --- |
| `replaces.txt` | 671 | common mistakes → correct forms, **each with an Arabic explanation** (`هاذا=هذا\|هذه	تحذف ألف "هاذا وهاذه" لكثرة الاستعمال`) |
| `darja.txt` | 241 | colloquial / loanword → standard Arabic (`أتوبيس=حافلة`) |
| `homophones.txt` | 173 | words that sound alike |
| `diacritics.txt` | 493 | words whose تشكيل is commonly wrong |

The explanations are the valuable part: Qalam can show **why** something is wrong, in Arabic. Grammarly doesn't
do that for Arabic at all.

**Licence caution:** most of `replaces.txt` comes from `linuxscout/aghlat`, which is **AGPL-3.0**. Inside LanguageTool the
lists are distributed under LGPL-2.1. Before bundling any of them, decide Qalam's own licence (the repo has none yet).
The safest options are to ship the list as a separate LGPL data file with attribution, or to write our own list
using these only as a reference.

## Licences of what we'd bundle

| Component | Licence | Fine for Qalam? |
| --- | --- | --- |
| spellbook | MPL-2.0 | Yes. File-level copyleft, only changes to its own files must be shared |
| Ayaspell (Arabic) | tri-licence GPL / LGPL / MPL | Yes, under the MPL option |
| SCOWL en_US | permissive (keep the notice) | Yes |
| LanguageTool Arabic lists | LGPL-2.1 (partly from AGPL aghlat) | Needs a decision, see above |

Sources: Ayaspell's own site (https://ayaspell.sourceforge.net/) and its GitHub mirror
(https://github.com/munzirtaha/ayaspell), where 3.7 is the latest release. The dictionary files tested came from
LibreOffice's repository (https://github.com/LibreOffice/dictionaries, `ar/`, version 3.5).

## How it plugs into Qalam (design)

1. **Rust (`src-tauri/src/spell.rs`).** Load both dictionaries once, in the background, at startup. Commands:
   - `spell_check(paragraphs: [{id, text}]) → [{id, misspelt: [{from, to}]}]`: tokenise, choose the dictionary by
     script, skip numbers, URLs, e-mail addresses and words with digits (Obsidian's "don't check code" idea).
   - `spell_suggest(word) → [≤ 6 words]`: on demand only.
   - `spell_add_word(word)`: a personal dictionary in app data (`dictionary.txt`), loaded into both checkers.
2. **Editor (`src/editor/spellcheck.ts`), a ProseMirror plugin.**
   - Keep a `DecorationSet` of `Decoration.inline(from, to, {class: "misspelt"})`, mapped through every transaction.
     That's Grammarly's Delta `transformPosition`, for free.
   - Track which paragraphs changed. About 300 ms after typing pauses, send only those to Rust (Grammarly's batching idea).
   - Don't touch decorations while the input method is composing (`view.composing`).
   - Don't underline the word being typed until the cursor leaves it, so the writer isn't nagged mid-word.
3. **Clicking or right-clicking a misspelt word** opens a small menu: suggestions (≤ 6), "No suggestions" (disabled), "Add to
   dictionary", "Ignore". This is Obsidian's menu shape, drawn in Qalam's own style.
4. **Underline style.** A wavy line in the warm red of Qalam's palette, with `text-underline-offset` pushed below
   Arabic descenders (ي ر و ن), and whole-word decorations only, so Arabic letters stay joined.
