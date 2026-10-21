//! The تشكيل correction memory (see src/editor/memory.ts), kept as JSON in the app's data
//! folder so what Qalam learns survives restarts.

use tauri::{AppHandle, Manager};

fn path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("tashkeel-memory.json"))
}

#[tauri::command]
pub fn load_tashkeel_memory(app: AppHandle) -> Result<String, String> {
    match std::fs::read_to_string(path(&app)?) {
        Ok(json) => Ok(json),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn save_tashkeel_memory(app: AppHandle, json: String) -> Result<(), String> {
    let file = path(&app)?;
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    // Write then rename, so a crash mid-write can't leave a half-written memory.
    let partial = file.with_extension("json.partial");
    std::fs::write(&partial, json).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, &file).map_err(|e| e.to_string())
}
