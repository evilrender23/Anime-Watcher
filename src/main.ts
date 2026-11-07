import "./styles.css";
import { router } from "./router";
import { homeRoute, searchRoute, settingsRoute } from "./routes";
import { h, icon } from "./ui";
import { mountUpdater } from "./updater";

const brand = h(
  "button",
  { class: "brand", title: "Anime Watcher · Inicio", onclick: () => router.navigate(homeRoute()) },
  h("span", { class: "brand-mark" }, icon("play")),
  h("span", { class: "brand-name" }, "Anime Watcher"),
);

const navItem = (label: string, name: "home" | "settings", onClick: () => void) =>
  h(
    "button",
    { class: "nav-btn", title: label, onclick: onClick },
    icon(name),
    h("span", { class: "nav-label" }, label),
  );

const homeBtn = navItem("Inicio", "home", () => router.navigate(homeRoute()));
const settingsBtn = navItem("Ajustes", "settings", () => router.navigate(settingsRoute()));

const backBtn = h(
  "button",
  { class: "icon-btn topbar-back", title: "Atrás (Alt+←)", disabled: true, onclick: () => router.back() },
  icon("back"),
);

const searchInput = h("input", {
  type: "search",
  class: "search-input",
  placeholder: "Buscar animé…",
  spellcheck: false,
  autocomplete: "off",
  attrs: { "aria-label": "Buscar animé" },
  onkeydown: (e) => {
    if (e.key === "Escape") searchInput.blur();
  },
});

const searchForm = h(
  "form",
  {
    class: "search",
    role: "search",
    onsubmit: (e: SubmitEvent) => {
      e.preventDefault();
      const query = searchInput.value.trim();
      if (!query) return;
      searchInput.blur();
      router.navigate(searchRoute(query));
    },
  },
  icon("search", "icon search-icon"),
  searchInput,
  h("kbd", { class: "search-kbd", attrs: { "aria-hidden": "true" } }, "Ctrl K"),
);

const view = h("main", { class: "view", id: "contenido" });
const updateCard = h("aside", { class: "update-card", hidden: true, role: "status", attrs: { "aria-label": "Actualización" } });
const app = document.getElementById("app") ?? document.body;
app.classList.add("shell");
app.append(
  h(
    "header",
    { class: "topbar" },
    h("div", { class: "topbar-start" }, backBtn, brand),
    searchForm,
    h("nav", { class: "nav", attrs: { "aria-label": "Principal" } }, homeBtn, settingsBtn),
  ),
  view,
  h("footer", { class: "footer" }, "Hecho con ❤️ por EvilRender23"),
  updateCard,
);
mountUpdater(updateCard);

router.onChange((route, canGoBack) => {
  backBtn.disabled = !canGoBack;
  homeBtn.classList.toggle("active", route.section === "home");
  settingsBtn.classList.toggle("active", route.section === "settings");
  if (route.section === "home") homeBtn.setAttribute("aria-current", "page");
  else homeBtn.removeAttribute("aria-current");
  if (route.section === "settings") settingsBtn.setAttribute("aria-current", "page");
  else settingsBtn.removeAttribute("aria-current");
});

// Botón "atrás" del ratón, Alt+← y Ctrl+K para buscar.
window.addEventListener("mousedown", (e) => {
  if (e.button === 3 || e.button === 4) e.preventDefault();
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 3) {
    e.preventDefault();
    router.back();
  }
});
window.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    router.back();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

router.mount(view, homeRoute());
