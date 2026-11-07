// Fábricas de rutas: cada una describe una vista con sus parámetros.
import type { AnimeDetail } from "./api";
import { normUrl } from "./data";
import type { Route } from "./router";
import { detailView } from "./views/detail";
import { homeView } from "./views/home";
import { playerView } from "./views/player";
import { searchView } from "./views/search";
import { settingsView } from "./views/settings";

export const homeRoute = (): Route => ({
  key: "home",
  section: "home",
  render: (root, ctx) => homeView(root, ctx),
});

export const searchRoute = (query: string): Route => ({
  key: `search:${query}`,
  section: "search",
  render: (root, ctx) => searchView(root, ctx, query),
});

export const detailRoute = (url: string): Route => ({
  key: `detail:${normUrl(url)}`,
  section: "detail",
  render: (root, ctx) => detailView(root, ctx, url),
});

/** `detail` es contexto opcional para que el reproductor no tenga que volver a pedir la ficha. */
export const playerRoute = (url: string, detail: AnimeDetail | null = null): Route => ({
  key: `player:${url}`,
  section: "player",
  render: (root, ctx) => playerView(root, ctx, url, detail),
});

export const settingsRoute = (): Route => ({
  key: "settings",
  section: "settings",
  render: (root, ctx) => settingsView(root, ctx),
});
