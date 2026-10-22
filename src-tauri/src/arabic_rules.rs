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

/// كان and its sisters, a definite subject, then a one-word indefinite predicate that ends the
/// clause without the accusative alif: كان الجو جميل. → جميلًا.
///
/// Without حركات the accusative usually shows only as that alif, so this is the one place it can
/// be checked. Kept narrow on purpose: the predicate must end the clause or be followed by an
/// adverb or a separate preposition (any other word after it may be a possessive, «كان القرار
/// قرار الحكومة», where no alif is right), it must not look like a verb,
/// a dual or plural, a word that never takes the alif (أكبر، عطشان، words ending in ة ء ى),
/// a preposition with a pronoun (لهم → «لهما» is a word, but not this one) or an adverb, and
/// the fix must be a dictionary word. ظل is left out: it's also a noun («في ظل الخلافة»).
fn kana_predicate(chars: &[char], ws: &[Word], dict: &Dictionary, out: &mut Vec<Problem>) {
    const KANA: [&str; 13] = ["كان", "كانت", "أصبح", "أصبحت", "ليس", "ليست", "صار", "صارت", "بات", "باتت", "أمسى", "أضحى", "ظلت"];
    // Words after the predicate that show it's complete: adverbs, and separate prepositions (a
    // possessive can't start with one, so «مجتهد في دروسه» is a whole predicate).
    const STILL_ENDS_CLAUSE: [&str; 16] = [
        "جدا", "للغاية", "أيضا", "تماما", "دائما", "حقا", "فعلا", "كثيرا", "في", "على", "من", "إلى", "عن", "مع", "منذ", "حتى",
    ];
    const NOT_PREDICATES: [&str; 22] = [
        "بعد", "قبل", "فوق", "تحت", "عند", "هناك", "هنا", "حيث", "أين", "كيف", "متى", "منذ", "حول", "خلال", "دون", "ضد", "مع",
        "لدى", "نحو", "بين", "كذلك", "ذلك",
    ];
    const PRONOUNS: [&str; 11] = ["ه", "ها", "هم", "هما", "هن", "ك", "كم", "كما", "كن", "نا", "ي"];
    const PREPOSITIONS: [&str; 10] = ["ل", "ب", "ك", "عن", "من", "في", "على", "إلي", "مع", "عند"];
    for (i, triple) in ws.windows(3).enumerate() {
        let (kana, subject, predicate) = (&triple[0], &triple[1], &triple[2]);
        let k = kana.bare.strip_prefix('و').or_else(|| kana.bare.strip_prefix('ف')).unwrap_or(&kana.bare);
        if !KANA.contains(&k) && !KANA.contains(&kana.bare.as_str()) {
            continue;
        }
        if !subject.bare.starts_with("ال") || !adjacent(chars, kana, subject) || !adjacent(chars, subject, predicate) {
            continue;
        }
        let x = predicate.bare.as_str();
        let n = x.chars().count();
        let looks_wrong_kind = n < 3
            || ["ال", "وال", "فال", "بال", "كال", "لل"].iter().any(|p| x.starts_with(p))
            || x.starts_with(['ي', 'ت', 'ن', 'أ', 'إ', 'آ'])
            || ["سي", "ست", "سن", "سأ"].iter().any(|p| x.starts_with(p))
            || x.ends_with(['ة', 'ء', 'ى', 'ا', 'ي', 'ئ'])
            || ["ان", "ون", "ين", "ات"].iter().any(|e| x.ends_with(e))
            || NOT_PREDICATES.contains(&x)
            || PREPOSITIONS.iter().any(|p| x.strip_prefix(p).is_some_and(|rest| PRONOUNS.contains(&rest)));
        if looks_wrong_kind {
            continue;
        }
        // The clause must end here: punctuation, the end, or an adverb like «جدا».
        let after = chars[predicate.to..].iter().find(|c| **c != ' ');
        let ends = match after {
            None => true,
            Some(c) if matches!(c, '.' | '،' | '؛' | '؟' | '!' | ':' | '\n') => true,
            _ => ws.get(i + 3).is_some_and(|w| adjacent(chars, predicate, w) && STILL_ENDS_CLAUSE.contains(&w.bare.as_str())),
        };
        let with_alif = x.to_string() + "ا";
        if ends && dict.check(x) && dict.check(&with_alif) {
            out.push(problem(
                predicate.from,
                predicate.to,
                x.to_string() + "\u{064B}ا",
                "خبر «كان» وأخواتها منصوب، فيُكتب بتنوين الفتح وألف: «كان الجو جميلًا».",
            ));
        }
    }
}

/// و written on its own: «و الكتاب» → «والكتاب». The conjunction is always joined to the next
/// word. Left alone before single letters, digits and brackets («و ز», «و (2)»), as in maths
/// and lists.
fn detached_waw(chars: &[char], ws: &[Word], out: &mut Vec<Problem>) {
    for pair in ws.windows(2) {
        let (waw, next) = (&pair[0], &pair[1]);
        if waw.bare == "و" && next.bare.chars().count() >= 2 && adjacent(chars, waw, next) {
            let joined: String = std::iter::once('و').chain(chars[next.from..next.to].iter().copied()).collect();
            out.push(problem(waw.from, next.to, joined, "واو العطف تُكتب متصلة بالكلمة التي بعدها: «والكتاب»."));
        }
    }
}

/// Numbers 3–10 take the opposite gender to the noun's singular: ثلاث سيارات (سيارة is feminine),
/// ثلاثة كتب. Only the case Qalam can be sure of is checked: a number ending in ة before a common
/// plural whose singular is feminine (أربعة سنوات → أربع سنوات). Many masculine nouns also have
/// plurals in ات (اجتماعات، مجلدات، مستشفيات), so the plurals are a list, not a pattern.
fn number_gender(chars: &[char], ws: &[Word], out: &mut Vec<Problem>) {
    const NUMBERS: [(&str, &str); 8] = [
        ("ثلاثة", "ثلاث"), ("أربعة", "أربع"), ("خمسة", "خمس"), ("ستة", "ست"),
        ("سبعة", "سبع"), ("ثمانية", "ثماني"), ("تسعة", "تسع"), ("عشرة", "عشر"),
    ];
    const FEMININE_PLURALS: [&str; 44] = [
        "سنوات", "ساعات", "مرات", "سيارات", "شركات", "جامعات", "ولايات", "كلمات", "صفحات", "لغات", "دورات", "مباريات",
        "محاولات", "حالات", "طائرات", "دراسات", "مقالات", "روايات", "شخصيات", "مؤسسات", "منظمات", "جمعيات", "مسابقات",
        "بطولات", "عمليات", "فترات", "خطوات", "حلقات", "طبعات", "مقاطعات", "محافظات", "بلديات", "مجموعات", "فئات",
        "طبقات", "إجابات", "دقات", "قصائد", "رحلات", "زيارات", "سفارات", "وزارات", "مدارس", "دوريات",
    ];
    for pair in ws.windows(2) {
        let (number, noun) = (&pair[0], &pair[1]);
        let (prefix, bare) = match number.bare.strip_prefix('و').or_else(|| number.bare.strip_prefix('ب')).or_else(|| number.bare.strip_prefix('ل')) {
            Some(rest) if NUMBERS.iter().any(|(n, _)| *n == rest) => (&number.bare[..number.bare.len() - rest.len()], rest),
            _ => ("", number.bare.as_str()),
        };
        let Some((_, plain)) = NUMBERS.iter().find(|(n, _)| *n == bare) else { continue };
        if adjacent(chars, number, noun) && FEMININE_PLURALS.contains(&noun.bare.as_str()) {
            out.push(problem(
                number.from,
                number.to,
                format!("{prefix}{plain}"),
                "العدد من ثلاثة إلى عشرة يخالف المعدود في التذكير والتأنيث؛ ومفرد هذا المعدود مؤنث، فيُذكَّر العدد: «ثلاث سنوات».",
            ));
        }
    }
}

/// ذو and أبو change with the case: ذا / أبا after an accusative, ذي / أبي after a preposition.
/// Checked where the case is visible: «سلاحا ذو حدين» (an accusative noun ending in ا) → ذا, and
/// «على أبو محمد» / «على رجل ذو علم» (a separate preposition) → أبي / ذي. Pronoun endings that
/// end in ا (ابنهما، بيتها، كتابنا) aren't accusatives, and «أبو ظبي» is a place name.
fn five_nouns(chars: &[char], ws: &[Word], out: &mut Vec<Problem>) {
    const PREPOSITIONS: [&str; 9] = ["في", "على", "إلى", "عن", "مع", "من", "حتى", "عند", "لدى"];
    for (i, w) in ws.iter().enumerate() {
        if w.bare != "ذو" && w.bare != "أبو" {
            continue;
        }
        let Some(prev) = i.checked_sub(1).map(|j| &ws[j]) else { continue };
        if !adjacent(chars, prev, w) || ws.get(i + 1).is_some_and(|n| n.bare == "ظبي") {
            continue;
        }
        let stem = &w.bare[..w.bare.len() - 'و'.len_utf8()];
        // A separate preposition right before: genitive.
        if PREPOSITIONS.contains(&prev.bare.as_str()) {
            out.push(problem(w.from, w.to, format!("{stem}ي"), "بعد حرف الجر تأتي «أبي» و«ذي» مجرورتين بالياء: «على أبي محمد»."));
            continue;
        }
        // «ذو» after an indefinite accusative noun (…ًا) that it describes: «سلاحًا ذا حدين».
        let accusative = prev.bare.ends_with('ا')
            && prev.bare.chars().count() >= 4
            && !["ها", "نا", "هما", "كما"].iter().any(|p| prev.bare.ends_with(p))
            && !prev.bare.starts_with("ال");
        if w.bare == "ذو" && accusative {
            out.push(problem(w.from, w.to, "ذا", "«ذو» تتبع ما قبلها في الإعراب؛ فبعد اسم منصوب تأتي «ذا»: «سلاحًا ذا حدين»."));
        }
    }
}

/// Spaces just inside brackets around Arabic text: «( كلمة )» → «(كلمة)».
fn bracket_spaces(chars: &[char], out: &mut Vec<Problem>) {
    for i in 0..chars.len() {
        match chars[i] {
            '(' | '«' | '[' if chars.get(i + 1) == Some(&' ') => {
                let mut j = i + 1;
                while chars.get(j) == Some(&' ') {
                    j += 1;
                }
                if chars.get(j).is_some_and(|c| is_arabic_letter(*c)) {
                    out.push(problem(i, j, chars[i].to_string(), "لا تُترك مسافة بعد القوس الافتتاحي."));
                }
            }
            ')' | '»' | ']' if i > 0 && chars[i - 1] == ' ' => {
                let mut j = i;
                while j > 0 && chars[j - 1] == ' ' {
                    j -= 1;
                }
                if arabic_before(chars, j) {
                    out.push(problem(j, i + 1, chars[i].to_string(), "لا تُترك مسافة قبل القوس الختامي."));
                }
            }
            _ => {}
        }
    }
}

/// A full stop between two Arabic words with no space after it: «اختيارها.ومن» → «اختيارها. ومن».
/// Not after a one-letter abbreviation (د. ق.م) and not in web addresses (فهرس.نت).
fn space_after_full_stop(chars: &[char], ws: &[Word], out: &mut Vec<Problem>) {
    const WEB: [&str; 6] = ["نت", "كوم", "أورغ", "اورغ", "إنفو", "نيوز"];
    for pair in ws.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        if b.from == a.to + 1 && chars[a.to] == '.' && a.bare.chars().count() >= 2 && !WEB.contains(&b.bare.as_str()) {
            out.push(problem(a.to, a.to + 1, ". ", "تُترك مسافة بعد النقطة."));
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
    kana_predicate(&chars, &ws, dict, &mut out);
    detached_waw(&chars, &ws, &mut out);
    number_gender(&chars, &ws, &mut out);
    five_nouns(&chars, &ws, &mut out);
    bracket_spaces(&chars, &mut out);
    space_after_full_stop(&chars, &ws, &mut out);
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
        one(&d, "كان الطعام لذيذ جدا.", "لذيذ", "لذيذًا");
        one(&d, "أصبح الطالب مجتهد في دروسه.", "مجتهد", "مجتهدًا");
        one(&d, "كان الجو جميل.", "جميل", "جميلًا");
        one(&d, "أصبح الوضع خطير جدا.", "خطير", "خطيرًا");
        one(&d, "ليس الأمر سهل، لكنه ممكن.", "سهل", "سهلًا");
        one(&d, "اشتريت الخبز و الحليب.", "و الحليب", "والحليب");
        one(&d, "عاش هناك أربعة سنوات.", "أربعة", "أربع");
        one(&d, "زرت خمسة جامعات وثلاثة شركات.", "خمسة", "خمس");
        one(&d, "زرت خمسة جامعات وثلاثة شركات.", "وثلاثة", "وثلاث");
        one(&d, "يعد سلاحا ذو حدين.", "ذو", "ذا");
        one(&d, "سلمت على أبو محمد.", "أبو", "أبي");
        one(&d, "تحدثت مع رجل من ذو الخبرة.", "ذو", "ذي");
        one(&d, "قرأت الكتاب ( الجديد ) أمس.", "( ", "(");
        one(&d, "قرأت الكتاب ( الجديد ) أمس.", " )", ")");
        one(&d, "انتهى الدرس.بدأ الامتحان.", ".", ". ");
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
            "كان الجو جميلا، وكان القرار قرار الحكومة، وكان الأمر كذلك.",
            "كان الفضل لهم. كان الحكم لله. كان الاجتماع بعد.",
            "كان الطالب يدرس. أصبح الولد أكبر. كانت الطالبات مجتهدات. كان الفائزون.",
            "في ظل الخلافة العباسية، وكان التحليل النصي.",
            "إذا كانت س و ص عددين، فإن و (2) صحيحة.",
            "عاش أربع سنوات، وفي ستة اتحادات وأربعة مجلدات وستة مستشفيات وثلاثة كتب.",
            "وابنهما ذو الخمسة أعوام، وسافر إلى أبو ظبي، وسلمت على أبي محمد.",
            "زرت موقع فهرس.نت، وولد سنة 50 ق.م، وقال د.أحمد.",
            "الكتاب (الجديد) و«القديم» [المرجع].",
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

    /// The gate: no false alarms on clean Arabic. Needs a test text (Arabic Wikipedia and Wikinews,
    /// not in the repo; see research/arabic-rules.md): QALAM_TEST_ARABIC_CORPUS=<file> cargo test
    /// --release clean_corpus -- --nocapture. The texts have real mistakes of their own; each one
    /// found was checked by hand and listed in tests/arabic-reviewed.tsv. Anything else fails.
    /// Real mistakes in the test texts, each checked by hand: flagged text, then a stretch of
    /// the text around it.
    fn reviewed() -> Vec<(String, String)> {
        include_str!("../tests/arabic-reviewed.tsv")
            .lines()
            .filter(|l| !l.starts_with('#'))
            .filter_map(|l| {
                let mut cols = l.split('\t');
                Some((cols.next()?.to_string(), cols.next()?.to_string()))
            })
            .collect()
    }

    #[test]
    fn clean_corpus() {
        let Ok(path) = std::env::var("QALAM_TEST_ARABIC_CORPUS") else { return };
        let d = dict();
        let text = std::fs::read_to_string(path).unwrap();
        let known = reviewed();
        let mut found = Vec::new();
        for paragraph in text.lines() {
            let chars: Vec<char> = paragraph.chars().collect();
            for p in check(paragraph, &d.dict, &d.listed) {
                let ctx: String = chars[p.from.saturating_sub(25)..(p.to + 20).min(chars.len())].iter().collect();
                let bad: String = chars[p.from..p.to].iter().collect();
                let reviewed = known.iter().any(|(b, around)| *b == bad && ctx.contains(around.as_str()));
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
