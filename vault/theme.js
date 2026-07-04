(() => {
  "use strict";
  const KEY = "pmanager.theme";
  const root = document.documentElement;

  function preferred() {
    const stored = localStorage.getItem(KEY);
    if (stored === "dark" || stored === "light") return stored;
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
    return "light";
  }

  function apply(theme) {
    root.dataset.theme = theme;
    const isDark = theme === "dark";
    document.querySelectorAll("#theme-toggle, [data-theme-toggle]").forEach((el) => {
      const checkbox = el.querySelector(".theme-toggle-check");
      if (checkbox) {
        checkbox.checked = isDark;
      } else if (el.nodeName === "BUTTON") {
        // Legacy fallback — never overwrite a label's child nodes.
        el.textContent = isDark ? "Light mode" : "Dark mode";
        el.setAttribute("aria-pressed", isDark ? "true" : "false");
      }
      el.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} mode`);
      el.title = `Switch to ${isDark ? "light" : "dark"} mode`;
    });
  }

  function toggle() {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(KEY, next);
    apply(next);
  }

  // Apply immediately to avoid a flash of the wrong theme.
  apply(preferred());

  function wire() {
    document.querySelectorAll("#theme-toggle, [data-theme-toggle]").forEach((el) => {
      if (el.dataset.themeBound === "1") return;
      el.dataset.themeBound = "1";
      const checkbox = el.querySelector(".theme-toggle-check");
      if (checkbox) {
        checkbox.addEventListener("change", toggle);
      } else {
        el.addEventListener("click", toggle);
      }
    });
    apply(root.dataset.theme || preferred());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  // React to OS-level changes only if the user hasn't picked one explicitly.
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      if (localStorage.getItem(KEY)) return;
      apply(e.matches ? "dark" : "light");
    });
  }

  window.PMTheme = { toggle, current: () => root.dataset.theme };
})();
