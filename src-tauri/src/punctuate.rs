//! Offline English punctuation and capitalisation with 1-800-BAD-CODE's
//! punct_cap_seg_en model (Apache-2.0):
//! https://huggingface.co/1-800-BAD-CODE/punctuation_fullstop_truecase_english
//!
//! The model reads lower-case, unpunctuated words and predicts, for each word, its
//! capitalisation and the punctuation after it (. , ? or an acronym like "a.m.").
//! Downloaded once (210 MB) and checked against SHA-256 fingerprints, like the تشكيل model.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use ort::session::Session;
use ort::value::Tensor;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

const REVISION: &str = "b26fd1c40e88678859048898218ea4edcc24c84a";
const REPO: &str = "https://huggingface.co/1-800-BAD-CODE/punctuation_fullstop_truecase_english/resolve";
/// (file name, SHA-256)
const FILES: [(&str, &str); 2] = [
    ("spe_32k_lc_en.model", "9e86d0263de80b3b68327a21f5350c8cdf846e4c4400253c9baf05e3d44871c3"),
    ("punct_cap_seg_en.onnx", "dd922d459da618cd324280889740608b76fb3e9e61d3f402291be1251f91421b"),
];
/// Trained on up to 256 tokens, including the start and end tokens.
const MAX_TOKENS: usize = 254;
/// Long text is read in overlapping windows; half the overlap is trimmed from each side.
const OVERLAP: usize = 16;
const BOS: i64 = 1;
const EOS: i64 = 2;
/// post_preds labels: <NULL>, <ACRONYM>, ".", ",", "?"
const ACRONYM: i64 = 1;
const POST_PUNCT: [&str; 5] = ["", "", ".", ",", "?"];

#[derive(Default)]
pub struct PunctuationModel(Mutex<Option<Model>>);

fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("models").join("punct-en"))
}

#[tauri::command]
pub fn punctuation_model_installed(app: AppHandle) -> bool {
    model_dir(&app).map(|d| FILES.iter().all(|(f, _)| d.join(f).is_file())).unwrap_or(false)
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn install_punctuation_model(app: AppHandle) -> Result<(), String> {
    let dir = model_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut received_before = 0;
    for (name, sha) in FILES {
        let url = format!("{REPO}/{REVISION}/{name}");
        let mut response = reqwest::get(&url)
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Couldn't download {name}: {e}"))?;
        let total = response.content_length().map(|t| t + received_before);
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| format!("Download interrupted: {e}"))? {
            bytes.extend_from_slice(&chunk);
            let received = received_before + bytes.len() as u64;
            let _ = app.emit("model-download", DownloadProgress { received, total });
        }
        let hex: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        if hex != sha {
            return Err(format!("{name} didn't match its fingerprint, so it wasn't installed."));
        }
        let partial = dir.join(format!("{name}.partial"));
        std::fs::write(&partial, &bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&partial, dir.join(name)).map_err(|e| e.to_string())?;
        received_before += bytes.len() as u64;
    }
    Ok(())
}

// ---- SentencePiece (unigram) tokenizer ----
// The model's tokenizer uses identity normalisation and no byte fallback, so encoding is:
// collapse whitespace, mark word starts with ▁, then pick the highest-scoring split.

pub struct SentencePiece {
    pieces: HashMap<String, (u32, f32)>,
    id_to_piece: Vec<String>,
    max_piece_chars: usize,
    unk_id: u32,
    unk_score: f32,
}

/// Reads a protobuf varint at `pos`, advancing it.
fn varint(buf: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *buf.get(*pos).ok_or("Truncated tokenizer file")?;
        *pos += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err("Bad varint in tokenizer file".into())
}

/// Skips one protobuf field of the given wire type, returning its bytes if length-delimited.
fn field<'a>(buf: &'a [u8], pos: &mut usize, wire: u64) -> Result<Option<&'a [u8]>, String> {
    match wire {
        0 => varint(buf, pos).map(|_| None),
        1 => { *pos += 8; Ok(None) }
        5 => { *pos += 4; Ok(None) }
        2 => {
            let len = varint(buf, pos)? as usize;
            let bytes = buf.get(*pos..*pos + len).ok_or("Truncated tokenizer file")?;
            *pos += len;
            Ok(Some(bytes))
        }
        _ => Err(format!("Unsupported wire type {wire} in tokenizer file")),
    }
}

impl SentencePiece {
    /// Parses the pieces out of a SentencePiece ModelProto: field 1 holds repeated
    /// { 1: piece, 2: score (float), 3: type }.
    pub fn load(bytes: &[u8]) -> Result<Self, String> {
        const NORMAL: u64 = 1;
        const UNKNOWN: u64 = 2;
        const USER_DEFINED: u64 = 4;
        let mut pieces = HashMap::new();
        let mut id_to_piece = Vec::new();
        let (mut unk_id, mut min_score) = (0u32, f32::MAX);
        let mut pos = 0;
        while pos < bytes.len() {
            let key = varint(bytes, &mut pos)?;
            let data = field(bytes, &mut pos, key & 7)?;
            let (Some(msg), 1) = (data, key >> 3) else { continue };
            let (mut piece, mut score, mut kind) = (String::new(), 0f32, NORMAL);
            let mut p = 0;
            while p < msg.len() {
                let k = varint(msg, &mut p)?;
                match (k >> 3, k & 7) {
                    (1, 2) => piece = String::from_utf8_lossy(field(msg, &mut p, 2)?.unwrap()).into_owned(),
                    (2, 5) => {
                        let b = msg.get(p..p + 4).ok_or("Truncated score")?;
                        score = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                        p += 4;
                    }
                    (3, 0) => kind = varint(msg, &mut p)?,
                    (_, w) => { field(msg, &mut p, w)?; }
                }
            }
            let id = id_to_piece.len() as u32;
            if kind == UNKNOWN {
                unk_id = id;
            }
            if kind == NORMAL || kind == USER_DEFINED {
                min_score = min_score.min(score);
                pieces.insert(piece.clone(), (id, score));
            }
            id_to_piece.push(piece);
        }
        let max_piece_chars = pieces.keys().map(|p| p.chars().count()).max().unwrap_or(1);
        // SentencePiece scores an unknown character 10 below the worst known piece.
        Ok(SentencePiece { pieces, id_to_piece, max_piece_chars, unk_id, unk_score: min_score - 10.0 })
    }

    pub fn piece(&self, id: u32) -> &str {
        &self.id_to_piece[id as usize]
    }

    pub fn encode(&self, text: &str) -> Vec<u32> {
        let normalized = format!("▁{}", text.split_whitespace().collect::<Vec<_>>().join("▁"));
        let chars: Vec<char> = normalized.chars().collect();
        let n = chars.len();
        // best[i] = (score, start of the last piece, its id) for the best split of chars[..i]
        let mut best: Vec<(f32, usize, u32)> = vec![(f32::NEG_INFINITY, 0, 0); n + 1];
        best[0].0 = 0.0;
        for end in 1..=n {
            for start in end.saturating_sub(self.max_piece_chars)..end {
                if best[start].0 == f32::NEG_INFINITY {
                    continue;
                }
                let s: String = chars[start..end].iter().collect();
                if let Some(&(id, score)) = self.pieces.get(&s) {
                    if best[start].0 + score > best[end].0 {
                        best[end] = (best[start].0 + score, start, id);
                    }
                }
            }
            if best[end].0 == f32::NEG_INFINITY {
                best[end] = (best[end - 1].0 + self.unk_score, end - 1, self.unk_id);
            }
        }
        let mut ids = Vec::new();
        let mut end = n;
        while end > 0 {
            let (_, start, id) = best[end];
            // Consecutive unknown characters become a single <unk>, as in SentencePiece.
            if !(id == self.unk_id && ids.last() == Some(&self.unk_id)) {
                ids.push(id);
            }
            end = start;
        }
        ids.reverse();
        ids
    }
}

// ---- The model ----

struct Model {
    session: Session,
    tokenizer: SentencePiece,
    _environment: ort::environment::Environment,
}

/// What the model suggests for one token: capitalise which characters, punctuation after it.
struct TokenPrediction {
    caps: Vec<bool>,
    post: i64,
}

impl Model {
    fn load(dir: &PathBuf, runtime: &PathBuf) -> Result<Self, String> {
        let fail = |e: String| format!("Couldn't load the punctuation model: {e}");
        let environment = ort::init_from(runtime)
            .map_err(|e| fail(e.to_string()))?
            .with_name("qalam-punctuation")
            .build()
            .map_err(|e| fail(e.to_string()))?;
        let session = Session::builder(&environment)
            .map_err(|e| fail(e.to_string()))?
            .with_intra_threads(4)
            .map_err(|e| fail(e.to_string()))?
            .commit_from_file(dir.join(FILES[1].0))
            .map_err(|e| fail(e.to_string()))?;
        let bytes = std::fs::read(dir.join(FILES[0].0)).map_err(|e| fail(e.to_string()))?;
        let tokenizer = SentencePiece::load(&bytes).map_err(fail)?;
        Ok(Model { session, tokenizer, _environment: environment })
    }

    fn predict_window(&mut self, ids: &[u32]) -> Result<Vec<TokenPrediction>, String> {
        let err = |e: ort::Error| e.to_string();
        let mut input: Vec<i64> = Vec::with_capacity(ids.len() + 2);
        input.push(BOS);
        input.extend(ids.iter().map(|&i| i64::from(i)));
        input.push(EOS);
        let len = input.len();
        let tensor = Tensor::from_array(([1usize, len], input)).map_err(err)?;
        let out = self.session.run(ort::inputs!["input_ids" => tensor]).map_err(err)?;
        let (_, post) = out["post_preds"].try_extract_tensor::<i64>().map_err(err)?;
        let (cap_shape, caps) = out["cap_preds"].try_extract_tensor::<bool>().map_err(err)?;
        let width = cap_shape[2] as usize;
        // Drop the start and end tokens.
        Ok((1..len - 1)
            .map(|t| TokenPrediction { caps: caps[t * width..(t + 1) * width].to_vec(), post: post[t] })
            .collect())
    }

    /// Predictions for every token, reading long text in overlapping windows.
    fn predict(&mut self, ids: &[u32]) -> Result<Vec<TokenPrediction>, String> {
        let mut out = Vec::with_capacity(ids.len());
        let mut start = 0;
        let mut first = true;
        while start < ids.len() {
            let window_start = if first { 0 } else { start - OVERLAP };
            let window_end = (window_start + MAX_TOKENS).min(ids.len());
            let preds = self.predict_window(&ids[window_start..window_end])?;
            let last = window_end == ids.len();
            let skip = if first { 0 } else { OVERLAP / 2 };
            let keep_until = if last { preds.len() } else { preds.len() - OVERLAP / 2 };
            out.extend(preds.into_iter().take(keep_until).skip(skip));
            start = window_start + keep_until;
            first = false;
        }
        Ok(out)
    }

    /// The model's preferred form of each word: capitalised and with punctuation after it.
    /// Words are given already lower-cased and stripped of surrounding punctuation;
    /// empty words stay empty.
    fn suggest(&mut self, words: &[String]) -> Result<Vec<String>, String> {
        let kept: Vec<usize> = (0..words.len()).filter(|&i| !words[i].is_empty()).collect();
        if kept.is_empty() {
            return Ok(vec![String::new(); words.len()]);
        }
        let text = kept.iter().map(|&i| words[i].as_str()).collect::<Vec<_>>().join(" ");
        let ids = self.tokenizer.encode(&text);
        let preds = self.predict(&ids)?;

        let mut forms: Vec<String> = Vec::new();
        for (id, pred) in ids.iter().zip(&preds) {
            let piece = self.tokenizer.piece(*id);
            let (starts_word, body) = match piece.strip_prefix('▁') {
                Some(rest) => (true, rest),
                None => (false, piece),
            };
            if starts_word || forms.is_empty() {
                forms.push(String::new());
            }
            let word = forms.last_mut().unwrap();
            let offset = if starts_word { 1 } else { 0 };
            let body: String = if *id == self.tokenizer.unk_id {
                String::new() // the original characters are restored below
            } else {
                body.to_string()
            };
            let count = body.chars().count();
            for (k, ch) in body.chars().enumerate() {
                if pred.caps.get(k + offset).copied().unwrap_or(false) {
                    word.extend(ch.to_uppercase());
                } else {
                    word.push(ch);
                }
                if pred.post == ACRONYM {
                    word.push('.');
                }
                if k + 1 == count && pred.post != ACRONYM {
                    word.push_str(POST_PUNCT[pred.post as usize]);
                }
            }
            if count == 0 && pred.post > ACRONYM {
                word.push_str(POST_PUNCT[pred.post as usize]);
            }
        }

        let mut result = vec![String::new(); words.len()];
        if forms.len() != kept.len() {
            return Ok(result); // couldn't line words up; suggest nothing rather than guess
        }
        for (form, &i) in forms.into_iter().zip(&kept) {
            // Unknown characters (e.g. é) were dropped from the form; if letters no longer
            // match, keep the original word with only the punctuation suggestion.
            let letters = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
            result[i] = if letters(&form) == letters(&words[i]) {
                form
            } else {
                let trailing: String = form.chars().rev().take_while(|c| matches!(c, '.' | ',' | '?')).collect();
                format!("{}{}", words[i], trailing.chars().rev().collect::<String>())
            };
        }
        Ok(result)
    }
}

/// For each paragraph (given as words, lower-cased and stripped of punctuation by the
/// caller), the model's suggested form of each word.
#[tauri::command]
pub async fn punctuate_offline(app: AppHandle, paragraphs: Vec<Vec<String>>) -> Result<Vec<Vec<String>>, String> {
    let dir = model_dir(&app)?;
    let runtime = crate::offline::onnx_runtime_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PunctuationModel>();
        let mut guard = state.0.lock().map_err(|_| "The punctuation model is unavailable.".to_string())?;
        if guard.is_none() {
            *guard = Some(Model::load(&dir, &runtime)?);
        }
        let model = guard.as_mut().unwrap();
        paragraphs.iter().map(|words| model.suggest(words)).collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_dir() -> Option<PathBuf> {
        std::env::var("QALAM_TEST_PUNCT_MODEL").ok().map(PathBuf::from)
    }

    // Reference ids from the Python sentencepiece library on the same model.
    #[test]
    fn tokenizer_matches_sentencepiece() {
        let Some(dir) = model_dir() else { return };
        let sp = SentencePiece::load(&std::fs::read(dir.join(FILES[0].0)).unwrap()).unwrap();
        let cases: [(&str, &[u32]); 7] = [
            ("hello my name is albaraa", &[8015, 67, 534, 15, 9982, 1217, 193]),
            ("i woke up at 6 am", &[19, 3978, 57, 29, 408, 309]),
            ("dont   be late  ", &[107, 31, 24, 497]),
            ("café naïve résumé", &[14459, 2792, 0, 106, 27814]),
            ("mcdonalds xyzzyqq 2026 email@test.com", &[4204, 8, 1396, 166, 8096, 166, 3300, 3300, 20095, 2063, 0, 31, 1794, 4, 6594]),
            ("emoji 😀 test", &[8407, 101, 0, 494]),
            ("a", &[9]),
        ];
        for (text, want) in cases {
            assert_eq!(sp.encode(text), want, "{text}");
        }
    }

    #[test]
    fn suggests_punctuation_and_capitals() {
        let Some(dir) = model_dir() else { return };
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("onnxruntime/libonnxruntime.so");
        let mut model = Model::load(&dir, &runtime).unwrap();
        let words: Vec<String> = "hello my name is albaraa i study computer engineering in jordan what are you working on"
            .split(' ').map(String::from).collect();
        let out = model.suggest(&words).unwrap().join(" ");
        // Reference: the same model run through Python (punctuators' decoding).
        assert_eq!(out, "Hello, my name is Albaraa, I study computer engineering in Jordan. What are you working on?");
        let out = model.suggest(&"i woke up at 6 am".split(' ').map(String::from).collect::<Vec<_>>()).unwrap();
        assert_eq!(out.join(" "), "I woke up at 6 a.m.");
    }
}
