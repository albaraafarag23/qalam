//! "Fix hamzas" and "ة/ه · ى/ي": one-click fixes for the letters Arabic writers most often
//! type loosely: انا → أنا, الى → إلى, الاسلام → الإسلام, اللغه → اللغة, الذى → الذي.
//!
//! A word is only changed when the dictionary rejects it as typed AND real text
//! (dictionaries/ar-frequency.txt) doesn't use it as typed about as often as the fix, which
//! protects names and loanwords: سبتة, إريك, «واي باك مشين». The dictionary accepts many rare forms (إنّا, آنا, ألى), so the corrected
//! form must be clearly the common one in real text: seen at least 3 times and 10 times as
//! often as any other. انا → أنا, الى → إلى; but ان is left alone (أن is only 9 times as common
//! as إن, and after قال it must be إن) and counted as "unsure". Without frequency evidence
//! nothing changes: a missing word is better than a wrong one.
//! The article's alif (ال) is never given a hamza: «ألإسلام» is a question form, not a fix.

use std::collections::HashMap;

use serde::Serialize;
use spellbook::Dictionary;

fn is_arabic_letter(c: char) -> bool {
    matches!(c, '\u{0620}'..='\u{064A}' | '\u{066E}'..='\u{06D3}')
}

fn is_mark(c: char) -> bool {
    matches!(c, '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{0640}')
}

const ALIFS: [char; 4] = ['ا', 'أ', 'إ', 'آ'];

/// Where a word's stem can start: after nothing, after ال, after a one-letter prefix
/// (و ف ب ك ل), or after one of those followed by ال.
fn stem_starts(word: &[char]) -> Vec<usize> {
    // ال is the article only with at least two letters after it («الى» is إلى, not ال + ى).
    let has_al = |at: usize| word.len() > at + 3 && word[at] == 'ا' && word[at + 1] == 'ل';
    // The article's own alif is never a place for a hamza.
    if has_al(0) {
        return vec![2];
    }
    let mut out = vec![0];
    if word.len() > 2 && matches!(word[0], 'و' | 'ف' | 'ب' | 'ك' | 'ل') {
        if has_al(1) {
            out.push(3);
        } else {
            out.push(1);
        }
    }
    out
}

/// Reads dictionaries/ar-frequency.txt (word<TAB>count).
pub fn load_frequency(text: &str) -> HashMap<String, u32> {
    text.lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| {
            let (w, n) = l.split_once('\t')?;
            Some((w.to_string(), n.trim().parse().ok()?))
        })
        .collect()
}

/// Every other spelling of the word with its hamzas and/or final letters changed.
fn candidates(word: &[char], hamza: bool, endings: bool) -> Vec<String> {
    let mut forms: Vec<Vec<char>> = vec![word.to_vec()];
    if hamza {
        for start in stem_starts(word) {
            if word.get(start).is_some_and(|c| ALIFS.contains(c)) {
                let mut more = Vec::new();
                for f in &forms {
                    for a in ALIFS {
                        if a != f[start] {
                            let mut g = f.clone();
                            g[start] = a;
                            more.push(g);
                        }
                    }
                }
                forms.extend(more);
            }
        }
    }
    if endings {
        let last = word.len() - 1;
        let swap = match word[last] {
            'ه' => Some('ة'),
            'ة' => Some('ه'),
            'ي' => Some('ى'),
            'ى' => Some('ي'),
            _ => None,
        };
        if let Some(other) = swap {
            let more: Vec<Vec<char>> = forms
                .iter()
                .map(|f| {
                    let mut g = f.clone();
                    g[last] = other;
                    g
                })
                .collect();
            forms.extend(more);
        }
    }
    forms.into_iter().skip(1).map(|f| f.into_iter().collect()).collect()
}

/// One proposed change, as character offsets into the paragraph.
#[derive(Serialize, Debug, PartialEq)]
pub struct LetterFix {
    pub from: usize,
    pub to: usize,
    pub replacement: String,
}

#[derive(Serialize, Debug, Default)]
pub struct LetterFixes {
    pub fixes: Vec<LetterFix>,
    /// Words the dictionary rejects that could be fixed more than one way.
    pub unsure: usize,
}

/// The corrected form to use and how often it's seen, if one is clearly right.
fn choose(valid: Vec<String>, freq: &HashMap<String, u32>) -> Result<(String, u32), ()> {
    if valid.is_empty() {
        return Err(());
    }
    // A word with و in front (وأنا) counts as often as its bare form (أنا), when that has at
    // least 3 letters (so «واي» isn't read as و + أي).
    let count = |w: &String| {
        let own = freq.get(w).copied().unwrap_or(0);
        let bare = w
            .strip_prefix('و')
            .filter(|rest| rest.chars().count() >= 3)
            .and_then(|rest| freq.get(rest).copied())
            .unwrap_or(0);
        own.max(bare)
    };
    let mut ranked: Vec<(u32, String)> = valid.into_iter().map(|w| (count(&w), w)).collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    let best = ranked[0].0;
    let second = ranked.get(1).map(|r| r.0).unwrap_or(0);
    if best >= 3 && (second == 0 || best >= 10 * second) {
        return Ok((ranked.swap_remove(0).1, best));
    }
    Err(())
}

pub fn fix(text: &str, dict: &Dictionary, freq: &HashMap<String, u32>, hamza: bool, endings: bool) -> LetterFixes {
    let chars: Vec<char> = text.chars().collect();
    let mut out = LetterFixes::default();
    let mut i = 0;
    while i < chars.len() {
        if !is_arabic_letter(chars[i]) {
            i += 1;
            continue;
        }
        let from = i;
        while i < chars.len() && (is_arabic_letter(chars[i]) || is_mark(chars[i])) {
            i += 1;
        }
        let word = &chars[from..i];
        // Words with حركات are left as the writer wrote them.
        if word.len() < 2 || word.iter().any(|c| is_mark(*c)) {
            continue;
        }
        let typed: String = word.iter().collect();
        if dict.check(&typed) {
            continue;
        }
        let valid: Vec<String> = candidates(word, hamza, endings).into_iter().filter(|c| dict.check(c)).collect();
        if valid.is_empty() {
            continue; // not a letter problem (a real misspelling or an unknown word)
        }
        match choose(valid, freq) {
            // Used as typed in real text about as often as the "fix" (a name, a loanword): leave it.
            Ok((_, seen)) if 10 * freq.get(&typed).copied().unwrap_or(0) >= seen => {}
            Ok((replacement, _)) => out.fixes.push(LetterFix { from, to: i, replacement }),
            Err(()) => out.unsure += 1,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Arabic {
        dict: Dictionary,
        freq: HashMap<String, u32>,
    }

    fn dict() -> Arabic {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dictionaries");
        let read = |f: &str| std::fs::read_to_string(dir.join(f)).unwrap();
        Arabic { dict: Dictionary::new(&read("ar.aff"), &read("ar.dic")).unwrap(), freq: load_frequency(&read("ar-frequency.txt")) }
    }

    fn fixed(d: &Arabic, text: &str, hamza: bool, endings: bool) -> (String, usize) {
        let chars: Vec<char> = text.chars().collect();
        let result = fix(text, &d.dict, &d.freq, hamza, endings);
        let mut out = String::new();
        let mut at = 0;
        for f in &result.fixes {
            out.extend(&chars[at..f.from]);
            out.push_str(&f.replacement);
            at = f.to;
        }
        out.extend(&chars[at..]);
        (out, result.unsure)
    }

    #[test]
    fn hamzas() {
        let d = dict();
        assert_eq!(fixed(&d, "انا ذاهب الى الاسواق اذا", true, true).0, "أنا ذاهب إلى الأسواق إذا");
        // احب is a word as typed (أَحَبَّ without its hamza is accepted), so it's left alone.
        assert_eq!(fixed(&d, "وانا احب الاسلام اذا", true, false).0, "وأنا احب الإسلام إذا");
    }

    #[test]
    fn endings() {
        let d = dict();
        assert_eq!(fixed(&d, "اللغه العربيه جميلة", false, true).0, "اللغة العربية جميلة");
    }

    #[test]
    fn leaves_valid_and_ambiguous_words() {
        let d = dict();
        // علي is a name and a word; مدرسه can be "his teacher"; ان could be أن or إن.
        assert_eq!(fixed(&d, "علي مدرسه ان", true, true).0, "علي مدرسه ان");
        // A word with حركات is left as written.
        assert_eq!(fixed(&d, "اِنا", true, true).0, "اِنا");
    }
}
