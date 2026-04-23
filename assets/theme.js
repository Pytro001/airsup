/*!
 * Airsup theme helper (shared across landing page, static pages, and SPA).
 *
 * Sets document.documentElement.dataset.theme ("light" | "dark") and
 * persists the choice to localStorage.airsupTheme.
 *
 * Default is dark; users who set "light" in localStorage keep it.
 * A tiny inline script in each page's <head> must set the attribute BEFORE
 * first paint to avoid a flash. This file wires up toggle buttons after load.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "airsupTheme";
  var DEFAULT_THEME = "dark";
  var root = document.documentElement;

  // Sun icon (shown in dark mode: click to go light)
  var ICON_SUN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';

  // Moon icon (shown in light mode: click to go dark)
  var ICON_MOON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function getStored() {
    try {
      var t = localStorage.getItem(STORAGE_KEY);
      return t === "dark" || t === "light" ? t : null;
    } catch (e) { return null; }
  }

  function get() {
    return root.dataset.theme === "dark" ? "dark" : "light";
  }

  function apply(theme) {
    root.dataset.theme = theme === "dark" ? "dark" : "light";
    updateAllToggles();
    window.dispatchEvent(new CustomEvent("airsup:themechange", { detail: { theme: get() } }));
  }

  function set(theme) {
    var next = theme === "dark" ? "dark" : "light";
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
    apply(next);
  }

  function toggle() {
    set(get() === "dark" ? "light" : "dark");
  }

  function updateAllToggles() {
    var current = get();
    var icon = current === "dark" ? ICON_SUN : ICON_MOON;
    var label = current === "dark" ? "Switch to light mode" : "Switch to dark mode";
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      btn.innerHTML = icon;
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
    }
  }

  function wireButtons() {
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (btn.__airsupWired) continue;
      btn.__airsupWired = true;
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        toggle();
      });
    }
    updateAllToggles();
  }

  // Cross-tab sync
  window.addEventListener("storage", function (e) {
    if (e.key === STORAGE_KEY && (e.newValue === "light" || e.newValue === "dark")) {
      apply(e.newValue);
    }
  });

  // Ensure attribute is present (the inline <head> script should already have done this)
  if (root.dataset.theme !== "dark" && root.dataset.theme !== "light") {
    var stored = getStored();
    apply(stored || DEFAULT_THEME);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireButtons);
  } else {
    wireButtons();
  }

  window.AirsupTheme = { get: get, set: set, toggle: toggle, wire: wireButtons };
})();
