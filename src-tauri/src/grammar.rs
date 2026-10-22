//! English grammar with Harper (Automattic, Apache-2.0), an offline Rust grammar checker,
//! plus a short list of learner mistakes it misses (dictionaries/en-learner.txt).
//! See research/english.md for the comparison with LanguageTool and the measurements.
//!
//! Spelling stays with Hunspell (spell.rs), so the writer's own dictionary works the same
//! everywhere: Harper's own spellcheck is switched off. So are its style suggestions
//! (sentence length, wordiness): those are opinions, not mistakes.

use std::collections::HashMap;

use harper_core::linting::{LintGroup, LintKind, Linter, Suggestion};
use harper_core::parsers::PlainEnglish;
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document};
use serde::Deserialize;

/// American or British English: picks the spelling dictionary and Harper's dialect.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum English {
    #[default]
    Us,
    Gb,
}

/// A grammar problem, as character (not byte) offsets into the paragraph.
#[derive(Debug, PartialEq)]
pub struct Problem {
    pub from: usize,
    pub to: usize,
    pub message: String,
    /// Text to put in place of from..to; an empty string means "remove it".
    pub replacements: Vec<String>,
}

struct LearnerRule {
    words: Vec<String>,
    /// Only at the end of a clause: followed by punctuation or nothing.
    at_end: bool,
    right: String,
    why: String,
}

pub struct Grammar {
    linters: HashMap<English, LintGroup>,
    learner: Vec<LearnerRule>,
}

/// Categories that are about taste rather than correctness.
fn is_opinion(kind: LintKind) -> bool {
    matches!(kind, LintKind::Style | LintKind::Readability | LintKind::Enhancement | LintKind::Formatting | LintKind::Spelling)
}

/// Harper writes code-style quotes (`they're`); show typographic ones.
fn tidy_message(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut open = true;
    for c in message.chars() {
        if c == '`' {
            out.push(if open { '“' } else { '”' });
            open = !open;
        } else {
            out.push(c);
        }
    }
    out
}

/// Keeps a capital first letter when the replacement is put in its place.
fn match_case(original: &str, replacement: &str) -> String {
    let starts_upper = original.chars().next().is_some_and(char::is_uppercase);
    let mut chars = replacement.chars();
    match chars.next() {
        Some(first) if starts_upper => first.to_uppercase().chain(chars).collect(),
        _ => replacement.to_string(),
    }
}

impl Grammar {
    pub fn new(learner_list: &str) -> Self {
        let learner = learner_list
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .filter_map(|l| {
                let (pair, why) = l.split_once('\t').unwrap_or((l, ""));
                let (wrong, right) = pair.split_once('=')?;
                let at_end = wrong.ends_with('$');
                Some(LearnerRule {
                    words: wrong.trim_end_matches('$').split_whitespace().map(str::to_lowercase).collect(),
                    at_end,
                    right: right.trim().to_string(),
                    why: why.trim().to_string(),
                })
            })
            .collect();
        Grammar { linters: HashMap::new(), learner }
    }

    fn linter(&mut self, english: English) -> &mut LintGroup {
        self.linters.entry(english).or_insert_with(|| {
            let dialect = match english {
                English::Us => Dialect::American,
                English::Gb => Dialect::British,
            };
            let mut group = LintGroup::new_curated(FstDictionary::curated(), dialect);
            group.config.set_rule_enabled("SpellCheck", false);
            group
        })
    }

    /// Loads Harper's rules ahead of the first check (they take a moment to build).
    pub fn warm_up(&mut self, english: English) {
        self.linter(english);
    }

    pub fn check(&mut self, text: &str, english: English) -> Vec<Problem> {
        // Arabic-only paragraphs have nothing for an English grammar checker.
        if !text.chars().any(|c| c.is_ascii_alphabetic()) {
            return vec![];
        }
        let chars: Vec<char> = text.chars().collect();
        let document = Document::new_curated(text, &PlainEnglish);
        let mut problems: Vec<Problem> = self
            .linter(english)
            .lint(&document)
            .into_iter()
            .filter(|lint| !is_opinion(lint.lint_kind) && lint.span.end <= chars.len())
            .map(|lint| {
                let original: String = chars[lint.span.start..lint.span.end].iter().collect();
                let mut replacements: Vec<String> = Vec::new();
                for suggestion in &lint.suggestions {
                    let text = match suggestion {
                        Suggestion::ReplaceWith(with) => with.iter().collect(),
                        Suggestion::InsertAfter(add) => original.clone() + &add.iter().collect::<String>(),
                        Suggestion::Remove => String::new(),
                    };
                    // Harper sometimes offers the same fix with and without a trailing space.
                    if !replacements.iter().any(|r| r.trim() == text.trim()) {
                        replacements.push(text);
                    }
                }
                Problem { from: lint.span.start, to: lint.span.end, message: tidy_message(&lint.message), replacements }
            })
            .collect();
        problems.extend(self.learner_problems(&chars));
        problems.sort_by_key(|p| (p.from, p.to));
        // Two rules about the same stretch of text: keep the first.
        problems.dedup_by(|b, a| a.from < b.to && b.from < a.to);
        problems
    }

    fn learner_problems(&self, chars: &[char]) -> Vec<Problem> {
        // Latin words with their character positions.
        let mut words: Vec<(usize, usize, String)> = Vec::new();
        let mut i = 0;
        while i < chars.len() {
            if chars[i].is_ascii_alphabetic() {
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_alphabetic() || chars[i] == '\'' || chars[i] == '’') {
                    i += 1;
                }
                words.push((start, i, chars[start..i].iter().collect::<String>().to_lowercase()));
            } else {
                i += 1;
            }
        }
        let only_spaces = |from: usize, to: usize| chars[from..to].iter().all(|c| *c == ' ');
        let mut out = Vec::new();
        for rule in &self.learner {
            let n = rule.words.len();
            for w in 0..words.len().saturating_sub(n - 1) {
                let run = &words[w..w + n];
                let matches = run.iter().zip(&rule.words).all(|(word, want)| &word.2 == want)
                    && run.windows(2).all(|pair| only_spaces(pair[0].1, pair[1].0));
                if !matches {
                    continue;
                }
                let (from, to) = (run[0].0, run[n - 1].1);
                if rule.at_end && chars[to..].iter().find(|c| !c.is_whitespace()).is_some_and(|c| c.is_alphanumeric()) {
                    continue;
                }
                let original: String = chars[from..to].iter().collect();
                out.push(Problem { from, to, message: rule.why.clone(), replacements: vec![match_case(&original, &rule.right)] });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grammar() -> Grammar {
        Grammar::new(include_str!("../dictionaries/en-learner.txt"))
    }

    /// The flagged text and first fix of each problem.
    fn flagged(g: &mut Grammar, text: &str, english: English) -> Vec<(String, String)> {
        let chars: Vec<char> = text.chars().collect();
        g.check(text, english)
            .into_iter()
            .map(|p| (chars[p.from..p.to].iter().collect(), p.replacements.first().cloned().unwrap_or_default()))
            .collect()
    }

    #[test]
    fn catches_common_grammar_mistakes() {
        let mut g = grammar();
        let cases = [
            ("He go to school every day.", "go", "goes"),
            ("I have a apple.", "a", "an"),
            ("I could of done it better.", "could of", "could have"),
            ("She don't like it.", "don't", "doesn't"),
            ("Despite of the rain, we went out.", "Despite of", "Despite"),
            ("I want to discuss about the plan.", "discuss about", "discuss"),
        ];
        for (text, bad, fix) in cases {
            let found = flagged(&mut g, text, English::Us);
            assert!(found.iter().any(|(b, f)| b == bad && f == fix), "{text}: {found:?}");
        }
    }

    #[test]
    fn learner_rules() {
        let mut g = grammar();
        assert_eq!(flagged(&mut g, "I am agree with you.", English::Us), [("am agree".to_string(), "agree".to_string())]);
        assert_eq!(flagged(&mut g, "Please explain me the problem.", English::Us), [("explain me".to_string(), "explain to me".to_string())]);
        assert_eq!(flagged(&mut g, "Your welcome!", English::Us), [("Your welcome".to_string(), "You're welcome".to_string())]);
        // Not at the end of a clause: a correct phrase.
        assert!(flagged(&mut g, "Did you read your welcome message?", English::Us).is_empty());
    }

    #[test]
    fn leaves_correct_and_arabic_text_alone() {
        let mut g = grammar();
        assert!(flagged(&mut g, "My favorite color is gray.", English::Us).is_empty());
        assert!(flagged(&mut g, "انا اسمي البراء and I live in Dubai, عايش في الإمارات.", English::Us).is_empty());
        assert!(flagged(&mut g, "هذا الكتاب جميل جدا", English::Us).is_empty());
    }

    #[test]
    fn spelling_is_left_to_hunspell() {
        let mut g = grammar();
        // Harper's own spellcheck is off: no duplicate underline for a misspelt word.
        assert!(!flagged(&mut g, "I recieve the letter.", English::Us).iter().any(|(b, _)| b == "recieve"));
    }
}
