//! Comandos invocados desde la interfaz (ver `src/api.ts`).

use std::collections::BTreeMap;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::error::Result;
use crate::extract::{self, Stream, StreamKind};
use crate::jkanime;
use crate::player::{self, Detected, External};
use crate::proxy::Proxy;
use crate::site::{self, AnimeCard, AnimeDetail, EpisodeCard, EpisodeInfo};
use crate::store::{HistoryEntry, HistoryMark, ListEntry, ListUpdate, Settings, Store};
use crate::update::{self, Actualizador, Canal, Estado, VersionInstalada};

pub struct AppState {
    pub http: Client,
    pub proxy: Proxy,
    pub store: Store,
    pub actualizador: Actualizador,
    /// Lo pedido en la línea de comandos; se entrega una sola vez.
    pub inicio: std::sync::Mutex<Option<crate::cli::Inicio>>,
}

/// ¿Hay historial de ani-es en este equipo? (para ofrecer importarlo en Ajustes)
#[tauri::command]
pub fn ani_es_found() -> Option<crate::anies::Encontrado> {
    crate::anies::encontrado()
}

/// Importa el historial de ani-es buscando cada título en JKAnime.
#[tauri::command]
pub async fn ani_es_import(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<crate::anies::Resultado> {
    let (_, vistos) = crate::anies::buscar().ok_or_else(|| crate::error::msg("No se encontró el historial de ani-es."))?;
    let resultado = crate::anies::importar(&state.http, &state.store, vistos).await?;
    let _ = tauri::Emitter::emit(&app, EVENTO_HISTORIAL, ());
    Ok(resultado)
}

/// Búsqueda o "continuar" pedidos al abrir la app (`anime-watcher naruto`, `anime-watcher -c`).
#[tauri::command]
pub fn startup_action(state: State<'_, AppState>) -> crate::cli::Inicio {
    state.inicio.lock().unwrap().take().unwrap_or_default()
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

/// Busca a la vez en MonosChinos y en JKAnime. Si una fuente falla se devuelve la otra; sólo es
/// un error si fallan las dos. La interfaz agrupa los resultados por el dominio de cada URL.
#[tauri::command]
pub async fn search(state: State<'_, AppState>, query: String) -> Result<Vec<AnimeCard>> {
    let (monos, jk) = tokio::join!(site::search(&state.http, &query), jkanime::search(&state.http, &query));
    match (monos, jk) {
        (Err(e), Err(_)) => Err(e),
        (monos, jk) => Ok(monos.unwrap_or_default().into_iter().chain(jk.unwrap_or_default()).collect()),
    }
}

/// La ficha y el episodio se piden a la fuente de la URL.
#[tauri::command]
pub async fn anime(state: State<'_, AppState>, url: String) -> Result<AnimeDetail> {
    if jkanime::es_suya(&url) { jkanime::anime(&state.http, &url).await } else { site::anime(&state.http, &url).await }
}

#[tauri::command]
pub async fn episode(state: State<'_, AppState>, url: String) -> Result<EpisodeInfo> {
    if jkanime::es_suya(&url) { jkanime::episode(&state.http, &url).await } else { site::episode(&state.http, &url).await }
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

/// Episodio que se abre en un reproductor externo, para retomarlo y guardar el minuto.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seguimiento {
    pub anime_url: String,
    pub episode_url: String,
    #[serde(default)]
    pub start: f64,
}

/// Se emite cuando cambia el historial desde el backend (p. ej. al cerrar mpv).
pub const EVENTO_HISTORIAL: &str = "historial";

#[tauri::command]
pub fn play_external(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    stream: ResolvedStream,
    title: String,
    player: External,
    seguimiento: Option<Seguimiento>,
) -> Result<String> {
    let settings = state.store.settings();
    let manual = match player {
        External::Mpv => settings.mpv_path.as_deref(),
        External::Vlc => settings.vlc_path.as_deref(),
    };
    let stream = Stream { kind: stream.kind, url: stream.url, headers: stream.headers };
    let start = seguimiento.as_ref().map_or(0.0, |s| s.start);
    // Con mpv se sabe por dónde se quedó al cerrarlo (como hace ani-es).
    let carpeta = (player == External::Mpv && seguimiento.is_some())
        .then(|| std::env::temp_dir().join(format!("anime-watcher-mpv-{}", uuid::Uuid::new_v4())));
    if let Some(c) = &carpeta {
        let _ = std::fs::create_dir_all(c);
    }
    let (ruta, mut proceso) = player::launch(player, manual, &stream, &title, start, carpeta.as_deref())?;
    if let (Some(carpeta), Some(seguimiento)) = (carpeta, seguimiento) {
        std::thread::spawn(move || {
            let terminado_bien = proceso.wait().map(|s| s.success()).unwrap_or(false);
            let minuto = player::leer_minuto_mpv(&carpeta);
            let _ = std::fs::remove_dir_all(&carpeta);
            // Si mpv no pudo abrir el video no hay nada que guardar.
            let (true, Some(minuto)) = (terminado_bien, minuto) else { return };
            let estado = app.state::<AppState>();
            if let Ok(true) = estado.store.save_position(&seguimiento.anime_url, &seguimiento.episode_url, minuto, 0.0) {
                let _ = tauri::Emitter::emit(&app, EVENTO_HISTORIAL, ());
            }
        });
    }
    Ok(ruta)
}

/// Por dónde va el episodio en el reproductor integrado (cada pocos segundos y al pausar). No
/// avisa a la interfaz: es ella quien lo manda.
#[tauri::command]
pub fn history_position(
    state: State<'_, AppState>,
    anime_url: String,
    episode_url: String,
    position: f64,
    duration: f64,
) -> Result<()> {
    state.store.save_position(&anime_url, &episode_url, position, duration)?;
    Ok(())
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

/// Instalador (se actualiza sola), release (avisa de releases nuevos) o desarrollo.
#[tauri::command]
pub fn update_channel() -> Canal {
    update::canal()
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
