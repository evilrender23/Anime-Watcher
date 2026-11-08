use std::sync::{Arc, OnceLock};
use std::time::Duration;

use reqwest::{Client, header};
use url::Url;

use crate::error::Result;

/// Navegador de escritorio: varios servidores de video rechazan clientes desconocidos.
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/// Resolutor compartido (DoH + IPs alternativas de Cloudflare): ver `dns.rs`.
fn resolutor() -> reqwest::Result<Arc<crate::dns::Resolutor>> {
    static R: OnceLock<Arc<crate::dns::Resolutor>> = OnceLock::new();
    if let Some(r) = R.get() {
        return Ok(r.clone());
    }
    let r = Arc::new(crate::dns::Resolutor::new()?);
    Ok(R.get_or_init(|| r).clone())
}

/// Cliente para páginas y APIs: respuestas pequeñas, tiempo total acotado.
pub fn scraper_client() -> reqwest::Result<Client> {
    Client::builder()
        .dns_resolver(resolutor()?)
        .user_agent(USER_AGENT)
        .cookie_store(true)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .build()
}

/// Cliente para el proxy de video: las descargas duran lo que dure el episodio,
/// así que sólo se limita la espera entre lecturas. Algunos CDN (mp4upload) tardan
/// más de 10 s en completar el saludo TLS.
pub fn stream_client() -> reqwest::Result<Client> {
    Client::builder()
        .dns_resolver(resolutor()?)
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(30))
        .build()
}

/// Página descargada junto con la URL final tras las redirecciones.
pub struct Page {
    pub url: Url,
    pub body: String,
}

pub async fn get_page(client: &Client, url: &str, referer: Option<&str>) -> Result<Page> {
    let mut req = client.get(url);
    if let Some(referer) = referer {
        req = req.header(header::REFERER, referer);
    }
    let resp = req.send().await?.error_for_status()?;
    let url = resp.url().clone();
    let body = resp.text().await?;
    Ok(Page { url, body })
}

/// `https://host/` de una URL, útil como Referer.
pub fn origin_of(url: &Url) -> String {
    format!("{}/", url.origin().ascii_serialization())
}

/// Resuelve enlaces relativos (`/x`, `//host/x`, `x`) respecto de `base`.
pub fn absolutize(base: &Url, link: &str) -> Option<String> {
    base.join(link.trim()).ok().map(String::from)
}
