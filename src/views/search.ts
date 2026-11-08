import * as api from "../api";
import type { AnimeCard } from "../api";
import { router, type ViewContext } from "../router";
import { detailRoute, homeRoute } from "../routes";
import { copyText, withMenu } from "../contextmenu";
import { listMenuItems } from "../mylist";
import { setCrumbs } from "../shell";
import { SOURCES, sourceOf } from "../sources";
import { empty, h, loadInto, poster, skeleton } from "../ui";

export function searchView(root: HTMLElement, ctx: ViewContext, query: string): void {
  setCrumbs({ label: "Inicio", onClick: () => router.navigate(homeRoute()) }, "Búsqueda");
  const body = h("div", { class: "search-sources" });
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
      body,
    ),
  );

  loadInto(
    body,
    ctx.signal,
    () => api.search(query),
    (list) => {
      if (!list.length) {
        body.append(
          empty(
            "No se encontró ningún animé con ese nombre en MonosChinos ni en JKAnime.",
            "Prueba con el título en japonés o en romaji, o con una sola palabra clave.",
          ),
        );
        return;
      }
      // Una sección por fuente: el mismo animé puede estar en las dos con distintos servidores.
      for (const source of SOURCES) {
        const items = list.filter((a) => sourceOf(a.url).id === source.id);
        if (!items.length) continue;
        body.append(
          h(
            "section",
            { class: "block" },
            h(
              "header",
              { class: "rule" },
              h("h2", { class: "rule-title" }, source.name),
              h("span", { class: "rule-count" }, String(items.length)),
              h("span", { class: "rule-line", attrs: { "aria-hidden": "true" } }),
            ),
            h("div", { class: "grid grid-posters" }, items.map((a, i) => animeCard(a, i))),
          ),
        );
      }
    },
    "Buscando en MonosChinos y JKAnime…",
    () => skeleton("posters", 14, "Buscando…"),
  );
}

function animeCard(anime: AnimeCard, index: number): HTMLElement {
  const meta = [anime.kind, anime.year].filter((part): part is string => !!part && !!part.trim());
  const tile = h(
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
  return withMenu(tile, () => [
    { label: "Ver ficha y episodios", icon: "list", run: () => router.navigate(detailRoute(anime.url)) },
    "-",
    ...listMenuItems({ animeUrl: anime.url, title: anime.title, cover: anime.cover, total: null }),
    "-",
    { label: "Copiar título", icon: "copy", run: () => copyText(anime.title) },
    { label: "Copiar enlace", icon: "link", run: () => copyText(anime.url) },
  ]);
}
