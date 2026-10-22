# Qalam's Arabic grammar rules: built and gated

**Built:** 2026-10-22, `src-tauri/src/arabic_rules.rs` (on the `spellcheck` branch). Follows from
[languagetool-arabic.md](languagetool-arabic.md): LanguageTool flags something every 16 words of clean Arabic, so
Qalam writes its own rules and holds each one to a gate.

## The gate

A rule ships only if:
1. it catches its mistakes in the test sentences, and
2. on **141,293 words of clean Arabic** **every flag is a real mistake**. The words come from three texts:
   - 31,828 words of Wikipedia used while writing the rules
   - 96,496 words from 20 Wikipedia articles the rules had never seen
   - 12,969 words of news from 60 random Arabic Wikinews articles, a less formal style

   These texts have real mistakes of their own. 90 have been found so far, each checked by hand and listed in
   `src-tauri/tests/arabic-reviewed.tsv`. Any other flag fails the test.

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
| كان and its sisters + a predicate without its alif *(round 2)* | كان الجو جميل. · أصبح الطالب مجتهد في دروسه | جميلًا · مجتهدًا | 37 positions judged (29 without alif, all rightly left alone; 8 correct with alif) |
| A detached و *(round 2)* | الخبز و الحليب | والحليب | n/a (found 5 real ones in Wikipedia) |
| Run-together phrases *(round 2, in the mistakes list)* | الحمدلله · انشالله · ماشاءالله · بإذنالله | الحمد لله · إن شاء الله · ما شاء الله · بإذن الله | n/a |
| Number 3–10 with ة before a feminine plural *(round 3)* | أربعة سنوات · خمسة جامعات | أربع · خمس | 13 "number with ة + ات" in the clean text: the masculine ones (اتحادات، مجلدات، مستشفيات) left alone; 6 real mistakes found |
| ذو / أبو in the wrong case *(round 3)* | سلاحا ذو حدين · على أبو محمد · من ذو الخبرة | ذا · أبي · ذي | the 4 correct «إلى أبي…» and «وابنهما ذو» left alone |
| Spaces inside brackets *(round 3)* | ( الجديد ) · « نص » | (الجديد) · «نص» | maths brackets left alone; 9 real ones found |
| No space after a full stop *(round 3)* | الدرس.بدأ | الدرس. بدأ | «فهرس.نت» and «ق.م» left alone; 12 real ones found |
| More run-together words *(round 3, mistakes list)* | الخ · مايلي · لايزال · لازال | إلخ · ما يلي · لا يزال · ما زال | n/a |

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
- **كان:** the accusative usually shows only as an alif when there are no حركات, so this is the one place it can be checked.
  The predicate must end the clause, or be followed by an adverb (جدا) or a separate preposition (في، على…). Any other word after
  it might start a possessive («كان القرار قرارَ الحكومة», correctly without alif). It must not look like a verb (ي ت ن أ, سي…),
  a dual or plural (ان ون ين ات), a word that never takes the alif (أكبر، عطشان، words ending in ة ء ى), an adverb (هنا، بعد،
  كذلك) or a preposition with a pronoun (لهم: «لهما» is a word, but the wrong one). The fix must be a dictionary word. ظل is
  left out because it's also a noun («في ظل الخلافة»). It misses «كان الجو جميل اليوم» on purpose, because «اليوم» can start a possessive.
- **Detached و:** only before a word of 2+ letters (not «و ز» or «و (2)» in maths and lists).
- **Numbers:** many masculine nouns have plurals in ات (اجتماعات، مجلدات، تعريفات، مستشفيات), and the dictionary can't tell
  gender: nearly every masculine form is a word too (جامع، دوري، شرك). So the rule only knows a list of 44 common plurals
  whose singular is clearly feminine (سنوات، ساعات، سيارات، شركات، جامعات، ولايات…), and only checks a number *with* ة before
  one. The opposite mistake (ثلاث طلاب) needs the gender of a broken plural's singular, which isn't available yet.
- **ذو / أبو:** after a separate preposition they're genitive (أبي، ذي). After a word ending in ا, ذو is accusative (ذا), but
  not after a pronoun ending (ابنهما، بيتها، كتابنا), and not with ال. «أبو ظبي» is a place name and is left alone.
- **Full stop:** only between two Arabic words, not after a one-letter abbreviation (د. ق.م), not before a web ending
  (نت، كوم).
- **Mistakes list:** only clear-cut cases. Widely accepted joined forms (مازال، لابد، مادام، لاسيما) are left alone.

## Results vs LanguageTool

| | LanguageTool 6.6 | Qalam (spelling + these rules) |
| --- | --- | --- |
| 30 mistake sentences | 14 right (about 10 for the right reason) | **18 right** after round 3, all for the right reason |
| False alarms on clean Arabic | ~1 every 16 words | **0 in 141,293 words** |
| Memory | 618 MB | a few MB, inside Qalam |
| Speed | ~70 ms per sentence | microseconds |

LanguageTool still finds a few things Qalam doesn't (the هذا rule was its idea). Qalam is precise. Those mistakes need
real grammatical analysis: agreement (الطلاب ذهب، البنت الجميل), كان and its sisters (كان الجو جميل), numbers (ثلاث طلاب),
objects (رأيت المهندسون), الذي/التي. They're the job for the opt-in Claude check.

## Tried and dropped
- **الذي after a feminine noun** (المرأة الذي → التي). In the clean text, all 19 cases of «ال…ة الذي» were correct, because
  الذي referred to an earlier word: «مؤتمر القاهرة الذي», «للأمم المتحدة الذي», even «من المهادنة الذي» right after a
  preposition. No guard tells these apart without real grammatical analysis, so this is left to the Claude check.

## Next rules worth trying (each through the same gate)
- **Numbers, the other direction** (ثلاث طلاب → ثلاثة): needs a list of broken plurals with their singular's gender.
- **Still missed in the test sentences:** agreement (الطلاب ذهب، البنات يلعبون، البنت الجميل، الطالبان يدرسون), objects (رأيت
  المهندسون), الذي/التي, «كان الجو جميل اليوم». They need real grammatical analysis, i.e. the opt-in Claude check.
