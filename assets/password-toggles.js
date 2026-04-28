/**
 * Delegated show/hide for all .btn-password-toggle buttons (data-password-for="inputId").
 * Load once per page, before or after app.js.
 */
(function () {
  "use strict";
  document.addEventListener("click", function (e) {
    const btn = e.target.closest(".btn-password-toggle");
    if (!btn) return;
    e.preventDefault();
    const id = btn.getAttribute("data-password-for");
    if (!id) return;
    const input = document.getElementById(id);
    if (!input || (input.type !== "password" && input.type !== "text")) return;
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    const nowVisible = input.type === "text";
    btn.setAttribute("aria-pressed", nowVisible ? "true" : "false");
    btn.setAttribute("aria-label", nowVisible ? "Hide password" : "Show password");
    const sh = btn.querySelector(".btn-password-toggle__show");
    const hi = btn.querySelector(".btn-password-toggle__hide");
    if (sh) sh.hidden = nowVisible;
    if (hi) hi.hidden = !nowVisible;
  });
})();
