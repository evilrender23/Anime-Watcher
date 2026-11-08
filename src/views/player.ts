import Hls from "hls.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../api";
import type { AnimeDetail, Episode, EpisodeInfo, ExternalPlayer, ResolvedStream, Server, Settings } from "../api";
import { cachedAnime, getAnime, sameUrl } from "../data";
import { router, type Cleanup, type ViewContext } from "../router";
import { detailRoute, homeRoute, playerRoute, settingsRoute } from "../routes";
import { copyText, withMenu, type MenuItem } from "../contextmenu";
import { listMenuItems } from "../mylist";
import { setCrumbs } from "../shell";
import { clock, errMsg, h, icon, kbd, loadInto, poster, type IconName } from "../ui";

const PLAYER_NAMES: Record<ExternalPlayer, string> = { mpv: "mpv", vlc: "VLC" };
/** Tiempo máximo para recibir 'loadedmetadata' antes de descartar un servidor. */
const LOAD_TIMEOUT_MS = 30_000;
const SEEK_SECONDS = 10;
/** Cada cuánto se guarda por dónde va el episodio. */
const SAVE_EVERY_MS = 10_000;


type Outcome = { ok: true } | { ok: false; error: string; fatal?: boolean };
type Mode = "idle" | "builtin" | "external" | "web";

export function playerView(root: HTMLElement, ctx: ViewContext, url: string, context: AnimeDetail | null): Cleanup {
  setCrumbs({ label: "Inicio", onClick: () => router.navigate(homeRoute()) }, "Reproductor");
  const page = h("div", { class: "page player-page" });
  root.append(page);
  let teardown: Cleanup | null = null;
  loadInto(
    page,
    ctx.signal,
    () => Promise.all([api.episode(url), api.getSettings()]),
    ([info, settings]) => {
      teardown = mountPlayer(page, ctx.signal, url, info, settings, context);
    },
    "Cargando episodio…",
  );
  return () => teardown?.();
}

function setWindowFullscreen(on: boolean): void {
  try {
    getCurrentWindow()
      .setFullscreen(on)
      .catch((e: unknown) => console.warn("setFullscreen", e));
  } catch (e) {
    console.warn("setFullscreen", e);
  }
}

function mountPlayer(
  page: HTMLElement,
  signal: AbortSignal,
  url: string,
  info: EpisodeInfo,
  settings: Settings,
  context: AnimeDetail | null,
): Cleanup {
  let detail: AnimeDetail | null = context ?? (info.animeUrl ? cachedAnime(info.animeUrl) : null);
  const animeTitle = info.animeTitle || detail?.title || "Animé";
  const epLabel = info.number !== null ? `Episodio ${info.number}` : "Episodio";
  const externalTitle = info.number !== null ? `${animeTitle} - Episodio ${info.number}` : animeTitle;
  const external: ExternalPlayer | null = settings.player === "builtin" ? null : settings.player;
  const animeUrl = info.animeUrl;
  setCrumbs(
    { label: "Inicio", onClick: () => router.navigate(homeRoute()) },
    animeUrl ? { label: animeTitle, onClick: () => router.navigate(detailRoute(animeUrl)) } : animeTitle,
    epLabel,
  );

  // ---- Estado ----
  /** Generación del intento actual: cualquier await de un intento anterior queda obsoleto. */
  let gen = 0;
  let mode: Mode = "idle";
  let ready = false;
  let video: HTMLVideoElement | null = null;
  let hls: Hls | null = null;
  let iframe: HTMLIFrameElement | null = null;
  let stream: ResolvedStream | null = null;
  let active: Server | null = null;
  let cancelAttempt: (() => void) | null = null;
  let marked = false;
  const failed = new Set<Server>();
  /** Segundo por el que retomar (el guardado o, al cambiar de servidor, el actual). */
  let resumeAt = 0;
  let lastSave = 0;
  const resumeReady: Promise<void> = info.animeUrl
    ? api.historyList().then(
        (list) => {
          const entry = list.find((e) => sameUrl(e.animeUrl, info.animeUrl!) && sameUrl(e.lastEpisodeUrl, url));
          resumeAt = entry?.position ?? 0;
        },
        () => {},
      )
    : Promise.resolve();

  /** Guarda por dónde va el video (como el historial de ani-es). */
  function savePosition(v: HTMLVideoElement, force = false): void {
    if (!info.animeUrl || !Number.isFinite(v.currentTime)) return;
    const now = Date.now();
    if (!force && now - lastSave < SAVE_EVERY_MS) return;
    lastSave = now;
    resumeAt = v.currentTime;
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    void api.historyPosition(info.animeUrl, url, v.currentTime, duration).catch(() => {});
  }

  /** Para mpv/VLC: retomar donde iba y que mpv devuelva el minuto al cerrarse. */
  const tracking = (start: number): api.ExternalTracking | null =>
    info.animeUrl ? { animeUrl: info.animeUrl, episodeUrl: url, start } : null;

  // ---- DOM ----
  // Columna principal: título, escenario, barra de control, servidores.
  // Carril derecho: portada + lista de episodios (cuando se conoce la ficha).
  const head = h(
    "header",
    { class: "player-head" },
    h(
      "div",
      { class: "player-titles" },
      h("p", { class: "eyebrow" }, epLabel),
      h(
        "button",
        { class: "player-title", title: "Ver ficha", disabled: !info.animeUrl, onclick: () => openEpisodes() },
        animeTitle,
      ),
    ),
    h(
      "div",
      { class: "player-hint", attrs: { "aria-label": "Atajos de teclado" } },
      kbd("Espacio", "Pausar o reanudar"),
      kbd("←", `Retroceder ${SEEK_SECONDS} s`),
      kbd("→", `Avanzar ${SEEK_SECONDS} s`),
      kbd("F", "Pantalla completa"),
      kbd("N", "Siguiente episodio"),
      kbd("P", "Episodio anterior"),
    ),
  );
  const mediaLayer = h("div", { class: "stage-media" });
  const overlay = h("div", { class: "stage-overlay", hidden: true });
  const stage = h("div", { class: "stage" }, mediaLayer, overlay);
  const controls = h("div", { class: "dock", role: "toolbar", attrs: { "aria-label": "Controles" } });
  const message = h("div", { class: "player-msg", hidden: true });
  const chips = h("div", { class: "chips" });
  const railCover = h("div", { class: "rail-cover" });
  const railList = h("div", { class: "rail-list", role: "list" });
  const railCount = h("span", { class: "rule-count" });
  const rail = h(
    "aside",
    { class: "rail", attrs: { "aria-label": "Episodios" } },
    railCover,
    h(
      "header",
      { class: "rule rule-tight" },
      h("h2", { class: "rule-title" }, "Episodios"),
      railCount,
      h("span", { class: "rule-line", attrs: { "aria-hidden": "true" } }),
    ),
    railList,
  );
  page.append(
    h(
      "div",
      { class: "player-main" },
      head,
      stage,
      controls,
      message,
      h(
        "div",
        { class: "servers", role: "group", attrs: { "aria-label": "Servidores" } },
        h("span", { class: "servers-label" }, "Servidor"),
        chips,
      ),
    ),
    rail,
  );
  if (info.animeUrl) window.dispatchEvent(new CustomEvent("aw:now-playing", { detail: info.animeUrl }));

  const isStale = (my: number) => signal.aborted || my !== gen;

  // ---- Interfaz ----
  function renderHead(): void {
    railCover.replaceChildren(poster(detail?.cover ?? null, animeTitle, "ratio-poster"));
    renderRail();
  }

  function renderRail(): void {
    const eps = detail?.episodes ?? [];
    railCount.textContent = eps.length ? String(eps.length) : "";
    if (!eps.length) {
      railList.replaceChildren(h("p", { class: "side-empty" }, detail ? "Sin episodios." : "Cargando episodios…"));
      return;
    }
    let current: HTMLElement | null = null;
    railList.replaceChildren(
      ...eps.map((ep) => {
        const isCurrent = sameUrl(ep.url, url) || sameUrl(ep.url, info.url) || (info.number !== null && ep.number === info.number);
        const el = h(
          "button",
          {
            class: isCurrent ? "rail-row current" : "rail-row",
            role: "listitem",
            dataset: { num: String(ep.number) },
            title: `Episodio ${ep.number}`,
            onclick: () => !isCurrent && goTo(ep),
          },
          h("span", { class: "rail-num" }, String(ep.number).padStart(2, "0")),
          h("span", { class: "rail-label" }, `Episodio ${ep.number}`),
          isCurrent ? icon("play", "icon rail-mark") : null,
        );
        if (isCurrent) current = el;
        return el;
      }),
    );
    const target = current as HTMLElement | null;
    // Centra el episodio actual sólo dentro del carril (sin mover la vista principal).
    if (target) requestAnimationFrame(() => (railList.scrollTop = target.offsetTop - railList.clientHeight / 2 + target.clientHeight / 2));
  }

  function say(text: string, kind: "info" | "error" | "ok" | "notice" = "info"): void {
    message.hidden = !text;
    message.className = `player-msg msg-${kind}`;
    message.textContent = text;
  }

  function showStatus(text: string): void {
    overlay.hidden = false;
    overlay.replaceChildren(h("div", { class: "spinner" }), h("div", { class: "overlay-text" }, text));
  }

  function showStageError(text: string, actions: [string, () => void][], detailText?: string): void {
    overlay.hidden = false;
    overlay.replaceChildren(icon("alert", "icon overlay-icon"), h("div", { class: "overlay-text" }, text));
    if (detailText) overlay.append(h("div", { class: "overlay-detail" }, detailText));
    if (actions.length) {
      overlay.append(
        h(
          "div",
          { class: "overlay-actions" },
          actions.map(([label, fn], i) => h("button", { class: i === 0 ? "btn btn-primary" : "btn", onclick: fn }, label)),
        ),
      );
    }
  }

  function hideOverlay(): void {
    overlay.hidden = true;
    overlay.replaceChildren();
  }

  function neighbours(): { prev: Episode | null; next: Episode | null } {
    const eps = detail?.episodes ?? [];
    let i = eps.findIndex((e) => sameUrl(e.url, url) || sameUrl(e.url, info.url));
    if (i < 0 && info.number !== null) i = eps.findIndex((e) => e.number === info.number);
    if (i < 0) return { prev: null, next: null };
    return { prev: eps[i - 1] ?? null, next: eps[i + 1] ?? null };
  }

  function renderChips(): void {
    chips.replaceChildren(
      ...info.servers.map((server) => {
        const cls = ["chip", server === active ? "active" : "", failed.has(server) ? "failed" : ""].filter(Boolean).join(" ");
        const title = failed.has(server)
          ? `${server.name}: no funcionó (clic para reintentar)`
          : server.support === "web"
            ? `${server.name}: reproductor web`
            : server.name;
        return h(
          "button",
          { class: cls, title, onclick: () => void playServer(server) },
          server.name,
          server.support === "web" ? h("span", { class: "chip-tag" }, "web") : null,
        );
      }),
    );
    if (!info.servers.length) chips.append(h("span", { class: "muted" }, "Sin servidores"));
  }

  function button(label: string, name: IconName, onClick: () => void, disabled = false, title = label): HTMLButtonElement {
    return h("button", { class: "dock-btn", title, disabled, onclick: onClick }, icon(name), h("span", null, label));
  }

  function renderControls(): void {
    const { prev, next } = neighbours();
    const fullscreenLabel = document.fullscreenElement ? "Salir de pantalla completa (F)" : "Pantalla completa (F)";
    controls.replaceChildren(
      h(
        "div",
        { class: "dock-group", role: "group", attrs: { "aria-label": "Episodio" } },
        button("Anterior", "back", () => prev && goTo(prev), !prev, prev ? `Episodio ${prev.number} (P)` : "Anterior"),
        button("Siguiente", "next", () => next && goTo(next), !next, next ? `Episodio ${next.number} (N)` : "Siguiente"),
        h(
          "button",
          { class: "icon-btn", title: "Ver de nuevo", disabled: !ready, attrs: { "aria-label": "Ver de nuevo" }, onclick: replay },
          icon("replay"),
        ),
      ),
      h("span", { class: "dock-sep", attrs: { "aria-hidden": "true" } }),
      h(
        "div",
        { class: "dock-group dock-out", role: "group", attrs: { "aria-label": "Abrir en" } },
        h("span", { class: "dock-label", attrs: { "aria-hidden": "true" } }, "Abrir en"),
        button("Navegador", "external", openInBrowser, false, "Abrir en el navegador"),
        mode === "builtin" && ready && stream
          ? [
              button("mpv", "tv", () => void openExternal("mpv"), false, "Abrir en mpv"),
              button("VLC", "tv", () => void openExternal("vlc"), false, "Abrir en VLC"),
            ]
          : null,
      ),
      h(
        "button",
        { class: "icon-btn", title: fullscreenLabel, attrs: { "aria-label": fullscreenLabel }, onclick: toggleFullscreen },
        icon("fullscreen"),
      ),
    );
  }

  // ---- Medios ----
  function clearMedia(): void {
    const cancel = cancelAttempt;
    cancelAttempt = null;
    cancel?.();
    if (hls) {
      hls.destroy();
      hls = null;
    }
    if (video) {
      const v = video;
      video = null;
      if (ready) savePosition(v, true);
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    iframe = null;
    mediaLayer.replaceChildren();
    stream = null;
    mode = "idle";
    ready = false;
    hideOverlay();
  }

  async function attemptBuiltin(server: Server, my: number): Promise<Outcome> {
    await resumeReady;
    let resolved: ResolvedStream;
    try {
      resolved = await api.resolve(server);
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
    if (isStale(my)) return { ok: false, error: "cancelado" };

    return new Promise<Outcome>((done) => {
      clearMedia();
      const v = h("video", { class: "stage-video", controls: true, autoplay: true, preload: "auto" });
      // La pantalla completa la gestiona el escenario (botón, tecla F y doble clic).
      v.setAttribute("controlslist", "nofullscreen nodownload noremoteplayback");

      let started = false;
      let settled = false;
      let timeout = 0;
      const settle = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (cancelAttempt === cancel) cancelAttempt = null;
        done(outcome);
      };
      const cancel = () => settle({ ok: false, error: "cancelado" });
      const fail = (reason: string) => {
        if (v !== video) return;
        if (!started) {
          settle({ ok: false, error: reason });
          return;
        }
        // Ya se estaba reproduciendo: no se cambia de servidor automáticamente.
        showStageError(`Se interrumpió la reproducción en ${server.name}.`, [
          [
            "Probar otro servidor",
            () => {
              failed.add(server);
              void autoLoop();
            },
          ],
          ["Reintentar", () => void playServer(server)],
        ], reason);
      };

      v.addEventListener("loadedmetadata", () => {
        if (v !== video || started) return;
        started = true;
        ready = true;
        // Retoma donde lo dejaste, salvo que quede menos de un minuto.
        const end = Number.isFinite(v.duration) ? v.duration - 60 : Infinity;
        if (resumeAt > 0 && resumeAt < end) {
          v.currentTime = resumeAt;
          say(`Sigues donde lo dejaste (${clock(resumeAt)}). Para empezar de cero: clic derecho → Ver de nuevo.`, "notice");
        }
        hideOverlay();
        renderControls();
        settle({ ok: true });
      });
      v.addEventListener("timeupdate", () => {
        if (v === video && started && !v.seeking) savePosition(v);
      });
      v.addEventListener("pause", () => {
        if (v === video && started && !v.ended) savePosition(v, true);
      });
      v.addEventListener("playing", () => {
        if (v === video) void markHistory();
      });
      v.addEventListener("error", () => {
        const err = v.error;
        fail(err?.message || `error del video (código ${err?.code ?? "?"})`);
      });
      v.addEventListener("ended", () => {
        if (v !== video) return;
        // Terminado: la próxima vez empieza desde el principio.
        if (info.animeUrl) void api.historyPosition(info.animeUrl, url, v.duration, v.duration).catch(() => {});
        resumeAt = 0;
        if (!settings.autoNext) return;
        const { next } = neighbours();
        if (next) goTo(next);
      });
      v.addEventListener("dblclick", (e) => {
        e.preventDefault();
        toggleFullscreen();
      });

      cancelAttempt = cancel;
      timeout = window.setTimeout(() => fail(`el video no respondió en ${LOAD_TIMEOUT_MS / 1000} s`), LOAD_TIMEOUT_MS);
      mode = "builtin";
      stream = resolved;
      video = v;
      mediaLayer.append(v);
      showStatus(`Cargando video de ${server.name}…`);
      renderControls();

      if (resolved.kind === "hls" && Hls.isSupported()) {
        const instance = new Hls({ enableWorker: true, backBufferLength: 90 });
        hls = instance;
        let recovered = false;
        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (instance !== hls || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
            recovered = true;
            instance.recoverMediaError();
            return;
          }
          fail(`error HLS (${data.details})`);
        });
        instance.loadSource(resolved.proxyUrl);
        instance.attachMedia(v);
      } else {
        v.src = resolved.proxyUrl;
      }
    });
  }

  async function attemptExternal(server: Server, my: number, player: ExternalPlayer): Promise<Outcome> {
    await resumeReady;
    let resolved: ResolvedStream;
    try {
      resolved = await api.resolve(server);
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
    if (isStale(my)) return { ok: false, error: "cancelado" };
    showStatus(`Abriendo ${PLAYER_NAMES[player]}…`);
    let path: string;
    try {
      path = await api.playExternal(resolved, externalTitle, player, tracking(resumeAt));
    } catch (e) {
      // El servidor funciona; lo que falla es el reproductor (no instalado, ruta incorrecta…).
      return { ok: false, error: errMsg(e), fatal: true };
    }
    if (isStale(my)) return { ok: false, error: "cancelado" };
    clearMedia();
    mode = "external";
    stream = resolved;
    ready = true;
    mediaLayer.append(
      h(
        "div",
        { class: "external-panel" },
        icon("tv", "icon external-icon"),
        h("div", { class: "external-title" }, `Reproduciendo en ${PLAYER_NAMES[player]}`),
        h("div", { class: "external-path" }, path),
        h(
          "div",
          { class: "external-hint" },
          `Servidor: ${server.name}.${resumeAt > 0 ? ` Empieza en ${clock(resumeAt)}, donde lo dejaste.` : ""}${player === "mpv" ? " Al cerrar mpv se guarda por dónde ibas." : ""} Usa los controles de abajo para cambiar de episodio.`,
        ),
      ),
    );
    renderControls();
    void markHistory();
    return { ok: true };
  }

  function attempt(server: Server, my: number): Promise<Outcome> {
    return external ? attemptExternal(server, my, external) : attemptBuiltin(server, my);
  }

  function showFatal(error: string): void {
    clearMedia();
    renderControls();
    showStageError(error, [["Ir a Ajustes", () => router.navigate(settingsRoute())]]);
  }

  function playWeb(server: Server, note?: string): void {
    clearMedia();
    const frame = document.createElement("iframe");
    frame.className = "stage-frame";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-presentation");
    frame.setAttribute("allow", "autoplay; fullscreen; encrypted-media; picture-in-picture");
    frame.setAttribute("allowfullscreen", "");
    frame.referrerPolicy = "origin";
    frame.src = server.url;
    iframe = frame;
    mediaLayer.append(frame);
    mode = "web";
    ready = true;
    active = server;
    say(note ?? "", "notice");
    renderChips();
    renderControls();
    void markHistory();
  }

  /** Prueba los servidores directos en orden hasta que uno funcione. */
  async function autoLoop(): Promise<void> {
    const my = ++gen;
    clearMedia();
    say("");
    const direct = info.servers.filter((s) => s.support === "direct");
    let lastError = "";
    for (const server of direct) {
      if (failed.has(server)) continue;
      active = server;
      renderChips();
      showStatus(`Probando ${server.name}…`);
      const outcome = await attempt(server, my);
      if (isStale(my)) return;
      if (outcome.ok) {
        renderChips();
        return;
      }
      if (outcome.fatal) {
        showFatal(outcome.error);
        return;
      }
      console.warn(`Servidor ${server.name} descartado:`, outcome.error);
      failed.add(server);
      lastError = `${server.name}: ${outcome.error}`;
      renderChips();
    }

    const web = info.servers.find((s) => s.support === "web");
    if (web) {
      playWeb(
        web,
        direct.length
          ? `Ningún servidor directo funcionó; se muestra el reproductor web de ${web.name} (puede mostrar anuncios).`
          : `Este episodio sólo tiene reproductores web; se muestra ${web.name} (puede mostrar anuncios).`,
      );
      return;
    }
    clearMedia();
    active = null;
    renderChips();
    renderControls();
    showStageError(
      "No se encontró ningún servidor útil.",
      direct.length
        ? [
            [
              "Reintentar",
              () => {
                failed.clear();
                void autoLoop();
              },
            ],
          ]
        : [],
      lastError || undefined,
    );
  }

  /** Reproduce un servidor elegido a mano en el modo actual. */
  async function playServer(server: Server): Promise<void> {
    const my = ++gen;
    if (server.support === "web") {
      playWeb(server);
      return;
    }
    clearMedia();
    say("");
    active = server;
    renderChips();
    renderControls();
    showStatus(`Probando ${server.name}…`);
    const outcome = await attempt(server, my);
    if (isStale(my)) return;
    if (outcome.ok) {
      failed.delete(server);
      renderChips();
      return;
    }
    if (outcome.fatal) {
      showFatal(outcome.error);
      return;
    }
    failed.add(server);
    clearMedia();
    renderChips();
    renderControls();
    showStageError(`No se pudo reproducir ${server.name}.`, [["Probar otro servidor", () => void autoLoop()]], outcome.error);
  }

  async function markHistory(): Promise<void> {
    if (marked || !info.animeUrl || info.number === null) return;
    marked = true;
    const d = detail ?? (await detailReady);
    try {
      await api.historyMark({
        animeUrl: info.animeUrl,
        title: animeTitle,
        cover: d?.cover ?? null,
        episode: info.number,
        episodeUrl: url,
        totalEpisodes: d?.episodes.length || null,
        airing: !!d?.status && /emisi/i.test(d.status),
      });
    } catch (e) {
      console.warn("No se pudo guardar el historial", e);
    }
  }

  // ---- Acciones ----
  function goTo(ep: Episode): void {
    router.replace(playerRoute(ep.url, detail));
  }

  function openEpisodes(): void {
    if (info.animeUrl) router.navigate(detailRoute(info.animeUrl));
  }

  function replay(): void {
    if (mode === "builtin" && video) {
      video.currentTime = 0;
      void video.play().catch(() => {});
    } else if (mode === "external" && stream && external) {
      void launchExternal(stream, external);
    } else if (mode === "web" && iframe && active) {
      iframe.src = active.url;
    }
  }

  function openInBrowser(): void {
    openUrl(active?.url ?? info.url).catch((e: unknown) => say(errMsg(e), "error"));
  }

  async function launchExternal(s: ResolvedStream, player: ExternalPlayer): Promise<void> {
    say(`Abriendo en ${PLAYER_NAMES[player]}…`);
    try {
      // Desde el reproductor integrado: sigue en el mismo segundo.
      const start = video && Number.isFinite(video.currentTime) ? video.currentTime : resumeAt;
      const path = await api.playExternal(s, externalTitle, player, tracking(start));
      if (!signal.aborted) say(`Abierto en ${PLAYER_NAMES[player]} (${path})`, "ok");
    } catch (e) {
      if (!signal.aborted) say(errMsg(e), "error");
    }
  }

  function openExternal(player: ExternalPlayer): Promise<void> {
    if (!stream) return Promise.resolve();
    video?.pause();
    return launchExternal(stream, player);
  }

  function toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      stage.requestFullscreen().catch((e: unknown) => say(`No se pudo activar la pantalla completa: ${errMsg(e)}`, "error"));
    }
  }

  function seek(delta: number): void {
    if (!video) return;
    const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.min(Math.max(0, video.currentTime + delta), duration);
  }

  // ---- Menú contextual ----
  function episodeItems(): MenuItem[] {
    const { prev, next } = neighbours();
    const items: MenuItem[] = [
      { label: next ? `Siguiente: episodio ${next.number}` : "Siguiente episodio", icon: "next", hint: "N", disabled: !next, run: () => {
        if (next) goTo(next);
      } },
      { label: prev ? `Anterior: episodio ${prev.number}` : "Episodio anterior", icon: "back", hint: "P", disabled: !prev, run: () => {
        if (prev) goTo(prev);
      } },
      { label: "Ver de nuevo", icon: "replay", disabled: !ready, run: replay },
      { label: "Ficha y episodios", icon: "list", disabled: !info.animeUrl, run: openEpisodes },
      "-",
      { label: "Abrir en el navegador", icon: "external", run: openInBrowser },
    ];
    if (mode === "builtin" && ready && stream) {
      items.push(
        { label: "Abrir en mpv", icon: "tv", run: () => openExternal("mpv") },
        { label: "Abrir en VLC", icon: "tv", run: () => openExternal("vlc") },
      );
    }
    if (info.animeUrl) {
      const total = detail && !/emisi/i.test(detail.status ?? "") ? detail.episodes.length || null : null;
      items.push("-", ...listMenuItems({ animeUrl: info.animeUrl, title: animeTitle, cover: detail?.cover ?? null, total }));
    }
    items.push("-", { label: "Copiar enlace del episodio", icon: "link", run: () => copyText(url) });
    return items;
  }

  // Sobre el video: controles de reproducción primero.
  withMenu(stage, () => {
    const v = video;
    const media: MenuItem[] = v
      ? [
          v.paused
            ? { label: "Reproducir", icon: "play", hint: "Espacio", run: () => void v.play().catch(() => {}) }
            : { label: "Pausar", icon: "pause", hint: "Espacio", run: () => v.pause() },
          { label: `Retroceder ${SEEK_SECONDS} s`, icon: "rewind", hint: "←", run: () => seek(-SEEK_SECONDS) },
          { label: `Avanzar ${SEEK_SECONDS} s`, icon: "forward", hint: "→", run: () => seek(SEEK_SECONDS) },
          { label: v.muted ? "Activar sonido" : "Silenciar", run: () => void (v.muted = !v.muted) },
        ]
      : [];
    const full: MenuItem = {
      label: document.fullscreenElement ? "Salir de pantalla completa" : "Pantalla completa",
      icon: "fullscreen",
      hint: "F",
      run: toggleFullscreen,
    };
    return [...media, full, "-", ...episodeItems()];
  });
  withMenu(page, () => episodeItems());
  // Carril de episodios: ver el episodio pulsado.
  withMenu(railList, (target) => {
    const n = (target.closest(".rail-row") as HTMLElement | null)?.dataset.num;
    const ep = detail?.episodes.find((e) => String(e.number) === n);
    if (!ep) return [];
    return [
      { label: `Ver episodio ${ep.number}`, icon: "play", run: () => goTo(ep) },
      { label: "Copiar enlace del episodio", icon: "link", run: () => copyText(ep.url) },
    ];
  });

  // ---- Eventos globales ----
  const onFullscreenChange = () => {
    setWindowFullscreen(!!document.fullscreenElement);
    renderControls();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    switch (e.key) {
      case " ":
        if (!video) return;
        e.preventDefault();
        if (video.paused) void video.play().catch(() => {});
        else video.pause();
        break;
      case "ArrowLeft":
      case "ArrowRight":
        if (!video) return;
        e.preventDefault();
        seek(e.key === "ArrowLeft" ? -SEEK_SECONDS : SEEK_SECONDS);
        break;
      case "f":
      case "F":
        e.preventDefault();
        toggleFullscreen();
        break;
      case "n":
      case "N": {
        if (e.repeat) return;
        const { next } = neighbours();
        if (next) goTo(next);
        break;
      }
      case "p":
      case "P": {
        if (e.repeat) return;
        const { prev } = neighbours();
        if (prev) goTo(prev);
        break;
      }
    }
  };

  document.addEventListener("keydown", onKey);
  document.addEventListener("fullscreenchange", onFullscreenChange);

  // ---- Arranque ----
  const detailReady: Promise<AnimeDetail | null> =
    detail || !info.animeUrl
      ? Promise.resolve(detail)
      : getAnime(info.animeUrl).then(
          (d) => {
            detail = d;
            if (!signal.aborted) {
              renderHead();
              renderControls();
            }
            return d;
          },
          (e: unknown) => {
            console.warn("No se pudo cargar la ficha del animé", e);
            return null;
          },
        );

  renderHead();
  renderChips();
  renderControls();
  if (info.servers.length) void autoLoop();
  else showStageError("No se encontró ningún servidor útil.", []);

  return () => {
    gen++;
    clearMedia();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      setWindowFullscreen(false);
    }
    window.dispatchEvent(new CustomEvent("aw:now-playing", { detail: null }));
  };
}
