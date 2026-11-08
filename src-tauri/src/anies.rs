//! Importa el historial de ani-es (https://github.com/Zhuchii/ani-es).
//!
//! ani-es guarda en `~/ani-es/history.json` el título de JKAnime, el último episodio y por dónde
//! iba: `{ "Sousou no Frieren": { "last_cap": 5, "progress": "00:12:34" } }`. En Windows ani-es
//! corre dentro de WSL, así que también se busca en `\\wsl.localhost\<distro>\home\<usuario>`.
//! Cada título se busca en JKAnime para recuperar su ficha y su portada.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::{Result, msg};
use crate::jkanime;
use crate::store::{HistoryMark, Store};

#[derive(Debug, Deserialize)]
struct EntradaAniEs {
    #[serde(default)]
    last_cap: serde_json::Value,
    #[serde(default)]
    progress: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Visto {
    pub titulo: String,
    pub episodio: f64,
    /// Segundos.
    pub minuto: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Encontrado {
    pub ruta: String,
    pub animes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resultado {
    pub importados: usize,
    /// Títulos que no se encontraron en JKAnime.
    pub sin_encontrar: Vec<String>,
}

/// "00:12:34" → 754.
fn segundos(hms: &str) -> f64 {
    hms.trim()
        .split(':')
        .try_fold(0.0, |total, parte| parte.trim().parse::<f64>().ok().map(|n| total * 60.0 + n))
        .unwrap_or(0.0)
}

pub fn interpretar(texto: &str) -> Result<Vec<Visto>> {
    let mapa: BTreeMap<String, EntradaAniEs> =
        serde_json::from_str(texto).map_err(|e| msg(format!("El historial de ani-es no es válido: {e}")))?;
    Ok(mapa
        .into_iter()
        .filter_map(|(titulo, e)| {
            let episodio = match &e.last_cap {
                serde_json::Value::Number(n) => n.as_f64(),
                serde_json::Value::String(s) => s.trim().parse().ok(),
                _ => None,
            }
            .filter(|n| *n >= 1.0)?;
            let titulo = titulo.trim().to_owned();
            (!titulo.is_empty()).then(|| Visto {
                titulo,
                episodio,
                minuto: e.progress.as_deref().map(segundos).unwrap_or(0.0),
            })
        })
        .collect())
}

fn candidatos() -> Vec<PathBuf> {
    let mut rutas = Vec::new();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        rutas.push(Path::new(&home).join("ani-es").join("history.json"));
    }
    // Windows: ani-es se instala en WSL.
    if cfg!(windows) {
        for raiz in [r"\\wsl.localhost", r"\\wsl$"] {
            let Ok(distros) = std::fs::read_dir(raiz) else { continue };
            for distro in distros.flatten() {
                let Ok(usuarios) = std::fs::read_dir(distro.path().join("home")) else { continue };
                for usuario in usuarios.flatten() {
                    rutas.push(usuario.path().join("ani-es").join("history.json"));
                }
            }
            break;
        }
    }
    rutas
}

/// El historial de ani-es de este equipo, si lo hay y tiene algo.
pub fn buscar() -> Option<(PathBuf, Vec<Visto>)> {
    candidatos().into_iter().find_map(|ruta| {
        let vistos = interpretar(&std::fs::read_to_string(&ruta).ok()?).ok()?;
        (!vistos.is_empty()).then_some((ruta, vistos))
    })
}

fn normalizar(t: &str) -> String {
    t.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Busca cada título en JKAnime y lo añade al historial (con el episodio y el minuto).
pub async fn importar(client: &Client, store: &Store, vistos: Vec<Visto>) -> Result<Resultado> {
    let mut resultado = Resultado { importados: 0, sin_encontrar: Vec::new() };
    // De cuatro en cuatro para no saturar JKAnime.
    for grupo in vistos.chunks(4) {
        let busquedas = grupo.iter().map(|v| jkanime::search(client, &v.titulo));
        let respuestas = futures_util::future::join_all(busquedas).await;
        for (visto, respuesta) in grupo.iter().zip(respuestas) {
            let tarjetas = respuesta.unwrap_or_default();
            let buscado = normalizar(&visto.titulo);
            let Some(anime) = tarjetas.iter().find(|a| normalizar(&a.title) == buscado).or(tarjetas.first()) else {
                resultado.sin_encontrar.push(visto.titulo.clone());
                continue;
            };
            let episodio_url = format!("{}/{}/", anime.url.trim_end_matches('/'), visto.episodio);
            store.mark(HistoryMark {
                anime_url: anime.url.clone(),
                title: anime.title.clone(),
                cover: anime.cover.clone(),
                episode: visto.episodio,
                episode_url: episodio_url.clone(),
                total_episodes: None,
                airing: false,
            })?;
            if visto.minuto > 0.0 {
                store.save_position(&anime.url, &episodio_url, visto.minuto, 0.0)?;
            }
            resultado.importados += 1;
        }
    }
    Ok(resultado)
}

pub fn encontrado() -> Option<Encontrado> {
    buscar().map(|(ruta, vistos)| Encontrado { ruta: ruta.display().to_string(), animes: vistos.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lee_el_historial_de_ani_es() {
        let texto = r#"{
            "Sousou no Frieren": { "last_cap": 5, "progress": "00:12:34" },
            "One Piece": { "last_cap": "1100", "progress": "" },
            "Roto": { "last_cap": null }
        }"#;
        let mut v = interpretar(texto).unwrap();
        v.sort_by(|a, b| a.titulo.cmp(&b.titulo));
        assert_eq!(v.len(), 2);
        assert_eq!(v[0], Visto { titulo: "One Piece".into(), episodio: 1100.0, minuto: 0.0 });
        assert_eq!(v[1], Visto { titulo: "Sousou no Frieren".into(), episodio: 5.0, minuto: 754.0 });
        assert!(interpretar("no es json").is_err());
        assert_eq!(normalizar("Kimi no Na wa."), "kiminonawa");
    }

    /// `cargo test -- --ignored importa_de_verdad --nocapture`
    #[tokio::test]
    #[ignore]
    async fn importa_de_verdad() {
        let dir = std::env::temp_dir().join(format!("aw-anies-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("ani-es")).unwrap();
        std::fs::write(
            dir.join("ani-es/history.json"),
            r#"{"Sousou no Frieren": {"last_cap": 5, "progress": "00:12:34"}, "Kimi no Na wa.": {"last_cap": 1, "progress": "00:00:00"}, "Esto no existe xyzzy": {"last_cap": 2}}"#,
        )
        .unwrap();
        // SAFETY: test aislado, nada más lee HOME a la vez.
        unsafe { std::env::set_var("HOME", &dir) };
        let (ruta, vistos) = buscar().expect("lo encuentra en ~/ani-es");
        println!("{} → {} animés", ruta.display(), vistos.len());
        let store = Store::open(dir.join("datos"));
        let c = crate::http::scraper_client().unwrap();
        let r = importar(&c, &store, vistos).await.unwrap();
        println!("importados {} · sin encontrar {:?}", r.importados, r.sin_encontrar);
        for e in store.history() {
            println!("  {} · EP {} · {} · minuto {}", e.title, e.last_episode, e.last_episode_url, e.position);
        }
        assert_eq!(r.importados, 2);
        let frieren = store.history().into_iter().find(|e| e.title == "Sousou no Frieren").unwrap();
        assert_eq!(frieren.last_episode_url, "https://jkanime.net/sousou-no-frieren/5/");
        assert_eq!(frieren.position, 754.0);
        // El episodio importado existe y tiene servidores.
        let ep = jkanime::episode(&c, &frieren.last_episode_url).await.unwrap();
        assert!(!ep.servers.is_empty());
    }
}
