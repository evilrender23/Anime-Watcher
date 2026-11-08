// Fuentes de animé. El backend decide por el dominio de cada URL (ver src-tauri/src/jkanime.rs),
// así que aquí sólo hace falta para mostrar de dónde sale cada cosa.
export type SourceId = "monoschinos" | "jkanime";

export interface Source {
  id: SourceId;
  name: string;
}

export const SOURCES: readonly Source[] = [
  { id: "monoschinos", name: "MonosChinos" },
  { id: "jkanime", name: "JKAnime" },
];

export function sourceOf(url: string): Source {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // URL relativa o inválida: la fuente principal.
  }
  return SOURCES[/(^|\.)jkanime\.net$/.test(host) ? 1 : 0];
}
