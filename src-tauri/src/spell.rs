//! Offline spellcheck for Arabic and English with spellbook (a pure-Rust Hunspell, MPL-2.0)
//! and bundled dictionaries: Ayaspell for Arabic (used under its MPL option) and SCOWL for
//! English, American (en_US) or British (en_GB-ise). See research/spellcheck.md for why, and
//! for measurements. English grammar is checked in the same pass (grammar.rs).
//!
//! Each word goes to the dictionary of its script, so mixed Arabic/English text needs no
//! language setting. حركات are ignored by the Arabic dictionary itself (its IGNORE line), so
//! words with تشكيل check the same as without. A short list of common Arabic mistakes that
//! Hunspell accepts (dictionaries/ar-mistakes.txt) is flagged on top.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use spellbook::Dictionary;

use crate::grammar::{English, Grammar};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

/// Suggestion lists are cut to this length, as in most editors.
const MAX_SUGGESTIONS: usize = 6;

#[derive(Default)]
pub struct Spellchecker(Mutex<Option<Checker>>);

pub struct Checker {
    arabic: Dictionary,
    american: Dictionary,
    british: Dictionary,
    grammar: Grammar,
    /// wrong (without حركات) → (right, why)
    mistakes: HashMap<String, (String, String)>,
    personal: PathBuf,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Script {
    Arabic,
    Latin,
}

/// A problem in a paragraph, as UTF-16 offsets (what JavaScript strings use).
#[derive(Serialize, Debug, PartialEq)]
pub struct Issue {
    from: usize,
    to: usize,
    /// "spelling" or "grammar"
    kind: &'static str,
    /// Grammar only: what's wrong, and the fixes. Spelling suggestions are fetched on demand.
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    replacements: Vec<String>,
}

#[derive(Serialize)]
pub struct Suggestions {
    words: Vec<String>,
    /// Why the word is wrong, for the mistakes Qalam knows (in Arabic).
    note: Option<String>,
}

fn is_arabic_letter(c: char) -> bool {
    matches!(c, '\u{0620}'..='\u{064A}' | '\u{066E}'..='\u{06D3}' | '\u{06D5}' | '\u{06FA}'..='\u{06FF}'
        | '\u{0750}'..='\u{077F}' | '\u{08A0}'..='\u{08C9}' | '\u{FB50}'..='\u{FDFF}' | '\u{FE70}'..='\u{FEFF}')
}

/// حركات, tanween, shadda, sukun, superscript alef, and the tatweel ـ.
fn is_arabic_mark(c: char) -> bool {
    matches!(c, '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{0640}')
}

fn strip_marks(word: &str) -> String {
    word.chars().filter(|&c| !is_arabic_mark(c)).collect()
}

fn script_of(word: &str) -> Option<Script> {
    let arabic = word.chars().any(is_arabic_letter);
    let latin = word.chars().any(|c| c.is_alphabetic() && !is_arabic_letter(c) && !is_arabic_mark(c));
    match (arabic, latin) {
        (true, false) => Some(Script::Arabic),
        (false, true) if word.chars().all(|c| c.is_ascii_alphabetic() || c == '\'' || ('\u{C0}'..='\u{24F}').contains(&c)) => Some(Script::Latin),
        _ => None, // mixed scripts, or another alphabet: not ours to judge
    }
}

/// Chunks that aren't prose: links, e-mail addresses, file paths.
fn is_not_prose(chunk: &str) -> bool {
    chunk.contains("://") || chunk.starts_with("www.") || (chunk.contains('@') && chunk.contains('.')) || chunk.contains('/') || chunk.contains('\\')
}

/// A word to check: its text and UTF-16 offsets in the paragraph.
#[derive(Debug, PartialEq)]
struct Token<'a> {
    text: &'a str,
    script: Script,
    from: usize,
    to: usize,
}

/// Splits a paragraph into checkable words. A word is a run of letters (with any حركات);
/// an apostrophe joins two Latin letters (don't). Words touching digits, links and e-mail
/// addresses are skipped, as are single letters and acronyms (NATO).
fn tokens(text: &str) -> Vec<Token<'_>> {
    // (byte index, UTF-16 index) of every char, plus the end.
    let mut index: Vec<(usize, usize, char)> = Vec::with_capacity(text.len());
    let mut utf16 = 0;
    for (byte, c) in text.char_indices() {
        index.push((byte, utf16, c));
        utf16 += c.len_utf16();
    }
    let end = (text.len(), utf16);
    let at = |i: usize| index.get(i).map(|&(b, u, _)| (b, u)).unwrap_or(end);
    let is_word_char = |c: char| c.is_alphabetic() || is_arabic_mark(c);

    let mut out = Vec::new();
    let mut i = 0;
    while i < index.len() {
        // One whitespace-separated chunk.
        if index[i].2.is_whitespace() {
            i += 1;
            continue;
        }
        let chunk_start = i;
        while i < index.len() && !index[i].2.is_whitespace() {
            i += 1;
        }
        let chunk_end = i;
        if is_not_prose(&text[at(chunk_start).0..at(chunk_end).0]) {
            continue;
        }
        let mut j = chunk_start;
        while j < chunk_end {
            if !is_word_char(index[j].2) {
                j += 1;
                continue;
            }
            let start = j;
            while j < chunk_end {
                let c = index[j].2;
                let joins = (c == '\'' || c == '’')
                    && j > start
                    && j + 1 < chunk_end
                    && index[j - 1].2.is_ascii_alphabetic()
                    && index[j + 1].2.is_ascii_alphabetic();
                if is_word_char(c) || joins {
                    j += 1;
                } else {
                    break;
                }
            }
            let touches_digit = (start > chunk_start && index[start - 1].2.is_numeric())
                || (j < chunk_end && index[j].2.is_numeric());
            let (from_b, from_u) = at(start);
            let (to_b, to_u) = at(j);
            let word = &text[from_b..to_b];
            let letters = word.chars().filter(|&c| c.is_alphabetic() && !is_arabic_mark(c)).count();
            let acronym = word.chars().filter(|c| c.is_alphabetic()).all(|c| c.is_uppercase());
            if let (false, true, Some(script)) = (touches_digit, letters > 1, script_of(word)) {
                if !(script == Script::Latin && acronym) {
                    out.push(Token { text: word, script, from: from_u, to: to_u });
                }
            }
        }
    }
    out
}

impl Checker {
    fn load(dir: &PathBuf, personal: PathBuf) -> Result<Self, String> {
        let read = |name: &str| std::fs::read_to_string(dir.join(name)).map_err(|e| format!("Couldn't read {name}: {e}"));
        let arabic = Dictionary::new(&read("ar.aff")?, &read("ar.dic")?).map_err(|e| format!("Arabic dictionary: {e}"))?;
        let american = Dictionary::new(&read("en_US.aff")?, &read("en_US.dic")?).map_err(|e| format!("American English dictionary: {e}"))?;
        let british = Dictionary::new(&read("en_GB.aff")?, &read("en_GB.dic")?).map_err(|e| format!("British English dictionary: {e}"))?;
        let mut grammar = Grammar::new(&read("en-learner.txt")?);
        grammar.warm_up(English::Us);
        let mistakes = read("ar-mistakes.txt")?
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .filter_map(|l| {
                let (pair, why) = l.split_once('\t').unwrap_or((l, ""));
                let (wrong, right) = pair.split_once('=')?;
                Some((strip_marks(wrong.trim()), (right.trim().to_string(), why.trim().to_string())))
            })
            .collect();
        let mut checker = Checker { arabic, american, british, grammar, mistakes, personal };
        if let Ok(words) = std::fs::read_to_string(&checker.personal) {
            for word in words.lines().map(str::trim).filter(|w| !w.is_empty()) {
                checker.learn(word);
            }
        }
        Ok(checker)
    }

    fn dictionary(&self, script: Script, english: English) -> &Dictionary {
        match (script, english) {
            (Script::Arabic, _) => &self.arabic,
            (Script::Latin, English::Us) => &self.american,
            (Script::Latin, English::Gb) => &self.british,
        }
    }

    fn is_correct(&self, word: &str, script: Script, english: English) -> bool {
        match script {
            Script::Arabic => !self.mistakes.contains_key(&strip_marks(word)) && self.arabic.check(word),
            Script::Latin => self.dictionary(script, english).check(&word.replace('’', "'")),
        }
    }

    /// Misspelt words, then grammar problems that don't overlap them (a misspelt word is
    /// fixed first; its grammar is judged again afterwards).
    fn check(&mut self, paragraph: &str, english: English) -> Vec<Issue> {
        let mut issues: Vec<Issue> = tokens(paragraph)
            .into_iter()
            .filter(|t| !self.is_correct(t.text, t.script, english))
            .map(|t| Issue { from: t.from, to: t.to, kind: "spelling", message: None, replacements: vec![] })
            .collect();
        let problems = self.grammar.check(paragraph, english);
        if !problems.is_empty() {
            // Grammar positions count characters; JavaScript counts UTF-16 units.
            let mut utf16 = Vec::with_capacity(paragraph.len() + 1);
            let mut at = 0;
            for c in paragraph.chars() {
                utf16.push(at);
                at += c.len_utf16();
            }
            utf16.push(at);
            for p in problems {
                let (from, to) = (utf16[p.from], utf16[p.to]);
                if !issues.iter().any(|i| i.from < to && from < i.to) {
                    issues.push(Issue { from, to, kind: "grammar", message: Some(p.message), replacements: p.replacements });
                }
            }
            issues.sort_by_key(|i| i.from);
        }
        issues
    }

    fn suggest(&self, word: &str, english: English) -> Suggestions {
        let Some(script) = script_of(word) else {
            return Suggestions { words: vec![], note: None };
        };
        let bare = match script {
            Script::Arabic => strip_marks(word),
            Script::Latin => word.replace('’', "'"),
        };
        let mut words = Vec::new();
        if let Some((right, why)) = self.mistakes.get(&bare) {
            // Hunspell takes these words for correct, so its own suggestions are noise.
            let note = (!why.is_empty()).then(|| why.clone());
            return Suggestions { words: vec![right.clone()], note };
        }
        let mut found = Vec::new();
        self.dictionary(script, english).suggest(&bare, &mut found);
        for s in found {
            // Hunspell also proposes splitting a word in two; for Arabic those splits are
            // almost never right ("فسيك تبونها"), so they're left out.
            if (script == Script::Latin || !s.contains(' ')) && s != bare && !words.contains(&s) {
                words.push(s);
            }
        }
        if script == Script::Arabic {
            for candidate in arabic_candidates(&bare) {
                if candidate != bare && !words.contains(&candidate) && self.arabic.check(&candidate) {
                    words.push(candidate);
                }
            }
            // A writer who typed the article ال on a longer word meant it, and it never takes
            // a hamza: العربيه → العربية, not ألعربية or لعربيه. (Short words like الا → إلا
            // are left alone.)
            if bare.starts_with("ال") && bare.chars().count() > 4 {
                words.retain(|w| w.starts_with("ال"));
            }
            let mut scored: Vec<(f32, String)> = words.into_iter().map(|w| (arabic_distance(&bare, &w), w)).collect();
            scored.retain(|(d, _)| *d <= MAX_ARABIC_DISTANCE);
            scored.sort_by(|a, b| a.0.total_cmp(&b.0)); // stable: keeps Hunspell's order for ties
            words = scored.into_iter().map(|(_, w)| w).collect();
        }
        words.truncate(MAX_SUGGESTIONS);
        Suggestions { words, note: None }
    }

    /// Adds a word to the dictionary of its script (in memory only).
    fn learn(&mut self, word: &str) -> bool {
        // A "/" would be read as Hunspell flags.
        if word.contains('/') {
            return false;
        }
        match script_of(word) {
            Some(Script::Arabic) => {
                let bare = strip_marks(word);
                self.mistakes.remove(&bare);
                self.arabic.add(&bare).is_ok()
            }
            Some(Script::Latin) => {
                let word = word.replace('’', "'");
                self.american.add(&word).is_ok() && self.british.add(&word).is_ok()
            }
            None => false,
        }
    }
}

/// Letters Arabic writers commonly swap for each other: the forms of alif and hamza, ه/ة,
/// ت/ة, ى/ي/ئ, و/ؤ. Swapping two of these costs half an edit.
fn confusable(a: char, b: char) -> bool {
    CONFUSABLE_GROUPS.iter().any(|g| g.contains(a) && g.contains(b))
}

const CONFUSABLE_GROUPS: [&str; 5] = ["اأإآء", "هة", "تة", "ىيئ", "وؤ"];

/// Corrections Hunspell's suggester often misses, tried directly against the dictionary:
/// dropping an extra alif (هاذا → هذا, لاكن → لكن), dropping a doubled letter, and swapping a
/// letter for a confusable one.
fn arabic_candidates(word: &str) -> Vec<String> {
    let chars: Vec<char> = word.chars().collect();
    let mut out = Vec::new();
    for i in 0..chars.len() {
        let without = || chars.iter().enumerate().filter(|&(j, _)| j != i).map(|(_, c)| *c).collect::<String>();
        if chars[i] == 'ا' || (i > 0 && chars[i - 1] == chars[i]) {
            out.push(without());
        }
        for group in CONFUSABLE_GROUPS.iter().filter(|g| g.contains(chars[i])) {
            for other in group.chars().filter(|&c| c != chars[i]) {
                let mut changed = chars.clone();
                changed[i] = other;
                out.push(changed.into_iter().collect());
            }
        }
    }
    out
}

/// Edit distance where swapping confusable letters, or adding or dropping an alif, costs 0.5
/// (and adding or dropping و or ي 0.75).
fn arabic_distance(a: &str, b: &str) -> f32 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    // A missing or extra alif is the commonest slip; a missing و or ي (long vowels) is next.
    let gap = |c: char| match c {
        'ا' => 0.5,
        'و' | 'ي' => 0.75,
        _ => 1.0,
    };
    let mut prev = vec![0.0f32; b.len() + 1];
    for j in 1..=b.len() {
        prev[j] = prev[j - 1] + gap(b[j - 1]);
    }
    for i in 1..=a.len() {
        let mut row = vec![prev[0] + gap(a[i - 1]); b.len() + 1];
        for j in 1..=b.len() {
            let swap = if a[i - 1] == b[j - 1] { 0.0 } else if confusable(a[i - 1], b[j - 1]) { 0.5 } else { 1.0 };
            row[j] = (prev[j - 1] + swap).min(prev[j] + gap(a[i - 1])).min(row[j - 1] + gap(b[j - 1]));
        }
        prev = row;
    }
    prev[b.len()]
}

/// Hunspell's Arabic suggestions include letter shuffles that are rarely meant
/// (اللغه → غلاه). Keep the close ones, nearest first; Hunspell's order breaks ties.
const MAX_ARABIC_DISTANCE: f32 = 2.0;

fn dictionary_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().resolve("dictionaries", BaseDirectory::Resource).map_err(|e| e.to_string())
}

fn personal_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("dictionary.txt"))
}

/// Runs `f` with the loaded checker, loading the dictionaries on first use.
fn with_checker<T>(app: &AppHandle, f: impl FnOnce(&mut Checker) -> T) -> Result<T, String> {
    let state = app.state::<Spellchecker>();
    let mut guard = state.0.lock().map_err(|_| "The spellchecker is unavailable.".to_string())?;
    if guard.is_none() {
        *guard = Some(Checker::load(&dictionary_dir(app)?, personal_path(app)?)?);
    }
    Ok(f(guard.as_mut().unwrap()))
}

/// Loads the dictionaries in the background at startup, so the first check is instant.
pub fn preload(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = with_checker(&app, |_| ()) {
            eprintln!("spellcheck: {e}");
        }
    });
}

/// Spelling and grammar problems in each paragraph.
#[tauri::command]
pub async fn spell_check(app: AppHandle, paragraphs: Vec<String>, english: English) -> Result<Vec<Vec<Issue>>, String> {
    tauri::async_runtime::spawn_blocking(move || with_checker(&app, |c| paragraphs.iter().map(|p| c.check(p, english)).collect()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn spell_suggest(app: AppHandle, word: String, english: English) -> Result<Suggestions, String> {
    tauri::async_runtime::spawn_blocking(move || with_checker(&app, |c| c.suggest(&word, english)))
        .await
        .map_err(|e| e.to_string())?
}

/// Adds a word to the writer's own dictionary, kept in the app's data folder.
#[tauri::command]
pub async fn spell_add_word(app: AppHandle, word: String) -> Result<(), String> {
    let word = word.trim().to_string();
    let path = personal_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !with_checker(&app, |c| c.learn(&word))? {
            return Err(format!("“{word}” can't be added to the dictionary."));
        }
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut words = std::fs::read_to_string(&path).unwrap_or_default();
        if !words.lines().any(|w| w == word) {
            words.push_str(&word);
            words.push('\n');
            let partial = path.with_extension("txt.partial");
            std::fs::write(&partial, words).map_err(|e| e.to_string())?;
            std::fs::rename(&partial, &path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checker() -> Checker {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dictionaries");
        Checker::load(&dir, std::env::temp_dir().join("qalam-test-no-personal-dictionary.txt")).unwrap()
    }

    /// The misspelt words (spelling issues only).
    fn flagged(c: &mut Checker, text: &str) -> Vec<String> {
        flagged_as(c, text, English::Us, "spelling")
    }

    fn flagged_as(c: &mut Checker, text: &str, english: English, kind: &str) -> Vec<String> {
        let units: Vec<u16> = text.encode_utf16().collect();
        c.check(text, english).iter().filter(|i| i.kind == kind).map(|i| String::from_utf16(&units[i.from..i.to]).unwrap()).collect()
    }

    #[test]
    fn tokens_skip_links_numbers_and_acronyms() {
        let words: Vec<&str> = tokens("See https://qalam.dev or mail me@x.io, NATO said 3rd time: don't stop.")
            .iter()
            .map(|t| t.text)
            .collect();
        assert_eq!(words, ["See", "or", "mail", "said", "time", "don't", "stop"]);
    }

    #[test]
    fn offsets_are_utf16() {
        // "😀" is two UTF-16 units.
        let t = tokens("😀 teh");
        assert_eq!((t[0].from, t[0].to), (3, 6));
    }

    #[test]
    fn arabic_with_and_without_harakat() {
        let mut c = checker();
        assert!(flagged(&mut c, "أنا اسْمِي الْبَرَاءِ وَحِيدٌ مِنْ مِصْرَ، عايش في الإمارات").is_empty());
        assert_eq!(flagged(&mut c, "انا اسمي البراء"), ["انا"]);
    }

    #[test]
    fn known_mistakes_are_flagged_with_a_note() {
        let mut c = checker();
        assert_eq!(flagged(&mut c, "ذالك شيئ جميل"), ["ذالك", "شيئ"]);
        let s = c.suggest("ذالك", English::Us);
        assert_eq!(s.words, ["ذلك"]);
        assert!(s.note.is_some());
        // Same word with حركات.
        assert_eq!(flagged(&mut c, "ذَالِكَ"), ["ذَالِكَ"]);
    }

    #[test]
    fn mixed_paragraph_uses_both_dictionaries() {
        let mut c = checker();
        assert_eq!(flagged(&mut c, "قرأت كتاب recieve عن الذى"), ["recieve", "الذى"]);
        assert_eq!(c.suggest("recieve", English::Us).words[0], "receive");
        assert_eq!(c.suggest("الذى", English::Us).words[0], "الذي");
    }

    #[test]
    fn arabic_suggestions_are_close_ones() {
        let c = checker();
        let s = c.suggest("اللغه", English::Us).words;
        assert_eq!(s[0], "اللغة");
        assert!(!s.iter().any(|w| w == "غلاه" || w == "اغلله"), "{s:?}");
        assert_eq!(c.suggest("الكتااب", English::Us).words[0], "الكتاب");
        assert_eq!(c.suggest("سيارت", English::Us).words[0], "سيارة");
        assert_eq!(c.suggest("هاذا", English::Us).words[0], "هذا");
        assert!(c.suggest("لاكن", English::Us).words[..2].contains(&"لكن".to_string()));
        assert_eq!(c.suggest("مسؤل", English::Us).words[0], "مسؤول");
        assert!(!c.suggest("العربيه", English::Us).words.iter().any(|w| w.starts_with("أل")));
        assert!((arabic_distance("انا", "أنا") - 0.5).abs() < 1e-6);
    }

    #[test]
    fn american_or_british_spelling() {
        let mut c = checker();
        assert_eq!(flagged_as(&mut c, "My favourite colour is grey.", English::Us, "spelling"), ["favourite", "colour", "grey"]);
        assert!(flagged_as(&mut c, "My favourite colour is grey.", English::Gb, "spelling").is_empty());
        assert_eq!(flagged_as(&mut c, "My favorite color is gray.", English::Gb, "spelling"), ["favorite", "color", "gray"]);
        assert_eq!(c.suggest("colour", English::Us).words[0], "color");
        assert_eq!(c.suggest("color", English::Gb).words[0], "colour");
    }

    #[test]
    fn grammar_and_spelling_together() {
        let mut c = checker();
        let text = "He go to school, I recieve teh letter. انا اسمي البراء";
        assert_eq!(flagged_as(&mut c, text, English::Us, "spelling"), ["recieve", "teh", "انا"]);
        assert_eq!(flagged_as(&mut c, text, English::Us, "grammar"), ["go"]);
        let issue = c.check("He go home.", English::Us).into_iter().find(|i| i.kind == "grammar").unwrap();
        assert_eq!(issue.replacements[0], "goes");
        assert!(issue.message.is_some());
    }

    #[test]
    fn learned_words_are_accepted() {
        let mut c = checker();
        assert_eq!(flagged(&mut c, "Albaraa wrote فسيكتبونها"), ["Albaraa", "فسيكتبونها"]);
        assert!(c.learn("Albaraa"));
        assert!(c.learn("فسيكتبونها"));
        assert!(flagged(&mut c, "Albaraa wrote فسيكتبونها").is_empty());
    }
}
