// Temporadas: agrupa los animés de una misma franquicia ("Shingeki no Kyojin", "… Temporada 2",
// "…: The Final Season", "… Movie 1") y los ordena como se ven: temporadas, películas y extras.
// Las fuentes no dan la franquicia, así que se deduce del título.

export type SeasonCategory = "tv" | "movie" | "extra";

export interface SeasonInfo {
  category: SeasonCategory;
  /** Número de temporada (1 si no lo indica; 99 = temporada final). */
  season: number;
  /** Parte o cour dentro de la temporada (0 = sin partes). */
  part: number;
  /** Sin número de temporada pero con subtítulo ("Yuukaku-hen"): va tras la serie original. */
  arc: boolean;
  /** "Temporada 2 · Parte 2", "Película 1", "OVA"… */
  label: string;
}

const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const FINAL = 99;

/** Minúsculas y sin tildes, para comparar títulos. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const MOVIE_RE = /\b(?:movie|pelicula|gekijouban|film)\b/;
const EXTRA_RE = /\b(?:ova|ona|oad|specials?|especial(?:es)?|recap|picture drama)\b/;

/** Temporada, parte y tipo deducidos del título (y del tipo que dé la fuente). */
export function seasonInfo(title: string, kind?: string | null): SeasonInfo {
  const t = fold(title);
  const k = fold(kind ?? "");
  const num = (re: RegExp) => {
    const m = t.match(re);
    return m ? Number(m[1]) : 0;
  };

  if (MOVIE_RE.test(k) || MOVIE_RE.test(t)) {
    const n = num(/\b(?:movie|pelicula|film)\s*(\d+)\b/);
    // Las películas sin número van detrás de las numeradas.
    return { category: "movie", season: n || 50, part: 0, arc: false, label: n ? `Película ${n}` : "Película" };
  }
  // Si el título dice qué temporada es, manda sobre el tipo ("Final Season - Kanketsu-hen" es "Especial").
  const seasonInTitle = /\b(?:temporada|season|saison)\b|\bkanketsu-?hen\b/.test(t);
  if (!seasonInTitle && (EXTRA_RE.test(k) || EXTRA_RE.test(t))) {
    const label = /\bova\b/.test(k) || /\bova\b/.test(t)
      ? "OVA"
      : /\bona\b/.test(k) || /\bona\b/.test(t)
        ? "ONA"
        : /recap/.test(t)
          ? "Resumen"
          : "Especial";
    return { category: "extra", season: 0, part: 0, arc: false, label };
  }

  let season =
    num(/\b(?:temporada|season|saison)\s*(\d+)\b/) ||
    num(/\b(\d+)\s*(?:st|nd|rd|th|a|ª|º)?\s*(?:season|temporada)\b/);
  if (!season) {
    const roman = t.match(/\b(ii|iii|iv|vi{0,3}|ix|x)\s*$/) ?? t.match(/\b(ii|iii|iv|vi{0,3}|ix|x)\s*[:\-–]/);
    if (roman && ROMAN[roman[1]]) season = ROMAN[roman[1]];
  }
  const final = /\bfinal season\b|\btemporada final\b|\bkanketsu-?hen\b/.test(t);
  if (final) season = FINAL;
  let part = num(/\b(?:part|parte|cour)\s*(\d+)\b/);
  // "The Final Season - Kanketsu-hen" es la última parte de la temporada final.
  if (/\bkanketsu-?hen\b/.test(t) && !part) part = 3;
  const subtitle = subtitleOf(title);
  if (!season && !part && subtitle) return { category: "tv", season: 1, part: 0, arc: true, label: subtitle };
  if (!season) season = 1;

  let label = season === FINAL ? "Temporada final" : `Temporada ${season}`;
  if (part) label += ` · Parte ${part}`;
  return { category: "tv", season, part, arc: false, label };
}

/** Lo que va tras ": " o " - " ("Re:Zero" no lleva espacio y no cuenta). */
function subtitleOf(title: string): string | null {
  const m = title.match(/(?::\s|\s[-–—]\s)(.+)$/);
  return m ? m[1].trim() : null;
}

/** Clave de franquicia: el título sin subtítulo ni marcas de temporada, parte, película u OVA. */
export function franchiseKey(title: string): string {
  let t = fold(title);
  // El subtítulo va tras ": " o " - " ("Re:Zero" no lleva espacio y se conserva).
  t = t.split(/:\s|\s[-–—]\s/)[0];
  t = t
    .replace(/\((?:tv|serie|sub(?: espanol)?)\)/g, " ")
    .replace(/\b\d+\s*(?:st|nd|rd|th|a|ª|º)?\s*(?:season|temporada)\b/g, " ")
    .replace(/\b(?:temporada|season|saison)\s*\d*\b/g, " ")
    .replace(/\b(?:the )?final\b/g, " ")
    .replace(/\b(?:part|parte|cour)\s*\d+\b/g, " ")
    .replace(/\b(?:movie|pelicula|gekijouban|film)\s*\d*\b/g, " ")
    .replace(/\b(?:ova|ona|oad|specials?|especial(?:es)?|recap|picture drama)\b/g, " ")
    .replace(/\b(?:ii|iii|iv|vi{0,3}|ix)\s*$/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return t;
}

/** Título "limpio" de la franquicia para mostrarlo (el más corto del grupo, sin subtítulo). */
export function franchiseName(titles: string[]): string {
  const base = titles.map((t) => t.split(/:\s|\s[-–—]\s/)[0].trim());
  return base.sort((a, b) => a.length - b.length)[0] ?? titles[0] ?? "";
}

const CATEGORY_ORDER: Record<SeasonCategory, number> = { tv: 0, movie: 1, extra: 2 };

/** Orden de visionado: temporadas por número y parte; después películas y extras. */
export function compareSeasons(
  a: { title: string; kind?: string | null; year?: string | null },
  b: { title: string; kind?: string | null; year?: string | null },
): number {
  const sa = seasonInfo(a.title, a.kind);
  const sb = seasonInfo(b.title, b.kind);
  const year = (x: { year?: string | null }) => Number(x.year) || 0;
  return (
    CATEGORY_ORDER[sa.category] - CATEGORY_ORDER[sb.category] ||
    sa.season - sb.season ||
    sa.part - sb.part ||
    Number(sa.arc) - Number(sb.arc) ||
    year(a) - year(b) ||
    a.title.localeCompare(b.title, "es")
  );
}

export interface Franchise<T> {
  key: string;
  name: string;
  items: T[];
}

/**
 * Agrupa por franquicia conservando el orden en que aparece cada una. Los grupos de un
 * solo animé se devuelven aparte en `singles`.
 */
export function groupByFranchise<T extends { title: string; kind?: string | null; year?: string | null }>(
  items: T[],
): { groups: Franchise<T>[]; singles: T[] } {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = franchiseKey(item.title) || fold(item.title);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  const groups: Franchise<T>[] = [];
  const singles: T[] = [];
  for (const [key, list] of map) {
    if (list.length < 2) {
      singles.push(...list);
      continue;
    }
    list.sort(compareSeasons);
    groups.push({ key, name: franchiseName(list.map((x) => x.title)), items: list });
  }
  return { groups, singles };
}
