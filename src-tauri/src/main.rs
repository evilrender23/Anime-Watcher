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
mod update;

use tauri::Manager;

use commands::AppState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let http = http::scraper_client()?;
            let proxy = tauri::async_runtime::block_on(proxy::Proxy::start(http::stream_client()?))?;
            let data_dir = app.path().app_data_dir()?;
            store::migrate_legacy(&data_dir);
            let store = store::Store::open(data_dir);
            let actualizador = update::Actualizador::default();
            let handle = app.handle().clone();
            actualizador.vigilar(app.handle().clone(), move || handle.state::<AppState>().store.settings().auto_update);
            app.manage(AppState { http, proxy, store, actualizador });
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
            commands::list_all,
            commands::list_save,
            commands::list_remove,
            commands::update_info,
            commands::update_state,
            commands::update_check,
            commands::update_apply,
        ])
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar Anime Watcher")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<AppState>().actualizador.al_salir();
            }
        });
}
