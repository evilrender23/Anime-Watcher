// Sin consola adicional en Windows en las versiones de lanzamiento.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod error;
mod extract;
mod http;
mod player;
mod proxy;
mod site;
mod store;

use tauri::Manager;

use commands::AppState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let http = http::scraper_client()?;
            let proxy = tauri::async_runtime::block_on(proxy::Proxy::start(http::stream_client()?))?;
            let store = store::Store::open(app.path().app_data_dir()?);
            app.manage(AppState { http, proxy, store });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::latest,
            commands::search,
            commands::anime,
            commands::episode,
            commands::resolve,
            commands::play_external,
            commands::get_settings,
            commands::save_settings,
            commands::detect_players,
            commands::history_list,
            commands::history_mark,
            commands::history_remove,
        ])
        .run(tauri::generate_context!())
        .expect("no se pudo iniciar anicli-es");
}
