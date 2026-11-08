//! Argumentos de la línea de comandos, como en ani-es:
//!
//!     anime-watcher [opciones] [búsqueda]
//!       -h, --help        muestra la ayuda
//!       -v, --version     muestra la versión
//!       -c, --continue    continúa el último animé donde lo dejaste
//!
//! `anime-watcher naruto` abre la app buscando "naruto".

use serde::Serialize;

/// Qué hacer al abrir la app (lo recoge la interfaz con `startup_action`).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inicio {
    pub busqueda: Option<String>,
    pub continuar: bool,
}

#[derive(Debug, PartialEq)]
pub enum Accion {
    Abrir(Inicio),
    /// Escribir este texto y salir sin abrir la ventana.
    Salir(String),
}

pub fn ayuda() -> String {
    format!(
        "Anime Watcher {}\n\n\
         Uso: anime-watcher [opciones] [búsqueda]\n\n\
         Opciones:\n  \
           -h, --help        Muestra esta ayuda\n  \
           -v, --version     Muestra la versión\n  \
           -c, --continue    Continúa el último animé donde lo dejaste\n\n\
         Ejemplos:\n  \
           anime-watcher naruto\n  \
           anime-watcher -c\n",
        env!("CARGO_PKG_VERSION")
    )
}

pub fn interpretar(args: impl IntoIterator<Item = String>) -> Accion {
    let mut inicio = Inicio::default();
    let mut palabras: Vec<String> = Vec::new();
    for arg in args {
        // macOS añade -psn_0_12345 al abrir desde el Finder en sistemas antiguos.
        if arg.starts_with("-psn_") {
            continue;
        }
        if !palabras.is_empty() {
            palabras.push(arg);
            continue;
        }
        match arg.as_str() {
            "-h" | "--help" | "--ayuda" => return Accion::Salir(ayuda()),
            "-v" | "--version" => return Accion::Salir(format!("anime-watcher v{}\n", env!("CARGO_PKG_VERSION"))),
            "-c" | "--continue" | "--continuar" => inicio.continuar = true,
            "--" => {}
            otro if otro.starts_with('-') => {}
            _ => palabras.push(arg),
        }
    }
    let busqueda = palabras.join(" ").trim().to_owned();
    inicio.busqueda = (!busqueda.is_empty()).then_some(busqueda);
    Accion::Abrir(inicio)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn como_ani_es() {
        assert_eq!(interpretar(args(&[])), Accion::Abrir(Inicio::default()));
        assert_eq!(
            interpretar(args(&["one", "piece"])),
            Accion::Abrir(Inicio { busqueda: Some("one piece".into()), continuar: false })
        );
        assert_eq!(interpretar(args(&["-c"])), Accion::Abrir(Inicio { busqueda: None, continuar: true }));
        assert!(matches!(interpretar(args(&["--help"])), Accion::Salir(t) if t.contains("--continue")));
        assert!(matches!(interpretar(args(&["-v"])), Accion::Salir(t) if t.starts_with("anime-watcher v")));
        assert_eq!(interpretar(args(&["-psn_0_1234"])), Accion::Abrir(Inicio::default()));
        // Tras la primera palabra todo es búsqueda (como "naruto -shippuden").
        assert_eq!(
            interpretar(args(&["naruto", "-c"])),
            Accion::Abrir(Inicio { busqueda: Some("naruto -c".into()), continuar: false })
        );
    }
}
