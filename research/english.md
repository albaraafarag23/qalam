# English for Qalam: grammar checker and British spelling, measured

**Studied:** 2026-10-22. Companion to [spellcheck.md](spellcheck.md).

## Recommendation (built on the `spellcheck` branch)

- **Spelling:** Hunspell (spellbook) with SCOWL 2026.02.25, **American (en_US) or British (en_GB-ise)**,
  chosen in Settings. Hunspell stays in charge of spelling in both languages, so the writer's own dictionary
  works the same everywhere.
- **Grammar:** **[Harper](https://github.com/Automattic/harper)** (Automattic, Apache-2.0), an offline grammar checker
  written in Rust, with its own spellcheck and its style opinions switched off.
- **Learner mistakes Harper misses:** a short list of our own (`dictionaries/en-learner.txt`), each with an explanation.

## Harper vs LanguageTool vs Grammarly

| | Harper | LanguageTool | Grammarly |
| --- | --- | --- | --- |
| Runs | inside Qalam (Rust library) | separate Java server | Grammarly's servers |
| Offline | yes | yes, if you run the server | no |
| Time per check | ~2–4 ms per paragraph (measured) | ~650 ms (Harper's comparison) | ~4 s (Harper's comparison) |
| Licence | Apache-2.0 | LGPL-2.1 | proprietary |
| Size added to Qalam | ~12.7 MB (without its thesaurus) | a Java runtime plus ~200 MB | n/a |
| English rules | hundreds, growing quickly | ~1,774 rule groups, plus statistical and AI rules | proprietary |
| Dialects | US, UK, Canadian, Australian, Indian | yes | yes |

LanguageTool has more rules (for example "There is many problems" and "I work here since 2002", which Harper
misses). But it needs a Java runtime next to the app, it's ~300× slower per check, and it's LGPL. Harper fits Qalam's
"small, offline, instant" design. LanguageTool's English rules stay useful as a **reference** for writing our own.

## Measurements (harper-core 2.13, release build)

**22 sentences with typical mistakes, including ones common for Arabic speakers. Harper caught 15:**

| Caught | Missed |
| --- | --- |
| He **go** → goes · **a** apple → an · **Their** going → They're · **could of** → could have · **Its** a nice day → It's · She **don't** → doesn't · **The the** → The · **egypt** → Egypt · **more taller** → taller · **Despite of** → Despite · **discuss about** → discuss · **Alot** → A lot · I **has** → have · teh, recieve, definately (spelling) | I **am agree** · **Your welcome** · There **is many** reasons · he will **came** · **explain me** · I am living here **since** 2015 |

Each catch comes with a plain-English explanation ("The form of the verb must agree in grammatical number with the pronoun.").

**False alarms on clean, formal English** (the GPL-3 licence text, 5,644 words, 208 sentences): 72 flags in total.
About 30 were style opinions ("this sentence is long"), which Qalam switches off. Most of the rest were legal or technical
words it didn't know ("Affero", "relicensing"). About 5 were real grammar false alarms. That's a good rate for very dense text.

**Mixed Arabic and English:** `انا اسمي البراء and I live in Dubai, عايش في الإمارات.` produced no false flags. Harper leaves
Arabic alone, so it can run on every paragraph that has Latin letters.

**Speed:** 23 sentences in 52 ms. 208 long legal sentences in 0.9 s (4.3 ms each). Building the rule set takes ~0.4 s once, done in
the background at start-up.

## What we built on top

- **Learner list (`en-learner.txt`)**, written for Qalam. It covers mistakes Harper misses that are common for Arabic speakers:
  "I **am agree**" → agree, "**explain me**" → explain to me, "**Your welcome**!" → You're welcome (only at the end of a clause, so
  "your welcome message" is left alone), "return back", "mention about", "emphasise on", "cope up with". Rules that are
  sometimes valid English ("explain them", "order for") were left out on purpose: a rule that's wrong some of the time
  costs more trust than it earns.
- **No double underlines.** If a word is misspelt, its grammar isn't judged until it's fixed (Harper's own spellcheck is off).
- **Opinions off.** Harper's Style, Readability, Enhancement and Formatting categories are dropped. Qalam only flags mistakes.

## British spelling

SCOWL publishes British dictionaries under the same permissive licence as the American one. `en_GB-ise` follows the
"-ise" spelling used by the UK press and government (organise, analyse), plus colour, centre, travelled, programme.
Tested: each dictionary accepts its own spellings and flags the other's, with the right suggestion first
(colour → color in American, color → colour in British). The choice also switches Harper to British grammar rules.
LibreOffice's en_GB was the other option, but it's LGPL, so SCOWL's was preferred.

## Ideas for later

- **Rules for Arabic speakers writing English.** LanguageTool has a rule file for German speakers writing English
  (`grammar-l2-de.xml`). An Arabic version, growing from `en-learner.txt`, would be unique to Qalam:
  e.g. "there is many", missing "the" or "a", "since" with the present tense.
- **Harper's rules can be extended** with its own pattern language ("weir"). Our learner list could move there once it grows.
