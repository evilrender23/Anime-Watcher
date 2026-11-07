import * as api from "../api";
import type { AnimeCard } from "../api";
import { router, type ViewContext } from "../router";
import { detailRoute, homeRoute } from "../routes";
import { setCrumbs } from "../shell";
import { empty, h, loadInto, poster, skeleton } from "../ui";

export function searchView(root: HTMLElement, ctx: ViewContext, query: string): void {
  setCrumbs({ label: "Inicio", onClick: () => router.navigate(homeRoute()) }, "Búsqueda");
  const count = h("span", { class: "rule-count" });
  const body = h("div");
  root.append(
    h(
      "div",
      { class: "page" },
      h(
        "header",
        { class: "page-head" },
        h("p", { class: "eyebrow" }, "Resultados para"),
        h("h1", { class: "display" }, `“${query}”`),
      ),
      h(
        "section",
        { class: "block" },
        h(
          "header",
          { class: "rule" },
          h("h2", { class: "rule-title" }, "Animé"),
          count,
          h("span", { class: "rule-line", attrs: { "aria-hidden": "true" } }),
        ),
        body,
      ),
    ),
  );

  loadInto(
    body,
    ctx.signal,
    () => api.search(query),
    (list) => {
      count.textContent = String(list.length);
      if (!list.length) {
        body.append(
          empty(
            "No se encontró ningún animé con ese nombre.",
            "Prueba con el título en japonés o en romaji, o con una sola palabra clave.",
          ),
        );
        return;
      }
      body.append(h("div", { class: "grid grid-posters" }, list.map((a, i) => animeCard(a, i))));
    },
    "Buscando…",
    () => skeleton("posters", 14, "Buscando…"),
  );
}

function animeCard(anime: AnimeCard, index: number): HTMLElement {
  const meta = [anime.kind, anime.year].filter((part): part is string => !!part && !!part.trim());
  return h(
    "button",
    {
      class: "tile",
      title: anime.title,
      style: `--i:${Math.min(index, 16)}`,
      onclick: () => router.navigate(detailRoute(anime.url)),
    },
    h("div", { class: "tile-media" }, poster(anime.cover, anime.title, "ratio-poster")),
    h(
      "div",
      { class: "tile-caption tile-caption-stack" },
      h("span", { class: "tile-title" }, anime.title),
      meta.length ? h("span", { class: "tile-meta" }, meta.join(" · ")) : null,
      anime.genre ? h("span", { class: "tile-sub" }, anime.genre) : null,
    ),
  );
}
