//! Reproductores externos (mpv y VLC).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::error::{Result, msg};
use crate::extract::Stream;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum External {
    Mpv,
    Vlc,
}

impl External {
    fn label(self) -> &'static str {
        match self {
            External::Mpv => "mpv",
            External::Vlc => "VLC",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Detected {
    pub mpv: Option<String>,
    pub vlc: Option<String>,
}

pub fn detect(mpv_path: Option<&str>, vlc_path: Option<&str>) -> Detected {
    let show = |p: PathBuf| p.to_string_lossy().into_owned();
    Detected {
        mpv: find(External::Mpv, mpv_path).map(show),
        vlc: find(External::Vlc, vlc_path).map(show),
    }
}

/// Ruta manual si existe; si no, el PATH y las carpetas de instalación habituales.
pub fn find(player: External, manual: Option<&str>) -> Option<PathBuf> {
    if let Some(manual) = manual.map(str::trim).filter(|m| !m.is_empty()) {
        let path = PathBuf::from(manual);
        return path.is_file().then_some(path);
    }
    let (commands, candidates): (&[&str], Vec<PathBuf>) = match player {
        External::Mpv => (
            &["mpv", "mpvnet"],
            [
                env_path("ProgramFiles", r"mpv\mpv.exe"),
                env_path("ProgramFiles", r"mpv.net\mpvnet.exe"),
                env_path("LOCALAPPDATA", r"Programs\mpv.net\mpvnet.exe"),
                env_path("USERPROFILE", r"scoop\apps\mpv\current\mpv.exe"),
                env_path("ProgramData", r"chocolatey\bin\mpv.exe"),
            ]
            .into_iter()
            .flatten()
            .collect(),
        ),
        External::Vlc => (
            &["vlc"],
            [
                env_path("ProgramFiles", r"VideoLAN\VLC\vlc.exe"),
                env_path("ProgramFiles(x86)", r"VideoLAN\VLC\vlc.exe"),
                env_path("USERPROFILE", r"scoop\apps\vlc\current\vlc.exe"),
            ]
            .into_iter()
            .flatten()
            .collect(),
        ),
    };
    // Las apps abiertas desde el Finder no heredan el PATH de Homebrew ni ven los .app como comandos.
    #[cfg(target_os = "macos")]
    let candidates: Vec<PathBuf> = candidates
        .into_iter()
        .chain(
            match player {
                External::Mpv => &["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv", "/Applications/mpv.app/Contents/MacOS/mpv"][..],
                External::Vlc => &["/Applications/VLC.app/Contents/MacOS/VLC"][..],
            }
            .iter()
            .map(PathBuf::from),
        )
        .collect();
    commands
        .iter()
        .find_map(|c| which::which(c).ok())
        .or_else(|| candidates.into_iter().find(|p| p.is_file()))
}

fn env_path(var: &str, rest: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(|base| Path::new(&base).join(rest))
}

/// Abre el video en el reproductor y devuelve la ruta del ejecutable y el proceso.
///
/// - `start`: segundo por el que empezar (0 = desde el principio).
/// - `minuto`: sólo mpv; carpeta donde mpv deja al cerrarse por dónde iba (`start=<s>` en su
///   archivo de "ver más tarde"). Ver [`leer_minuto_mpv`].
pub fn launch(
    player: External,
    manual: Option<&str>,
    stream: &Stream,
    title: &str,
    start: f64,
    minuto: Option<&Path>,
) -> Result<(String, std::process::Child)> {
    let exe = find(player, manual).ok_or_else(|| {
        msg(format!(
            "No se encontró {}. Instálalo o indica la ruta del ejecutable en Ajustes.",
            player.label()
        ))
    })?;
    let referer = stream.headers.get("Referer");
    let user_agent = stream.headers.get("User-Agent");

    let mut args: Vec<String> = Vec::new();
    match player {
        External::Mpv => {
            args.push(format!("--force-media-title={title}"));
            if start > 0.0 {
                args.push(format!("--start={}", start.floor()));
            }
            if let Some(carpeta) = minuto {
                args.push("--save-position-on-quit".into());
                args.push(format!("--watch-later-directory={}", carpeta.display()));
            }
            if let Some(referer) = referer {
                args.push(format!("--referrer={referer}"));
            }
            if let Some(ua) = user_agent {
                args.push(format!("--user-agent={ua}"));
            }
            args.push(stream.url.clone());
        }
        External::Vlc => {
            args.push(format!("--meta-title={title}"));
            if start > 0.0 {
                args.push(format!("--start-time={}", start.floor()));
            }
            if let Some(referer) = referer {
                args.push(format!("--http-referrer={referer}"));
            }
            if let Some(ua) = user_agent {
                args.push(format!("--http-user-agent={ua}"));
            }
            args.push(stream.url.clone());
        }
    }

    let mut command = Command::new(&exe);
    command.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Sin ventana de consola si el ejecutable es de consola (p. ej. mpv.com).
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command
        .spawn()
        .map_err(|err| msg(format!("No se pudo abrir {}: {err}", player.label())))?;
    Ok((exe.to_string_lossy().into_owned(), child))
}

/// Por dónde se quedó mpv: lee `start=<segundos>` del archivo que deja en `carpeta` al cerrarse.
/// Sin archivo, el video terminó (mpv no lo guarda al llegar al final): `Some(0)`.
pub fn leer_minuto_mpv(carpeta: &Path) -> Option<f64> {
    let Ok(entradas) = std::fs::read_dir(carpeta) else { return Some(0.0) };
    let mut minuto = Some(0.0);
    for entrada in entradas.flatten() {
        let texto = std::fs::read_to_string(entrada.path()).unwrap_or_default();
        if let Some(s) = texto.lines().find_map(|l| l.trim().strip_prefix("start=")) {
            minuto = s.trim().parse().ok();
        }
    }
    minuto
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lee_el_minuto_que_guarda_mpv() {
        let carpeta = std::env::temp_dir().join(format!("aw-mpv-{}", uuid::Uuid::new_v4()));
        assert_eq!(leer_minuto_mpv(&carpeta), Some(0.0), "sin carpeta: terminado");
        std::fs::create_dir_all(&carpeta).unwrap();
        std::fs::write(carpeta.join("0A1B2C"), "# https://x/video.m3u8\nstart=754.531000\nvolume=80\n").unwrap();
        assert_eq!(leer_minuto_mpv(&carpeta), Some(754.531));
        std::fs::remove_dir_all(&carpeta).unwrap();
    }
}
