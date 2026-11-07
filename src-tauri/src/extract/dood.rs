//! DoodStream (dood.*, dsvplay, playmogo, d000d...): la página pide `/pass_md5/...`,
//! que devuelve el prefijo del MP4; el reproductor le añade 10 caracteres aleatorios,
//! el token y la hora actual.

use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use reqwest::{Client, header};
use url::Url;

use super::{Stream, not_found};
use crate::error::{Result, msg};
use crate::http::{get_page, origin_of};
use crate::site::BASE;

/// Espejos que sirven los mismos códigos cuando el dominio original no responde
/// (por ejemplo, dsvplay.com bloqueado por el proveedor de internet).
const MIRRORS: &[&str] = &["playmogo.com", "d000d.com", "dood.li"];

static PASS_MD5: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"/pass_md5/[^'"\s]+"#).unwrap());
static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[?&]token=([A-Za-z0-9]+)").unwrap());

pub async fn resolve(client: &Client, url: &str) -> Result<Stream> {
    let embed = embed_url(url)?;
    let page = match get_page(client, embed.as_str(), Some(BASE)).await {
        Ok(page) => page,
        Err(first) => {
            let mut found = None;
            for mirror in MIRRORS {
                let mut alt = embed.clone();
                if alt.set_host(Some(mirror)).is_err() {
                    continue;
                }
                if let Ok(page) = get_page(client, alt.as_str(), Some(BASE)).await {
                    found = Some(page);
                    break;
                }
            }
            found.ok_or(first)?
        }
    };

    let (Some(pass), Some(token)) = (
        PASS_MD5.find(&page.body).map(|m| m.as_str().to_owned()),
        TOKEN.captures(&page.body).map(|c| c[1].to_owned()),
    ) else {
        return Err(not_found(&page.url, &page.body));
    };

    let pass_url = page.url.join(&pass).map_err(|_| msg("Enlace de DoodStream inválido."))?;
    let prefix = client
        .get(pass_url)
        .header(header::REFERER, page.url.as_str())
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let prefix = prefix.trim();
    if !prefix.starts_with("http") {
        return Err(msg("DoodStream rechazó la solicitud del video."));
    }

    let expiry = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let video = format!("{prefix}{}?token={token}&expiry={expiry}", random_suffix());
    Ok(Stream::new(video, Some(origin_of(&page.url))))
}

/// `/d/<código>` es la página de descarga; el reproductor está en `/e/<código>`.
fn embed_url(url: &str) -> Result<Url> {
    let mut parsed = Url::parse(url).map_err(|_| msg("Enlace de DoodStream inválido."))?;
    if let Some(code) = parsed.path().strip_prefix("/d/").map(str::to_owned) {
        parsed.set_path(&format!("/e/{code}"));
    }
    Ok(parsed)
}

fn random_suffix() -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    uuid::Uuid::new_v4()
        .as_bytes()
        .iter()
        .take(10)
        .map(|b| CHARS[*b as usize % CHARS.len()] as char)
        .collect()
}
