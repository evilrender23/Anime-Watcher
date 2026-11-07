//! Comandos invocados desde la interfaz (ver `src/api.ts`).

use std::collections::BTreeMap;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::Result;
use crate::extract::{self, Stream, StreamKind};
use crate::player::{self, Detected, External};
use crate::proxy::Proxy;
use crate::site::{self, AnimeCard, AnimeDetail, EpisodeCard, EpisodeInfo};
use crate::store::{HistoryEntry, HistoryMark, ListEntry, ListUpdate, Settings, Store};
use crate::update::{self, Actualizador, Estado, VersionInstalada};

pub struct AppState {
    pub http: Client,
    pub proxy: Proxy,
    pub store: Store,
    pub actualizador: Actualizador,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedStream {
    pub server: String,
    pub kind: StreamKind,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub proxy_url: String,
}

#[tauri::command]
pub async fn latest(state: State<'_, AppState>) -> Result<Vec<EpisodeCard>> {
    site::latest(&state.http).await
}

#[tauri::command]
pub async fn search(state: State<'_, AppState>, query: String) -> Result<Vec<AnimeCard>> {
    site::search(&state.http, &query).await
}

#[tauri::command]
pub async fn anime(state: State<'_, AppState>, url: String) -> Result<AnimeDetail> {
    site::anime(&state.http, &url).await
}

#[tauri::command]
pub async fn episode(state: State<'_, AppState>, url: String) -> Result<EpisodeInfo> {
    site::episode(&state.http, &url).await
}

#[tauri::command]
pub async fn resolve(state: State<'_, AppState>, name: String, url: String) -> Result<ResolvedStream> {
    let stream = extract::resolve(&state.http, &name, &url).await?;
    let proxy_url = state.proxy.register(&stream.url, &stream.headers);
    Ok(ResolvedStream {
        server: name,
        kind: stream.kind,
        url: stream.url,
        headers: stream.headers,
        proxy_url,
    })
}

#[tauri::command]
pub fn play_external(
    state: State<'_, AppState>,
    stream: ResolvedStream,
    title: String,
    player: External,
) -> Result<String> {
    let settings = state.store.settings();
    let manual = match player {
        External::Mpv => settings.mpv_path.as_deref(),
        External::Vlc => settings.vlc_path.as_deref(),
    };
    let stream = Stream { kind: stream.kind, url: stream.url, headers: stream.headers };
    player::launch(player, manual, &stream, &title)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.store.settings()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<()> {
    state.store.save_settings(settings)
}

#[tauri::command]
pub fn detect_players(state: State<'_, AppState>) -> Detected {
    let settings = state.store.settings();
    player::detect(settings.mpv_path.as_deref(), settings.vlc_path.as_deref())
}

#[tauri::command]
pub fn history_list(state: State<'_, AppState>) -> Vec<HistoryEntry> {
    state.store.history()
}

#[tauri::command]
pub fn history_mark(state: State<'_, AppState>, mark: HistoryMark) -> Result<HistoryEntry> {
    state.store.mark(mark)
}

#[tauri::command]
pub fn history_remove(state: State<'_, AppState>, anime_url: String) -> Result<()> {
    state.store.remove(&anime_url)
}

#[tauri::command]
pub fn list_all(state: State<'_, AppState>) -> Vec<ListEntry> {
    state.store.list()
}

#[tauri::command]
pub fn list_save(state: State<'_, AppState>, update: ListUpdate) -> Result<ListEntry> {
    state.store.list_save(update)
}

#[tauri::command]
pub fn list_remove(state: State<'_, AppState>, anime_url: String) -> Result<()> {
    state.store.list_remove(&anime_url)
}

/// Commit, rama y fecha de esta copia; `None` en una compilación de desarrollo.
#[tauri::command]
pub fn update_info() -> Option<VersionInstalada> {
    update::version_instalada()
}

#[tauri::command]
pub fn update_state(state: State<'_, AppState>) -> Estado {
    state.actualizador.estado()
}

/// Busca en segundo plano; el resultado llega con el evento `actualizacion`.
#[tauri::command]
pub fn update_check(state: State<'_, AppState>, install: bool) {
    state.actualizador.buscar_ahora(install);
}

/// Cierra la app para que el instalador cambie a la versión lista y la vuelva a abrir.
#[tauri::command]
pub fn update_apply(app: tauri::AppHandle, state: State<'_, AppState>) {
    state.actualizador.aplicar();
    app.exit(0);
}
