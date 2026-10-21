mod claude;
mod offline;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(offline::OfflineModel::default())
        .invoke_handler(tauri::generate_handler![
            claude::set_api_key,
            claude::has_api_key,
            claude::clear_api_key,
            claude::diacritize,
            offline::offline_model_installed,
            offline::install_offline_model,
            offline::diacritize_offline,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
