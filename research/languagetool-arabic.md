# LanguageTool for Arabic grammar: tested, not bundled

**Tested:** 2026-10-22, LanguageTool 6.6 (stable) as a local server on a Java 21 runtime. Only this computer
talked to it. Question: would bundling it (as an optional "deep check" download) make Qalam's Arabic better?

**Answer: no, not as a whole.** It catches some real mistakes, but on clean, professionally written Arabic it flags something
every ~16 words, and most of those flags are wrong or are old-fashioned purist preferences. Shipping that would teach writers to
ignore Qalam's underlines. A handful of its *ideas* are worth writing as Qalam's own rules, held to a strict false-alarm test.

## Costs (size is not the issue)

| | |
| --- | --- |
| Download | LanguageTool 392 MB + Java runtime 159 MB |
| Memory | 225 MB at start, **618 MB** after checking 32k words |
| Speed | ~70 ms per sentence (fine in the background) |
| Licence | LGPL-2.1 (fine as a separate program) |

## Test 1: 30 sentences with typical mistakes

**About 10 of 25 grammar mistakes caught for the right reason:**

| Caught ✓ | Missed ✗ |
| --- | --- |
| هذا المدرسة → هذه · إن المعلمون → المعلمين · على المعلمون → المعلمين · لم يذهبون → لم يذهبوا · سوف لن → لن · إلى إلى (repeated word) · space before ، and ؟ · Latin ? → ؟ · المرأة الذي → التي · إنشاء الله → إن شاء الله | Subject–verb agreement (الطلاب ذهب, البنات يلعبون, الطالبان يدرسون) · adjective gender (البنت الجميل, الطالبات المجتهدين) · كان / أصبح predicate (كان الجو جميل) · لن يحضرون · numbers (ثلاث طلاب, خمس كتب) · قال أن → قال إنّ · رأيت رجلا ذو علم · الرجل الذين · رأيت المهندسون |

Wrong reasons and nonsense, from the same run:
- **«اشتريت خمسة كتب»** (correct) is flagged: a rule reads the ك of كتب as "like" and suggests «خمسة تب».
- **«سلمت على أبو محمد»** is flagged by a plural rule with the fix «على (أبو)».
- Every word ending in ا gets a "please add tanween" style note (صباحا → صباحًا).

## Test 2: clean Arabic (Arabic Wikipedia, 4 articles, 31,828 words)

**2,024 flags, one every 16 words.** By rule:

| Rule (what it does) | Flags on clean text | Verdict |
| --- | --- | --- |
| Hunspell spelling | 657 | Qalam already does spelling, with better suggestions |
| "Add tanween" style note | 476 | Taste, not a mistake |
| Purist word lists (AR_SIMPLE_REPLACE, homophones) | 182 | Mostly preferences: اعتبر → عدّ, حول → في, الفترة → المدة, كما أن → ثم أن, مضر → «مظر» |
| "ك means like" (syntax_0002_as_ka) | 65 | Broken |
| الذي / التي agreement (gender_0010/0011) | 34 | Mostly wrong: «وهي التي» → «وهي الذي» |
| Plural after a preposition (jar_plural) | 15 | Fires on numbers and broken plurals: «في القرون» → «في القرات» |
| **لم + يفعلون → يفعلوا** (jazem_lm) | **0** | ✅ precise |
| **سوف لن → لن** | **0** | ✅ precise |
| **Repeated word** | 10 | ✅ the 5 inspected were all headings run into the text by the Wikipedia export, not real false alarms |
| **Space before ، ؛ ؟** | 4 | ✅ nearly precise |
| هذا + feminine noun (gender_0001_hadha) | 1 | Good, but «وفي هذا إشارة» (correct) was flagged |
| إنّ + plural in و (nawasikh_plural) | 2 | Fires on numbers and names: «أن ستة» → «أن (ستة)» |

## Decision

1. **Don't bundle LanguageTool.** Its Arabic precision is too low, and the size wasn't the reason.
2. **Write Qalam's own Arabic grammar rules, one at a time, each with a gate:** it must catch its mistakes in the test sentences and
   make **zero** flags on the 31,828-word clean set before it ships. First candidates, taken from what worked above and from basic grammar:
   - لم / لن + a present verb ending in ون → drop the ن (لم يذهبون → لم يذهبوا, لن يحضرون → لن يحضروا)
   - سوف لن → لن
   - repeated word (two identical words in a row, except intentional pairs like «رويدًا رويدًا»)
   - space before ، ؛ ؟ ! and Latin punctuation (? ; ,) inside Arabic text
   - إن شاء الله written as «إنشاء الله»
3. **For deep Arabic grammar** (agreement, كان and إنّ, numbers), which no open tool does well, the realistic route is
   **Claude, opt-in**: the writer asks for a check of a paragraph and gets a preview to accept, as تشكيل already works. Every
   suggestion still goes through the same "letters only change where intended" safety checks.

The test files (30 sentences with expected flags, the Wikipedia text) are kept in `~/rea-targets/lt/test` to use as the gate
for Qalam's own rules.
