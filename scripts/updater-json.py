#!/usr/bin/env python3
"""Genera el latest.json del actualizador a partir de los archivos de una release.

Uso: updater-json.py <version> <notas> <base_url> <carpeta_con_.sig> <salida>

<carpeta_con_.sig> contiene las firmas (*.sig) descargadas de la release; cada firma
se llama igual que su instalador más ".sig". <base_url> es la URL de descarga de los
archivos de la release, p. ej. https://github.com/USUARIO/REPO/releases/download/v1.0.1

El actualizador de Tauri busca primero la clave "<so>-<arq>-<instalador>" y después
"<so>-<arq>", así que se publican las dos para que funcione con cualquier forma de
instalación: NSIS o MSI en Windows, .app en macOS y AppImage, .deb o .rpm en Linux.
"""
import json
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

# (clave en latest.json, función que reconoce el nombre del instalador)
RULES = [
    ("windows-x86_64-nsis", lambda n: n.endswith("_x64-setup.exe")),
    ("windows-x86_64-msi", lambda n: n.endswith(".msi") and "_x64_" in n),
    ("darwin-aarch64-app", lambda n: n.endswith("_aarch64.app.tar.gz")),
    ("darwin-x86_64-app", lambda n: n.endswith("_x64.app.tar.gz")),
    ("linux-x86_64-appimage", lambda n: n.endswith("_amd64.AppImage")),
    ("linux-x86_64-deb", lambda n: n.endswith("_amd64.deb")),
    ("linux-x86_64-rpm", lambda n: n.endswith(".x86_64.rpm")),
    ("linux-aarch64-appimage", lambda n: n.endswith("_aarch64.AppImage")),
]

# Instalador preferido para la clave genérica "<so>-<arq>" (sin tipo de instalador).
DEFAULTS = {
    "windows-x86_64": "windows-x86_64-nsis",
    "darwin-aarch64": "darwin-aarch64-app",
    "darwin-x86_64": "darwin-x86_64-app",
    "linux-x86_64": "linux-x86_64-appimage",
    "linux-aarch64": "linux-aarch64-appimage",
}


def build(version: str, notes: str, base_url: str, sig_dir: Path) -> dict:
    platforms: dict[str, dict] = {}
    for sig in sorted(sig_dir.glob("*.sig")):
        asset = sig.name[: -len(".sig")]
        for key, matches in RULES:
            if matches(asset) and key not in platforms:
                platforms[key] = {
                    "signature": sig.read_text(encoding="utf-8").strip(),
                    "url": f"{base_url.rstrip('/')}/{urllib.parse.quote(asset)}",
                }
    for generic, specific in DEFAULTS.items():
        if specific in platforms:
            platforms[generic] = platforms[specific]
    return {
        "version": version,
        "notes": notes,
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": dict(sorted(platforms.items())),
    }


def main() -> int:
    if len(sys.argv) != 6:
        print(__doc__, file=sys.stderr)
        return 2
    version, notes, base_url, sig_dir, out = sys.argv[1:]
    data = build(version, notes, base_url, Path(sig_dir))
    required = ["windows-x86_64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"]
    missing = [p for p in required if p not in data["platforms"]]
    Path(out).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"latest.json: {', '.join(data['platforms'])}")
    if missing:
        print(f"Faltan plataformas en la release: {', '.join(missing)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
