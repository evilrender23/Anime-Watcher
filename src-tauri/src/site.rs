//! Extracción de datos de MonosChinos (antes monoschinos2.com, ahora monoschinos.st).

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use regex::Regex;
use reqwest::Client;
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};

use crate::error::{Result, msg};
use crate::extract::{self, Support};
use crate::http::get_page;

pub const BASE: &str = "https://monoschinos.st";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeCard {
    pub title: String,
    pub number: f64,
    pub url: String,
    pub thumb: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeCard {
    pub title: String,
    pub url: String,
    pub cover: Option<String>,
    pub year: Option<String>,
    pub kind: Option<String>,
    pub genre: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub number: f64,
    pub url: String,
    pub thumb: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeDetail {
    pub url: String,
    pub title: String,
    pub alt_title: Option<String>,
    pub cover: Option<String>,
    pub status: Option<String>,
    pub genres: Vec<String>,
    pub synopsis: Option<String>,
    /// "Anime", "Película", "OVA"… si la fuente lo indica.
    pub kind: Option<String>,
    /// Temporada de emisión ("Primavera 2017").
    pub season: Option<String>,
    /// Otras temporadas y relacionados que enlaza la propia fuente (JKAnime).
    pub related: Vec<Related>,
    pub episodes: Vec<Episode>,
}

/// Animé enlazado desde una ficha: precuela, secuela, película…
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Related {
    pub title: String,
    pub url: String,
    /// "Precuela", "Secuela", "Adaptación"… tal cual lo escribe la fuente.
    pub relation: String,
    /// "Serie", "Pelicula", "OVA"…
    pub kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub name: String,
    pub url: String,
    pub support: Support,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeInfo {
    pub url: String,
    pub anime_title: String,
    pub number: Option<f64>,
    pub anime_url: Option<String>,
    pub servers: Vec<Server>,
}

fn sel(css: &str) -> Selector {
    Selector::parse(css).expect("selector CSS válido")
}

static EPISODE_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"-episodio-(\d+(?:\.\d+)?)/?$").unwrap());

/// Número de episodio a partir de `/ver/<slug>-episodio-<n>`.
fn episode_number(url: &str) -> Option<f64> {
    EPISODE_NUMBER.captures(url)?.get(1)?.as_str().parse().ok()
}

fn text_of(el: ElementRef) -> String {
    el.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn non_empty(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

/// Las imágenes usan carga diferida: la real está en `data-src`.
fn image_of(el: ElementRef) -> Option<String> {
    let img = el.select(&sel("img")).next()?;
    img.attr("data-src")
        .or_else(|| img.attr("src"))
        .map(str::to_owned)
}

// ---------------------------------------------------------------- portada

pub async fn latest(client: &Client) -> Result<Vec<EpisodeCard>> {
    let page = get_page(client, BASE, None).await?;
    Ok(parse_latest(&page.body))
}

fn parse_latest(html: &str) -> Vec<EpisodeCard> {
    let doc = Html::parse_document(html);
    let mut seen = std::collections::HashSet::new();
    doc.select(&sel(r#"article a[href*="/ver/"]"#))
        .filter_map(|a| {
            let url = a.attr("href")?.to_owned();
            let number = episode_number(&url)?;
            let title = text_of(a.select(&sel("h3")).next()?);
            if title.is_empty() || !seen.insert(url.clone()) {
                return None;
            }
            Some(EpisodeCard { title, number, thumb: image_of(a), url })
        })
        .collect()
}

// ---------------------------------------------------------------- búsqueda

pub async fn search(client: &Client, query: &str) -> Result<Vec<AnimeCard>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut url = url::Url::parse(BASE).unwrap();
    url.set_path("/buscar");
    url.query_pairs_mut().append_pair("q", query);
    let page = get_page(client, url.as_str(), None).await?;
    Ok(parse_search(&page.body))
}

fn parse_search(html: &str) -> Vec<AnimeCard> {
    let doc = Html::parse_document(html);
    doc.select(&sel(r#"article a[href*="/anime/"]"#))
        .filter_map(|a| {
            let url = a.attr("href")?.to_owned();
            let title = text_of(a.select(&sel("h3")).next()?);
            if title.is_empty() {
                return None;
            }
            let kind = a
                .select(&sel(r#"div[class*="uppercase"]"#))
                .next()
                .map(text_of)
                .and_then(non_empty);
            // Línea de metadatos: <span>año</span><span separador/><span>género</span>
            let meta: Vec<String> = a
                .select(&sel(r#"div[class*="font-mono"] span"#))
                .map(text_of)
                .filter(|t| !t.is_empty())
                .collect();
            let year = meta
                .iter()
                .find(|t| t.len() == 4 && t.chars().all(|c| c.is_ascii_digit()))
                .cloned();
            let genre = meta.iter().rev().find(|t| Some(*t) != year.as_ref()).cloned();
            Some(AnimeCard { title, cover: image_of(a), url, year, kind, genre })
        })
        .collect()
}

// ---------------------------------------------------------------- ficha del animé

pub async fn anime(client: &Client, url: &str) -> Result<AnimeDetail> {
    let page = get_page(client, url, None).await?;
    let (mut detail, ajax) = parse_anime(&page.body, page.url.as_str())?;
    if let Some(ajax) = ajax {
        detail.episodes = episodes(client, &ajax).await?;
    }
    Ok(detail)
}

/// Devuelve la ficha (sin episodios) y la URL de la lista de episodios.
fn parse_anime(html: &str, url: &str) -> Result<(AnimeDetail, Option<String>)> {
    let doc = Html::parse_document(html);
    let title = doc
        .select(&sel("h1"))
        .map(text_of)
        .find(|t| !t.is_empty())
        .ok_or_else(|| msg("La página del animé no tiene el formato esperado."))?;
    let alt_title = doc.select(&sel("h1 + div")).next().map(text_of).and_then(non_empty);
    let poster = doc.select(&sel(r#"img[data-src*="/thumbs/imagen/"]"#)).next();
    let cover = poster
        .and_then(|img| img.attr("data-src").map(str::to_owned))
        .or_else(|| {
            doc.select(&sel(r#"meta[property="og:image"]"#))
                .next()
                .and_then(|m| m.attr("content").map(str::to_owned))
        });
    // La etiqueta de estado ("Finalizado", "En emisión") va encima del póster.
    let status = doc
        .select(&sel(r#"img[data-src*="/thumbs/imagen/"] ~ div"#))
        .next()
        .map(text_of)
        .and_then(non_empty);
    // Los géneros aparecen dos veces (cabecera y pestaña de información).
    let mut genres: Vec<String> = Vec::new();
    for genre in doc.select(&sel(r#"a[href*="/genero/"]"#)).map(text_of) {
        if !genre.is_empty() && !genres.contains(&genre) {
            genres.push(genre);
        }
    }
    let synopsis = doc
        .select(&sel("#tab-info p"))
        .chain(doc.select(&sel("h1 ~ p")))
        .map(|p| p.text().collect::<String>().trim().to_owned())
        .find(|t| !t.is_empty());
    let ajax = doc
        .select(&sel("section.caplist[data-ajax]"))
        .next()
        .and_then(|s| s.attr("data-ajax").map(str::to_owned));
    let kind = info_field(&doc, "Tipo");
    let season = info_field(&doc, "Temporada");

    let detail = AnimeDetail {
        url: url.to_owned(),
        title,
        alt_title,
        cover,
        status,
        genres,
        synopsis,
        kind,
        season,
        related: Vec::new(),
        episodes: Vec::new(),
    };
    Ok((detail, ajax))
}

/// Valor de la pestaña "Información": `<dt>Temporada</dt><dd>Primavera 2017</dd>`.
fn info_field(doc: &Html, label: &str) -> Option<String> {
    let dt = doc.select(&sel("dl dt")).find(|dt| text_of(*dt).eq_ignore_ascii_case(label))?;
    let dd = dt.next_siblings().find_map(ElementRef::wrap)?;
    if dd.value().name() != "dd" {
        return None;
    }
    non_empty(text_of(dd))
}

#[derive(Deserialize)]
struct Pagination {
    paginate_url: String,
    perpage: serde_json::Value,
    eps: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct CapList {
    caps: Vec<Cap>,
}

#[derive(Deserialize)]
struct Cap {
    episodio: serde_json::Value,
    url: String,
    thumb: Option<String>,
}

fn json_number(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// La lista de episodios se pagina en bloques de `perpage` (50) desde `/ajax/caplist/<id>?p=N`.
async fn episodes(client: &Client, ajax_url: &str) -> Result<Vec<Episode>> {
    let pagination: Pagination = client.get(ajax_url).send().await?.error_for_status()?.json().await?;
    let total = pagination.eps.len();
    if total == 0 {
        return Ok(Vec::new());
    }
    let per_page = json_number(&pagination.perpage).filter(|n| *n >= 1.0).unwrap_or(50.0) as usize;
    let pages = total.div_ceil(per_page);

    let requests = (1..=pages).map(|page| {
        let req = client.get(&pagination.paginate_url).query(&[("p", page)]);
        async move {
            let list: CapList = req.send().await?.error_for_status()?.json().await?;
            Ok::<_, crate::error::Error>(list.caps)
        }
    });
    let mut episodes: Vec<Episode> = futures_util::future::try_join_all(requests)
        .await?
        .into_iter()
        .flatten()
        .filter_map(|cap| {
            let number = json_number(&cap.episodio).or_else(|| episode_number(&cap.url))?;
            Some(Episode { number, url: cap.url, thumb: cap.thumb })
        })
        .collect();
    episodes.sort_by(|a, b| a.number.total_cmp(&b.number));
    episodes.dedup_by(|a, b| a.url == b.url);
    Ok(episodes)
}

// ---------------------------------------------------------------- episodio

pub async fn episode(client: &Client, url: &str) -> Result<EpisodeInfo> {
    let page = get_page(client, url, None).await?;
    parse_episode(&page.body, page.url.as_str())
}

fn parse_episode(html: &str, url: &str) -> Result<EpisodeInfo> {
    let doc = Html::parse_document(html);
    let anime_link = doc
        .select(&sel(r#"a[href*="/anime/"]"#))
        .find(|a| !text_of(*a).is_empty());
    let anime_url = anime_link.and_then(|a| a.attr("href").map(str::to_owned));
    let anime_title = anime_link
        .map(text_of)
        .or_else(|| doc.select(&sel("h2")).next().map(text_of))
        .filter(|t| !t.is_empty())
        .ok_or_else(|| msg("La página del episodio no tiene el formato esperado."))?;

    // Cada servidor es un botón con la URL del reproductor en base64.
    let mut servers: Vec<(u8, Server)> = doc
        .select(&sel("[data-player]"))
        .filter_map(|b| {
            let bytes = STANDARD.decode(b.attr("data-player")?.trim()).ok()?;
            let embed = String::from_utf8(bytes).ok()?.trim().to_owned();
            if !embed.starts_with("http") {
                return None;
            }
            let name = text_of(b);
            let name = if name.is_empty() { host_name(&embed) } else { name };
            let host = extract::classify(&name, &embed);
            Some((host.rank(), Server { support: host.support(), name, url: embed }))
        })
        .collect();
    // Orden estable: primero los servidores que sabemos extraer, del más fiable al menos.
    servers.sort_by_key(|(rank, _)| *rank);

    Ok(EpisodeInfo {
        url: url.to_owned(),
        anime_title,
        number: episode_number(url),
        anime_url,
        servers: servers.into_iter().map(|(_, s)| s).collect(),
    })
}

fn host_name(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| "servidor".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lee_tipo_y_temporada() {
        let html = r#"<h1>Shingeki no Kyojin Temporada 2</h1><div>Attack on Titan Season 2</div>
            <dl><dt class="a">Tipo</dt><dd>Anime</dd> <dt>Estado</dt><dd>Finalizado</dd>
            <dt>Temporada</dt><dd class="x">Primavera 2017</dd></dl>"#;
        let (d, _) = parse_anime(html, "https://monoschinos.st/anime/x").unwrap();
        assert_eq!(d.kind.as_deref(), Some("Anime"));
        assert_eq!(d.season.as_deref(), Some("Primavera 2017"));
        assert!(d.related.is_empty());
    }

    /// `cargo test -- --ignored temporadas_real --nocapture`
    #[tokio::test]
    #[ignore]
    async fn temporadas_real() {
        let c = crate::http::scraper_client().unwrap();
        let m = anime(&c, "https://monoschinos.st/anime/Shingeki-no-Kyojin-temporada-2-sub-espanol").await.unwrap();
        println!("monos: {} · {:?} · {:?} · {} eps", m.title, m.kind, m.season, m.episodes.len());
        assert_eq!(m.season.as_deref(), Some("Primavera 2017"));
        let j = crate::jkanime::anime(&c, "https://jkanime.net/shingeki-no-kyojin-season-2/").await.unwrap();
        println!("jk: {} · {:?} · {:?}", j.title, j.kind, j.season);
        for r in &j.related {
            println!("  {} → {} ({:?}) {}", r.relation, r.title, r.kind, r.url);
        }
        assert!(j.related.iter().any(|r| r.relation == "Secuela"));
    }
}
