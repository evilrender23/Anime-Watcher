//! Ajustes, historial y lista personal guardados como JSON en la carpeta de datos de la aplicación
//! (`%APPDATA%\com.evilrender23.animewatcher` en Windows).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// Animés recordados en el historial.
const MAX_HISTORY: usize = 200;

/// Identificador de las versiones que se llamaban "anicli-es"; su carpeta de datos es hermana de la actual.
const LEGACY_IDENTIFIER: &str = "com.anicli-es.desktop";

/// Copia los ajustes y el historial de la carpeta de "anicli-es" que aún no existan en `dir`.
/// Nunca sobrescribe datos nuevos; los fallos sólo se registran para no impedir el arranque.
pub fn migrate_legacy(dir: &Path) {
    let Some(legacy) = dir.parent().map(|parent| parent.join(LEGACY_IDENTIFIER)) else {
        return;
    };
    for name in ["settings.json", "history.json"] {
        let (from, to) = (legacy.join(name), dir.join(name));
        if !from.is_file() || to.exists() {
            continue;
        }
        if let Err(err) = fs::create_dir_all(dir).and_then(|()| fs::copy(&from, &to)) {
            eprintln!("no se pudo migrar {}: {err}", from.display());
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PlayerKind {
    #[default]
    Builtin,
    Mpv,
    Vlc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub player: PlayerKind,
    pub mpv_path: Option<String>,
    pub vlc_path: Option<String>,
    pub auto_next: bool,
    /// Buscar y compilar versiones nuevas en segundo plano (ver `update.rs`).
    pub auto_update: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { player: PlayerKind::Builtin, mpv_path: None, vlc_path: None, auto_next: true, auto_update: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub anime_url: String,
    pub title: String,
    pub cover: Option<String>,
    pub last_episode: f64,
    pub last_episode_url: String,
    pub watched: Vec<f64>,
    pub updated_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMark {
    pub anime_url: String,
    pub title: String,
    pub cover: Option<String>,
    pub episode: f64,
    pub episode_url: String,
    /// Episodios publicados del animé, si se conocen (para la lista personal).
    #[serde(default)]
    pub total_episodes: Option<u32>,
    /// En emisión: el total aún puede crecer, así que no se marca como completado.
    #[serde(default)]
    pub airing: bool,
}

/// Estado de un animé en la lista personal (como en MyAnimeList).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListStatus {
    Watching,
    Completed,
    OnHold,
    Dropped,
    PlanToWatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub anime_url: String,
    pub title: String,
    pub cover: Option<String>,
    pub status: ListStatus,
    /// Nota del 1 al 10; `None` = sin puntuar.
    pub score: Option<u8>,
    /// Episodios vistos.
    pub progress: u32,
    /// Episodios totales; `None` = desconocido (p. ej. en emisión).
    pub total: Option<u32>,
    #[serde(default)]
    pub notes: String,
    pub added_at: u64,
    pub updated_at: u64,
}

/// Cambios enviados desde la interfaz al añadir o editar una entrada de la lista.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListUpdate {
    pub anime_url: String,
    pub title: String,
    pub cover: Option<String>,
    pub status: ListStatus,
    pub score: Option<u8>,
    pub progress: u32,
    pub total: Option<u32>,
    #[serde(default)]
    pub notes: String,
}

pub struct Store {
    dir: PathBuf,
    settings: Mutex<Settings>,
    /// Más reciente primero.
    history: Mutex<Vec<HistoryEntry>>,
    /// Lista personal, editada más recientemente primero.
    list: Mutex<Vec<ListEntry>>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Self {
        let settings = load(&dir.join("settings.json")).unwrap_or_default();
        let history = load(&dir.join("history.json")).unwrap_or_default();
        let list = load(&dir.join("list.json")).unwrap_or_default();
        Store { dir, settings: Mutex::new(settings), history: Mutex::new(history), list: Mutex::new(list) }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn save_settings(&self, settings: Settings) -> Result<()> {
        let settings = Settings {
            mpv_path: clean(settings.mpv_path),
            vlc_path: clean(settings.vlc_path),
            ..settings
        };
        let mut current = self.settings.lock().unwrap();
        save(&self.dir, "settings.json", &settings)?;
        *current = settings;
        Ok(())
    }

    pub fn history(&self) -> Vec<HistoryEntry> {
        self.history.lock().unwrap().clone()
    }

    /// Marca un episodio como visto, mueve el animé al principio del historial y
    /// actualiza la lista personal (ver [`Store::sync_list`]).
    pub fn mark(&self, mark: HistoryMark) -> Result<HistoryEntry> {
        self.sync_list(&mark)?;
        let mut history = self.history.lock().unwrap();
        let mut entry = match history.iter().position(|e| e.anime_url == mark.anime_url) {
            Some(i) => history.remove(i),
            None => HistoryEntry {
                anime_url: mark.anime_url.clone(),
                title: String::new(),
                cover: None,
                last_episode: mark.episode,
                last_episode_url: String::new(),
                watched: Vec::new(),
                updated_at: 0,
            },
        };
        entry.title = mark.title;
        if mark.cover.is_some() {
            entry.cover = mark.cover;
        }
        entry.last_episode = mark.episode;
        entry.last_episode_url = mark.episode_url;
        if !entry.watched.contains(&mark.episode) {
            entry.watched.push(mark.episode);
            entry.watched.sort_by(f64::total_cmp);
        }
        entry.updated_at = now_millis();
        history.insert(0, entry.clone());
        history.truncate(MAX_HISTORY);
        save(&self.dir, "history.json", &*history)?;
        Ok(entry)
    }

    pub fn remove(&self, anime_url: &str) -> Result<()> {
        let mut history = self.history.lock().unwrap();
        history.retain(|e| e.anime_url != anime_url);
        save(&self.dir, "history.json", &*history)
    }

    pub fn list(&self) -> Vec<ListEntry> {
        self.list.lock().unwrap().clone()
    }

    /// Añade o edita una entrada de la lista y la mueve al principio.
    pub fn list_save(&self, update: ListUpdate) -> Result<ListEntry> {
        let mut list = self.list.lock().unwrap();
        let now = now_millis();
        let added_at = match list.iter().position(|e| e.anime_url == update.anime_url) {
            Some(i) => list.remove(i).added_at,
            None => now,
        };
        let total = update.total.filter(|&t| t > 0);
        let mut progress = update.progress;
        if let Some(total) = total {
            progress = progress.min(total);
            // Como en MyAnimeList: completado implica todos los episodios vistos.
            if update.status == ListStatus::Completed {
                progress = total;
            }
        }
        let entry = ListEntry {
            anime_url: update.anime_url,
            title: update.title,
            cover: update.cover,
            status: update.status,
            score: update.score.filter(|s| (1..=10).contains(s)),
            progress,
            total,
            notes: update.notes.trim().to_owned(),
            added_at,
            updated_at: now,
        };
        list.insert(0, entry.clone());
        save(&self.dir, "list.json", &*list)?;
        Ok(entry)
    }

    pub fn list_remove(&self, anime_url: &str) -> Result<()> {
        let mut list = self.list.lock().unwrap();
        list.retain(|e| e.anime_url != anime_url);
        save(&self.dir, "list.json", &*list)
    }

    /// Al ver un episodio: añade el animé a la lista como "Viendo" si no estaba, sube el
    /// progreso, pasa "Planeo ver"/"En espera" a "Viendo" y, si se terminó un animé ya
    /// finalizado, lo marca como completado.
    fn sync_list(&self, mark: &HistoryMark) -> Result<()> {
        let mut list = self.list.lock().unwrap();
        let now = now_millis();
        let episode = if mark.episode.is_finite() && mark.episode >= 1.0 { mark.episode.floor() as u32 } else { 0 };
        let total = mark.total_episodes.filter(|&t| t > 0);
        let mut entry = match list.iter().position(|e| e.anime_url == mark.anime_url) {
            Some(i) => list.remove(i),
            None => ListEntry {
                anime_url: mark.anime_url.clone(),
                title: mark.title.clone(),
                cover: None,
                status: ListStatus::Watching,
                score: None,
                progress: 0,
                total: None,
                notes: String::new(),
                added_at: now,
                updated_at: now,
            },
        };
        entry.title = mark.title.clone();
        if mark.cover.is_some() {
            entry.cover = mark.cover.clone();
        }
        if !mark.airing && total.is_some() {
            entry.total = total;
        }
        entry.progress = entry.progress.max(episode);
        if let Some(total) = entry.total {
            entry.progress = entry.progress.min(total);
        }
        if matches!(entry.status, ListStatus::PlanToWatch | ListStatus::OnHold) {
            entry.status = ListStatus::Watching;
        }
        if entry.status == ListStatus::Watching && !mark.airing && entry.total.is_some_and(|t| entry.progress >= t) {
            entry.status = ListStatus::Completed;
        }
        entry.updated_at = now;
        list.insert(0, entry);
        save(&self.dir, "list.json", &*list)
    }
}

fn clean(path: Option<String>) -> Option<String> {
    path.map(|p| p.trim().trim_matches('"').to_owned()).filter(|p| !p.is_empty())
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn load<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(value) => Some(value),
        Err(err) => {
            eprintln!("ignorando {} dañado: {err}", path.display());
            None
        }
    }
}

/// Escritura atómica: archivo temporal + renombrado.
fn save<T: Serialize + ?Sized>(dir: &Path, name: &str, value: &T) -> Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(&tmp, dir.join(name))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(anime: &str, episode: f64) -> HistoryMark {
        HistoryMark {
            anime_url: anime.to_owned(),
            title: format!("Título {anime}"),
            cover: None,
            episode,
            episode_url: format!("{anime}-episodio-{episode}"),
            total_episodes: None,
            airing: false,
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("anime-watcher-{tag}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn watching_adds_to_list_and_completes_finished_anime() {
        let dir = temp_dir("list");
        let store = Store::open(dir.clone());
        store.mark(HistoryMark { total_episodes: Some(3), ..mark("a", 1.0) }).unwrap();
        let entry = &store.list()[0];
        assert_eq!((entry.status, entry.progress, entry.total), (ListStatus::Watching, 1, Some(3)));

        store.mark(HistoryMark { total_episodes: Some(3), ..mark("a", 3.0) }).unwrap();
        // Volver a un episodio anterior no baja el progreso.
        store.mark(HistoryMark { total_episodes: Some(3), ..mark("a", 2.0) }).unwrap();
        let entry = &Store::open(dir.clone()).list()[0];
        assert_eq!((entry.status, entry.progress), (ListStatus::Completed, 3));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn airing_anime_is_never_auto_completed() {
        let dir = temp_dir("airing");
        let store = Store::open(dir.clone());
        store.mark(HistoryMark { total_episodes: Some(5), airing: true, ..mark("a", 5.0) }).unwrap();
        let entry = &store.list()[0];
        assert_eq!((entry.status, entry.progress, entry.total), (ListStatus::Watching, 5, None));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn list_save_validates_and_keeps_added_at() {
        let dir = temp_dir("save");
        let store = Store::open(dir.clone());
        let update = |status, score, progress| ListUpdate {
            anime_url: "a".into(),
            title: "A".into(),
            cover: None,
            status,
            score,
            progress,
            total: Some(12),
            notes: "  nota  ".into(),
        };
        let first = store.list_save(update(ListStatus::PlanToWatch, Some(11), 40)).unwrap();
        assert_eq!((first.score, first.progress, first.notes.as_str()), (None, 12, "nota"));
        let done = store.list_save(update(ListStatus::Completed, Some(9), 2)).unwrap();
        assert_eq!((done.score, done.progress, done.added_at), (Some(9), 12, first.added_at));

        // Planeo ver → Viendo al reproducir un episodio.
        store.list_save(update(ListStatus::PlanToWatch, None, 0)).unwrap();
        store.mark(mark("a", 1.0)).unwrap();
        assert_eq!(store.list()[0].status, ListStatus::Watching);

        store.list_remove("a").unwrap();
        assert!(Store::open(dir.clone()).list().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mark_moves_anime_to_front_and_persists() {
        let dir = std::env::temp_dir().join(format!("anime-watcher-test-{}", uuid::Uuid::new_v4()));
        let store = Store::open(dir.clone());
        store.mark(mark("a", 1.0)).unwrap();
        store.mark(mark("b", 3.0)).unwrap();
        let entry = store.mark(mark("a", 2.0)).unwrap();
        store.mark(mark("a", 1.0)).unwrap();

        assert_eq!(entry.watched, vec![1.0, 2.0]);
        let reopened = Store::open(dir.clone());
        let history = reopened.history();
        assert_eq!(history.iter().map(|e| e.anime_url.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(history[0].last_episode, 1.0);
        assert_eq!(history[0].watched, vec![1.0, 2.0]);

        reopened.remove("a").unwrap();
        assert_eq!(Store::open(dir.clone()).history().len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrate_legacy_copies_only_missing_files() {
        let root = std::env::temp_dir().join(format!("anime-watcher-migrate-{}", uuid::Uuid::new_v4()));
        let legacy = root.join(LEGACY_IDENTIFIER);
        let dir = root.join("com.evilrender23.animewatcher");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(legacy.join("history.json"), "[\"antiguo\"]").unwrap();
        fs::write(legacy.join("settings.json"), "{\"player\":\"vlc\"}").unwrap();
        fs::write(dir.join("settings.json"), "{\"player\":\"mpv\"}").unwrap();

        migrate_legacy(&dir);
        migrate_legacy(&dir);

        assert_eq!(fs::read_to_string(dir.join("history.json")).unwrap(), "[\"antiguo\"]");
        assert_eq!(fs::read_to_string(dir.join("settings.json")).unwrap(), "{\"player\":\"mpv\"}");
        assert!(legacy.join("history.json").is_file(), "la carpeta antigua no se toca");
        fs::remove_dir_all(root).unwrap();
    }
}
