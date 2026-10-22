//! Opening and saving documents, and the backup copy that keeps unsaved work safe.
//!
//! Files: Qalam's own format (.qalam: the editor's document as JSON, so headings, lists,
//! bold and حركات all survive), Word (.docx) and plain text (.txt). The editor turns a
//! document into each format and back; this module only picks paths and reads and writes
//! files. Word files are binary, so they travel to and from the editor as base64.
//!
//! Backup: while there are unsaved changes the editor sends its document here every couple of
//! seconds, and it's written to the app's data folder. If Qalam closes or crashes before the
//! work is saved, the next start restores it.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct OpenedDocument {
    path: String,
    name: String,
    /// "qalam", "docx" or "text"
    kind: &'static str,
    /// The file's text; for .docx, its bytes as base64.
    contents: String,
}

#[derive(Serialize)]
pub struct SavePath {
    path: String,
    name: String,
    kind: &'static str,
}

fn kind_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("qalam") => "qalam",
        Some("docx") => "docx",
        _ => "text",
    }
}

/// Where the Open and Save dialogs start: the current document's folder, or else Documents.
fn start_folder(app: &AppHandle, current: Option<&str>) -> Option<PathBuf> {
    current.and_then(|p| Path::new(p).parent().map(Path::to_path_buf)).or_else(|| app.path().document_dir().ok())
}

fn name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Reads a document. Text must be UTF-8 (a byte-order mark is dropped).
fn read(path: &Path) -> Result<OpenedDocument, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Couldn't open {}: {e}", name_of(path)))?;
    if kind_of(path) == "docx" {
        let contents = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(OpenedDocument { path: path.to_string_lossy().into_owned(), name: name_of(path), kind: "docx", contents });
    }
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let contents = String::from_utf8(bytes.to_vec())
        .map_err(|_| format!("{} isn't UTF-8 text, so Qalam can't read it yet.", name_of(path)))?;
    Ok(OpenedDocument { path: path.to_string_lossy().into_owned(), name: name_of(path), kind: kind_of(path), contents })
}

/// Writes then renames, so a crash mid-write never leaves a half-written file.
fn write_atomically(path: &Path, contents: impl AsRef<[u8]>) -> Result<(), String> {
    let partial = path.with_extension(format!("{}.partial", path.extension().and_then(|e| e.to_str()).unwrap_or("")));
    std::fs::write(&partial, contents).map_err(|e| format!("Couldn't save {}: {e}", name_of(path)))?;
    std::fs::rename(&partial, path).map_err(|e| format!("Couldn't save {}: {e}", name_of(path)))
}

/// Shows the Open dialog and reads the chosen file. None when the writer cancels.
#[tauri::command]
pub async fn open_document(app: AppHandle, current: Option<String>) -> Result<Option<OpenedDocument>, String> {
    let mut dialog = app.dialog().file().set_title("Open · فتح");
    if let Some(folder) = start_folder(&app, current.as_deref()) {
        dialog = dialog.set_directory(folder);
    }
    let picked = dialog
        .add_filter("Documents (Qalam, Word, text)", &["qalam", "docx", "txt"])
        .add_filter("Qalam documents", &["qalam"])
        .add_filter("Word documents", &["docx"])
        .add_filter("Text", &["txt"])
        .blocking_pick_file();
    match picked {
        None => Ok(None),
        Some(file) => read(&file.into_path().map_err(|e| e.to_string())?).map(Some),
    }
}

/// Reads a document by path: one passed when Qalam was started (double-clicking a file).
#[tauri::command]
pub fn read_document(path: String) -> Result<OpenedDocument, String> {
    read(Path::new(&path))
}

/// Shows the Save dialog. The editor then writes the document in the chosen kind.
#[tauri::command]
pub async fn choose_save_path(app: AppHandle, suggested_name: String, current: Option<String>) -> Result<Option<SavePath>, String> {
    let mut dialog = app.dialog().file().set_title("Save · حفظ");
    if let Some(folder) = start_folder(&app, current.as_deref()) {
        dialog = dialog.set_directory(folder);
    }
    let picked = dialog
        .set_file_name(suggested_name)
        .add_filter("Qalam document", &["qalam"])
        .add_filter("Word document", &["docx"])
        .add_filter("Text", &["txt"])
        .blocking_save_file();
    let Some(file) = picked else { return Ok(None) };
    let mut path = file.into_path().map_err(|e| e.to_string())?;
    if path.extension().is_none() {
        path.set_extension("qalam");
    }
    Ok(Some(SavePath { path: path.to_string_lossy().into_owned(), name: name_of(&path), kind: kind_of(&path) }))
}

#[tauri::command]
pub fn write_document(path: String, contents: String) -> Result<(), String> {
    write_atomically(Path::new(&path), contents)
}

/// Writes a binary document (.docx), sent as base64.
#[tauri::command]
pub fn write_document_base64(path: String, base64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64).map_err(|e| e.to_string())?;
    write_atomically(Path::new(&path), bytes)
}

/// Images are kept inside the document, so it stays one self-contained file.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// Shows an Open dialog for an image and returns it as a data URL, ready to show and to save
/// with the document. None when the writer cancels.
#[tauri::command]
pub async fn pick_image(app: AppHandle, current: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title("Insert image · إدراج صورة");
    if let Some(folder) = current.as_deref().and_then(|p| Path::new(p).parent()).map(Path::to_path_buf).or_else(|| app.path().picture_dir().ok()) {
        dialog = dialog.set_directory(folder);
    }
    let Some(file) = dialog.add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "bmp"]).blocking_pick_file() else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| format!("Couldn't open {}: {e}", name_of(&path)))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("{} is larger than 20 MB. Please use a smaller image.", name_of(&path)));
    }
    let mime = match path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "image/png",
    };
    Ok(Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes))))
}

/// A file given on the command line, as when a .qalam file is double-clicked.
#[tauri::command]
pub fn startup_document() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-') && Path::new(a).is_file())
}

fn backup_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("unsaved-work.json"))
}

#[tauri::command]
pub fn save_backup(app: AppHandle, json: String) -> Result<(), String> {
    let path = backup_path(&app)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    write_atomically(&path, json)
}

#[tauri::command]
pub fn load_backup(app: AppHandle) -> Result<Option<String>, String> {
    match std::fs::read_to_string(backup_path(&app)?) {
        Ok(json) => Ok(Some(json)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn clear_backup(app: AppHandle) -> Result<(), String> {
    match std::fs::remove_file(backup_path(&app)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Opens the system's print dialog for the page (it also offers saving as PDF).
#[tauri::command]
pub fn print_document(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

/// Closes the window for real, once the editor has dealt with unsaved changes.
#[tauri::command]
pub fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_reads_back() {
        let dir = std::env::temp_dir().join(format!("qalam-doc-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("رسالة.qalam");
        write_atomically(&path, "{\"qalam\":1}").unwrap();
        let doc = read(&path).unwrap();
        assert_eq!((doc.name.as_str(), doc.kind, doc.contents.as_str()), ("رسالة.qalam", "qalam", "{\"qalam\":1}"));
        assert!(!dir.join("رسالة.qalam.partial").exists());

        let text = dir.join("notes.TXT");
        std::fs::write(&text, b"\xEF\xBB\xBFhello\n").unwrap();
        let doc = read(&text).unwrap();
        assert_eq!((doc.kind, doc.contents.as_str()), ("text", "hello\n"));
        let word = dir.join("letter.docx");
        std::fs::write(&word, [0x50, 0x4B, 0x03, 0x04]).unwrap();
        let doc = read(&word).unwrap();
        assert_eq!((doc.kind, doc.contents.as_str()), ("docx", "UEsDBA=="));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
