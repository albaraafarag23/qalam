mod claude;
mod memory;
mod offline;
mod punctuate;
mod runtime;
mod spell;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(offline::OfflineModel::default())
        .manage(punctuate::PunctuationModel::default())
        .manage(spell::Spellchecker::default())
        .setup(|app| {
            spell::preload(app.handle());
            #[cfg(windows)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.with_webview(windows_title_bar_fix)?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            claude::set_api_key,
            claude::has_api_key,
            claude::clear_api_key,
            claude::diacritize,
            memory::load_tashkeel_memory,
            memory::save_tashkeel_memory,
            offline::offline_model_installed,
            offline::install_offline_model,
            offline::diacritize_offline,
            punctuate::punctuation_model_installed,
            punctuate::install_punctuation_model,
            punctuate::punctuate_offline,
            spell::spell_check,
            spell::spell_suggest,
            spell::spell_add_word,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// wry turns on WebView2's non-client region support, which lets a page act as part of the
/// title bar. Qalam keeps the normal Windows title bar, and with the support on, Windows 11
/// treated the toolbar's right end as the Close/Maximize buttons (Close tooltip over ⚙,
/// Snap Layouts over ☾). Turning it off leaves the whole page an ordinary client area.
#[cfg(windows)]
fn windows_title_bar_fix(webview: tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings9;
    use windows_core::Interface;
    unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let Ok(settings) = core.Settings() else { return };
        if let Ok(settings9) = settings.cast::<ICoreWebView2Settings9>() {
            // The change applies from the next navigation, so reload the page once.
            if settings9.SetIsNonClientRegionSupportEnabled(false).is_ok() {
                let _ = core.Reload();
            }
        }
    }
}
