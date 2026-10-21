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
    let key = keyring_entry()?
        .get_password()
        .map_err(|_| "No Claude API key yet. Add one in Settings.".to_string())?;

    let instructions = if mode == "light" { LIGHT_INSTRUCTIONS } else { FULL_INSTRUCTIONS };
    let input = serde_json::to_string(&paragraphs).map_err(|e| e.to_string())?;
    let body = json!({
        "model": MODEL,
        "max_tokens": 16000,
        "fallbacks": "default",
        "output_config": {
            "effort": "medium",
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": { "paragraphs": { "type": "array", "items": { "type": "string" } } },
                    "required": ["paragraphs"],
                    "additionalProperties": false
                }
            }
        },
        "system": format!("You are an expert in Arabic grammar and orthography. {instructions}\n\n{RULES}"),
        "messages": [{ "role": "user", "content": format!("Paragraphs (JSON array):\n{input}") }]
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

    let text = reply["content"]
        .as_array()
        .and_then(|blocks| blocks.iter().find(|b| b["type"] == "text"))
        .and_then(|b| b["text"].as_str())
        .ok_or("Claude's reply had no text.")?;
    let parsed: Diacritized = serde_json::from_str(text).map_err(|e| format!("Unexpected reply format: {e}"))?;
    if parsed.paragraphs.len() != paragraphs.len() {
        return Err("Claude returned a different number of paragraphs.".into());
    }
    Ok(parsed.paragraphs)
}
