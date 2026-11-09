import * as api from "../api";
import type { AnimeCard, AnimeDetail, Episode, HistoryEntry } from "../api";
import { getAnime, sameUrl } from "../data";
import { router, type ViewContext } from "../router";
import { detailRoute, homeRoute, playerRoute } from "../routes";
import { compareSeasons, franchiseKey, franchiseName, seasonInfo } from "../seasons";
import { setCrumbs } from "../shell";
import { sourceOf } from "../sources";
import { copyText, withMenu } from "../contextmenu";
import { listMenuItems, listPanel, peekList, saveEntry } from "../mylist";
import { sameUrl as same } from "../data";
import { empty, fact, h, icon, loadInto, poster, skeleton, toast } from "../ui";

/** Orden de la lista de episodios; se conserva entre fichas durante la sesión. */
let sortDesc = false;

export function detailView(root: HTMLElement, ctx: ViewContext, url: string): void {
  const home = { label: "Inicio", onClick: () => router.navigate(homeRoute()) };
  setCrumbs(home, "Ficha");
  const page = h("div", { class: "page detail-page" });
  root.append(page);
  loadInto(
    page,
    ctx.signal,
    () =>
      Promise.all([
        getAnime(url),
        api.historyList().catch((e: unknown): HistoryEntry[] => {
          console.warn("No se pudo leer el historial", e);
          return [];
        }),
      ]),
    ([detail, history]) => {
      setCrumbs(home, detail.title);
      const entry = history.find((x) => sameUrl(x.animeUrl, url) || sameUrl(x.animeUrl, detail.url)) ?? null;
      renderDetail(page, detail, entry);
    },
    "Cargando animé…",
    () => skeleton("detail", 1, "Cargando animé…"),
  );
}

function renderDetail(page: HTMLElement, detail: AnimeDetail, entry: HistoryEntry | null): void {
  const episodes = detail.episodes;
  const play = (ep: Episode) => router.navigate(playerRoute(ep.url, detail));

  // Acciones: continuar donde se quedó o empezar desde el primero.
  const actions = h("div", { class: "actions" });
  if (entry) {
    actions.append(
      h(
        "button",
        { class: "btn btn-primary", onclick: () => router.navigate(playerRoute(entry.lastEpisodeUrl, detail)) },
        icon("play"),
        `Continuar episodio ${entry.lastEpisode}`,
      ),
    );
    let lastIndex = episodes.findIndex((e) => sameUrl(e.url, entry.lastEpisodeUrl));
    if (lastIndex < 0) lastIndex = episodes.findIndex((e) => e.number === entry.lastEpisode);
    const next = lastIndex >= 0 ? episodes[lastIndex + 1] : undefined;
    if (next) {
      actions.append(h("button", { class: "btn", onclick: () => play(next) }, icon("next"), `Siguiente · ${next.number}`));
    }
  } else if (episodes.length) {
    const first = episodes[0];
    actions.append(
      h("button", { class: "btn btn-primary", onclick: () => play(first) }, icon("play"), `Ver episodio ${first.number}`),
    );
  }

  const status = detail.status?.trim();
  const live = !!status && /emisi/i.test(status);
  const watchedCount = entry?.watched.length ?? 0;

  // Columna izquierda: portada + ficha técnica (pegajosa al hacer scroll).
  const aside = h(
    "aside",
    { class: "detail-aside" },
    poster(detail.cover, detail.title, "ratio-poster detail-cover"),
    listPanel(
      { animeUrl: detail.url, title: detail.title, cover: detail.cover, total: live ? null : episodes.length || null },
      entry ? Math.max(0, ...entry.watched.map((n) => Math.floor(n))) : 0,
    ),
    h(
      "dl",
      { class: "spec" },
      status
        ? fact("Emisión", h("span", { class: live ? "status status-live" : "status" }, live ? h("i", { class: "live-dot" }) : null, status))
        : null,
      fact("Episodios", String(episodes.length)),
      detail.season ? fact("Estreno", detail.season) : null,
      fact("Fuente", sourceOf(detail.url).name),
      entry ? fact("Vistos", `${watchedCount} / ${episodes.length}`) : null,
      entry ? fact("Último", `EP ${entry.lastEpisode}`) : null,
    ),
    detail.genres.length ? h("div", { class: "tags" }, detail.genres.map((g) => h("span", { class: "tag" }, g))) : null,
  );

  // Progreso visible sólo si ya se empezó a ver.
  const progress =
    entry && episodes.length
      ? h(
          "div",
          { class: "progress", title: `${watchedCount} de ${episodes.length} episodios vistos` },
          h("span", { class: "progress-bar", style: `--p:${Math.min(1, watchedCount / episodes.length)}` }),
        )
      : null;

  const main = h(
    "div",
    { class: "detail-main" },
    h(
      "header",
      { class: "detail-head" },
      h("p", { class: "eyebrow" }, `Ficha del animé · ${seasonInfo(detail.title, detail.kind).label}`),
      h("h1", { class: "display" }, detail.title),
      detail.altTitle ? h("p", { class: "alt-title" }, detail.altTitle) : null,
      progress,
      detail.synopsis ? h("p", { class: "lede synopsis" }, detail.synopsis.trim()) : null,
      actions,
    ),
    seasonsSection(detail),
    episodeSection(detail, entry, play),
  );

  // Fondo: la portada muy difuminada detrás de la cabecera.
  const backdrop = detail.cover
    ? h("div", { class: "backdrop", attrs: { "aria-hidden": "true" } }, poster(detail.cover, "", "backdrop-img"))
    : null;

  if (backdrop) page.append(backdrop);
  page.append(h("div", { class: "detail-layout" }, aside, main));

  const base = { animeUrl: detail.url, title: detail.title, cover: detail.cover, total: live ? null : episodes.length || null };
  const first = episodes[0];
  withMenu(page, () => [
    entry
      ? {
          label: `Continuar episodio ${entry.lastEpisode}`,
          icon: "play" as const,
          run: () => router.navigate(playerRoute(entry.lastEpisodeUrl, detail)),
        }
      : { label: first ? `Ver episodio ${first.number}` : "Sin episodios", icon: "play" as const, disabled: !first, run: () => first && play(first) },
    "-",
    ...listMenuItems(base),
    "-",
    { label: "Copiar título", icon: "copy", run: () => copyText(detail.title) },
    { label: "Copiar enlace", icon: "link", run: () => copyText(detail.url) },
  ]);
  // Cada episodio: verlo o marcar el progreso de la lista hasta él. Delegado en la rejilla,
  // que se vuelve a dibujar al cambiar el orden.
  const grid = page.querySelector(".ep-grid");
  if (grid) {
    withMenu(grid, (target) => {
      const num = (target.closest(".ep") as HTMLElement | null)?.dataset.num;
      const ep = num === undefined ? undefined : episodes.find((e) => String(e.number) === num);
      if (!ep) return [];
      const listed = peekList()?.find((e) => same(e.animeUrl, detail.url)) ?? null;
      const upTo = Math.floor(ep.number);
      return [
        { label: `Ver episodio ${ep.number}`, icon: "play", run: () => play(ep) },
        {
          label: !listed || listed.progress < upTo
            ? `Marcar visto hasta el ${ep.number}`
            : listed.progress === upTo
              ? `Visto hasta aquí en mi lista`
              : `Bajar el progreso al ${upTo}`,
          icon: "check",
          disabled: !!listed && listed.progress === upTo,
          run: async () => {
            await (listed
              ? saveEntry(listed, { progress: upTo })
              : saveEntry({ ...base, status: "watching", score: null, progress: upTo, notes: "" }, {}));
            toast(`Progreso de «${detail.title}»: ${upTo} episodios.`, "ok");
          },
        },
        "-",
        { label: "Copiar enlace del episodio", icon: "link", run: () => copyText(ep.url) },
      ];
    });
  }
}

/** Búsquedas por franquicia ya hechas en esta sesión (clave: fuente + franquicia). */
const franchiseCache = new Map<string, Promise<AnimeCard[]>>();

/**
 * Temporadas de la misma serie en la misma fuente: se buscan por el nombre de la franquicia
 * y se completan con los relacionados que enlaza la ficha (JKAnime). Se carga aparte para no
 * retrasar la ficha y se oculta si no hay más de una entrega.
 */
function seasonsSection(detail: AnimeDetail): HTMLElement {
  const section = h("section", { class: "block seasons", hidden: true });
  const key = franchiseKey(detail.title);
  const source = sourceOf(detail.url).id;
  if (!key) return section;

  const query = franchiseName([detail.title]);
  const cacheKey = `${source}:${key}`;
  const search: Promise<AnimeCard[]> =
    franchiseCache.get(cacheKey) ??
    api.search(query).catch((e: unknown): AnimeCard[] => {
      console.warn("No se pudieron buscar las temporadas", e);
      franchiseCache.delete(cacheKey);
      return [];
    });
  franchiseCache.set(cacheKey, search);

  // Si la vista ya se cerró, la sección queda fuera del documento y no pasa nada.
  void search.then((results) => {
    type Item = { title: string; url: string; cover: string | null; kind: string | null; year: string | null; relation?: string };
    const items: Item[] = [];
    const add = (it: Item) => {
      if (!items.some((x) => same(x.url, it.url))) items.push(it);
    };
    add({ title: detail.title, url: detail.url, cover: detail.cover, kind: detail.kind, year: null });
    for (const r of results) {
      if (sourceOf(r.url).id === source && franchiseKey(r.title) === key) add({ ...r });
    }
    for (const r of detail.related) {
      add({ title: r.title, url: r.url, cover: null, kind: r.kind, year: null, relation: r.relation });
    }
    if (items.length < 2) return;
    items.sort(compareSeasons);

    const current = items.findIndex((x) => same(x.url, detail.url));
    const prev = current > 0 ? items[current - 1] : null;
    const next = current >= 0 ? items[current + 1] ?? null : null;
    const nav = h(
      "div",
      { class: "rule-tools" },
      prev
        ? h("button", { class: "btn btn-sm btn-quiet", title: prev.title, onclick: () => router.navigate(detailRoute(prev.url)) }, icon("back"), "Anterior")
        : null,
      next
        ? h("button", { class: "btn btn-sm btn-quiet", title: next.title, onclick: () => router.navigate(detailRoute(next.url)) }, "Siguiente", icon("next"))
        : null,
    );

    section.replaceChildren(
      h(
        "header",
        { class: "rule" },
        h("h2", { class: "rule-title" }, "Temporadas"),
        h("span", { class: "rule-count" }, String(items.length)),
        h("span", { class: "rule-line", attrs: { "aria-hidden": "true" } }),
        nav,
      ),
      h(
        "div",
        { class: "season-list" },
        items.map((it, i) => {
          const info = seasonInfo(it.title, it.kind);
          const isCurrent = i === current;
          const sub = [it.relation, it.kind, it.year].filter(Boolean).join(" · ");
          const el = h(
            "button",
            {
              class: isCurrent ? "season-item current" : "season-item",
              title: it.title,
              attrs: isCurrent ? { "aria-current": "page" } : {},
              onclick: () => !isCurrent && router.navigate(detailRoute(it.url)),
            },
            poster(it.cover, it.title, "season-thumb"),
            h(
              "span",
              { class: "season-text" },
              h("span", { class: `season-label season-${info.category}` }, info.label),
              h("span", { class: "season-title" }, it.title),
              sub ? h("span", { class: "season-sub" }, sub) : null,
            ),
          );
          return withMenu(el, () => [
            { label: "Ver ficha y episodios", icon: "list", disabled: isCurrent, run: () => router.navigate(detailRoute(it.url)) },
            "-",
            ...listMenuItems({ animeUrl: it.url, title: it.title, cover: it.cover, total: null }),
            "-",
            { label: "Copiar título", icon: "copy", run: () => copyText(it.title) },
            { label: "Copiar enlace", icon: "link", run: () => copyText(it.url) },
          ]);
        }),
      ),
    );
    section.hidden = false;
  });
  return section;
}

function episodeSection(detail: AnimeDetail, entry: HistoryEntry | null, play: (ep: Episode) => void): HTMLElement {
  const episodes = detail.episodes;
  const head = h(
    "header",
    { class: "rule" },
    h("h2", { class: "rule-title" }, "Episodios"),
    h("span", { class: "rule-count" }, String(episodes.length)),
    h("span", { class: "rule-line", attrs: { "aria-hidden": "true" } }),
  );
  const section = h("section", { class: "block episodes" }, head);

  if (!episodes.length) {
    section.append(empty("No se encontraron episodios, intenta con otro animé."));
    return section;
  }

  const watched = new Set(entry?.watched ?? []);
  const lastNumber = entry?.lastEpisode ?? null;
  const grid = h("div", { class: "ep-grid" });

  const sortLabel = h("span");
  const sortBtn = h(
    "button",
    {
      class: "btn btn-sm btn-quiet",
      title: "Cambiar el orden",
      onclick: () => {
        sortDesc = !sortDesc;
        renderGrid();
      },
    },
    icon("sort"),
    sortLabel,
  );

  const gotoInput = h("input", {
    type: "number",
    class: "input input-sm goto-input",
    placeholder: "Ir a…",
    min: "0",
    attrs: { "aria-label": "Ir al episodio" },
    onkeydown: (e) => {
      if (e.key !== "Enter") return;
      const raw = gotoInput.value.trim();
      if (!raw) return;
      const ep = episodes.find((x) => x.number === Number(raw));
      if (ep) play(ep);
      else toast(`No existe el episodio ${raw}.`, "error");
    },
  });

  head.append(h("div", { class: "rule-tools" }, gotoInput, sortBtn));

  const renderGrid = () => {
    sortLabel.textContent = sortDesc ? "Desc." : "Asc.";
    const list = sortDesc ? [...episodes].reverse() : episodes;
    grid.replaceChildren(
      ...list.map((ep) => {
        const isLast = lastNumber !== null && ep.number === lastNumber;
        const isWatched = watched.has(ep.number);
        const cls = ["ep", isWatched ? "watched" : "", isLast ? "last" : ""].filter(Boolean).join(" ");
        const label = `Episodio ${ep.number}${isLast ? " · último visto" : isWatched ? " · visto" : ""}`;
        return h(
          "button",
          { class: cls, title: label, dataset: { num: String(ep.number) }, attrs: { "aria-label": label }, onclick: () => play(ep) },
          h("span", { class: "ep-num" }, String(ep.number).padStart(2, "0")),
          isLast ? icon("play", "icon ep-mark") : isWatched ? icon("check", "icon ep-mark") : null,
        );
      }),
    );
  };
  renderGrid();

  section.append(grid);
  if (entry) {
    section.append(
      h(
        "div",
        { class: "legend" },
        h("span", { class: "legend-item" }, h("i", { class: "swatch swatch-last" }), "Último visto"),
        h("span", { class: "legend-item" }, h("i", { class: "swatch swatch-watched" }), "Visto"),
        h("span", { class: "legend-item" }, h("i", { class: "swatch" }), "Pendiente"),
      ),
    );
  }
  return section;
}
