# Qalam's approach: the best of Grammarly, Obsidian and open source

We studied three ways of checking writing ([grammarly.md](grammarly.md), [obsidian.md](obsidian.md),
[spellcheck.md](spellcheck.md), [english.md](english.md)). This page takes the strengths of each, leaves their weaknesses
behind, and says what Qalam does instead. ✅ = built (on the `spellcheck` branch), ⏳ = planned.

## What each one gets right, and wrong

| | Take ✓ | Leave ✗ |
| --- | --- | --- |
| **Grammarly** | Underlines stay on the right word while you type · checks only what changed · different colours for different kinds of problem · a card with the fix **and why** · careful with input methods (IME) | Sends your text to its servers · needs an account · ~4 s per check · no Arabic · a complex overlay on top of other apps' text · licence forbids study |
| **Obsidian** | Simple, familiar menu (≤ 6 suggestions, "Add to dictionary") · skips links and code · falls back to the system language · works offline | Only spelling, no grammar · depends on Chromium and downloads dictionaries from Google · right-to-left is one switch for the whole document · no explanations |
| **Open source** (Hunspell, Ayaspell, SCOWL, Harper, LanguageTool) | Offline and free · fast (µs per word, ms per paragraph) · permissive licences · LanguageTool's Arabic lists **explain** each mistake | Hunspell accepts some wrong Arabic (ذالك, شيئ) and its Arabic suggestions are noisy · LanguageTool needs Java and is slow · Harper is English-only and misses learner mistakes |

## Qalam's combination

### Where checking happens
- ✅ **Everything on the device**, in Rust: no account, no server, no text leaves the computer (vs Grammarly). Arabic spelling takes ~1.7 µs per word
  and English grammar ~2–4 ms per paragraph.
- ✅ **One engine per job, chosen per word:** Arabic words → Ayaspell, Latin words → SCOWL (American or British), English
  grammar → Harper. No language setting, and mixed paragraphs just work (vs Obsidian's one language list).
- ✅ **Bundled dictionaries:** nothing is downloaded on first use (vs Chromium).

### How problems are shown
- ✅ **Two kinds, two looks:** spelling = red wavy line, grammar = blue double line. They differ in shape as well as colour,
  so they're readable for colour-blind writers too (Grammarly's idea, made accessible).
- ✅ **Underlines drawn inside the text** as editor decorations, not an overlay on top: they wrap with lines and scroll with the
  page for free, and follow every edit (Grammarly's Delta tracking, built into ProseMirror).
- ✅ **Whole words only, below Arabic descenders:** letters stay joined and the line clears ي ر و ن. Neither Grammarly nor
  Obsidian has to think about this, and both get Arabic wrong.
- ✅ **Never nags mid-word:** the word being typed is underlined only once you move on.
- ✅ **Never disturbs an input method:** no changes while a character is being composed (Grammarly).

### What happens on a click
- ✅ **One small card**, in Obsidian's familiar shape: up to 6 fixes, "Add to dictionary", "Ignore".
- ✅ **…plus the reason**, as Grammarly does, but **in Arabic for Arabic** (e.g. «تُحذف الألف بعد الذال في «ذلك» كتابةً»).
  No other tool explains Arabic mistakes.
- ✅ **The card speaks the text's language:** Arabic labels and right-to-left layout for Arabic words.
- ✅ **Keyboard too:** Ctrl+. opens the card at the cursor, ↑/↓ move between fixes, Enter applies, Esc closes.
- ✅ **Your dictionary is yours:** "Add to dictionary" is saved in Qalam's data folder, for both languages.

### Quality, where the open tools fall short
- ✅ **Arabic mistakes Hunspell accepts** (ذالك, شيئ, إبن, ابتداءا…) are flagged from Qalam's own list.
- ✅ **Better Arabic suggestions:** ranked by a weighted distance, where commonly confused letters (أ/ا/إ, ه/ة, ى/ي) and a missing or
  extra alif count half. Qalam also tries those fixes itself (لاكن → لكن, which Hunspell never offers). The article ال keeps its form.
- ✅ **English learner mistakes Harper misses** ("I am agree", "explain me", "Your welcome!") from Qalam's own list.
- ✅ **Mistakes only, not opinions:** style and readability suggestions are off.
- ✅ **No double underlines:** a misspelt word isn't also flagged for grammar.

### Speed and big documents
- ✅ **Only changed paragraphs are re-checked**, ~300 ms after typing pauses (Grammarly's batching).
- ✅ **Nearest first:** a long document is checked 40 paragraphs at a time, starting near the cursor, so what you're looking at is
  ready first (a simple version of Grammarly's "visible first").
- ✅ **Suggestions only when asked:** they're computed when a card opens, because Arabic suggestions can take up to a few hundred ms.

### Left out on purpose
- ✗ **Sending text anywhere.** An optional Claude-powered check may come later, but only if the writer turns it on.
- ✗ **Style nagging and "readability scores."** They're opinions, and they'd crowd out real mistakes.
- ✗ **Rules that are sometimes wrong** ("explain them", "order for"). One wrong flag costs more trust than a right one earns.
- ✗ **An animation on every underline.** Underlines are redrawn whenever a paragraph is re-checked, so it would flicker.
- ✗ **LanguageTool's Java server.** Tested for Arabic: too many false alarms, and ~600 MB of memory. Its precise rules are a reference for our own.

## Next (⏳)
- ✅ **Arabic grammar, first rules** ([arabic-rules.md](arabic-rules.md)): لم/لن + يفعلون, plurals after إنّ and prepositions,
  قال إنّ, سوف لن, repeated words, Arabic punctuation spacing, إن شاء الله, هذه before feminine nouns. Each fix is explained in
  Arabic. Three rounds so far, now including كان, numbers, ذو/أبو and Arabic typography. **0 false alarms in 141,293 words**
  of clean Arabic (Wikipedia and Wikinews), against LanguageTool's one every 16 words.
- ⏳ **Deeper Arabic grammar** (agreement, كان, numbers): more gated rules, and Claude as an opt-in deep check.
- ⏳ **Rules for Arabic speakers writing English**, growing `en-learner.txt` (LanguageTool has the same idea for German speakers).
- ⏳ **Dialect words** (عامية) shown as a gentle, optional suggestion, never as a mistake.
- ⏳ **Learning from corrections:** words the writer keeps accepting become part of their dictionary automatically, as تشكيل memory already does.
