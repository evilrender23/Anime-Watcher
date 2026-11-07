// Contrato entre la interfaz y el backend en Rust (src-tauri/src/commands.rs).
// Todos los comandos rechazan la promesa con un mensaje de error en español (string).
import { invoke } from "@tauri-apps/api/core";

/** Episodio reciente mostrado en la portada del sitio. */
export interface EpisodeCard {
  title: string;
  number: number;
  url: string;
  thumb: string | null;
}

/** Resultado de búsqueda. */
export interface AnimeCard {
  title: string;
  url: string;
  cover: string | null;
  year: string | null;
  /** "Anime", "Película", "OVA", ... */
  kind: string | null;
  genre: string | null;
}

export interface Episode {
  number: number;
  url: string;
  thumb: string | null;
}

export interface AnimeDetail {
  url: string;
  title: string;
  altTitle: string | null;
  cover: string | null;
  /** "Finalizado", "En emisión", ... */
  status: string | null;
  genres: string[];
  synopsis: string | null;
  /** Ordenados de forma ascendente por número. */
  episodes: Episode[];
}

/**
 * "direct": el backend sabe extraer el video (reproductor integrado o mpv/VLC).
 * "web": sólo se puede ver con el reproductor web del servidor (iframe) o en el navegador.
 */
export type ServerSupport = "direct" | "web";

export interface Server {
  name: string;
  url: string;
  support: ServerSupport;
}

export interface EpisodeInfo {
  url: string;
  animeTitle: string;
  number: number | null;
  animeUrl: string | null;
  /** Ya vienen ordenados por preferencia: primero los "direct" más fiables, luego los "web". */
  servers: Server[];
}

export interface ResolvedStream {
  /** Nombre del servidor del que salió el video. */
  server: string;
  kind: "hls" | "mp4";
  /** URL directa del video (requiere las cabeceras de `headers`). */
  url: string;
  headers: Record<string, string>;
  /** URL local (http://127.0.0.1:PUERTO/...) que ya añade las cabeceras; usar en <video>/hls.js. */
  proxyUrl: string;
}

export type PlayerKind = "builtin" | "mpv" | "vlc";
export type ExternalPlayer = "mpv" | "vlc";

export interface Settings {
  player: PlayerKind;
  /** Ruta manual a mpv.exe; null = detección automática. */
  mpvPath: string | null;
  /** Ruta manual a vlc.exe; null = detección automática. */
  vlcPath: string | null;
  /** Pasar al siguiente episodio al terminar (reproductor integrado). */
  autoNext: boolean;
}

export interface DetectedPlayers {
  mpv: string | null;
  vlc: string | null;
}

export interface HistoryEntry {
  animeUrl: string;
  title: string;
  cover: string | null;
  lastEpisode: number;
  lastEpisodeUrl: string;
  /** Números de episodio vistos. */
  watched: number[];
  /** Milisegundos desde UNIX_EPOCH. */
  updatedAt: number;
}

export interface HistoryMark {
  animeUrl: string;
  title: string;
  cover: string | null;
  episode: number;
  episodeUrl: string;
}

export const latest = () => invoke<EpisodeCard[]>("latest");
export const search = (query: string) => invoke<AnimeCard[]>("search", { query });
export const anime = (url: string) => invoke<AnimeDetail>("anime", { url });
export const episode = (url: string) => invoke<EpisodeInfo>("episode", { url });
export const resolve = (server: Server) =>
  invoke<ResolvedStream>("resolve", { name: server.name, url: server.url });
/** Abre el video en mpv o VLC. Devuelve la ruta del ejecutable usado. */
export const playExternal = (stream: ResolvedStream, title: string, player: ExternalPlayer) =>
  invoke<string>("play_external", { stream, title, player });

export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) => invoke<void>("save_settings", { settings });
export const detectPlayers = () => invoke<DetectedPlayers>("detect_players");

/** Se emite en `window` cada vez que cambia el historial (la barra lateral lo escucha). */
export const HISTORY_EVENT = "aw:history-changed";
const historyChanged = () => window.dispatchEvent(new Event(HISTORY_EVENT));

export const historyList = () => invoke<HistoryEntry[]>("history_list");
export const historyMark = async (mark: HistoryMark) => {
  const entry = await invoke<HistoryEntry>("history_mark", { mark });
  historyChanged();
  return entry;
};
export const historyRemove = async (animeUrl: string) => {
  await invoke<void>("history_remove", { animeUrl });
  historyChanged();
};
