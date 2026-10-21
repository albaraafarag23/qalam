mod claude;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            claude::set_api_key,
            claude::has_api_key,
            claude::clear_api_key,
            claude::diacritize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
