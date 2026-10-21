//! Offline تشكيل with CATT (Character-based Arabic Tashkeel Transformer, Abjad AI,
//! Apache-2.0): https://github.com/abjadai/catt. We run its encoder-only ONNX model, which
//! predicts one mark per letter, so it can never change a letter.
//!
//! The model (72 MB) isn't bundled: it's downloaded once from CATT's release, checked
//! against a SHA-256 fingerprint, and kept in the app's data folder.

use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;

use ort::session::Session;
use ort::value::Tensor;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

const MODEL_URL: &str = "https://github.com/abjadai/catt/releases/download/v2/eo_model_onnx.zip";
const MODEL_SHA256: &str = "5343bfdfda70c981b587811b79348b8dde91f65c0a551ca98f232ea5cb62ceac";
const MODEL_FILES: [&str; 2] = ["encoder.onnx", "decoder.onnx"];
/// The model reads at most 1024 characters; longer text is split at spaces.
const MAX_CHARS: usize = 900;
/// Light mode only keeps marks the model is at least this sure of.
const LIGHT_MIN_CONFIDENCE: f32 = 0.8;

/// Loaded on first use and kept for the rest of the session.
#[derive(Default)]
pub struct OfflineModel(Mutex<Option<Model>>);

struct Model {
    encoder: Session,
    decoder: Session,
}

fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("models").join("catt-eo"))
}

/// Microsoft's ONNX Runtime library, shipped next to the app (see tools/fetch-onnxruntime.sh).
pub fn onnx_runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "onnxruntime.dll" } else { "libonnxruntime.so" };
    Ok(app.path().resource_dir().map_err(|e| e.to_string())?.join("onnxruntime").join(name))
}

#[tauri::command]
pub fn offline_model_installed(app: AppHandle) -> bool {
    model_dir(&app).map(|d| MODEL_FILES.iter().all(|f| d.join(f).is_file())).unwrap_or(false)
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn install_offline_model(app: AppHandle) -> Result<(), String> {
    let mut response = reqwest::get(MODEL_URL)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Couldn't download the model: {e}"))?;
    let total = response.content_length();
    let mut bytes = Vec::with_capacity(total.unwrap_or(0) as usize);
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Download interrupted: {e}"))? {
        bytes.extend_from_slice(&chunk);
        let _ = app.emit("model-download", DownloadProgress { received: bytes.len() as u64, total });
    }

    let digest = Sha256::digest(&bytes);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    if hex != MODEL_SHA256 {
        return Err("The downloaded model didn't match its fingerprint, so it wasn't installed.".into());
    }

    let dir = model_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    for name in MODEL_FILES {
        let mut file = archive.by_name(name).map_err(|e| format!("{name} missing from download: {e}"))?;
        let mut data = Vec::new();
        file.read_to_end(&mut data).map_err(|e| e.to_string())?;
        // Write then rename, so a half-written file is never mistaken for a model.
        let partial = dir.join(format!("{name}.partial"));
        std::fs::write(&partial, data).map_err(|e| e.to_string())?;
        std::fs::rename(&partial, dir.join(name)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---- CATT's vocabulary ----
// Letters are fed to the model in Buckwalter transliteration; ids are positions in this list.
const LETTERS: [&str; 41] = [
    "<PAD>", "<BOS>", "<EOS>", " ", "$", "&", "'", "*", "<", ">", "A", "D", "E", "H", "S", "T", "Y", "Z", "b",
    "d", "f", "g", "h", "j", "k", "l", "m", "n", "p", "q", "r", "s", "t", "v", "w", "x", "y", "z", "|", "}",
    "<MASK>",
];
const SPACE_ID: i64 = 3;

fn buckwalter(c: char) -> Option<&'static str> {
    Some(match c {
        'ء' => "'", 'آ' => "|", 'أ' => ">", 'ؤ' => "&", 'إ' => "<", 'ئ' => "}", 'ا' => "A", 'ب' => "b",
        'ة' => "p", 'ت' => "t", 'ث' => "v", 'ج' => "j", 'ح' => "H", 'خ' => "x", 'د' => "d", 'ذ' => "*",
        'ر' => "r", 'ز' => "z", 'س' => "s", 'ش' => "$", 'ص' => "S", 'ض' => "D", 'ط' => "T", 'ظ' => "Z",
        'ع' => "E", 'غ' => "g", 'ف' => "f", 'ق' => "q", 'ك' => "k", 'ل' => "l", 'م' => "m", 'ن' => "n",
        'ه' => "h", 'و' => "w", 'ى' => "Y", 'ي' => "y",
        _ => return None,
    })
}

fn letter_id(c: char) -> Option<i64> {
    let bw = buckwalter(c)?;
    LETTERS.iter().position(|l| *l == bw).map(|i| i as i64)
}

/// The marks for each of the model's 18 output tags, in Unicode canonical order (vowel or
/// tanween before shadda), matching how Qalam stores marks everywhere else.
const TAG_MARKS: [&str; 18] = [
    "", "", "", "",            // <PAD> <BOS> <EOS> <NT> (no mark)
    "\u{064F}\u{0651}",        // <SD>  damma + shadda
    "\u{064C}\u{0651}",        // <SDD> dammatan + shadda
    "\u{064E}\u{0651}",        // <SF>  fatha + shadda
    "\u{064B}\u{0651}",        // <SFF> fathatan + shadda
    "\u{0650}\u{0651}",        // <SK>  kasra + shadda
    "\u{064D}\u{0651}",        // <SKK> kasratan + shadda
    "\u{064B}", "\u{064D}", "\u{064C}", // F K N: fathatan kasratan dammatan
    "\u{064E}", "\u{0650}", "\u{0652}", "\u{064F}", // a i o u: fatha kasra sukun damma
    "\u{0651}",                // ~ shadda
];

fn is_mark(c: char) -> bool {
    ('\u{064B}'..='\u{0652}').contains(&c)
}

/// Light تشكيل (تشكيل جزئي) keeps the marks that change how a word reads and drops the
/// predictable ones: سكون, a vowel already implied by the long letter after it (فتحة before ا
/// or ى, كسرة before ي, ضمة before و), and case endings unless they're تنوين or شدة. Marks
/// the model is less than 80% sure of are dropped too.
fn light_marks(marks: &str, confidence: f32, next_letter: Option<char>, word_end: bool) -> &str {
    const SHADDA: char = '\u{0651}';
    const TANWEEN: [char; 3] = ['\u{064B}', '\u{064C}', '\u{064D}'];
    if confidence < LIGHT_MIN_CONFIDENCE || marks.is_empty() {
        return "";
    }
    let has = |c: char| marks.contains(c);
    if has(SHADDA) || TANWEEN.iter().any(|&t| has(t)) {
        return marks;
    }
    if word_end || has('\u{0652}') {
        return ""; // case ending or سكون
    }
    let implied = match next_letter {
        Some('ا' | 'ى') => has('\u{064E}'),
        Some('ي') => has('\u{0650}'),
        Some('و') => has('\u{064F}'),
        _ => false,
    };
    if implied { "" } else { marks }
}

/// Two spelling rules every Arabic writer follows, applied to the model's marks:
/// - a bare alef (ا ى آ) never carries a حركة;
/// - a word-final ي that the model gave a كسرة or ضمة is a long vowel: it takes no mark and
///   the letter before it takes a كسرة (اسْمَيِ → اسْمِي). ي with شدة or سكون is left alone.
fn fix_spelling_rules(chars: &[char], marks: &mut [Option<String>], owner: &[Option<usize>]) {
    for (p, o) in owner.iter().enumerate() {
        let Some(i) = *o else { continue };
        match chars[i] {
            'ا' | 'ى' | 'آ' => {
                if let Some(m) = marks[i].as_mut() {
                    m.clear();
                }
            }
            'ي' => {
                let word_end = owner.get(p + 1).copied().flatten().is_none();
                let prev = if p > 0 { owner[p - 1] } else { None };
                let is_short_vowel = |m: &str| m == "\u{0650}" || m == "\u{064F}";
                if let (true, Some(j), Some(m)) = (word_end, prev, marks[i].as_deref()) {
                    if is_short_vowel(m) {
                        marks[i] = Some(String::new());
                        if let Some(pm) = marks[j].as_mut() {
                            if !pm.contains('\u{0651}') {
                                *pm = "\u{0650}".to_string();
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

impl Model {
    fn load(dir: &PathBuf, runtime: &PathBuf) -> Result<Self, String> {
        let fail = |e: String| format!("Couldn't load the offline model: {e}");
        let environment = crate::runtime::environment(runtime).map_err(fail)?;
        let open = |name: &str| -> Result<Session, String> {
            Session::builder(environment)
                .map_err(|e| e.to_string())?
                .with_intra_threads(4)
                .map_err(|e| e.to_string())?
                .commit_from_file(dir.join(name))
                .map_err(|e| e.to_string())
        };
        let encoder = open("encoder.onnx").map_err(fail)?;
        let decoder = open("decoder.onnx").map_err(fail)?;
        Ok(Model { encoder, decoder })
    }

    /// For each input id, the best tag and its probability.
    fn predict(&mut self, ids: &[i64]) -> Result<Vec<(usize, f32)>, String> {
        let len = ids.len();
        let err = |e: ort::Error| e.to_string();
        let src = Tensor::from_array(([1usize, len], ids.to_vec())).map_err(err)?;
        let mask = Tensor::from_array(([1usize, 1, len, len], vec![true; len * len])).map_err(err)?;
        let encoded = self.encoder.run(ort::inputs!["src" => src, "src_mask" => mask]).map_err(err)?;
        let (shape, hidden) = encoded["encoder_output"].try_extract_tensor::<f32>().map_err(err)?;
        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
        let enc_src = Tensor::from_array((dims, hidden.to_vec())).map_err(err)?;
        drop(encoded);
        let decoded = self.decoder.run(ort::inputs!["enc_src" => enc_src]).map_err(err)?;
        let (_, logits) = decoded["decoder_output"].try_extract_tensor::<f32>().map_err(err)?;

        Ok(logits
            .chunks(TAG_MARKS.len())
            .map(|row| {
                let (best, &top) = row.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap();
                let sum: f32 = row.iter().map(|&x| (x - top).exp()).sum();
                (best, 1.0 / sum) // softmax probability of the best tag
            })
            .collect())
    }

    /// Returns the paragraph with predicted marks after every Arabic letter (marks it
    /// already had are replaced; everything else is untouched).
    fn diacritize(&mut self, paragraph: &str, light: bool) -> Result<String, String> {
        let chars: Vec<char> = paragraph.chars().collect();
        // The model sees only Arabic letters and single spaces between words, the same
        // cleaning CATT applies: marks and tatweel vanish, anything else separates words.
        let mut ids: Vec<i64> = Vec::new();
        let mut owner: Vec<Option<usize>> = Vec::new();
        for (i, &c) in chars.iter().enumerate() {
            if is_mark(c) || c == '\u{0640}' {
                continue;
            }
            if let Some(id) = letter_id(c) {
                ids.push(id);
                owner.push(Some(i));
            } else if ids.last().is_some_and(|&last| last != SPACE_ID) {
                ids.push(SPACE_ID);
                owner.push(None);
            }
        }

        let mut marks: Vec<Option<String>> = vec![None; chars.len()];
        let mut confidence: Vec<f32> = vec![0.0; chars.len()];
        let mut start = 0;
        while start < ids.len() {
            // Cut at the last space within the limit, so no word is split.
            let mut end = (start + MAX_CHARS).min(ids.len());
            if end < ids.len() {
                if let Some(space) = ids[start..end].iter().rposition(|&id| id == SPACE_ID) {
                    end = start + space;
                }
            }
            for (k, (tag, conf)) in self.predict(&ids[start..end])?.into_iter().enumerate() {
                if let Some(i) = owner[start + k] {
                    marks[i] = Some(TAG_MARKS[tag].to_string());
                    confidence[i] = conf;
                }
            }
            start = end;
            while ids.get(start) == Some(&SPACE_ID) {
                start += 1;
            }
        }

        // Spelling rules first, on the full prediction; light mode then thins it out.
        fix_spelling_rules(&chars, &mut marks, &owner);
        if light {
            for (p, o) in owner.iter().enumerate() {
                let Some(i) = *o else { continue };
                let next = owner.get(p + 1).copied().flatten().map(|j| chars[j]);
                let kept = light_marks(marks[i].as_deref().unwrap_or(""), confidence[i], next, next.is_none());
                marks[i] = Some(kept.to_string());
            }
        }

        let mut out = String::with_capacity(paragraph.len() * 2);
        for (i, &c) in chars.iter().enumerate() {
            if is_mark(c) {
                continue;
            }
            out.push(c);
            if let Some(m) = &marks[i] {
                out.push_str(m);
            }
        }
        Ok(out)
    }
}

#[tauri::command]
pub async fn diacritize_offline(app: AppHandle, paragraphs: Vec<String>, mode: String) -> Result<Vec<String>, String> {
    let dir = model_dir(&app)?;
    let runtime = onnx_runtime_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<OfflineModel>();
        let mut guard = state.0.lock().map_err(|_| "The offline model is unavailable.".to_string())?;
        if guard.is_none() {
            *guard = Some(Model::load(&dir, &runtime)?);
        }
        let model = guard.as_mut().unwrap();
        paragraphs.iter().map(|p| model.diacritize(p, mode == "light")).collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    // Needs the downloaded model: QALAM_TEST_MODEL=<folder with encoder.onnx and decoder.onnx>.
    #[test]
    fn matches_catt_reference_output() {
        let Ok(dir) = std::env::var("QALAM_TEST_MODEL") else { return };
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("onnxruntime/libonnxruntime.so");
        let mut model = Model::load(&PathBuf::from(dir), &runtime).unwrap();
        // Reference outputs from CATT's own Python ONNX code (catt_models_onnx.py).
        let cases = [
            ("ذهب الطالب إلى المدرسة في الصباح الباكر", "ذَهَبَ الطَّالِبُ إِلَى الْمَدْرَسَةِ فِي الصَّبَاحِ الْبَاكِرِ"),
            ("إن الكتابة باللغة العربية تحتاج إلى عناية بالحركات", "إنَّ الْكِتَابَةَ بِاللُّغَةِ الْعَرَبِيَّةِ تَحْتَاجُ إلَى عِنَايَةٍ بِالْحَرَكَاتِ"),
        ];
        for (input, want) in cases {
            assert_eq!(model.diacritize(input, false).unwrap(), want);
        }
        // Non-Arabic text and punctuation pass through untouched.
        let mixed = model.diacritize("كتب Qalam، ثم ذهب!", false).unwrap();
        assert!(mixed.contains(" Qalam، ") && mixed.ends_with('!'), "{mixed}");
        // Light mode never adds sukun, and drops endings that aren't tanween or shadda.
        let light = model.diacritize("ذهب الطالب إلى المدرسة", true).unwrap();
        assert!(!light.contains('\u{0652}'), "{light}");
        assert!(light.contains("الطَّ"), "{light}");
        println!("light: {light}\nmixed: {mixed}");
    }
}

#[cfg(test)]
pub fn test_load(dir: &PathBuf, runtime: &PathBuf) -> Result<(), String> {
    Model::load(dir, runtime).map(|_| ())
}

#[cfg(test)]
mod light_samples {
    use super::*;
    #[test]
    fn show_light_and_full() {
        let Ok(dir) = std::env::var("QALAM_TEST_MODEL") else { return };
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("onnxruntime/libonnxruntime.so");
        let mut m = Model::load(&PathBuf::from(dir), &runtime).unwrap();
        for s in ["انا اسمي البراء وحيد وأكتب في قلم كل يوم", "علم المعلم الطلاب درسا جديدا عن تاريخ العرب", "ذهب الطالب إلى المدرسة في الصباح الباكر"] {
            println!("full : {}\nlight: {}\n", m.diacritize(s, false).unwrap(), m.diacritize(s, true).unwrap());
        }
    }
}

#[cfg(test)]
mod user_sample {
    use super::*;
    #[test]
    fn print_user_sentence() {
        let Ok(dir) = std::env::var("QALAM_TEST_MODEL") else { return };
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("onnxruntime/libonnxruntime.so");
        let mut m = Model::load(&PathBuf::from(dir), &runtime).unwrap();
        let s = "انا اسمي البراء وجيد من مصر عايش في الامارات";
        println!("FULL={}", m.diacritize(s, false).unwrap());
        println!("LIGHT={}", m.diacritize(s, true).unwrap());
    }
}
