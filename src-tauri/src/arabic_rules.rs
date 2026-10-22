//! Arabic grammar and punctuation rules written for Qalam.
//!
//! Every rule here must pass a gate before it ships: it catches its mistakes in the test
//! sentences and makes no flags at all on 31,828 words of clean Arabic (Wikipedia). See
//! research/languagetool-arabic.md for why: an underline that's wrong teaches the writer to
//! ignore all of them. Where a rule changes a word, the fix must be a word the dictionary
//! knows, which keeps it from firing on look-alikes (لم يكون is never "fixed" to يكوا).

use std::collections::HashSet;

use spellbook::Dictionary;

use crate::grammar::Problem;

fn is_arabic_letter(c: char) -> bool {
    matches!(c, '\u{0620}'..='\u{064A}' | '\u{066E}'..='\u{06D3}' | '\u{06D5}' | '\u{06FA}'..='\u{06FF}')
}

fn is_mark(c: char) -> bool {
    matches!(c, '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{0640}')
}

/// An Arabic word: its character span, and its letters without حركات.
struct Word {
    from: usize,
    to: usize,
    bare: String,
}

fn words(chars: &[char]) -> Vec<Word> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if is_arabic_letter(chars[i]) {
            let from = i;
            while i < chars.len() && (is_arabic_letter(chars[i]) || is_mark(chars[i])) {
                i += 1;
            }
            let bare = chars[from..i].iter().filter(|c| !is_mark(**c)).collect();
            out.push(Word { from, to: i, bare });
        } else {
            i += 1;
        }
    }
    out
}

/// Two words separated by spaces only (no punctuation, no line break).
fn adjacent(chars: &[char], a: &Word, b: &Word) -> bool {
    b.from > a.to && chars[a.to..b.from].iter().all(|c| *c == ' ' || *c == '\u{00A0}')
}

fn problem(from: usize, to: usize, fix: impl Into<String>, why: &str) -> Problem {
    Problem { from, to, message: why.to_string(), replacements: vec![fix.into()] }
}

/// لم / لن followed by a present verb that kept its ن: لم يذهبون → لم يذهبوا.
fn jussive_and_subjunctive(chars: &[char], ws: &[Word], dict: &Dictionary, out: &mut Vec<Problem>) {
    for pair in ws.windows(2) {
        let (particle, verb) = (&pair[0], &pair[1]);
        let why = match particle.bare.as_str() {
            "لم" | "ولم" | "فلم" | "ألم" => "بعد «لم» يأتي الفعل المضارع مجزومًا، فتُحذف النون من آخره.",
            "لن" | "ولن" | "فلن" => "بعد «لن» يأتي الفعل المضارع منصوبًا، فتُحذف النون من آخره.",
            _ => continue,
        };
        if !adjacent(chars, particle, verb) {
            continue;
        }
        let v: Vec<char> = verb.bare.chars().collect();
        let n = v.len();
        if !matches!(v.first(), Some('ي' | 'ت' | 'أ' | 'ن')) {
            continue;
        }
        let stem = |drop: usize| v[..n - drop].iter().collect::<String>();
        // يفعلون → يفعلوا ; تفعلين → تفعلي ; يفعلان → يفعلا. Short words are left alone: they're
        // usually verbs whose root ends in و or ي (يكون, تبين), not plural endings.
        let fix = if n >= 5 && verb.bare.ends_with("ون") {
            Some(stem(2) + "وا")
        } else if n >= 6 && verb.bare.ends_with("ين") {
            Some(stem(1))
        } else if n >= 6 && verb.bare.ends_with("ان") {
            Some(stem(1))
        } else {
            None
        };
        if let Some(fix) = fix {
            if dict.check(&verb.bare) && dict.check(&fix) {
                out.push(problem(verb.from, verb.to, fix, why));
            }
        }
    }
}

/// سوف لن → لن
fn sawfa_lan(chars: &[char], ws: &[Word], out: &mut Vec<Problem>) {
    for pair in ws.windows(2) {
        if matches!(pair[0].bare.as_str(), "سوف" | "وسوف" | "فسوف") && pair[1].bare == "لن" && adjacent(chars, &pair[0], &pair[1]) {
            let fix = if pair[0].bare == "سوف" { "لن".to_string() } else { pair[0].bare.trim_end_matches("سوف").to_string() + "لن" };
            out.push(problem(pair[0].from, pair[1].to, fix, "«سوف» للمستقبل و«لن» تنفي المستقبل وحدها، فيُكتفى بـ«لن»."));
        }
    }
}

/// The same word twice in a row. Only for small function words (عن عن، إلى إلى) and definite
/// words (العالم العالم): other repeats are often meant, as in names (بطرس بطرس غالي، محمد محمد),
/// numbers (ألف ألف, a million), accusative adverbs (رويدًا رويدًا) and spelled-out abbreviations
/// (إن إن دي بي). Two words both starting with و are a list ("والأعاصير والأعاصير المضادة").
fn repeated_word(chars: &[char], ws: &[Word], out: &mut Vec<Problem>) {
    const FUNCTION_WORDS: [&str; 30] = [
        "في", "من", "إلى", "على", "عن", "مع", "أن", "إن", "قد", "لم", "لن", "هذا", "هذه", "ذلك", "تلك", "كان", "هو", "هي",
        "كل", "بين", "حتى", "ثم", "أو", "كما", "بعد", "قبل", "عند", "لكن", "بل", "التي",
    ];
    let short = |w: Option<&Word>| w.is_some_and(|w| w.bare.chars().count() <= 2);
    for (i, pair) in ws.windows(2).enumerate() {
        let (a, b) = (&pair[0], &pair[1]);
        let definite = ["ال", "وال", "فال", "بال", "كال"].iter().any(|p| a.bare.starts_with(p)) && a.bare.chars().count() > 3;
        if a.bare != b.bare || !(definite || FUNCTION_WORDS.contains(&a.bare.as_str())) || a.bare.starts_with('و') {
            continue;
        }
        if short(Some(a)) && (short(ws.get(i + 2)) || (i > 0 && short(ws.get(i - 1)))) {
            continue;
        }
        if adjacent(chars, a, b) {
            let typed: String = chars[a.from..a.to].iter().collect();
            out.push(problem(a.from, b.to, typed, "كلمة مكررة."));
        }
    }
}

fn arabic_before(chars: &[char], mut i: usize) -> bool {
    while i > 0 && is_mark(chars[i - 1]) {
        i -= 1;
    }
    i > 0 && is_arabic_letter(chars[i - 1])
}

/// The next character that isn't a space, from i on.
fn next_visible(chars: &[char], i: usize) -> Option<char> {
    chars[i..].iter().copied().find(|c| *c != ' ')
}

/// Arabic punctuation: no space before ، ؛ ؟ ! . ; a space after ، and ؛ ; Arabic marks
/// instead of Latin ? , ; between Arabic words.
fn punctuation(chars: &[char], out: &mut Vec<Problem>) {
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // Spaces before a mark that should hug the word before it.
        if c == ' ' && arabic_before(chars, i) {
            let start = i;
            while i < chars.len() && chars[i] == ' ' {
                i += 1;
            }
            if let Some(&mark) = chars.get(i) {
                let ends_clause = chars.get(i + 1).is_none_or(|n| *n == ' ' || is_arabic_letter(*n));
                if matches!(mark, '،' | '؛' | '؟' | '!' | '.') && ends_clause && !(mark == '.' && chars.get(i + 1) == Some(&'.')) {
                    out.push(problem(start, i + 1, mark.to_string(), "لا تُترك مسافة قبل علامة الترقيم، بل بعدها."));
                }
            }
            continue;
        }
        if arabic_before(chars, i) {
            match c {
                // ، or ؛ glued to the next word: مرحبا،كيف
                '،' | '؛' if chars.get(i + 1).is_some_and(|n| is_arabic_letter(*n)) => {
                    out.push(problem(i, i + 1, format!("{c} "), "تُترك مسافة بعد الفاصلة."));
                }
                '?' => out.push(problem(i, i + 1, "؟", "علامة الاستفهام في النص العربي: «؟»")),
                ',' | ';' if next_visible(chars, i + 1).is_some_and(is_arabic_letter) => {
                    let (fix, name) = if c == ',' { ("،", "الفاصلة") } else { ("؛", "الفاصلة المنقوطة") };
                    out.push(problem(i, i + 1, fix, &format!("{name} في النص العربي: «{fix}»")));
                }
                _ => {}
            }
        }
        i += 1;
    }
}

/// إنشاء الله (meaning "building God") → إن شاء الله
fn insha_allah(chars: &[char], ws: &[Word], out: &mut Vec<Problem>) {
    for pair in ws.windows(2) {
        if matches!(pair[0].bare.as_str(), "إنشاء" | "انشاء") && pair[1].bare == "الله" && adjacent(chars, &pair[0], &pair[1]) {
            out.push(problem(pair[0].from, pair[1].to, "إن شاء الله", "«إن شاء الله» ثلاث كلمات: «إنْ» الشرطية و«شاء» و«الله». أما «إنشاء» فمعناها البناء."));
        }
    }
}

/// After القول comes إنّ, not أنّ: قال أنه → قال إنه.
fn qala_inna(chars: &[char], ws: &[Word], out: &mut Vec<Problem>) {
    const SAY: [&str; 16] = ["قال", "قالت", "قالوا", "قلت", "قلنا", "وقال", "فقال", "وقالت", "فقالت", "وقالوا", "يقول", "تقول", "أقول", "نقول", "ويقول", "يقولون"];
    const ANNA: [&str; 8] = ["أن", "أنه", "أنها", "أنهم", "أنهن", "أننا", "أني", "أنك"];
    for pair in ws.windows(2) {
        let (say, anna) = (&pair[0], &pair[1]);
        if SAY.contains(&say.bare.as_str()) && ANNA.contains(&anna.bare.as_str()) && adjacent(chars, say, anna) {
            let fix: String = std::iter::once('إ').chain(chars[anna.from + 1..anna.to].iter().copied()).collect();
            out.push(problem(anna.from, anna.to, fix, "بعد القول تُكسر همزة «إنّ»: «قال إنّ…»."));
        }
    }
}

/// A sound masculine plural in ون after إنّ and its sisters or after a preposition, where it
/// must end in ين: إن المعلمون → إن المعلمين، على المهندسون → على المهندسين.
/// Guarded four ways: the word must not be listed in the dictionary as a word of its own (sound
/// plurals never are; singulars and broken plurals ending in ون are: زيتون، قانون، فنون، عيون);
/// the singular must have at least three letters; and both the singular and the fix must be
/// dictionary words. «من» is left out: it can mean "who" (من المسؤولون؟).
fn plural_after_particle(chars: &[char], ws: &[Word], dict: &Dictionary, listed: &HashSet<String>, out: &mut Vec<Problem>) {
    const INNA: [&str; 12] = ["إن", "أن", "لكن", "ليت", "لعل", "كأن", "وإن", "فإن", "ولكن", "لأن", "بأن", "وأن"];
    const JARR: [&str; 20] = [
        "في", "على", "إلى", "عن", "وفي", "وعلى", "وإلى", "وعن", "بين", "لدى", "عند", "مع", "حول", "نحو", "ضد", "دون", "خلال", "ضمن", "عبر", "لدي",
    ];
    for pair in ws.windows(2) {
        let (particle, noun) = (&pair[0], &pair[1]);
        let why = if INNA.contains(&particle.bare.as_str()) {
            "اسم «إنّ» وأخواتها منصوب، وجمع المذكر السالم يُنصب بالياء: «إنّ المعلمين»."
        } else if JARR.contains(&particle.bare.as_str()) {
            "الاسم بعد حرف الجر مجرور، وجمع المذكر السالم يُجر بالياء: «على المعلمين»."
        } else {
            continue;
        };
        if !adjacent(chars, particle, noun) || !noun.bare.starts_with("ال") || !noun.bare.ends_with("ون") {
            continue;
        }
        let letters: Vec<char> = noun.bare.chars().collect();
        let without_al: String = letters[2..].iter().collect();
        let singular: String = letters[2..letters.len() - 2].iter().collect();
        if listed.contains(&without_al) || singular.chars().count() < 3 {
            continue;
        }
        let fix: String = letters[..letters.len() - 2].iter().collect::<String>() + "ين";
        if dict.check(&noun.bare) && dict.check(&singular) && dict.check(&fix) {
            out.push(problem(noun.from, noun.to, fix, why));
        }
    }
}

/// Words ending in ون that the dictionary lists as entries of their own (from ar.dic), for
/// telling a singular like زيتون from a sound plural like معلمون.
pub fn listed_on_words(dic: &str) -> HashSet<String> {
    dic.lines()
        .map(|line| line.split('/').next().unwrap_or("").trim())
        .filter(|w| w.ends_with("ون"))
        .map(String::from)
        .collect()
}

/// هذا before a feminine noun: هذا المدرسة → هذه المدرسة. Only for definite nouns ending in ة
/// right after هذا (so «في هذا إشارة», where هذا points back, is left alone), and not for the
/// men's titles that end in ة.
fn hadha_feminine(chars: &[char], ws: &[Word], out: &mut Vec<Problem>) {
    const MEN: [&str; 8] = ["الخليفة", "العلامة", "الداعية", "الرحالة", "الراوية", "النابغة", "الفهامة", "الطاغية"];
    for pair in ws.windows(2) {
        let (this, noun) = (&pair[0], &pair[1]);
        if !matches!(this.bare.as_str(), "هذا" | "وهذا" | "فهذا" | "بهذا" | "لهذا" | "كهذا") || !adjacent(chars, this, noun) {
            continue;
        }
        if noun.bare.starts_with("ال") && noun.bare.ends_with('ة') && noun.bare.chars().count() > 4 && !MEN.contains(&noun.bare.as_str()) {
            let fix = this.bare.trim_end_matches("هذا").to_string() + "هذه";
            out.push(problem(this.from, this.to, fix, "اسم الإشارة للمؤنث «هذه»: «هذه المدرسة»."));
        }
    }
}

/// All rule findings in a paragraph, as character offsets.
pub fn check(text: &str, dict: &Dictionary, listed: &HashSet<String>) -> Vec<Problem> {
    let chars: Vec<char> = text.chars().collect();
    if !chars.iter().any(|c| is_arabic_letter(*c)) {
        return vec![];
    }
    let ws = words(&chars);
    let mut out = Vec::new();
    jussive_and_subjunctive(&chars, &ws, dict, &mut out);
    sawfa_lan(&chars, &ws, &mut out);
    repeated_word(&chars, &ws, &mut out);
    punctuation(&chars, &mut out);
    insha_allah(&chars, &ws, &mut out);
    qala_inna(&chars, &ws, &mut out);
    plural_after_particle(&chars, &ws, dict, listed, &mut out);
    hadha_feminine(&chars, &ws, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Arabic {
        dict: Dictionary,
        listed: HashSet<String>,
    }

    fn dict() -> Arabic {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dictionaries");
        let read = |f: &str| std::fs::read_to_string(dir.join(f)).unwrap();
        let dic = read("ar.dic");
        Arabic { dict: Dictionary::new(&read("ar.aff"), &dic).unwrap(), listed: listed_on_words(&dic) }
    }

    fn flagged(d: &Arabic, text: &str) -> Vec<(String, String)> {
        let chars: Vec<char> = text.chars().collect();
        check(text, &d.dict, &d.listed).into_iter().map(|p| (chars[p.from..p.to].iter().collect(), p.replacements[0].clone())).collect()
    }

    fn one(d: &Arabic, text: &str, bad: &str, fix: &str) {
        let found = flagged(d, text);
        assert!(found.iter().any(|(b, f)| b == bad && f == fix), "{text}: {found:?}");
    }

    #[test]
    fn catches_its_mistakes() {
        let d = dict();
        one(&d, "لم يذهبون إلى العمل أمس.", "يذهبون", "يذهبوا");
        one(&d, "لن يحضرون الاجتماع غدا.", "يحضرون", "يحضروا");
        one(&d, "سوف لن أذهب إلى الحفلة.", "سوف لن", "لن");
        one(&d, "ذهبت إلى إلى المدرسة.", "إلى إلى", "إلى");
        one(&d, "مرحبا ، كيف حالك ؟", " ،", "،");
        one(&d, "مرحبا ، كيف حالك ؟", " ؟", "؟");
        one(&d, "مرحبا،كيف حالك", "،", "، ");
        one(&d, "كيف حالك?", "?", "؟");
        one(&d, "ذهبت إلى السوق, واشتريت خبزا", ",", "،");
        one(&d, "إنشاء الله سنلتقي غدا.", "إنشاء الله", "إن شاء الله");
        one(&d, "قال أن الامتحان صعب.", "أن", "إن");
        one(&d, "قالت أنها ستأتي.", "أنها", "إنها");
        one(&d, "إن المعلمون مجتهدون في عملهم.", "المعلمون", "المعلمين");
        one(&d, "سلمت على المعلمون في الصباح.", "المعلمون", "المعلمين");
        one(&d, "تحدثت مع المهندسون عن المشروع.", "المهندسون", "المهندسين");
        one(&d, "هذا المدرسة كبيرة جدا.", "هذا", "هذه");
        one(&d, "ذهبت إلى هذا الجامعة.", "هذا", "هذه");
    }

    #[test]
    fn leaves_correct_text_alone() {
        let d = dict();
        for text in [
            "لم يكن الجو باردا، ولن يكون.",
            "لم يذهبوا إلى العمل، ولن يحضروا غدا.",
            "سار رويدا رويدا حتى وصل.",
            "انظر موقع إن إن دي بي للتفاصيل.",
            "بدأ بطرس بطرس غالي عمله، ومبلغها مئة ألف ألف فلس.",
            "مثل الرياح والأعاصير والأعاصير المضادة.",
            "وفي هذا إشارة إلى مكانته، وهذا الخليفة عادل، وهذه المدرسة كبيرة.",
            "لا لا، لم أقصد ذلك.",
            "قال إن الامتحان صعب.",
            "يجب أن يذهب الطلاب إلى المدرسة.",
            "كتب 3.5 كيلوغرام، ثم ذهب.",
            "الطالب مجتهد، والمعلم كذلك؛ أليس كذلك؟ نعم!",
            "Hello, world? This is fine.",
            // Singular nouns and broken plurals that end in ون.
            "اشتريت الزيت وجلست على الزيتون وفي الليمون فائدة.",
            "تحدث عن المجنون وعن القانون وفي المضمون وإلى الصابون.",
            "نظرت إلى العيون وفي الفنون وعلى الحصون وفي القرون الوسطى.",
            "من المسؤولون عن هذا؟",
            "إن المعلمين مجتهدون، وسلمت على المهندسين.",
        ] {
            assert!(flagged(&d, text).is_empty(), "{text}: {:?}", flagged(&d, text));
        }
    }

    /// The gate: no false alarms on clean Arabic. Needs the corpus (Arabic Wikipedia text, not in
    /// the repo; see research/arabic-rules.md): QALAM_TEST_ARABIC_CORPUS=<file> cargo test --release
    /// clean_corpus -- --nocapture. Wikipedia has real mistakes of its own; each finding below was
    /// checked by hand (the flagged text, and a few words around it), and anything else fails.
    const REVIEWED: &[(&str, &str)] = &[
        // Tuning set: 4 articles, 31,828 words.
        (" .", "كأداة للتعريف ."),
        ("أن", "يقولون أن من وضعه"),
        ("أنه", "يقولون أنه ابن عاصم"),
        (" .", "العربية الفصحى ."),
        ("الصالات الصالات", "الصالات الصالات"),
        ("عن عن", "المقريزي عن عن"),
        (" ؛", "مكترث ؛"),
        // Unseen set: 20 articles, 96,496 words.
        (" .", "في إنجلترا ."),
        ("أن", "عندما نقول أن"),
        (" ،", "تاريخ البشرية ،"),
        (" ،", "استكشافية مصرية ،"),
        ("أنه", "وقال أنه لا"),
        ("أن", "الذي قال أن بريطانيا"),
        (" ،", "منتصف الأطلسي ،"),
        ("العالم العالم", "انحاء العالم العالم"),
        ("،", "قرب دمشق،أع"),
        ("الشارع الشارع", "وينصّفها الشارع الشارع"),
        (" ؛", "دمشق ؛ الأسطورة"),
        (" ،", "والعدد لإقليدس ،"),
        ("أنها", "فقال أنها"),
        (" ،", "إلى بانيها ،"),
        (" .", "من النهر ."),
        ("العراقيون", "لدى العراقيون"),
        (" .", "ونادي المنصور ."),
    ];

    #[test]
    fn clean_corpus() {
        let Ok(path) = std::env::var("QALAM_TEST_ARABIC_CORPUS") else { return };
        let d = dict();
        let text = std::fs::read_to_string(path).unwrap();
        let mut found = Vec::new();
        for paragraph in text.lines() {
            let chars: Vec<char> = paragraph.chars().collect();
            for p in check(paragraph, &d.dict, &d.listed) {
                let ctx: String = chars[p.from.saturating_sub(25)..(p.to + 20).min(chars.len())].iter().collect();
                let bad: String = chars[p.from..p.to].iter().collect();
                let reviewed = REVIEWED.iter().any(|(b, around)| *b == bad && ctx.contains(around));
                println!("{} «{bad}» → {:?}   …{ctx}…", if reviewed { "ok  " } else { "FLAG" }, p.replacements);
                if !reviewed {
                    found.push(bad);
                }
            }
        }
        println!("{} words, {} unreviewed flags", text.split_whitespace().count(), found.len());
        assert!(found.is_empty(), "flags not reviewed: {found:?}");
    }
}
