import * as api from "../api";
import type { AnimeDetail, Episode, HistoryEntry } from "../api";
import { getAnime, sameUrl } from "../data";
import { router, type ViewContext } from "../router";
import { playerRoute } from "../routes";
import { empty, h, icon, loadInto, poster, skeleton, toast } from "../ui";

/** Orden de la lista de episodios; se conserva entre fichas durante la sesión. */
let sortDesc = false;

export function detailView(root: HTMLElement, ctx: ViewContext, url: string): void {
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

  // Botones principales: continuar donde se quedó o empezar desde el primero.
  const actions = h("div", { class: "detail-actions" });
  if (entry) {
    actions.append(
      h(
        "button",
        { class: "btn btn-primary btn-lg", onclick: () => router.navigate(playerRoute(entry.lastEpisodeUrl, detail)) },
        icon("play"),
        `Continuar · Episodio ${entry.lastEpisode}`,
      ),
    );
    let lastIndex = episodes.findIndex((e) => sameUrl(e.url, entry.lastEpisodeUrl));
    if (lastIndex < 0) lastIndex = episodes.findIndex((e) => e.number === entry.lastEpisode);
    const next = lastIndex >= 0 ? episodes[lastIndex + 1] : undefined;
    if (next) {
      actions.append(
        h("button", { class: "btn btn-lg", onclick: () => play(next) }, icon("next"), `Siguiente · Episodio ${next.number}`),
      );
    }
  } else if (episodes.length) {
    const first = episodes[0];
    actions.append(
      h("button", { class: "btn btn-primary btn-lg", onclick: () => play(first) }, icon("play"), `Ver episodio ${first.number}`),
    );
  }

  const status = detail.status?.trim();
  const badges = h(
    "div",
    { class: "badges" },
    status
      ? h(
          "span",
          { class: /emisi/i.test(status) ? "badge badge-live" : "badge" },
          /emisi/i.test(status) ? h("span", { class: "live-dot", attrs: { "aria-hidden": "true" } }) : null,
          status,
        )
      : null,
    h("span", { class: "badge" }, `${episodes.length} ${episodes.length === 1 ? "episodio" : "episodios"}`),
  );

  const backdrop: HTMLElement[] = [];
  if (detail.cover) {
    const img = document.createElement("img");
    img.className = "detail-backdrop";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.remove(), { once: true });
    img.src = detail.cover;
    backdrop.push(img);
  }

  const hero = h(
    "section",
    { class: "detail-hero" },
    backdrop,
    h(
      "div",
      { class: "detail-hero-inner" },
      poster(detail.cover, detail.title, "ratio-poster detail-cover"),
      h(
        "div",
        { class: "detail-info" },
        h("p", { class: "eyebrow" }, "Ficha del animé"),
        h("h1", { class: "detail-title" }, detail.title),
        detail.altTitle ? h("div", { class: "detail-alt" }, detail.altTitle) : null,
        badges,
        detail.genres.length
          ? h("div", { class: "genres" }, detail.genres.map((g) => h("span", { class: "genre" }, g)))
          : null,
        detail.synopsis ? h("p", { class: "synopsis" }, detail.synopsis.trim()) : null,
        actions,
      ),
    ),
  );

  page.append(hero, episodeSection(detail, entry, play));
}

function episodeSection(detail: AnimeDetail, entry: HistoryEntry | null, play: (ep: Episode) => void): HTMLElement {
  const episodes = detail.episodes;
  const title = h(
    "div",
    { class: "section-head" },
    h(
      "h2",
      { class: "section-title" },
      h("span", { class: "section-icon" }, icon("list")),
      "Episodios",
      h("span", { class: "section-count" }, String(episodes.length)),
    ),
  );
  const section = h("section", { class: "section episodes" }, title);

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
      class: "btn btn-sm",
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
    placeholder: "Nº",
    min: "0",
    onkeydown: (e) => {
      if (e.key !== "Enter") return;
      const raw = gotoInput.value.trim();
      if (!raw) return;
      const ep = episodes.find((x) => x.number === Number(raw));
      if (ep) play(ep);
      else toast(`No existe el episodio ${raw}.`, "error");
    },
  });

  title.append(
    h(
      "div",
      { class: "episode-tools" },
      h("label", { class: "goto" }, "Ir al episodio", gotoInput),
      sortBtn,
    ),
  );

  const renderGrid = () => {
    sortLabel.textContent = sortDesc ? "Descendente" : "Ascendente";
    const list = sortDesc ? [...episodes].reverse() : episodes;
    grid.replaceChildren(
      ...list.map((ep) => {
        const isLast = lastNumber !== null && ep.number === lastNumber;
        const isWatched = watched.has(ep.number);
        const cls = ["ep-btn", isWatched ? "watched" : "", isLast ? "last" : ""].filter(Boolean).join(" ");
        const label = `Episodio ${ep.number}${isLast ? " · último visto" : isWatched ? " · visto" : ""}`;
        return h(
          "button",
          { class: cls, title: label, attrs: { "aria-label": label }, onclick: () => play(ep) },
          h("span", { class: "ep-num" }, String(ep.number)),
          isLast
            ? h("span", { class: "ep-mark ep-mark-last" }, icon("play"))
            : isWatched
              ? h("span", { class: "ep-mark" }, icon("check"))
              : null,
        );
      }),
    );
  };
  renderGrid();

  const legend = entry
    ? h(
        "div",
        { class: "ep-legend" },
        h("span", { class: "legend-item" }, h("span", { class: "ep-mark ep-mark-last" }, icon("play")), "Último visto"),
        h("span", { class: "legend-item" }, h("span", { class: "ep-mark" }, icon("check")), "Visto"),
      )
    : null;

  section.append(grid);
  if (legend) section.append(legend);
  return section;
}
