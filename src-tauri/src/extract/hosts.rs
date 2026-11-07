//! Servidores cuyo enlace está en la página (tal cual o empaquetado).

use std::sync::LazyLock;

use regex::Regex;
use reqwest::{Client, header};
use serde::Deserialize;
use url::Url;

use super::{Host, Stream, classify, not_found, packer, resolve_host};
use crate::error::{Result, msg};
use crate::http::{Page, absolutize, get_page, origin_of};
use crate::site::BASE;

/// Patrones de JWPlayer/VideoJS, en orden de fiabilidad.
static SOURCE_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // sources: [{file:"...m3u8"}]  (lulu, uqload, savefiles, streamwish)
        r#"sources\s*:\s*\[\s*\{\s*["']?file["']?\s*:\s*["']([^"']+)["']"#,
        // sources: ["...mp4"]
        r#"sources\s*:\s*\[\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']"#,
        // var links = {"hls2": "...", "hls4": "/stream/..."}  (streamwish/vidhide)
        r#"["']hls\d*["']\s*:\s*["']([^"']+)["']"#,
        // file: '...mp4'  (yourupload)
        r#"file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']"#,
        r#"<source[^>]+src=["']([^"']+\.(?:m3u8|mp4)[^"']*)["']"#,
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

/// Busca el video en el HTML y en sus scripts empaquetados.
fn find_source(page: &Page) -> Option<String> {
    let unpacked = packer::unpack_all(&page.body);
    let texts = std::iter::once(page.body.as_str()).chain(unpacked.iter().map(String::as_str));
    for text in texts {
        for pattern in SOURCE_PATTERNS.iter() {
            for caps in pattern.captures_iter(text) {
                let link = caps[1].replace("\\/", "/");
                if link.contains("empty.") || link.ends_with(".srt") || link.ends_with(".vtt") {
                    continue;
                }
                if let Some(abs) = absolutize(&page.url, &link) {
                    return Some(abs);
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------- mp4upload

static MP4UPLOAD_SRC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"src\s*:\s*"(https?://[^"]+\.mp4[^"]*)""#).unwrap());

pub async fn mp4upload(client: &Client, url: &str) -> Result<Stream> {
    let page = get_page(client, url, Some(BASE)).await?;
    let video = MP4UPLOAD_SRC
        .captures(&page.body)
        .map(|c| c[1].to_owned())
        .ok_or_else(|| not_found(&page.url, &page.body))?;
    // Sin este Referer el CDN responde 403.
    Ok(Stream::new(video, Some(origin_of(&page.url))))
}

// ---------------------------------------------------------------- savefiles

/// savefiles y sus espejos (streamhls...): el embed es un formulario que se envía a `/dl`
/// para obtener el reproductor.
pub async fn savefiles(client: &Client, url: &str) -> Result<Stream> {
    let parsed = Url::parse(url).map_err(|_| msg("Enlace de savefiles inválido."))?;
    let code = file_code(&parsed).ok_or_else(|| msg("Enlace de savefiles inválido."))?;
    let origin = origin_of(&parsed);
    let resp = client
        .post(format!("{origin}dl"))
        .header(header::REFERER, format!("{origin}e/{code}"))
        .form(&[("op", "embed"), ("file_code", code.as_str()), ("auto", "1"), ("referer", BASE)])
        .send()
        .await?
        .error_for_status()?;
    let page = Page { url: resp.url().clone(), body: resp.text().await? };
    let video = find_source(&page).ok_or_else(|| not_found(&page.url, &page.body))?;
    Ok(Stream::new(video, Some(origin)))
}

/// Código del archivo en `/e/<code>`, `/embed-<code>.html` o `/<code>`.
fn file_code(url: &Url) -> Option<String> {
    let last = url.path_segments()?.filter(|s| !s.is_empty()).last()?;
    let last = last.strip_suffix(".html").unwrap_or(last);
    let code = last.strip_prefix("embed-").unwrap_or(last);
    (!code.is_empty()).then(|| code.to_owned())
}

// ---------------------------------------------------------------- mixdrop

static MIXDROP_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"MDCore\.wurl\s*=\s*"([^"]+)""#).unwrap());

pub async fn mixdrop(client: &Client, url: &str) -> Result<Stream> {
    // `/f/<code>` es la página de descarga; el reproductor está en `/e/<code>`.
    let url = url.replacen("/f/", "/e/", 1);
    let page = get_page(client, &url, Some(BASE)).await?;
    let video = packer::unpack_all(&page.body)
        .iter()
        .find_map(|js| MIXDROP_URL.captures(js).map(|c| c[1].to_owned()))
        .and_then(|link| absolutize(&page.url, &link))
        .ok_or_else(|| not_found(&page.url, &page.body))?;
    Ok(Stream::new(video, Some(origin_of(&page.url))))
}

// ---------------------------------------------------------------- hexload

#[derive(Deserialize)]
struct HexloadResponse {
    msg: Option<String>,
    result: Option<HexloadResult>,
}

#[derive(Deserialize)]
struct HexloadResult {
    url: String,
}

pub async fn hexload(client: &Client, url: &str) -> Result<Stream> {
    let parsed = Url::parse(url).map_err(|_| msg("Enlace de hexload inválido."))?;
    let code = file_code(&parsed).ok_or_else(|| msg("Enlace de hexload inválido."))?;
    let origin = origin_of(&parsed);
    let resp: HexloadResponse = client
        .post(format!("{origin}download"))
        .header(header::REFERER, url)
        .form(&[("op", "download3"), ("id", code.as_str()), ("ajax", "1"), ("method_free", "1")])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    match resp.result {
        Some(result) if result.url.starts_with("http") => Ok(Stream::new(result.url, Some(origin))),
        _ => Err(msg(format!(
            "hexload no entregó el video ({}).",
            resp.msg.unwrap_or_else(|| "sin respuesta".to_owned())
        ))),
    }
}

// ---------------------------------------------------------------- genérico

pub async fn generic(client: &Client, url: &str) -> Result<Stream> {
    let page = get_page(client, url, Some(BASE)).await?;

    // Dominios intermedios que redirigen a un servidor conocido (p. ej. a mixdrop).
    let landed = classify("", page.url.as_str());
    if landed != Host::Generic {
        return Box::pin(resolve_host(client, landed, page.url.as_str())).await;
    }

    // Espejos de savefiles con el mismo formulario.
    if page.body.contains(r#"action="/dl""#) && page.body.contains(r#"value="embed""#) {
        return savefiles(client, page.url.as_str()).await;
    }

    if let Some(video) = find_source(&page) {
        return Ok(Stream::new(video, Some(origin_of(&page.url))));
    }

    // Algunos enlaces apuntan a la página del archivo (`/<code>`, `/v/<code>`) en vez del embed.
    if let Some(code) = file_code(&page.url).filter(|_| !page.url.path().starts_with("/e/")) {
        let embed = format!("{}e/{code}", origin_of(&page.url));
        if let Ok(embed_page) = get_page(client, &embed, Some(BASE)).await {
            if let Some(video) = find_source(&embed_page) {
                return Ok(Stream::new(video, Some(origin_of(&embed_page.url))));
            }
        }
    }
    Err(not_found(&page.url, &page.body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(body: &str) -> Page {
        Page { url: Url::parse("https://host.example/e/abc").unwrap(), body: body.to_owned() }
    }

    #[test]
    fn finds_jwplayer_source_skipping_subtitles() {
        let body = r#"jwplayer("vplayer").setup({sources:[{file:"https://cdn.example/hls2/master.m3u8?t=1"}],tracks:[{file:"/srt/empty.srt"}]})"#;
        assert_eq!(find_source(&page(body)).unwrap(), "https://cdn.example/hls2/master.m3u8?t=1");
    }

    #[test]
    fn resolves_relative_streamwish_links() {
        let body = r#"var links={"hls4":"/stream/xyz/master.m3u8","hls2":"https://cdn.example/a.m3u8"};"#;
        assert_eq!(find_source(&page(body)).unwrap(), "https://host.example/stream/xyz/master.m3u8");
    }

    #[test]
    fn extracts_file_codes() {
        let code = |u: &str| file_code(&Url::parse(u).unwrap());
        assert_eq!(code("https://savefiles.com/embed-qbqvo35se1zv.html").as_deref(), Some("qbqvo35se1zv"));
        assert_eq!(code("https://savefiles.com/e/qbqvo35se1zv").as_deref(), Some("qbqvo35se1zv"));
        assert_eq!(code("https://hexload.com/embed-tw7f7qklaz71").as_deref(), Some("tw7f7qklaz71"));
        assert_eq!(code("https://luluvdo.com/5f7u84bo9qwl").as_deref(), Some("5f7u84bo9qwl"));
        assert_eq!(code("https://luluvdo.com/").as_deref(), None);
    }
}
