use serde::{Serialize, Serializer};

/// Error que viaja hasta la interfaz como un mensaje en español.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error("Error de archivo: {0}")]
    Io(#[from] std::io::Error),
    #[error("Respuesta JSON inválida: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

pub fn msg(text: impl Into<String>) -> Error {
    Error::Msg(text.into())
}

impl From<reqwest::Error> for Error {
    fn from(err: reqwest::Error) -> Self {
        let host = err
            .url()
            .and_then(|u| u.host_str())
            .unwrap_or("el servidor")
            .to_owned();
        // Si ni las IPs alternativas conectan, casi siempre es un bloqueo de la operadora.
        const BLOQUEO: &str = "Puede que tu operadora lo esté bloqueando (en España pasa durante el fútbol): prueba más tarde o con una VPN.";
        let text = if err.is_timeout() {
            format!("Tiempo de espera agotado al conectar con {host}. {BLOQUEO}")
        } else if err.is_connect() {
            format!("No se pudo conectar con {host}. {BLOQUEO}")
        } else if let Some(status) = err.status() {
            format!("{host} respondió con el código {}.", status.as_u16())
        } else if err.is_decode() || err.is_body() {
            format!("Respuesta incompleta o inválida de {host}.")
        } else {
            format!("Error de red con {host}: {err}")
        };
        Error::Msg(text)
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
