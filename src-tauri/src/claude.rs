//! Talking to Claude. The API key lives in the OS keyring (Secret Service on Linux,
//! Credential Manager on Windows) and is only ever read here, never sent to the page.

use serde::Deserialize;
use serde_json::{json, Value};

const KEYRING_SERVICE: &str = "dev.qalam.app";
const KEYRING_USER: &str = "anthropic-api-key";
const MODEL: &str = "claude-opus-5-5";

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_api_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("The key is empty.".into());
    }
    keyring_entry()?.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn has_api_key() -> bool {
    keyring_entry().and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok()
}

#[tauri::command]
pub fn clear_api_key() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

const FULL_INSTRUCTIONS: &str = "Add full Arabic diacritics (تشكيل كامل) to every paragraph: \
every letter gets its vowel, sukun or shadda, and word endings get the correct case ending \
(إعراب) for the sentence.";

const LIGHT_INSTRUCTIONS: &str = "Add light Arabic diacritics (تشكيل خفيف) to every paragraph, the \
way careful modern writers do: only the marks a reader needs to avoid misreading. That means \
shadda, tanween, case endings where the grammar would otherwise be ambiguous, and vowels that \
distinguish words written with the same letters (for example عَلِمَ / عُلِّمَ). Leave every \
other letter bare.";

const RULES: &str = "Rules:\n\
- Only add or change diacritics (U+064B to U+0652). Never add, remove or change a letter, \
space or punctuation mark, even to fix a spelling or a missing hamza: write انا as انا, not أنا.\n\
- Do not use superscript alef (ٰ) or tatweel (ـ).\n\
- Leave non-Arabic text exactly as it is.\n\
- Return the paragraphs in the same order and the same number as given.";

#[derive(Deserialize)]
struct Diacritized {
    paragraphs: Vec<String>,
}

/// Asks Claude to add diacritics to each paragraph. The caller checks that the letters
/// came back unchanged and applies only the marks.
#[tauri::command]
pub async fn diacritize(paragraphs: Vec<String>, mode: String) -> Result<Vec<String>, String> {
    let instructions = if mode == "light" { LIGHT_INSTRUCTIONS } else { FULL_INSTRUCTIONS };
    let input = serde_json::to_string(&paragraphs).map_err(|e| e.to_string())?;
    let schema = json!({
        "type": "object",
        "properties": { "paragraphs": { "type": "array", "items": { "type": "string" } } },
        "required": ["paragraphs"],
        "additionalProperties": false
    });
    let text = ask(
        format!("You are an expert in Arabic grammar and orthography. {instructions}\n\n{RULES}"),
        format!("Paragraphs (JSON array):\n{input}"),
        schema,
        "medium",
    )
    .await?;
    let parsed: Diacritized = serde_json::from_str(&text).map_err(|e| format!("Unexpected reply format: {e}"))?;
    if parsed.paragraphs.len() != paragraphs.len() {
        return Err("Claude returned a different number of paragraphs.".into());
    }
    Ok(parsed.paragraphs)
}

/// One request to Claude with a structured (JSON schema) answer; returns the answer's text.
async fn ask(system: String, user: String, schema: Value, effort: &str) -> Result<String, String> {
    let key = keyring_entry()?
        .get_password()
        .map_err(|_| "No Claude API key yet. Add one in Settings.".to_string())?;
    let body = json!({
        "model": MODEL,
        "max_tokens": 16000,
        "fallbacks": "default",
        "output_config": { "effort": effort, "format": { "type": "json_schema", "schema": schema } },
        "system": system,
        "messages": [{ "role": "user", "content": user }]
    });

    let response = reqwest::Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Claude: {e}"))?;

    let status = response.status();
    let reply: Value = response.json().await.map_err(|e| format!("Unreadable reply from Claude: {e}"))?;
    if !status.is_success() {
        let message = reply["error"]["message"].as_str().unwrap_or("unknown error");
        return Err(match status.as_u16() {
            401 => "Claude rejected the API key. Check it in Settings.".into(),
            429 => "Too many requests right now. Try again in a moment.".into(),
            _ => format!("Claude returned an error ({status}): {message}"),
        });
    }

    match reply["stop_reason"].as_str() {
        Some("refusal") => return Err("Claude declined this text.".into()),
        Some("max_tokens") => return Err("The text is too long for one go. Select less.".into()),
        _ => {}
    }

    reply["content"]
        .as_array()
        .and_then(|blocks| blocks.iter().find(|b| b["type"] == "text"))
        .and_then(|b| b["text"].as_str())
        .map(String::from)
        .ok_or_else(|| "Claude's reply had no text.".to_string())
}

// ---- Deep check: grammar the built-in rules can't judge ----
// Opt-in: the writer asks for it on a paragraph (or a selection) and gets suggestions as
// underlines, each with a reason; nothing changes until one is accepted.

const DEEP_CHECK: &str = "You are a meticulous proofreader for Modern Standard Arabic and for English. \
For each paragraph, find real mistakes only:\n\
- grammar: agreement in number and gender (verbs, adjectives, pronouns), case endings that show in \
the spelling (ون/ين, ان/ين, the accusative alif, the five nouns أبو/ذو), كان and إنّ and their sisters, \
verbs after لم/لن/أن, numbers and the nouns they count, الذي/التي/الذين/اللواتي;\n\
- spelling: hamza, ة/ه, ى/ي, missing or extra letters; English spelling and grammar;\n\
- punctuation and spacing.\n\
Do not change style, word choice, register or dialect words unless they are clearly wrong, do not add \
diacritics, and never rewrite a sentence that is already correct.\n\
For each mistake give: `original`, the exact text to replace, copied character for character from the \
paragraph (including any diacritics), as short as possible but whole words; `replacement`, the corrected \
text; `explanation`, one short sentence saying why, in Arabic for Arabic text and in English for English \
text. If a paragraph has no mistakes, give it an empty list. Return one entry per paragraph, in order.";

#[derive(Deserialize, serde::Serialize, Debug, PartialEq)]
pub struct Correction {
    original: String,
    replacement: String,
    explanation: String,
}

#[derive(Deserialize)]
struct CheckedParagraph {
    corrections: Vec<Correction>,
}

#[derive(Deserialize)]
struct DeepCheckReply {
    paragraphs: Vec<CheckedParagraph>,
}

fn deep_check_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "paragraphs": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "corrections": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "original": { "type": "string" },
                                    "replacement": { "type": "string" },
                                    "explanation": { "type": "string" }
                                },
                                "required": ["original", "replacement", "explanation"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["corrections"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["paragraphs"],
        "additionalProperties": false
    })
}

/// Keeps only corrections that change something and whose text is really in the paragraph.
fn usable(paragraph: &str, corrections: Vec<Correction>) -> Vec<Correction> {
    corrections
        .into_iter()
        .filter(|c| !c.original.is_empty() && c.original != c.replacement && paragraph.contains(&c.original))
        .collect()
}

/// Asks Claude for the mistakes in each paragraph. English spelling follows `english` ("us"/"gb").
#[tauri::command]
pub async fn deep_check(paragraphs: Vec<String>, english: String) -> Result<Vec<Vec<Correction>>, String> {
    let spelling = if english == "gb" { "British" } else { "American" };
    let input = serde_json::to_string(&paragraphs).map_err(|e| e.to_string())?;
    let text = ask(
        format!("{DEEP_CHECK}\nUse {spelling} spelling for English."),
        format!("Paragraphs (JSON array):\n{input}"),
        deep_check_schema(),
        "high",
    )
    .await?;
    let reply: DeepCheckReply = serde_json::from_str(&text).map_err(|e| format!("Unexpected reply format: {e}"))?;
    if reply.paragraphs.len() != paragraphs.len() {
        return Err("Claude returned a different number of paragraphs.".into());
    }
    Ok(paragraphs.iter().zip(reply.paragraphs).map(|(p, checked)| usable(p, checked.corrections)).collect())
}

// ---- Rewrite and translate ----
// Opt-in like the deep check: the writer picks an action, sees the result in a preview and
// decides. Each paragraph comes back as one paragraph, in the same order.

fn transform_instructions(action: &str, english: &str) -> Result<String, String> {
    let spelling = if english == "gb" { "British" } else { "American" };
    let keep = "Keep the meaning, the facts, names and numbers exactly. Keep each paragraph's language \
                unless asked to translate. Don't add headings, quotes, notes or explanations: return only \
                the text.";
    let task = match action {
        "formal" => "Rewrite each paragraph in a more formal, professional register (for Arabic, careful \
                     Modern Standard Arabic; for English, polished business English).",
        "friendly" => "Rewrite each paragraph in a warmer, friendlier, more conversational tone, still correct.",
        "shorter" => "Make each paragraph shorter and tighter: cut repetition and filler, keep every point.",
        "clearer" => "Rewrite each paragraph to be clearer and easier to read: simpler sentences, clear order, \
                      no jargon, same content.",
        "translate" => "Translate each paragraph: Arabic paragraphs into natural English, English paragraphs \
                        into natural Modern Standard Arabic. A paragraph that mixes both goes into the \
                        language that is not its main one. Translate meaning, not word for word.",
        _ => return Err(format!("Unknown action: {action}")),
    };
    Ok(format!(
        "You are an expert editor and translator for Arabic and English. {task} {keep} \
         Fix any spelling and grammar mistakes as you go. Use {spelling} spelling for English. \
         Write Arabic without diacritics unless the original has them."
    ))
}

/// Rewrites or translates each paragraph. `action`: formal, friendly, shorter, clearer, translate.
#[tauri::command]
pub async fn transform(paragraphs: Vec<String>, action: String, english: String) -> Result<Vec<String>, String> {
    let system = transform_instructions(&action, &english)?;
    let input = serde_json::to_string(&paragraphs).map_err(|e| e.to_string())?;
    let schema = json!({
        "type": "object",
        "properties": { "paragraphs": { "type": "array", "items": { "type": "string" } } },
        "required": ["paragraphs"],
        "additionalProperties": false
    });
    let text = ask(system, format!("Paragraphs (JSON array):\n{input}"), schema, "medium").await?;
    let parsed: Diacritized = serde_json::from_str(&text).map_err(|e| format!("Unexpected reply format: {e}"))?;
    if parsed.paragraphs.len() != paragraphs.len() {
        return Err("Claude returned a different number of paragraphs.".into());
    }
    Ok(parsed.paragraphs)
}

// ---- Synonyms ----
// Words that could replace one word in its sentence, keeping the meaning it has there. Claude
// sees the sentence, so "bank" by a river and "bank" with money get different words.

#[derive(Deserialize)]
struct SynonymReply {
    synonyms: Vec<String>,
}

#[tauri::command]
pub async fn synonyms(word: String, sentence: String) -> Result<Vec<String>, String> {
    let schema = json!({
        "type": "object",
        "properties": { "synonyms": { "type": "array", "items": { "type": "string" } } },
        "required": ["synonyms"],
        "additionalProperties": false
    });
    let system = "You suggest synonyms for one word as it is used in a sentence, in Arabic or English. \
                  Give up to 8 words or short phrases that could replace it in that sentence with the same \
                  meaning, best first, already in the right form for the sentence (number, gender, tense, \
                  definite article and attached letters for Arabic). Same language as the word. No \
                  explanations; an empty list if there are none.";
    let user = format!("Sentence: {sentence}\nWord: {word}");
    let text = ask(system.to_string(), user, schema, "low").await?;
    let reply: SynonymReply = serde_json::from_str(&text).map_err(|e| format!("Unexpected reply format: {e}"))?;
    Ok(reply.synonyms.into_iter().filter(|s| !s.trim().is_empty() && s.trim() != word.trim()).take(8).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_reply_and_drops_unusable_corrections() {
        let reply = r#"{"paragraphs":[{"corrections":[
            {"original":"ذهب","replacement":"ذهبوا","explanation":"الفاعل جمع."},
            {"original":"غير موجود","replacement":"x","explanation":"not in the text"},
            {"original":"المدرسة","replacement":"المدرسة","explanation":"no change"}
        ]},{"corrections":[]}]}"#;
        let parsed: DeepCheckReply = serde_json::from_str(reply).unwrap();
        let paragraphs = ["الطلاب ذهب إلى المدرسة.", "Fine."];
        let kept: Vec<Vec<Correction>> =
            paragraphs.iter().zip(parsed.paragraphs).map(|(p, c)| usable(p, c.corrections)).collect();
        assert_eq!(kept[0].len(), 1);
        assert_eq!(kept[0][0].replacement, "ذهبوا");
        assert!(kept[1].is_empty());
    }

    #[test]
    fn every_action_has_instructions() {
        for action in ["formal", "friendly", "shorter", "clearer", "translate"] {
            assert!(transform_instructions(action, "gb").unwrap().contains("British"));
        }
        assert!(transform_instructions("poem", "us").is_err());
    }
}
