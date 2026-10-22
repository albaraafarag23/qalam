# Qalam's Arabic grammar rules: built and gated

**Built:** 2026-10-22, `src-tauri/src/arabic_rules.rs` (on the `spellcheck` branch). Follows from
[languagetool-arabic.md](languagetool-arabic.md): LanguageTool flags something every 16 words of clean Arabic, so
Qalam writes its own rules and holds each one to a gate.

## The gate

A rule ships only if:
1. it catches its mistakes in the test sentences, and
2. on **128,324 words of clean Arabic Wikipedia** (a 31,828-word set used while writing the rules, plus a 96,496-word set
   from 20 other articles the rules had never seen) **every flag is a real mistake**. Wikipedia has a few of its own (24
   found, each checked by hand and listed in the test); anything else fails the test.

Run it: `QALAM_TEST_ARABIC_CORPUS=<text file> cargo test --release clean_corpus -- --nocapture`. The corpus isn't in the repo
(Wikipedia text is CC BY-SA). It's kept in `~/rea-targets/lt/test/`.

## The rules

| Rule | Example | Fix | Correct uses in the clean text (all left alone) |
| --- | --- | --- | --- |
| لم / لن + present verb that kept its ن | لم يذهبون · لن يحضرون | يذهبوا · يحضروا | 239 |
| Sound plural in ون after إنّ and its sisters or a preposition | إن المعلمون · مع المهندسون | المعلمين · المهندسين | 41 |
| إنّ after a verb of saying | قال أن الامتحان صعب | قال إن | 14 |
| سوف لن | سوف لن أذهب | لن | (none in the text) |
| Repeated word (function words and definite words only) | إلى إلى · العالم العالم | إلى · العالم | n/a |
| Space before ، ؛ ؟ ! . | مرحبا ، كيف حالك ؟ | مرحبا، كيف حالك؟ | n/a |
| No space after ، ؛ | مرحبا،كيف | مرحبا، كيف | n/a |
| Latin ? , ; between Arabic words | كيف حالك? | كيف حالك؟ | n/a |
| إنشاء الله | إنشاء الله | إن شاء الله | n/a |
| هذا before a feminine noun | هذا المدرسة | هذه المدرسة | ⚠ **0**: correct text never has it, so the gate can't test this rule; its safety rests on hand-written exceptions |

Each fix comes with a short explanation in Arabic, written for Qalam.

### How the risky rules avoid false alarms
- **لم / لن:** the fix must be a dictionary word, so «لم يكن» and «لن يكون» are never "fixed" (يكوا isn't a word). Short words
  (يكون، تبين) are skipped: they end in و or ي because of their root, not a plural ending.
- **Plural after a particle.** Skips «من» (it can mean "who": من المسؤولون؟). Skips any word the dictionary lists as an entry of
  its own: sound plurals never are, while singulars and broken plurals ending in ون are (زيتون، قانون، مجنون، فنون، عيون). The
  singular must be a word of 3+ letters, and the fix a dictionary word.
- **Repeated word.** Only small function words (عن عن، في في) and words with ال. Other repeats are often meant: names
  (بطرس بطرس غالي), «ألف ألف» (a million), «رويدًا رويدًا», spelled-out abbreviations (إن إن دي بي), and lists where both
  words start with و (الأعاصير والأعاصير المضادة). This costs one real catch in the test text (an indefinite «طائرة طائرة»).
- **هذا:** only before a definite noun ending in ة, right after هذا (so «وفي هذا إشارة» is left alone). Men's titles ending in ة
  (الخليفة، العلامة، الداعية…) are excepted.

## Results vs LanguageTool

| | LanguageTool 6.6 | Qalam (spelling + these rules) |
| --- | --- | --- |
| 30 mistake sentences | 14 right (about 10 for the right reason) | 15 right (with هذا، all for the right reason) |
| False alarms on clean Arabic | ~1 every 16 words | **0 in 128,324 words** |
| Memory | 618 MB | a few MB, inside Qalam |
| Speed | ~70 ms per sentence | microseconds |

LanguageTool still finds a few things Qalam doesn't (the هذا rule was its idea). Qalam is precise. Those mistakes need
real grammatical analysis: agreement (الطلاب ذهب، البنت الجميل), كان and its sisters (كان الجو جميل), numbers (ثلاث طلاب),
objects (رأيت المهندسون), الذي/التي. They're the job for the opt-in Claude check.

## Next rules worth trying (each through the same gate)
- **كان / أصبح / ليس + an indefinite predicate without tanween** (كان الجو جميل → جميلًا). Needs care: the predicate is
  often a phrase, not one word.
- **Numbers 3–10 with a plural noun** (ثلاث طلاب → ثلاثة). Needs each noun's singular and its gender.
- **الذي / التي after a person noun** (المرأة الذي → التي). LanguageTool's version had 34 false alarms. It must skip
  possessive constructions (كتاب المدرسة الذي…).
