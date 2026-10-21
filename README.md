# Qalam · قلم

A writing app for Arabic and English. It proofreads both languages as you type, and runs on Linux and Windows.

> **Early development.** Qalam is not ready for everyday use yet.

## What works so far

- Arabic and English in the same document: each paragraph and list sets its own direction (right-to-left or left-to-right) from its text, with no toggle.
- Arabic fonts that sit evenly beside English text, even with حركات: Amiri (default, classic) and Vazirmatn (modern), built into the app.
- حركات (Arabic diacritics): a toolbar and shortcuts (Alt+1 to Alt+8) that put a mark on the letter you just typed. A new vowel replaces the old one, and شدة combines with a vowel.
- Headings, bold, italic, and bulleted and numbered lists. Arabic lists count ١ ٢ ٣.
- Automatic تشكيل (button شكّل, Ctrl+Shift+T), light or full, shown as a preview first:
  - offline by default, using [CATT](https://github.com/abjadai/catt) (Abjad AI, Apache-2.0). On the WikiNews benchmark it gets 5.5% of marks wrong with case endings, 3.2% without (our measurement);
  - with a Claude API key, Claude is used instead, with the offline model as a fallback;
  - it never changes your letters: any word whose letters differ is left as you typed it.
- Automatic English punctuation, offline: press Enter at the end of an English paragraph and missing capitals and . , ? are added, using [punct_cap_seg_en](https://huggingface.co/1-800-BAD-CODE/punctuation_fullstop_truecase_english) (Apache-2.0). It only adds, never removes what you typed. One Ctrl+Z undoes it, and it can be switched off in the bottom bar.

## Planned

- Spellcheck as you type, in Arabic and English, offline.
- AI grammar and punctuation: Claude when online (bring your own API key), a local model offline.
- Real pages, printing and PDF export.
- Open and save `.docx`.

## Run it from source

You need Node.js 20+ and Rust. On Linux you also need Tauri's [system dependencies](https://tauri.app/start/prerequisites/).

```
npm install
./tools/fetch-onnxruntime.sh   # Microsoft's ONNX Runtime, for the offline models
npm run tauri dev
```

The offline models (72 MB for تشكيل, 210 MB for punctuation) are downloaded by the app the first time you use them, and checked against their SHA-256 fingerprints.

## Licence of bundled fonts

Vazirmatn, Amiri, Noto Serif and IBM Plex Sans Arabic are released under the SIL Open Font License. "Qalam Amiri" (src/fonts/) is a modified Amiri with its climbing letter combinations switched off so every word sits on one line; it's built by `tools/build-arabic-font.py` and keeps Amiri's licence (src/fonts/OFL-Amiri.txt).
