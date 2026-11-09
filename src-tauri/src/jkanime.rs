//! Segunda fuente: JKAnime (la que usa ani-es). Mismos tipos que `site.rs`, así que la interfaz
//! no distingue de dónde sale cada animé: las URLs de jkanime.net se envían aquí.
//!
//! - Búsqueda: `/buscar/<palabras_con_guion_bajo>/` (una sola página, hasta 30 resultados).
//! - Ficha: `/<slug>/`; los episodios se piden por POST a `/ajax/episodes/<id>/<p>` con el token
//!   CSRF y las cookies de la ficha (16 por página).
//! - Episodio: `/<slug>/<n>/`. Las películas son el episodio 1. El reproductor propio
//!   (`/jkplayer/um?...`) da un HLS y `var servers = [...]` lista los demás servidores con el
//!   enlace en base64.

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use regex::Regex;
use reqwest::Client;
use scraper::{ElementRef, Html, Selector};
use serde::Deserialize;

use crate::error::{Result, msg};
use crate::extract::{self, Support};
use crate::http::get_page;
use crate::site::{AnimeCard, AnimeDetail, Episode, EpisodeInfo, Related, Server};

pub const BASE: &str = "https://jkanime.net";
const MINIATURAS: &str = "https://cdn.jkdesa.com/assets/images/animes/video/image/";

/// ¿Es una URL de JKAnime?
pub fn es_suya(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h == "jkanime.net" || h.ends_with(".jkanime.net")))
        .unwrap_or(false)
}

fn sel(css: &str) -> Selector {
    Selector::parse(css).expect("selector CSS válido")
}

fn texto(el: ElementRef) -> String {
    el.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn no_vacio(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

// ---------------------------------------------------------------- búsqueda

/// Como en la web: las palabras se separan con `_`.
fn url_busqueda(consulta: &str) -> String {
    let palabras: Vec<String> = consulta
        .split_whitespace()
        .map(|p| url::form_urlencoded::byte_serialize(p.as_bytes()).collect())
        .collect();
    format!("{BASE}/buscar/{}/", palabras.join("_"))
}

pub async fn search(client: &Client, consulta: &str) -> Result<Vec<AnimeCard>> {
    let consulta = consulta.trim();
    if consulta.is_empty() {
        return Ok(Vec::new());
    }
    let pagina = get_page(client, &url_busqueda(consulta), None).await?;
    Ok(parse_busqueda(&pagina.body))
}

fn parse_busqueda(html: &str) -> Vec<AnimeCard> {
    let doc = Html::parse_document(html);
    doc.select(&sel("div.anime__item"))
        .filter_map(|item| {
            let enlace = item.select(&sel("h5 a")).next()?;
            let url = enlace.attr("href")?.to_owned();
            let title = texto(enlace);
            if title.is_empty() || !es_suya(&url) {
                return None;
            }
            let cover = item
                .select(&sel("[data-setbg]"))
                .next()
                .and_then(|d| d.attr("data-setbg").map(str::to_owned));
            let kind = item.select(&sel("li.anime")).next().map(texto).and_then(no_vacio);
            // El primer <li> es el estado ("Concluido", "En emision").
            let genre = item
                .select(&sel(".anime__item__text li"))
                .next()
                .map(texto)
                .and_then(no_vacio);
            Some(AnimeCard { title, url, cover, year: None, kind, genre })
        })
        .collect()
}

// ---------------------------------------------------------------- ficha

static AJAX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"url:\s*'(https://jkanime\.net/ajax/episodes/\d+/?)'").unwrap());
static CSRF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"name="csrf-token" content="([^"]+)""#).unwrap());

/// "https://jkanime.net/slug/" (con la barra final, como en la web).
fn normalizar_ficha(url: &str) -> String {
    format!("{}/", url.trim_end_matches('/'))
}

pub async fn anime(client: &Client, url: &str) -> Result<AnimeDetail> {
    let url = normalizar_ficha(url);
    let pagina = get_page(client, &url, None).await?;
    let mut ficha = parse_ficha(&pagina.body, &url)?;
    let ajax = AJAX.captures(&pagina.body).map(|c| c[1].to_owned());
    let token = CSRF.captures(&pagina.body).map(|c| c[1].to_owned());
    if let (Some(ajax), Some(token)) = (ajax, token) {
        ficha.episodes = episodios(client, &url, &ajax, &token).await?;
    }
    Ok(ficha)
}

fn dato<'a>(doc: &'a Html, etiqueta: &str) -> Option<ElementRef<'a>> {
    doc.select(&sel(".anime__details__widget li, .card-bod li"))
        .find(|li| li.select(&sel("span")).next().is_some_and(|s| texto(s).trim_end_matches(':').eq_ignore_ascii_case(etiqueta)))
}

fn parse_ficha(html: &str, url: &str) -> Result<AnimeDetail> {
    let doc = Html::parse_document(html);
    let title = doc
        .select(&sel(".anime_info h3"))
        .map(texto)
        .find(|t| !t.is_empty())
        .ok_or_else(|| msg("La página del animé de JKAnime no tiene el formato esperado."))?;
    let alt_title = doc.select(&sel(".anime_info h3 + span")).next().map(texto).and_then(no_vacio);
    let cover = doc
        .select(&sel(r#"meta[property="og:image"]"#))
        .next()
        .and_then(|m| m.attr("content").map(str::to_owned))
        .or_else(|| doc.select(&sel(".anime_info img")).next().and_then(|i| i.attr("src").map(str::to_owned)));
    let status = dato(&doc, "Estado")
        .and_then(|li| li.select(&sel("div")).next().map(texto))
        .and_then(no_vacio)
        // La web escribe "En emision" sin tilde.
        .map(|s| if s.eq_ignore_ascii_case("en emision") { "En emisión".to_owned() } else { s });
    let mut genres: Vec<String> = Vec::new();
    if let Some(li) = dato(&doc, "Generos") {
        for g in li.select(&sel("a")).map(texto) {
            if !g.is_empty() && !genres.contains(&g) {
                genres.push(g);
            }
        }
    }
    let synopsis = doc.select(&sel(".anime_info p.scroll")).next().map(texto).and_then(no_vacio);
    let season = dato(&doc, "Temporada")
        .and_then(|li| li.select(&sel("a")).next().map(texto))
        .and_then(no_vacio);
    let kind = dato(&doc, "Tipo")
        .map(|li| texto(li).trim_start_matches("Tipo:").trim().to_owned())
        .and_then(no_vacio);
    Ok(AnimeDetail {
        url: url.to_owned(),
        title,
        alt_title,
        cover,
        status,
        genres,
        synopsis,
        kind,
        season,
        related: relacionados(&doc),
        episodes: Vec::new(),
    })
}

static TITULO_Y_TIPO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?)\s*\(([^()]+)\)$").unwrap());

/// Bloque "Temporadas y relacionados": `<h5>Secuela</h5><a href=…>Título (Serie)</a>`.
fn relacionados(doc: &Html) -> Vec<Related> {
    let Some(caja) = doc
        .select(&sel("h3"))
        .find(|h| texto(*h).to_lowercase().starts_with("temporadas y relacionados"))
        .and_then(|h| h.parent())
        .and_then(ElementRef::wrap)
    else {
        return Vec::new();
    };
    let mut relacion = String::new();
    let mut lista: Vec<Related> = Vec::new();
    for hijo in caja.children().filter_map(ElementRef::wrap) {
        match hijo.value().name() {
            "h5" => relacion = texto(hijo),
            "a" => {
                let Some(url) = hijo.attr("href").filter(|u| es_suya(u)) else { continue };
                let completo = texto(hijo);
                let (title, kind) = match TITULO_Y_TIPO.captures(&completo) {
                    Some(c) => (c[1].to_owned(), Some(c[2].trim().to_owned())),
                    None => (completo.clone(), None),
                };
                if title.is_empty() || lista.iter().any(|r| r.url == url) {
                    continue;
                }
                lista.push(Related { title, url: url.to_owned(), relation: relacion.clone(), kind });
            }
            _ => {}
        }
    }
    lista
}

#[derive(Deserialize)]
struct PaginaEpisodios {
    data: Vec<EpisodioAjax>,
    last_page: u32,
}

#[derive(Deserialize)]
struct EpisodioAjax {
    number: serde_json::Value,
    image: Option<String>,
}

async fn pedir_pagina(client: &Client, ficha: &str, ajax: &str, token: &str, p: u32) -> Result<PaginaEpisodios> {
    // La página va en la ruta (`/ajax/episodes/<id>/<p>`), como hace la web: `?p=` se ignora.
    Ok(client
        .post(format!("{}/{p}", ajax.trim_end_matches('/')))
        .header("X-Requested-With", "XMLHttpRequest")
        .header("X-CSRF-TOKEN", token)
        .header(reqwest::header::REFERER, ficha)
        .form(&[("_token", token)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

async fn episodios(client: &Client, ficha: &str, ajax: &str, token: &str) -> Result<Vec<Episode>> {
    let primera = pedir_pagina(client, ficha, ajax, token, 1).await?;
    let resto = (2..=primera.last_page.min(200)).map(|p| pedir_pagina(client, ficha, ajax, token, p));
    let mut todas = vec![primera];
    todas.extend(futures_util::future::try_join_all(resto).await?);
    let mut lista: Vec<Episode> = todas
        .into_iter()
        .flat_map(|p| p.data)
        .filter_map(|e| {
            let number = match &e.number {
                serde_json::Value::Number(n) => n.as_f64(),
                serde_json::Value::String(s) => s.trim().parse().ok(),
                _ => None,
            }?;
            Some(Episode {
                number,
                url: format!("{ficha}{}/", numero_en_url(number)),
                thumb: e.image.filter(|i| !i.is_empty()).map(|i| format!("{MINIATURAS}{i}")),
            })
        })
        .collect();
    lista.sort_by(|a, b| a.number.total_cmp(&b.number));
    lista.dedup_by(|a, b| a.url == b.url);
    Ok(lista)
}

/// 12 → "12"; 12.5 → "12.5".
fn numero_en_url(n: f64) -> String {
    if n.fract() == 0.0 { format!("{}", n as i64) } else { n.to_string() }
}

// ---------------------------------------------------------------- episodio

static EPISODIO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(https?://(?:www\.)?jkanime\.net/[^/]+/)([^/]+)/?$").unwrap());
static SERVIDORES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"var servers = (\[.*?\]);").unwrap());
static JKPLAYER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<iframe[^>]+src="(https://jkanime\.net/jkplayer/um\?[^"]+)""#).unwrap());

#[derive(Deserialize)]
struct ServidorJk {
    remote: String,
    server: String,
    #[serde(default)]
    lang: serde_json::Value,
}

pub async fn episode(client: &Client, url: &str) -> Result<EpisodeInfo> {
    let pagina = get_page(client, url, None).await?;
    parse_episodio(&pagina.body, url)
}

fn parse_episodio(html: &str, url: &str) -> Result<EpisodeInfo> {
    let partes = EPISODIO.captures(url.trim()).ok_or_else(|| msg("Enlace de episodio de JKAnime no válido."))?;
    let anime_url = partes[1].to_owned();
    let number = partes[2].parse::<f64>().ok().or(Some(1.0));

    let doc = Html::parse_document(html);
    // <h1>Episodio 1 <span/> - Sousou no Frieren</h1>
    let anime_title = doc
        .select(&sel("h1"))
        .map(texto)
        .find_map(|t| t.split_once(" - ").map(|(_, titulo)| titulo.trim().to_owned()))
        .filter(|t| !t.is_empty())
        .ok_or_else(|| msg("La página del episodio de JKAnime no tiene el formato esperado."))?;

    let mut servers: Vec<(u8, Server)> = Vec::new();
    if let Some(jk) = JKPLAYER.captures(html) {
        servers.push((extract::Host::JkPlayer.rank(), Server { name: "JKAnime".into(), url: jk[1].replace("&amp;", "&"), support: Support::Direct }));
    }
    if let Some(lista) = SERVIDORES.captures(html) {
        let lista: Vec<ServidorJk> = serde_json::from_str(&lista[1]).unwrap_or_default();
        for s in lista {
            // lang 1: subtitulado; 3: latino (se marca en el nombre).
            let latino = s.lang.as_i64() == Some(3) || s.lang.as_str() == Some("3");
            let Ok(bytes) = STANDARD.decode(s.remote.trim()) else { continue };
            let Ok(embed) = String::from_utf8(bytes) else { continue };
            let embed = embed.trim().to_owned();
            if !embed.starts_with("http") {
                continue;
            }
            let host = extract::classify(&s.server, &embed);
            let name = if latino { format!("{} (latino)", s.server) } else { s.server };
            servers.push((host.rank() + u8::from(latino) * 10, Server { support: host.support(), name, url: embed }));
        }
    }
    servers.sort_by_key(|(rank, _)| *rank);

    Ok(EpisodeInfo {
        url: url.to_owned(),
        anime_title,
        number,
        anime_url: Some(anime_url),
        servers: servers.into_iter().map(|(_, s)| s).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconoce_sus_urls() {
        assert!(es_suya("https://jkanime.net/sousou-no-frieren/"));
        assert!(!es_suya("https://monoschinos.st/anime/x"));
        assert_eq!(url_busqueda("one  piece"), "https://jkanime.net/buscar/one_piece/");
        assert_eq!(numero_en_url(12.0), "12");
        assert_eq!(numero_en_url(12.5), "12.5");
    }

    #[test]
    fn lee_busqueda_ficha_y_episodio() {
        let busqueda = r#"<div class="anime__item"><a href="https://jkanime.net/sousou-no-frieren/"><div class="anime__item__pic set-bg" data-setbg="https://cdn/x.jpg"></div></a>
            <div class="anime__item__text"><ul><li>Concluido</li><li class="anime">Serie</li></ul>
            <h5><a href="https://jkanime.net/sousou-no-frieren/">Sousou no Frieren</a></h5></div></div>"#;
        let r = parse_busqueda(busqueda);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].title, "Sousou no Frieren");
        assert_eq!(r[0].cover.as_deref(), Some("https://cdn/x.jpg"));
        assert_eq!(r[0].kind.as_deref(), Some("Serie"));

        let ficha = r#"<div class="card-bod"><ul><li><span>Generos:</span> <a href="/genero/a/">Drama</a>, <a>Fantasia</a></li>
            <li><span>Temporada:</span> <a href="https://jkanime.net/temporada/otono-2023">Otoño 2023</a></li>
            <li><span>Estado:</span> <div class="enemision">En emision</div></li></ul></div>
            <div class="anime_info"><h3>Sousou no Frieren</h3><span>Frieren</span><p class="scroll">Sinopsis.</p></div>
            <div class="col col-lg-6"><h3 class="mb-3">Temporadas y relacionados</h3>
            <h5 id="aditional" class="font-weight-bold">Secuela</h5>
            <a href="https://jkanime.net/sousou-no-frieren-2nd-season/">Sousou no Frieren 2nd Season (Serie) </a> <br></div>"#;
        let f = parse_ficha(ficha, "https://jkanime.net/sousou-no-frieren/").unwrap();
        assert_eq!(f.title, "Sousou no Frieren");
        assert_eq!(f.alt_title.as_deref(), Some("Frieren"));
        assert_eq!(f.status.as_deref(), Some("En emisión"));
        assert_eq!(f.genres, vec!["Drama", "Fantasia"]);
        assert_eq!(f.season.as_deref(), Some("Otoño 2023"));
        assert_eq!(f.related.len(), 1);
        assert_eq!(f.related[0].title, "Sousou no Frieren 2nd Season");
        assert_eq!(f.related[0].relation, "Secuela");
        assert_eq!(f.related[0].kind.as_deref(), Some("Serie"));

        let episodio = r#"<h1 class="mb-2">Episodio 3 <span class="lang_def"></span> - Sousou no Frieren</h1>
            <script>var servers = [{"remote":"aHR0cHM6Ly92b2Uuc3gvZS9hYmM=","server":"VOE","lang":1},{"remote":"aHR0cHM6Ly9tZWdhLm56L2VtYmVkL3g=","server":"Mega","lang":1}];</script>"#;
        let e = parse_episodio(episodio, "https://jkanime.net/sousou-no-frieren/3/").unwrap();
        assert_eq!(e.anime_title, "Sousou no Frieren");
        assert_eq!(e.number, Some(3.0));
        assert_eq!(e.anime_url.as_deref(), Some("https://jkanime.net/sousou-no-frieren/"));
        assert_eq!(e.servers[0].name, "VOE");
        assert_eq!(e.servers[0].url, "https://voe.sx/e/abc");
        assert_eq!(e.servers.last().unwrap().support, Support::Web);
    }

    /// `cargo test -- --ignored jkanime_real --nocapture`
    #[tokio::test]
    #[ignore]
    async fn jkanime_real() {
        let c = crate::http::scraper_client().unwrap();
        let r = search(&c, "frieren").await.unwrap();
        println!("búsqueda: {:?}", r.iter().map(|a| (&a.title, &a.url)).collect::<Vec<_>>());
        let f = anime(&c, &r[0].url).await.unwrap();
        println!("ficha: {} · {:?} · {} episodios · {:?}", f.title, f.status, f.episodes.len(), f.episodes.first().map(|e| &e.url));
        assert!(!f.episodes.is_empty());
        println!("último: {:?}", f.episodes.last().map(|e| &e.url));
        assert_eq!(f.episodes.len(), 28, "Frieren tiene 28 episodios en 2 páginas");
        let e = episode(&c, "https://jkanime.net/kanojo-no-tomodachi/6/").await.unwrap();
        println!("episodio: {} {:?}", e.anime_title, e.number);
        for s in &e.servers {
            let r = crate::extract::resolve(&c, &s.name, &s.url).await;
            let estado = match &r {
                Ok(st) => {
                    // ¿Sirve de verdad el video? (primeros bytes, con sus cabeceras)
                    let mut req = c.get(&st.url).header("Range", "bytes=0-1023");
                    for (k, v) in &st.headers {
                        req = req.header(k.as_str(), v.as_str());
                    }
                    let codigo = req.send().await.map(|r| r.status().as_u16()).unwrap_or(0);
                    format!("OK {:?} HTTP {codigo} {}", st.kind, &st.url[..st.url.len().min(60)])
                }
                Err(e) => format!("ERR {e}"),
            };
            println!("  {:<16} {:?} → {estado}", s.name, s.support);
        }
    }
}
