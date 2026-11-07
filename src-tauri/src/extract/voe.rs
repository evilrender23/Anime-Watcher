//! voe.sx: redirige a un dominio aleatorio y guarda la configuración del reproductor
//! ofuscada en `<script type="application/json">["..."]</script>`.

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use regex::Regex;
use reqwest::Client;

use super::{Stream, not_found};
use crate::error::{Result, msg};
use crate::http::{Page, get_page, origin_of};
use crate::site::BASE;

static REDIRECT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"window\.location\.href\s*=\s*'(https?://[^']+)'"#).unwrap());
static CONFIG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?s)<script type="application/json">\s*(\[.*?\])\s*</script>"#).unwrap());

/// Separadores basura que voe intercala en la cadena.
const JUNK: &[&str] = &["@$", "^^", "~@", "%?", "*~", "!!", "#&"];

pub async fn resolve(client: &Client, url: &str) -> Result<Stream> {
    let mut page = get_page(client, url, Some(BASE)).await?;
    if !CONFIG.is_match(&page.body) {
        if let Some(next) = REDIRECT.captures(&page.body).map(|c| c[1].to_owned()) {
            page = get_page(client, &next, Some(BASE)).await?;
        }
    }
    let Page { url, body } = page;
    let config = CONFIG
        .captures(&body)
        .and_then(|c| serde_json::from_str::<Vec<String>>(&c[1]).ok())
        .and_then(|v| v.into_iter().next())
        .ok_or_else(|| not_found(&url, &body))?;
    let data = decode(&config).ok_or_else(|| msg("No se pudo descifrar el reproductor de voe."))?;

    let source = ["source", "direct_access_url"]
        .iter()
        .filter_map(|k| data.get(*k).and_then(|v| v.as_str()))
        .find(|s| s.starts_with("http"))
        .ok_or_else(|| not_found(&url, &body))?;
    Ok(Stream::new(source.to_owned(), Some(origin_of(&url))))
}

/// rot13 → quitar separadores → base64 → desplazar cada carácter -3 → invertir → base64 → JSON.
fn decode(encoded: &str) -> Option<serde_json::Value> {
    let mut text: String = encoded.chars().map(rot13).collect();
    for junk in JUNK {
        text = text.replace(junk, "");
    }
    let shifted: Vec<u8> = b64(&text)?.into_iter().map(|b| b.wrapping_sub(3)).rev().collect();
    let json = b64(std::str::from_utf8(&shifted).ok()?)?;
    serde_json::from_slice(&json).ok()
}

fn rot13(c: char) -> char {
    match c {
        'a'..='z' => (((c as u8 - b'a') + 13) % 26 + b'a') as char,
        'A'..='Z' => (((c as u8 - b'A') + 13) % 26 + b'A') as char,
        _ => c,
    }
}

fn b64(text: &str) -> Option<Vec<u8>> {
    STANDARD_NO_PAD.decode(text.trim().trim_end_matches('=')).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_real_player_config() {
        // Configuración capturada de voe.sx (noviembre de 2026).
        let data = decode(include_str!("testdata/voe_config.txt")).unwrap();
        assert_eq!(data["file_code"], "gwhksv2zntxk");
        let source = data["source"].as_str().unwrap();
        assert!(source.starts_with("https://") && source.contains("/master.m3u8?"), "{source}");
        assert!(data["direct_access_url"].as_str().unwrap().contains(".mp4"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode("esto no es voe").is_none());
    }
}
