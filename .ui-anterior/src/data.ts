// Caché en memoria de las fichas de animé para no repetir peticiones al navegar
// entre detalle y reproductor.
import * as api from "./api";
import type { AnimeDetail } from "./api";

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: AnimeDetail }>();

export function normUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normUrl(a) === normUrl(b);
}

export function cachedAnime(url: string): AnimeDetail | null {
  const hit = cache.get(normUrl(url));
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(normUrl(url));
    return null;
  }
  return hit.data;
}

export function rememberAnime(detail: AnimeDetail, requestedUrl?: string): void {
  const entry = { at: Date.now(), data: detail };
  cache.set(normUrl(detail.url), entry);
  if (requestedUrl) cache.set(normUrl(requestedUrl), entry);
}

export async function getAnime(url: string): Promise<AnimeDetail> {
  const hit = cachedAnime(url);
  if (hit) return hit;
  const detail = await api.anime(url);
  rememberAnime(detail, url);
  return detail;
}
