# Qalam · قلم

A writing app for Arabic and English. It proofreads both languages as you type, and runs on Linux and Windows.

> **Early development.** Qalam is not ready for everyday use yet.

## What works so far

- Arabic and English in the same document: each paragraph and list sets its own direction (right-to-left or left-to-right) from its text, with no toggle.
- Arabic fonts that sit evenly beside English text: Scheherazade New (default) and Amiri, built into the app.
- حركات (Arabic diacritics): a toolbar and shortcuts (Alt+1 to Alt+8) that put a mark on the letter you just typed. A new vowel replaces the old one, and شدة combines with a vowel.
- Headings, bold, italic, and bulleted and numbered lists. Arabic lists count ١ ٢ ٣.

## Planned

- Spellcheck as you type, in Arabic and English, offline.
- AI grammar and punctuation: Claude when online (bring your own API key), a local model offline.
- Automatic تشكيل, full or light, that never changes your letters.
- Real pages, printing and PDF export.
- Open and save `.docx`.

## Run it from source

You need Node.js 20+ and Rust. On Linux you also need Tauri's [system dependencies](https://tauri.app/start/prerequisites/).

```
npm install
npm run tauri dev
```

## Licence of bundled fonts

Scheherazade New, Amiri, Noto Serif and IBM Plex Sans Arabic are released under the SIL Open Font License.
