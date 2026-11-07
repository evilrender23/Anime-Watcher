//! Proxy HTTP local (127.0.0.1) para el reproductor integrado.
//!
//! El WebView no puede enviar `Referer`/`User-Agent` propios en peticiones de video,
//! y la mayoría de servidores los exigen. Cada video registrado recibe un token aleatorio;
//! el proxy reenvía las peticiones (incluido `Range`) con las cabeceras del servidor y
//! reescribe las listas HLS para que segmentos y claves también pasen por aquí.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use reqwest::Client;
use serde::Deserialize;
use url::Url;

/// Videos recordados a la vez; los más antiguos se olvidan.
const MAX_SESSIONS: usize = 64;

/// Cabeceras de la respuesta original que el `<video>`/hls.js necesita.
const PASSTHROUGH: &[HeaderName] = &[
    header::CONTENT_TYPE,
    header::CONTENT_LENGTH,
    header::CONTENT_RANGE,
    header::ACCEPT_RANGES,
    header::LAST_MODIFIED,
    header::ETAG,
];

#[derive(Default)]
struct Sessions {
    headers: HashMap<String, Arc<HeaderMap>>,
    order: VecDeque<String>,
}

#[derive(Clone)]
struct Shared {
    client: Client,
    port: u16,
    sessions: Arc<Mutex<Sessions>>,
}

pub struct Proxy {
    shared: Shared,
}

impl Proxy {
    pub async fn start(client: Client) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let shared = Shared { client, port, sessions: Arc::default() };
        let app = Router::new().route("/v/{session}", get(serve)).with_state(shared.clone());
        tauri::async_runtime::spawn(async move {
            if let Err(err) = axum::serve(listener, app).await {
                eprintln!("proxy de video detenido: {err}");
            }
        });
        Ok(Proxy { shared })
    }

    /// Registra las cabeceras de un video y devuelve su URL local.
    pub fn register(&self, url: &str, headers: &BTreeMap<String, String>) -> String {
        let mut map = HeaderMap::new();
        for (name, value) in headers {
            if let (Ok(name), Ok(value)) = (HeaderName::try_from(name.as_str()), HeaderValue::from_str(value)) {
                map.insert(name, value);
            }
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        let mut sessions = self.shared.sessions.lock().unwrap();
        sessions.headers.insert(token.clone(), Arc::new(map));
        sessions.order.push_back(token.clone());
        while sessions.order.len() > MAX_SESSIONS {
            if let Some(old) = sessions.order.pop_front() {
                sessions.headers.remove(&old);
            }
        }
        drop(sessions);
        proxied(self.shared.port, &token, url)
    }
}

fn proxied(port: u16, token: &str, target: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(target.as_bytes()).collect();
    format!("http://127.0.0.1:{port}/v/{token}?u={encoded}")
}

#[derive(Deserialize)]
struct Target {
    u: String,
}

async fn serve(
    State(shared): State<Shared>,
    Path(token): Path<String>,
    Query(target): Query<Target>,
    request_headers: HeaderMap,
) -> Response {
    let Some(headers) = shared.sessions.lock().unwrap().headers.get(&token).cloned() else {
        return error(StatusCode::FORBIDDEN, "sesión desconocida");
    };
    let Ok(url) = Url::parse(&target.u) else {
        return error(StatusCode::BAD_REQUEST, "URL inválida");
    };
    if !matches!(url.scheme(), "http" | "https") {
        return error(StatusCode::BAD_REQUEST, "esquema no permitido");
    }

    let mut upstream = shared.client.get(url).headers((*headers).clone());
    for name in [header::RANGE, header::IF_RANGE] {
        if let Some(value) = request_headers.get(&name) {
            upstream = upstream.header(name, value.clone());
        }
    }
    let resp = match upstream.send().await {
        Ok(resp) => resp,
        Err(err) => return error(StatusCode::BAD_GATEWAY, &err.to_string()),
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let final_url = resp.url().clone();
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let small = resp.content_length().is_some_and(|len| len < 5_000_000);

    if status.is_success() && looks_like_playlist(&final_url, &content_type, small) {
        let text = match resp.text().await {
            Ok(text) => text,
            Err(err) => return error(StatusCode::BAD_GATEWAY, &err.to_string()),
        };
        if text.trim_start().starts_with("#EXTM3U") {
            let body = rewrite_playlist(&text, &final_url, |abs| proxied(shared.port, &token, abs));
            return with_cors(
                (status, [(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")], body).into_response(),
            );
        }
        return with_cors((status, [(header::CONTENT_TYPE, content_type)], text).into_response());
    }

    let mut response = Response::builder().status(status);
    for name in PASSTHROUGH {
        if let Some(value) = resp.headers().get(name) {
            response = response.header(name, value.clone());
        }
    }
    let body = Body::from_stream(resp.bytes_stream());
    match response.body(body) {
        Ok(response) => with_cors(response),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
    }
}

/// Algunos servidores entregan las listas como `text/plain`; sólo se leen enteras si son pequeñas.
fn looks_like_playlist(url: &Url, content_type: &str, small: bool) -> bool {
    content_type.contains("mpegurl")
        || url.path().ends_with(".m3u8")
        || (small && content_type.starts_with("text/plain"))
}

/// Convierte cada URI de una lista M3U8 (líneas de recurso y atributos `URI="..."`)
/// en una URL absoluta pasada por `proxify`.
fn rewrite_playlist(text: &str, base: &Url, proxify: impl Fn(&str) -> String) -> String {
    let absolute = |link: &str| base.join(link).map(String::from).unwrap_or_else(|_| link.to_owned());
    let mut out = String::with_capacity(text.len() * 2);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push_str(line);
        } else if trimmed.starts_with('#') {
            out.push_str(&rewrite_uri_attributes(trimmed, |uri| proxify(&absolute(uri))));
        } else {
            out.push_str(&proxify(&absolute(trimmed)));
        }
        out.push('\n');
    }
    out
}

fn rewrite_uri_attributes(line: &str, map: impl Fn(&str) -> String) -> String {
    const KEY: &str = "URI=\"";
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find(KEY) {
        let value_start = start + KEY.len();
        let Some(len) = rest[value_start..].find('"') else { break };
        out.push_str(&rest[..value_start]);
        out.push_str(&map(&rest[value_start..value_start + len]));
        out.push('"');
        rest = &rest[value_start + len + 1..];
    }
    out.push_str(rest);
    out
}

fn with_cors(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges"),
    );
    response
}

fn error(status: StatusCode, text: &str) -> Response {
    with_cors((status, text.to_owned()).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_every_uri_in_playlist() {
        let base = Url::parse("https://cdn.example/hls/abc/master.m3u8?t=1").unwrap();
        let playlist = "#EXTM3U\n\
#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"/audio/index.m3u8\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=1000\n\
index-v1-a1.m3u8?t=1\n\
\n\
https://other.example/seg-1.ts\n";
        let out = rewrite_playlist(playlist, &base, |abs| format!("P[{abs}]"));
        assert_eq!(
            out,
            "#EXTM3U\n\
#EXT-X-KEY:METHOD=AES-128,URI=\"P[https://cdn.example/hls/abc/key.bin]\",IV=0x1\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"P[https://cdn.example/audio/index.m3u8]\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=1000\n\
P[https://cdn.example/hls/abc/index-v1-a1.m3u8?t=1]\n\
\n\
P[https://other.example/seg-1.ts]\n"
        );
    }

    #[test]
    fn proxied_url_round_trips_target() {
        let target = "https://cdn.example/a b/master.m3u8?t=1&s=2";
        let url = Url::parse(&proxied(1234, "tok", target)).unwrap();
        assert_eq!(url.path(), "/v/tok");
        let (_, u) = url.query_pairs().find(|(k, _)| k == "u").unwrap();
        assert_eq!(u, target);
    }
}
