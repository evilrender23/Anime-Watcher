//! Ajustes e historial guardados como JSON en la carpeta de datos de la aplicación
//! (`%APPDATA%\com.anicli-es.desktop`).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// Animés recordados en el historial.
const MAX_HISTORY: usize = 200;

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
}

impl Default for Settings {
    fn default() -> Self {
        Settings { player: PlayerKind::Builtin, mpv_path: None, vlc_path: None, auto_next: true }
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
}

pub struct Store {
    dir: PathBuf,
    settings: Mutex<Settings>,
    /// Más reciente primero.
    history: Mutex<Vec<HistoryEntry>>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Self {
        let settings = load(&dir.join("settings.json")).unwrap_or_default();
        let history = load(&dir.join("history.json")).unwrap_or_default();
        Store { dir, settings: Mutex::new(settings), history: Mutex::new(history) }
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

    /// Marca un episodio como visto y mueve el animé al principio del historial.
    pub fn mark(&self, mark: HistoryMark) -> Result<HistoryEntry> {
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
        }
    }

    #[test]
    fn mark_moves_anime_to_front_and_persists() {
        let dir = std::env::temp_dir().join(format!("anicli-es-test-{}", uuid::Uuid::new_v4()));
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
}
