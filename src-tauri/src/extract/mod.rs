//! Obtiene el video real (MP4 o HLS) a partir de la página "embed" de cada servidor.

mod dood;
mod hosts;
mod packer;
mod voe;

use std::collections::BTreeMap;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{Result, msg};
use crate::http::USER_AGENT;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Support {
    /// Sabemos extraer el video: reproductor integrado, mpv o VLC.
    Direct,
    /// Sólo se puede ver con la página del propio servidor.
    Web,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamKind {
    Hls,
    Mp4,
}

/// Video listo para reproducir: la URL sólo funciona enviando `headers`.
#[derive(Debug, Clone)]
pub struct Stream {
    pub kind: StreamKind,
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

impl Stream {
    fn new(url: String, referer: Option<String>) -> Self {
        let kind = if url.contains(".m3u8") { StreamKind::Hls } else { StreamKind::Mp4 };
        let mut headers = BTreeMap::from([("User-Agent".to_owned(), USER_AGENT.to_owned())]);
        if let Some(referer) = referer {
            headers.insert("Referer".to_owned(), referer);
        }
        Stream { kind, url, headers }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Host {
    Mp4Upload,
    Voe,
    SaveFiles,
    MixDrop,
    Dood,
    Hexload,
    /// Reproductores JWPlayer/VideoJS con el enlace en la página (lulu, uqload, yourupload, streamwish...).
    Generic,
    /// Cifrado o protegido con captcha (filemoon/byse, mega, ok.ru).
    WebOnly,
}

impl Host {
    pub fn support(self) -> Support {
        if self == Host::WebOnly { Support::Web } else { Support::Direct }
    }

    /// Orden de preferencia al probar servidores (menor = antes). voe va primero porque su
    /// CDN responde rápido; el de mp4upload a veces tarda segundos en el saludo TLS.
    pub fn rank(self) -> u8 {
        match self {
            Host::Voe => 0,
            Host::Mp4Upload => 1,
            Host::SaveFiles => 2,
            Host::Generic => 3,
            Host::MixDrop => 4,
            Host::Dood => 5,
            Host::Hexload => 6,
            Host::WebOnly => 9,
        }
    }
}

const DOOD_HOSTS: &[&str] = &["dood", "dsvplay", "playmogo", "d000d", "d0000d", "ds2play", "ds2video", "vidply"];
const WEB_ONLY_HOSTS: &[&str] = &["mega.nz", "filemoon", "bysekoze", "byse", "ok.ru", "odnoklassniki"];

/// Decide el extractor a partir del nombre del servidor y del dominio del embed.
pub fn classify(name: &str, url: &str) -> Host {
    let name = name.to_ascii_lowercase();
    let host = Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    let is = |needle: &str| host.contains(needle);

    if is("mp4upload") {
        Host::Mp4Upload
    } else if is("voe") || name == "voe" {
        Host::Voe
    } else if is("savefiles") || is("streamhls") {
        Host::SaveFiles
    } else if is("mixdrop") || is("mxdrop") || name.contains("mixdrop") || name.contains("mxdrop") {
        Host::MixDrop
    } else if DOOD_HOSTS.iter().any(|d| is(d)) || name.contains("dood") {
        Host::Dood
    } else if is("hexload") {
        Host::Hexload
    } else if WEB_ONLY_HOSTS.iter().any(|d| is(d)) || name == "filemoon" || name == "mega" || name == "ok" {
        Host::WebOnly
    } else {
        Host::Generic
    }
}

/// Extrae el video de un servidor.
pub async fn resolve(client: &Client, name: &str, url: &str) -> Result<Stream> {
    resolve_host(client, classify(name, url), url).await
}

async fn resolve_host(client: &Client, host: Host, url: &str) -> Result<Stream> {
    match host {
        Host::Mp4Upload => hosts::mp4upload(client, url).await,
        Host::Voe => voe::resolve(client, url).await,
        Host::SaveFiles => hosts::savefiles(client, url).await,
        Host::MixDrop => hosts::mixdrop(client, url).await,
        Host::Dood => dood::resolve(client, url).await,
        Host::Hexload => hosts::hexload(client, url).await,
        Host::Generic => hosts::generic(client, url).await,
        Host::WebOnly => Err(msg("Este servidor sólo funciona con su reproductor web.")),
    }
}

/// Mensaje común cuando la página no contiene el video.
fn not_found(host: &Url, body: &str) -> crate::error::Error {
    let lower = body.to_ascii_lowercase();
    let deleted = ["file was deleted", "has been deleted", "no longer available", "video not found", "file not found"]
        .iter()
        .any(|p| lower.contains(p));
    let host = host.host_str().unwrap_or("el servidor");
    if deleted {
        msg(format!("El video fue eliminado de {host}."))
    } else {
        msg(format!("No se encontró el video en {host}."))
    }
}
