(function () {
  "use strict";

  const API_BASE = window.AIRSUP_CONFIG?.apiUrl || "";
  const $ = (id) => document.getElementById(id);
  /** Set true to show Chat in nav and /workspace#chat. Code paths stay; UI hidden when false. */
  const CHAT_ENABLED = false;

  /* ── Supabase init ── */
  let supabaseClient = null;

  function initSupabase() {
    const W = window;
    const cfg = { ...(W.AIRSUP_CONFIG || {}) };
    if (W.AIRSUP_LOCAL && typeof W.AIRSUP_LOCAL === "object") Object.assign(cfg, W.AIRSUP_LOCAL);
    const lib = W.supabase;
    if (!cfg?.supabaseUrl) return null;
    let key = String(cfg.supabaseAnonKey || "").trim();
    if (!key || key === "YOUR_SUPABASE_ANON_KEY") {
      try { const ls = localStorage.getItem("airsup_supabase_anon_key"); if (ls) key = ls.trim(); } catch (_) {}
    }
    if (!key || key === "YOUR_SUPABASE_ANON_KEY") return null;
    if (!lib?.createClient) return null;
    try {
      return lib.createClient(cfg.supabaseUrl, key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
    } catch (err) {
      console.error("[Airsup] createClient:", err);
      return null;
    }
  }
  supabaseClient = initSupabase();

  async function syncUserProfileFromAuth(user) {
    if (!supabaseClient || !user) return;
    const meta = user.user_metadata || {};
    const anonymous = user.is_anonymous === true;
    const displayName = String(
      meta.full_name || meta.name || meta.preferred_username ||
      user.email?.split("@")[0] || (anonymous ? "Guest" : "")
    ).trim() || (anonymous ? "Guest" : "User");
    const letter = displayName.charAt(0).toUpperCase();
    await supabaseClient.from("profiles").upsert({ id: user.id, display_name: displayName, avatar_letter: letter }, { onConflict: "id" });
    await supabaseClient.from("user_settings").upsert({ user_id: user.id, preferred_name: displayName }, { onConflict: "user_id" });
    currentUser = { id: user.id, email: user.email || "", displayName, isAnonymous: anonymous };
    updateAuthUI();
  }

  /* ── State ── */
  let currentUser = null;
  let currentView = "onboarding";
  let userRole = null;
  let isSending = false;
  let sessionBootstrapLock = false;
  let onboardStep = 0;
  let onboardData = {};
  let pendingFiles = [];
  /** File[] selected on onboarding brief step (any type; uploaded after project is created). */
  let onboardingProjectFiles = [];
  let latestProjectId = null;
  /** Cached /api/admin/overview result for fast re-render after soft-delete (avoids re-fetching). */
  let adminOverviewCache = null;
  /** Cached from last admin overview load (factory picker in workspace). */
  let adminWorkspaceFactoriesCache = [];
  let adminWorkspaceBackWired = false;
  let activeConnectionMatchId = null;
  /** Virtual id for the user-level Supi thread in Connections. */
  const SUPI_THREAD_ID = "__supi__";
  let visitsMatchesCache = [];

  function resetOnboardData() {
    onboardingProjectFiles = [];
    onboardData = {
      role: "", fullName: "", phone: "", whatsapp1: "", companyName: "", location: "", website: "",
      briefUrl: "", briefPastedText: "", briefText: "", briefSource: "", briefFileName: "",
      capabilities: "", priceRange: "", moqMin: "", moqMax: "", specialization: "",
    };
  }
  resetOnboardData();

  function mergePhoneFromRow(ccEl, localEl) {
    const lib = window.AIRSUP_PHONE;
    if (lib) {
      const m = lib.mergeDialAndNational(ccEl && ccEl.value, localEl && localEl.value);
      return m || "";
    }
    const c = phoneDigits((ccEl && ccEl.value) || "");
    const n = phoneDigits((localEl && localEl.value) || "");
    if (!c || !n) return "";
    return "+" + c + n;
  }

  function onboardPhoneFieldHtml(dataKey, label, value, required) {
    const lib = window.AIRSUP_PHONE;
    if (!lib) {
      return (
        '<div class="onboard-field"><label class="onboard-label" for="onboard-ph-sf-' +
        escapeAttr(dataKey) +
        '">' +
        escapeHtml(label) +
        '</label><input class="onboard-input onboard-input-phone-tel" data-key="' +
        escapeAttr(dataKey) +
        '" id="onboard-ph-sf-' +
        escapeAttr(dataKey) +
        '" type="tel" inputmode="numeric" pattern="[0-9]*" placeholder="Digits only" value="' +
        escapeAttr(phoneDigits(value || "")) +
        '"' +
        (required ? " required" : "") +
        " /></div>"
      );
    }
    const parts = lib.parseStoredPhoneToParts(value || "");
    const idBase = "onboard-ph-" + dataKey;
    return (
      '<div class="onboard-field onboard-field-phone" data-phone-key="' +
      escapeAttr(dataKey) +
      '">' +
      '<label class="onboard-label" for="' +
      idBase +
      '-local">' +
      escapeHtml(label) +
      "</label>" +
      '<div class="phone-inline">' +
      '<select class="onboard-input phone-cc-select" id="' +
      idBase +
      '-cc" aria-label="Country code">' +
      lib.dialCodeOptionsHtml(parts.dial) +
      "</select>" +
      '<input class="onboard-input phone-local-num" id="' +
      idBase +
      '-local" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="tel-national" value="' +
      escapeAttr(parts.national) +
      '"' +
      (required ? " required" : "") +
      " /></div></div>"
    );
  }

  function onboardPinPhoneRowHtml(value) {
    const lib = window.AIRSUP_PHONE;
    const parts = lib ? lib.parseStoredPhoneToParts(value || "") : { dial: "49", national: phoneDigits(value || "") };
    const idBase = "onboard-pin-phone";
    return (
      '<div class="onboard-field onboard-field-phone onboard-field-phone--signin">' +
      '<label class="onboard-label" for="' +
      idBase +
      '-local">Login phone number</label>' +
      '<div class="phone-inline">' +
      '<select class="onboard-input phone-cc-select" id="' +
      idBase +
      '-cc" aria-label="Country code">' +
      (lib ? lib.dialCodeOptionsHtml(parts.dial) : "") +
      "</select>" +
      '<input class="onboard-input phone-local-num" id="' +
      idBase +
      '-local" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="tel-national" value="' +
      escapeAttr(parts.national) +
      '" required /></div></div>'
    );
  }

  function settingsPhoneRowHtml(label, idCc, idLocal, storedPhone) {
    const lib = window.AIRSUP_PHONE;
    if (!lib) {
      return (
        '<div class="settings-field"><label class="settings-label">' +
        escapeHtml(label) +
        '</label><input type="tel" id="settings-phone" class="settings-input" value="' +
        escapeAttr(storedPhone || "") +
        '" /></div>'
      );
    }
    const parts = lib.parseStoredPhoneToParts(storedPhone || "");
    return (
      '<div class="settings-field"><label class="settings-label">' +
      escapeHtml(label) +
      '</label><div class="phone-inline">' +
      '<select class="settings-input phone-cc-select" id="' +
      escapeAttr(idCc) +
      '" aria-label="Country code">' +
      lib.dialCodeOptionsHtml(parts.dial) +
      "</select>" +
      '<input type="text" class="settings-input phone-local-num" id="' +
      escapeAttr(idLocal) +
      '" inputmode="numeric" pattern="[0-9]*" autocomplete="tel-national" value="' +
      escapeAttr(parts.national) +
      '" /></div></div>'
    );
  }

  function readSettingsStoredPhone() {
    if ($("settings-phone-cc") && $("settings-phone-local")) {
      return mergePhoneFromRow($("settings-phone-cc"), $("settings-phone-local"));
    }
    return ($("settings-phone")?.value || "").trim();
  }

  /* ── Helpers ── */
  function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function escapeAttr(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  /** Pairs with .password-input-wrap and assets/password-toggles.js */
  function passwordToggleButtonHtml(forId) {
    return (
      '<button type="button" class="btn-password-toggle" data-password-for="' +
      escapeAttr(forId) +
      '" aria-label="Show password" aria-pressed="false" tabindex="0">' +
      '<span class="btn-password-toggle__show" aria-hidden="true">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
      "</span>" +
      '<span class="btn-password-toggle__hide" hidden aria-hidden="true">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 3-4.5M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>' +
      "</span>" +
      "</button>"
    );
  }

  /** One-line inline validation (onboarding), no browser alert. */
  function setOnboardLineError(elementId, message) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.hidden = false;
    } else {
      el.textContent = "";
      el.hidden = true;
    }
  }

  /** Empty ok; else http(s) URL with host. Fills in https for bare hostnames. */
  function validateOptionalHttpUrl(raw) {
    const t = String(raw == null ? "" : raw).trim();
    if (!t) return { ok: true };
    if (/^(javascript|data|vbscript):/i.test(t)) {
      return { ok: false, error: "Only http and https links are allowed." };
    }
    try {
      const u = new URL(/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(t) ? t : "https://" + t);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { ok: false, error: "Only http and https links are allowed." };
      }
      if (!u.hostname) return { ok: false, error: "Enter a valid website URL (e.g. https://example.com)." };
      return { ok: true, normalized: u.href };
    } catch (_) {
      return { ok: false, error: "Enter a valid website URL (e.g. https://example.com)." };
    }
  }

  const formFlashTimers = {};
  /** Inline status text; replaces browser alert/confirm feedback. */
  function setFormFlash(elementId, text, isError, autoHideMs) {
    const el = $(elementId);
    if (!el) return;
    if (formFlashTimers[elementId]) {
      clearTimeout(formFlashTimers[elementId]);
      formFlashTimers[elementId] = 0;
    }
    if (text == null || text === "") {
      el.hidden = true;
      el.textContent = "";
      el.style.color = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.style.color = isError ? "#d93025" : "";
    if (autoHideMs && !isError) {
      formFlashTimers[elementId] = setTimeout(function () {
        el.hidden = true;
        el.textContent = "";
        el.style.color = "";
        formFlashTimers[elementId] = 0;
      }, autoHideMs);
    }
  }

  /** Centered overlay; returns true if user confirms. Replaces native confirm() for consistent UI. */
  function showConfirmDialog(message, options) {
    options = options || {};
    var confirmLabel = options.confirmLabel || "OK";
    var cancelLabel = options.cancelLabel || "Cancel";
    var danger = options.danger === true;
    return new Promise(function (resolve) {
      var prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      var wrap = document.createElement("div");
      wrap.id = "airsup-confirm-modal";
      wrap.className = "modal-overlay";
      wrap.setAttribute("role", "dialog");
      wrap.setAttribute("aria-modal", "true");
      wrap.setAttribute("aria-labelledby", "airsup-confirm-title");
      wrap.innerHTML =
        '<div class="modal-box">' +
        '<h2 class="modal-title" id="airsup-confirm-title">Confirm</h2>' +
        '<p class="modal-message">' +
        escapeHtml(message) +
        "</p>" +
        '<div class="modal-actions">' +
        '<button type="button" class="btn-outline" id="airsup-confirm-cancel">' +
        escapeHtml(cancelLabel) +
        "</button>" +
        '<button type="button" class="' +
        (danger ? "btn-danger" : "btn-primary") +
        '" id="airsup-confirm-ok">' +
        escapeHtml(confirmLabel) +
        "</button></div></div>";
      function finish(result) {
        document.body.style.overflow = prevOverflow;
        wrap.remove();
        document.removeEventListener("keydown", onKey);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }
      document.addEventListener("keydown", onKey);
      wrap.addEventListener("click", function (e) {
        if (e.target === wrap) finish(false);
      });
      document.body.appendChild(wrap);
      $("airsup-confirm-cancel")?.addEventListener("click", function () {
        finish(false);
      });
      $("airsup-confirm-ok")?.addEventListener("click", function () {
        finish(true);
      });
      setTimeout(function () {
        $("airsup-confirm-cancel")?.focus();
      }, 0);
    });
  }
  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || "")); };
      r.onerror = function () { reject(new Error("Could not read file")); };
      r.readAsText(file);
    });
  }

  function isTextLikeFile(file) {
    var n = (file.name || "").toLowerCase();
    var m = (file.type || "").toLowerCase();
    if (m.indexOf("text/") === 0) return true;
    if (m === "application/json" || m === "application/xml") return true;
    return /\.(txt|md|markdown|csv|json|log|html?|xml|yaml|yml|rtf)$/i.test(n);
  }

  /** Text from .txt / .md / etc. for intake import (cap matches server). */
  async function buildTextForImportFromFiles(files) {
    var max = 64000;
    var parts = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!isTextLikeFile(f)) continue;
      try {
        var t = await readFileAsText(f);
        if (t && String(t).trim()) parts.push("--- " + (f.name || "file") + " ---\n" + t);
      } catch (_) { /* binary or unreadable, skip for import */ }
    }
    var s = parts.join("\n\n");
    return s.length > max ? s.slice(0, max) : s;
  }

  /** Onboarding file uploads: no 3D/CAD; cap count and per-file size (matches sensible Supabase use). */
  var ONBOARDING_MAX_FILES = 8;
  var ONBOARDING_MAX_FILE_BYTES = 20 * 1024 * 1024;

  var ONBOARDING_3D_OR_CAD = new Set(
    "3dm,3ds,3mf,abc,asm,b3d,blend,blend1,bvh,catpart,dae,dxf,dwf,dwg,f3d,fbx,gltf,glb,iam,ifc,iges,igs,ipt,jt,max,md2,md3,ms3d,nif,obj,ogex,par,ply,prt,rvm,sldasm,sldprt,skp,step,stl,stp,u3d,usdz,vrml,wrl,x3d,x_t,x_b,xgl,3dxml".split(
      ","
    )
  );

  function fileExtensionFromName(name) {
    var n = String(name || "").toLowerCase();
    var i = n.lastIndexOf(".");
    if (i < 0) return "";
    return n.slice(i + 1) || "";
  }

  function isAllowedOnboardingUpload(file) {
    var ext = fileExtensionFromName(file.name);
    if (ext && ONBOARDING_3D_OR_CAD.has(ext)) return false;
    var t = (file.type || "").toLowerCase();
    if (t.indexOf("image/") === 0) return true;
    if (t === "application/pdf" || t === "application/x-pdf") return true;
    if (t.indexOf("text/") === 0) return true;
    if (t === "application/json" || t === "application/xml" || t === "text/xml") return true;
    if (
      t.indexOf("application/vnd.openxmlformats") === 0 ||
      t.indexOf("application/vnd.ms-") === 0 ||
      t.indexOf("application/vnd.oasis.opendocument") === 0
    )
      return true;
    if (t === "application/rtf" || t === "text/rtf") return true;
    if (!ext) return false;
    return (
      "pdf,txt,md,markdown,mdown,csv,tsv,json,rtf,log,html,htm,xml,doc,docx,xls,xlsx,ppt,pptx,odt,ods,odp,jpg,jpeg,png,gif,webp,bmp,svg,ico,tif,tiff,heic,heif"
        .split(",")
        .indexOf(ext) >= 0
    );
  }

  function validateOnboardingProjectFiles(fileArray) {
    var arr = fileArray && fileArray.length ? fileArray : [];
    if (arr.length > ONBOARDING_MAX_FILES) {
      return {
        ok: false,
        error: "Choose at most " + ONBOARDING_MAX_FILES + " files (20 MB each; images, PDF, and documents only).",
        files: [],
      };
    }
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].size > ONBOARDING_MAX_FILE_BYTES) {
        return {
          ok: false,
          error:
            "File is too large: \u201c" +
            (arr[i].name || "file") +
            "\u201d. Max 20 MB per file.",
          files: [],
        };
      }
    }
    for (var j = 0; j < arr.length; j++) {
      if (!isAllowedOnboardingUpload(arr[j])) {
        return {
          ok: false,
          error:
            "Not allowed: \u201c" +
            (arr[j].name || "file") +
            "\u201d. 3D and CAD files are not supported. Use images, PDF, or text/office documents.",
          files: [],
        };
      }
    }
    return { ok: true, error: null, files: arr };
  }

  /** OpenStreetMap-backed suggestions; you can still type any value. */
  function wireLocationAutocomplete(input) {
    if (!input || input.getAttribute("data-airsup-place") === "1") return;
    input.setAttribute("data-airsup-place", "1");
    var field = input.closest(".onboard-field, .settings-field");
    if (field) field.classList.add("location-autocomplete-field");
    var list = document.createElement("ul");
    list.className = "location-autocomplete-suggestions";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-hidden", "true");
    (field || input.parentNode).appendChild(list);
    var deb = 0;
    var seq = 0;
    var hideAfterT = 0;
    function showPanel() {
      list.removeAttribute("hidden");
      list.setAttribute("aria-hidden", "false");
      requestAnimationFrame(function () {
        list.classList.add("is-open");
      });
    }
    function hide() {
      clearTimeout(hideAfterT);
      if (!list.classList.contains("is-open") && !list.children.length) {
        list.setAttribute("hidden", "");
        list.setAttribute("aria-hidden", "true");
        return;
      }
      list.classList.remove("is-open");
      hideAfterT = setTimeout(function () {
        list.innerHTML = "";
        list.setAttribute("hidden", "");
        list.setAttribute("aria-hidden", "true");
        hideAfterT = 0;
      }, 200);
    }
    list.setAttribute("hidden", "");
    input.addEventListener("input", function () {
      clearTimeout(deb);
      var q = (input.value || "").trim();
      if (q.length < 2) {
        hide();
        return;
      }
      deb = setTimeout(function () {
        var n = ++seq;
        (async function () {
          try {
            var res = await fetch((API_BASE || "") + "/api/places/autocomplete?q=" + encodeURIComponent(q));
            if (n !== seq) return;
            if (!res.ok) { hide(); return; }
            var data = await res.json();
            if (n !== seq) return;
            var r = ((data && data.results) || []).slice(0, 3);
            list.classList.remove("is-open");
            list.innerHTML = "";
            if (!r.length) { hide(); return; }
            r.forEach(function (item) {
              if (!item || !item.label) return;
              var li = document.createElement("li");
              li.setAttribute("role", "option");
              li.className = "location-autocomplete-item";
              li.textContent = item.label;
              li.addEventListener("mousedown", function (e) {
                e.preventDefault();
                input.value = item.label;
                clearTimeout(hideAfterT);
                list.classList.remove("is-open");
                list.innerHTML = "";
                list.setAttribute("hidden", "");
                list.setAttribute("aria-hidden", "true");
              });
              list.appendChild(li);
            });
            showPanel();
          } catch (e) {
            if (n === seq) hide();
          }
        })();
      }, 450);
    });
    input.addEventListener("blur", function () { setTimeout(hide, 200); });
    input.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
  }
  function formatOutreachStage(stage) {
    if (stage === "await_supplier") return "Awaiting your response";
    return String(stage || "").replace(/_/g, " ") || "";
  }

  function summarizeProjectRequirements(req) {
    if (!req || typeof req !== "object") return "";
    try {
      var parts = [];
      if (req.quantity) parts.push("Qty: " + String(req.quantity));
      if (req.timeline) parts.push("Timeline: " + String(req.timeline));
      if (req.budget) parts.push("Budget: " + String(req.budget));
      if (req.materials) parts.push("Materials: " + String(req.materials).slice(0, 140));
      if (req.quality_requirements) parts.push("Quality: " + String(req.quality_requirements).slice(0, 120));
      return parts.join(" \u00b7 ");
    } catch (_) {
      return "";
    }
  }

  function formatMatchStatusLabel(status) {
    if (status === "intro_sent") return "Intro sent, say hello";
    if (status === "in_production") return "In production";
    return String(status || "").replace(/_/g, " ") || "";
  }

  function simpleMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\n{2,}/g, "</p><p>");
    html = html.replace(/\n/g, "<br>");
    html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>");
    return `<p>${html}</p>`;
  }

  async function apiCall(path, opts = {}) {
    const token = (await supabaseClient?.auth.getSession())?.data?.session?.access_token;
    const res = await fetch(`${API_BASE}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const text = await res.text();
      let detail = "HTTP " + res.status;
      try {
        const j = JSON.parse(text);
        if (j && typeof j.error === "string" && j.error.trim()) detail = j.error.trim();
        else if (text && text.length) detail = text.slice(0, 400);
      } catch (_) {
        if (text && text.length) detail = text.slice(0, 400);
      }
      throw new Error(detail);
    }
    return res.json();
  }

  async function refreshLatestProject() {
    if (!(await ensureSession())) return;
    try {
      const data = await apiCall("/api/projects/latest");
      latestProjectId = data.project?.id || null;
    } catch (_) {
      latestProjectId = null;
    }
  }

  async function uploadChatFiles(fileList) {
    if (!fileList?.length) return { filenames: [], err: null };
    if (!supabaseClient) return { filenames: [], err: "Supabase not configured" };
    const { data: auth } = await supabaseClient.auth.getUser();
    if (!auth?.user) return { filenames: [], err: "Not signed in" };
    const uid = auth.user.id;

    var projectId = latestProjectId;
    if (!projectId) {
      try {
        var latest = await apiCall("/api/projects/latest");
        projectId = latest.project && latest.project.id ? latest.project.id : null;
      } catch (_) {
        projectId = null;
      }
    }

    const names = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var rid =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : String(Date.now()) + "-" + i;
      var safe = String(f.name || "file")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 180);
      var path = projectId
        ? uid + "/" + projectId + "/" + rid + "_" + safe
        : uid + "/orphan/" + rid + "_" + safe;

      var up = await supabaseClient.storage.from("project-files").upload(path, f, {
        cacheControl: "3600",
        upsert: false,
        contentType: f.type || "application/octet-stream",
      });
      if (up.error) {
        var msg = up.error.message || "Storage upload failed";
        if (/bucket not found|No such bucket/i.test(msg)) {
          msg +=
            " Create the \u201cproject-files\u201d bucket (run Supabase migration 009) and Storage policies (010/011).";
        } else if (/row-level security|RLS|permission denied|not authorized/i.test(msg)) {
          msg +=
            " [Storage] First path folder must be your user id. Apply Supabase migrations (010/011 and 018_storage_rls_jwt_sub).";
        }
        return { filenames: [], err: msg };
      }

      try {
        await apiCall("/api/chat/register-file", {
          method: "POST",
          body: JSON.stringify({
            storage_path: path,
            filename: f.name || safe,
            bytes: f.size,
            mime_type: f.type || "",
            project_id: projectId,
          }),
        });
      } catch (regErr) {
        var regMsg = regErr.message || "Could not save file metadata";
        if (/row-level security|RLS|violates row-level security/i.test(regMsg)) {
          regMsg +=
            " [register-file API uses the service role on the server. On Vercel, set SUPABASE_SERVICE_ROLE_KEY to the Supabase service_role secret.]";
        }
        return { filenames: [], err: regMsg };
      }
      names.push(f.name || safe);
    }
    return { filenames: names, err: null };
  }

  /** Upload to Storage and register on a known project (onboarding; allowed types only). */
  async function uploadFilesToProject(projectId, fileList) {
    if (!fileList?.length) return { filenames: [], err: null };
    if (!projectId) return { filenames: [], err: "No project" };
    var v0 = validateOnboardingProjectFiles(fileList);
    if (!v0.ok) return { filenames: [], err: v0.error };
    fileList = v0.files;
    if (!supabaseClient) return { filenames: [], err: "Supabase not configured" };
    const { data: auth } = await supabaseClient.auth.getUser();
    if (!auth?.user) return { filenames: [], err: "Not signed in" };
    const uid = auth.user.id;
    const names = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var rid =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : String(Date.now()) + "-" + i;
      var safe = String(f.name || "file")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 180);
      var path = uid + "/" + projectId + "/" + rid + "_" + safe;
      var up = await supabaseClient.storage.from("project-files").upload(path, f, {
        cacheControl: "3600",
        upsert: false,
        contentType: f.type || "application/octet-stream",
      });
      if (up.error) {
        var msg = up.error.message || "Storage upload failed";
        if (/bucket not found|No such bucket/i.test(msg)) {
          msg +=
            " Create the \u201cproject-files\u201d bucket (run Supabase migration 009) and Storage policies (010/011).";
        } else if (/row-level security|RLS|permission denied|not authorized/i.test(msg)) {
          msg +=
            " [Storage] First path folder must be your user id. Apply Supabase migrations (010/011 and 018_storage_rls_jwt_sub).";
        }
        return { filenames: [], err: msg };
      }
      try {
        await apiCall("/api/projects/" + encodeURIComponent(projectId) + "/register-file", {
          method: "POST",
          body: JSON.stringify({
            storage_path: path,
            filename: f.name || safe,
            bytes: f.size,
            mime_type: f.type || "",
          }),
        });
      } catch (regErr) {
        return { filenames: [], err: regErr.message || "Could not save file metadata" };
      }
      names.push(f.name || safe);
    }
    return { filenames: names, err: null };
  }

  function showAuthBanner(msg) { const el = $("auth-banner"); if (el) { el.textContent = msg; el.hidden = false; } }
  function hideAuthBanner() { const el = $("auth-banner"); if (el) { el.hidden = true; el.textContent = ""; } }

  async function ensureSession() {
    hideAuthBanner();
    if (currentUser) return true;
    if (!supabaseClient) { showAuthBanner("Add your Supabase anon key in config.js."); return false; }
    if (sessionBootstrapLock) return false;
    const { data: sess0 } = await supabaseClient.auth.getSession();
    if (sess0?.session?.user) { await syncUserProfileFromAuth(sess0.session.user); return true; }
    sessionBootstrapLock = true;
    try {
      const { data, error } = await supabaseClient.auth.signInAnonymously();
      if (error) { showAuthBanner("Enable Anonymous sign-ins in Supabase \u2192 Authentication \u2192 Providers, then reload."); return false; }
      if (data?.user) await syncUserProfileFromAuth(data.user);
      return true;
    } finally { sessionBootstrapLock = false; }
  }

  /** Must match the home page (landingpage) login: fake email = digits + &quot;@login.airsup&quot; */
  function phoneDigits(phone) {
    return (phone == null ? "" : String(phone)).replace(/[^0-9]/g, "");
  }
  function phoneToFakeEmail(phone) {
    return phoneDigits(phone) + "@login.airsup";
  }

  /**
   * Binds the current session to phone + password (Supabase email + password) so the user can
   * sign in from the landing page. Safe to call on anonymous or existing email users.
   */
  async function applyPhonePinSignIn(phoneRaw, pin, pinConfirm) {
    if (!supabaseClient) return { error: "Not configured." };
    const phone = (phoneRaw || "").trim();
    const digits = phoneDigits(phone);
    if (digits.length < 7) { return { error: "Use a full phone number with country code (at least 7 digits)." }; }
    if (!pin || String(pin).length < 6) { return { error: "Password must be at least 6 characters." }; }
    if (String(pin) !== String(pinConfirm)) { return { error: "Passwords do not match." }; }

    const email = phoneToFakeEmail(phone);
    const { data: ures, error: guErr } = await supabaseClient.auth.getUser();
    if (guErr || !ures?.user) { return { error: "No active session. Reload and try again." }; }
    const u = ures.user;
    const meta = { ...(u.user_metadata || {}), phone };

    var attrs;
    if (u.is_anonymous) {
      attrs = { email, password: String(pin), data: meta };
    } else if (u.email && u.email.toLowerCase() === email.toLowerCase()) {
      attrs = { password: String(pin), data: meta };
    } else {
      attrs = { email, password: String(pin), data: meta };
    }

    const { data, error } = await supabaseClient.auth.updateUser(attrs);
    if (error) {
      var m = String(error.message || "Could not save sign-in.");
      if (/same\s+as\s+the\s+old\s+password/i.test(m)) { return { error: "Choose a new password, different from the old one." }; }
      if (/already|registered|exists|user already/i.test(m)) {
        return { error: "This phone is already used by another account. On the home page use Login with that number, or use a different phone in your profile." };
      }
      return { error: m };
    }
    if (data?.user) { await syncUserProfileFromAuth(data.user); }
    return { ok: true };
  }

  async function handleSignOut() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    currentUser = null; userRole = null; onboardStep = 0; resetOnboardData();
    window.location.href = "/";
  }

  /* ── Auth UI ── */
  function updateAuthUI() {
    const inOnboarding = currentView === "onboarding";
    const loggedIn = !!currentUser;
    const account = $("header-account");
    if (account) account.hidden = !loggedIn || inOnboarding;
    const avatarEl = $("avatar-letter");
    const avatarBtn = $("user-menu-trigger");
    if (loggedIn && avatarEl) avatarEl.textContent = (currentUser.displayName || "?").charAt(0).toUpperCase();
    if (avatarBtn) avatarBtn.classList.toggle("avatar-btn--anon", !loggedIn);
    const nav = $("header-nav");
    if (nav) nav.style.display = (loggedIn && !inOnboarding) ? "" : "none";
  }

  function buildNav() {
    const nav = $("header-nav");
    if (!nav) return;
    if (userRole === "supplier") {
      nav.innerHTML = '<button type="button" class="nav-link active" data-view="supplier-dashboard">Dashboard</button><button type="button" class="nav-link" data-view="supplier-profile">Factory profile</button>';
    } else {
      nav.innerHTML =
        '<button type="button" class="nav-link active" data-view="projects">Projects</button><button type="button" class="nav-link" data-view="connections">Connections<span class="nav-connections-badge" id="nav-connections-badge" hidden>+1</span></button>' +
        (CHAT_ENABLED ? '<button type="button" class="nav-link" data-view="chat">Chat</button>' : "");
    }
    nav.querySelectorAll(".nav-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.view;
        if (v) ensureSession().then((ok) => { if (ok) setView(v); });
      });
    });
  }

  function setupAuthListener() {
    if (!supabaseClient) return;
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (session?.user) syncUserProfileFromAuth(session.user);
      else if (event === "SIGNED_OUT") { currentUser = null; updateAuthUI(); }
    });
  }

  async function initAuthState() {
    if (!supabaseClient) return;
    const hash = window.location.hash;
    if (hash && (hash.includes("access_token") || hash.includes("error"))) {
      await supabaseClient.auth.getSession();
      window.history.replaceState(null, "", window.location.pathname);
    }
    const { data } = await supabaseClient.auth.getSession();
    if (data?.session?.user) {
      await syncUserProfileFromAuth(data.session.user);
      const { data: profile } = await supabaseClient.from("profiles").select("company, headline").eq("id", currentUser.id).maybeSingle();
      if (profile?.headline === "supplier") {
        userRole = "supplier"; buildNav(); setView("supplier-dashboard");
      } else if (profile?.company || profile?.headline) {
        userRole = "startup"; buildNav(); setView("projects");
      } else {
        // Logged in but onboarding not complete — stay in onboarding flow
        setView("onboarding");
      }
    } else {
      // No session — redirect to landing page (admin path keeps its own gate)
      const isAdmin = window.location.pathname.replace(/\/+$/, "") === "/admin";
      if (!isAdmin) {
        window.location.href = "/";
      }
    }
  }

  function closeAdminWorkspace() {
    const ws = $("admin-workspace");
    const ow = $("admin-overview-wrap");
    if (ws) {
      ws.hidden = true;
      delete ws.dataset.projectId;
    }
    if (ow) ow.hidden = false;
  }

  /* ── View switching ── */
  function setView(name) {
    if (name === "chat" && !CHAT_ENABLED) {
      name = "projects";
    }
    currentView = name;
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    const page = $(`page-${name}`);
    if (page) page.classList.add("active");
    const nav = $("header-nav");
    if (nav) nav.querySelectorAll(".nav-link").forEach((n) => n.classList.toggle("active", n.dataset.view === name));
    updateAuthUI();

    if (name === "chat" && CHAT_ENABLED) loadChatHistory();
    if (name === "projects") {
      loadProjects();
      if (userRole !== "supplier") void refreshConnectionsNavBadge();
    }
    if (name === "connections") loadConnections();
    if (name === "visit") loadVisit();
    if (name === "settings") void loadSettings();
    if (name === "onboarding") renderOnboardStep();
    if (name === "supplier-dashboard") loadSupplierDashboard();
    if (name === "supplier-profile") loadSupplierProfile();
    if (name === "admin") {
      closeAdminWorkspace();
      loadAdminOverview();
    }
  }

  /* ══════════════════════════════════════
     ONBOARDING
     ══════════════════════════════════════ */
  const STARTUP_STEPS = [
    { id: "company", type: "form", title: "Tell us about your company.", sub: "Use ChatGPT, Claude, or Grok for the deep brainstorm, then hand the brief to us here. We run factory search and contact for you.",
      fields: [
        { key: "companyName", label: "Company name", required: true },
        { key: "location", label: "Location" },
      ] },
    { id: "brief", type: "brief", title: "Bring your brief from ChatGPT, Claude, or Grok", sub: "We turn it into your manufacturing project and find the best suppliers for you." },
    { id: "contact", type: "form", title: "How can we reach you?", sub: "Your info is stored securely and only shared when we find a real match.",
      fields: [
        { key: "fullName", label: "Full name", required: true },
        { key: "phone", label: "Phone / WhatsApp", type: "phone", required: true },
      ] },
    { id: "signin", type: "pin", title: "Set your home-page sign-in", sub: "Set a password to log in on the home page with the phone number you entered in the last step. You can change it later in Settings." },
  ];

  const SUPPLIER_STEPS = [
    { id: "factory", type: "form", title: "Tell us about your factory.", sub: "Buyers hate talking to sales. Our AI briefs your designers and engineers directly. Less overhead, faster iterations.",
      fields: [
        { key: "companyName", label: "Company name", required: true },
        { key: "location", label: "Location", required: true },
        { key: "website", label: "Website", type: "url" },
        { key: "specialization", label: "What do you manufacture?", required: true },
      ] },
    { id: "capabilities", type: "form", title: "What can you produce?", sub: "This helps our AI match you with the right projects. Be specific about what your team excels at.",
      fields: [
        { key: "capabilities", label: "Additional information about your company", type: "textarea", compact: true },
        { key: "priceRange", label: "Project price range" },
        { key: "moqMin", label: "Minimal order quantity", type: "digits" },
        { key: "moqMax", label: "Maximal order quantity", type: "digits" },
      ] },
    { id: "contact", type: "form", title: "How can buyers reach you?", sub: "Pick a country code, then digits only. Your info is stored securely.",
      fields: [
        { key: "whatsapp1", label: "Phone / WhatsApp", type: "phone", required: true },
      ] },
    { id: "signin", type: "pin", title: "Set your home-page sign-in", sub: "Set a password to log in on the home page with the phone number you entered in the last step. You can change it later in Settings." },
  ];

  function getSteps() { return onboardData.role === "supplier" ? SUPPLIER_STEPS : STARTUP_STEPS; }

  function renderOnboardStep() {
    const stage = $("onboard-stage");
    const bar = $("onboard-bar");
    if (!stage || !bar) return;

    const steps = getSteps();
    const totalSteps = steps.length + 2;
    const pct = ((onboardStep + 1) / totalSteps) * 100;
    bar.style.width = pct + "%";

    if (onboardStep === 0) {
      stage.innerHTML = `
        <div class="onboard-question">
          <h1 class="onboard-title">Welcome to Airsup.</h1>
          <p class="onboard-sub">We use AI to connect startups directly with factory engineers. No sales people, no middlemen. Faster iterations, better products.</p>
          <div class="onboard-choices">
            <button type="button" class="onboard-choice" data-value="startup">I need something manufactured</button>
            <button type="button" class="onboard-choice" data-value="supplier">I\u2019m a factory / supplier</button>
          </div>
        </div>`;
      stage.querySelectorAll(".onboard-choice").forEach((btn) => {
        btn.addEventListener("click", () => {
          onboardData.role = btn.dataset.value;
          onboardStep++;
          renderOnboardStep();
        });
      });
      return;
    }

    const stepIdx = onboardStep - 1;
    if (stepIdx >= steps.length) {
      const isSupplier = onboardData.role === "supplier";
      stage.innerHTML = `
        <div class="onboard-question">
          <h1 class="onboard-title">${isSupplier ? "Your factory is live." : "You\u2019re all set."}</h1>
          <p class="onboard-sub">${isSupplier
            ? "Our AI will start sending you project briefs that match your capabilities. You\u2019ll work directly with buyers, no sales needed."
            : "We start now contacting the best factories based on your project requirements."}</p>
          <div class="onboard-actions">
            <button type="button" class="btn-primary btn-lg" id="onboard-go">${isSupplier ? "Go to dashboard" : "See your project"}</button>
          </div>
        </div>`;
      $("onboard-go")?.addEventListener("click", async () => {
        if (!(await ensureSession())) return;
        const goBtn = $("onboard-go");
        var prev = goBtn && goBtn.textContent;
        try {
          if (goBtn) { goBtn.disabled = true; goBtn.textContent = isSupplier ? "Loading\u2026" : "Preparing your project\u2026"; }
          const result = await saveOnboardingToSupabase() || {};
          userRole = isSupplier ? "supplier" : "startup";
          buildNav();
          if (isSupplier) {
            setView("supplier-dashboard");
            return;
          }
          if (result.importedProjectId) {
            latestProjectId = result.importedProjectId;
            setView("projects");
            await loadProjectDetail(result.importedProjectId);
            return;
          }
          {
            const steps = getSteps();
            var bi2 = -1;
            for (var sj = 0; sj < steps.length; sj++) {
              if (steps[sj].id === "brief") {
                bi2 = sj;
                break;
              }
            }
            if (bi2 >= 0) {
              onboardData._briefReturnHint = "Context needed. Add a link, paste, or a file.";
              onboardStep = bi2 + 1;
              renderOnboardStep();
            }
          }
        } catch (err) {
          {
            const steps = getSteps();
            var bi3 = -1;
            for (var sk = 0; sk < steps.length; sk++) {
              if (steps[sk].id === "brief") {
                bi3 = sk;
                break;
              }
            }
            if (bi3 >= 0) {
              onboardData._briefReturnHint = (err && err.message) ? String(err.message).slice(0, 120) : "Could not create project. Try again.";
              onboardStep = bi3 + 1;
              renderOnboardStep();
            }
          }
        } finally {
          if (goBtn) { goBtn.disabled = false; if (prev) goBtn.textContent = prev; }
        }
      });
      return;
    }

    const step = steps[stepIdx];
    if (step.type === "pin") {
      const isSupplier = onboardData.role === "supplier";
      var phoneRowHtml = "";
      var pinH =
        '<div class="onboard-question"><h1 class="onboard-title">' +
        step.title +
        "</h1>" +
        (step.sub ? '<p class="onboard-sub">' + step.sub + "</p>" : "") +
        '<div class="onboard-form">' +
        phoneRowHtml +
        '<div class="onboard-field"><label class="onboard-label" for="onboard-pin">Password (min. 6 characters)</label>' +
        '<div class="password-input-wrap">' +
        '<input class="onboard-input" type="password" id="onboard-pin" minlength="6" maxlength="64" autocomplete="new-password" required />' +
        passwordToggleButtonHtml("onboard-pin") +
        "</div></div>" +
        '<div class="onboard-field"><label class="onboard-label" for="onboard-pin2">Confirm password</label>' +
        '<div class="password-input-wrap">' +
        '<input class="onboard-input" type="password" id="onboard-pin2" minlength="6" maxlength="64" autocomplete="new-password" required />' +
        passwordToggleButtonHtml("onboard-pin2") +
        "</div></div>" +
        "</div>" +
        '<p class="onboard-field-error" id="onboard-pin-error" role="status" hidden></p>' +
        '<div class="onboard-actions"><button type="button" class="btn-primary" id="onboard-next">Continue</button>' +
        '<button type="button" class="onboard-skip" id="onboard-back">Back</button></div></div>';
      stage.innerHTML = pinH;
      var pinErrClear = function () { setOnboardLineError("onboard-pin-error", ""); };
      ["onboard-pin", "onboard-pin2"].forEach(function (iid) {
        document.getElementById(iid)?.addEventListener("input", pinErrClear);
      });
      $("onboard-next")?.addEventListener("click", async function () {
        if (!(await ensureSession())) return;
        setOnboardLineError("onboard-pin-error", "");
        var a = isSupplier
          ? (onboardData.whatsapp1 || "").trim()
          : (onboardData.phone || "").trim();
        if (!a) {
          setOnboardLineError("onboard-pin-error", "Add your phone number in the previous step, or go back to enter it.");
          return;
        }
        const b = ($("onboard-pin") && ($("onboard-pin").value)) || "";
        const c = ($("onboard-pin2") && ($("onboard-pin2").value)) || "";
        const nextBtn = $("onboard-next");
        var prevT = nextBtn && nextBtn.textContent;
        try {
          if (nextBtn) { nextBtn.disabled = true; if (nextBtn) nextBtn.textContent = "Saving\u2026"; }
          const r = await applyPhonePinSignIn(a, b, c);
          if (r.error) {
            setOnboardLineError("onboard-pin-error", r.error);
            return;
          }
          if (isSupplier) {
            onboardData.phone = (a || "").trim();
          }
          onboardStep++;
          renderOnboardStep();
        } finally {
          if (nextBtn) { nextBtn.disabled = false; if (prevT) nextBtn.textContent = prevT; }
        }
      });
      $("onboard-back")?.addEventListener("click", function () {
        onboardStep--;
        renderOnboardStep();
      });
      setTimeout(
        function () {
          $("onboard-pin") && ($("onboard-pin").focus());
        },
        100
      );
      return;
    }
    if (step.type === "brief") {
      var nf = onboardingProjectFiles.length;
      var fileBtnLabel =
        nf === 0
          ? "Choose files"
          : nf === 1
            ? escapeHtml(onboardingProjectFiles[0].name || "1 file")
            : escapeHtml(String(nf) + " files selected");
      const htmlB =
        '<div class="onboard-question"><h1 class="onboard-title">' + step.title + "</h1>" +
        (step.sub ? '<p class="onboard-sub">' + step.sub + "</p>" : "") +
        '<div class="onboard-form onboard-brief">' +
        '<div class="onboard-field"><input class="onboard-input" type="url" id="onboard-brief-url" name="onboard-brief-url" value="' +
        escapeAttr(onboardData.briefUrl || "") +
        '" placeholder="Chat link" autocomplete="url" /></div>' +
        '<div class="onboard-field onboard-brief-upload-field">' +
        '<input class="onboard-brief-file-input" type="file" id="onboard-brief-file" multiple ' +
        'accept="image/*,.pdf,.doc,.docx,.txt,.md,.markdown,.mdown,.csv,.tsv,.xlsx,.xls,.ppt,.pptx,.odt,.ods,.odp,.rtf,.html,.htm,.json,.xml,.heic" hidden />' +
        '<button type="button" class="onboard-brief-file-btn" id="onboard-brief-file-btn">' + fileBtnLabel + "</button></div>" +
        '<div class="onboard-field"><label class="onboard-label" for="onboard-brief-paste">Paste the conversation (optional)</label>' +
        '<textarea class="onboard-textarea onboard-input" id="onboard-brief-paste" rows="5" placeholder="If a share link fails to import, paste the chat here. You can also paste only, without a link.">' +
        escapeHtml(onboardData.briefPastedText || "") +
        "</textarea></div><p class=\"onboard-field-error\" id=\"onboard-brief-error\" role=\"status\" hidden></p></div>" +
        '<div class="onboard-actions"><button type="button" class="btn-primary" id="onboard-next">Continue</button>' +
        '<button type="button" class="onboard-skip" id="onboard-back">Back</button></div></div>';
      stage.innerHTML = htmlB;
      if (onboardData._briefReturnHint) {
        setOnboardLineError("onboard-brief-error", String(onboardData._briefReturnHint));
        delete onboardData._briefReturnHint;
      }
      var clearBriefErr = function () { setOnboardLineError("onboard-brief-error", ""); };
      stage.querySelector("#onboard-brief-url")?.addEventListener("input", clearBriefErr);
      stage.querySelector("#onboard-brief-paste")?.addEventListener("input", clearBriefErr);
      const fileInput = stage.querySelector("#onboard-brief-file");
      const fileBtn = stage.querySelector("#onboard-brief-file-btn");
      fileBtn &&
        fileInput &&
        fileBtn.addEventListener("click", function () {
          fileInput.click();
        });
      fileInput &&
        fileInput.addEventListener("change", function () {
          var raw = fileInput.files && fileInput.files.length
            ? Array.prototype.slice.call(fileInput.files, 0)
            : [];
          var v = validateOnboardingProjectFiles(raw);
          if (!v.ok) {
            setOnboardLineError("onboard-brief-error", v.error);
            fileInput.value = "";
            return;
          }
          clearBriefErr();
          onboardingProjectFiles = v.files;
          if (fileBtn) {
            var n = onboardingProjectFiles.length;
            fileBtn.textContent =
              n === 0
                ? "Choose files"
                : n === 1
                  ? onboardingProjectFiles[0].name || "1 file"
                  : n + " files selected";
          }
        });
      $("onboard-back")?.addEventListener("click", function () {
        var u = $("onboard-brief-url");
        if (u) onboardData.briefUrl = (u.value || "").trim();
        var pasteEl = $("onboard-brief-paste");
        if (pasteEl) onboardData.briefPastedText = (pasteEl.value || "").trim();
        onboardStep--;
        renderOnboardStep();
      });
      $("onboard-next")?.addEventListener("click", function () {
        const urlEl = $("onboard-brief-url");
        const fileEl = $("onboard-brief-file");
        const pasteEl = $("onboard-brief-paste");
        const u = (urlEl && urlEl.value ? urlEl.value : "").trim();
        if (pasteEl) onboardData.briefPastedText = (pasteEl.value || "").trim();
        var raw =
          fileEl && fileEl.files && fileEl.files.length
            ? Array.prototype.slice.call(fileEl.files, 0)
            : onboardingProjectFiles;
        var v = validateOnboardingProjectFiles(raw);
        if (!v.ok) {
          setOnboardLineError("onboard-brief-error", v.error);
          return;
        }
        onboardingProjectFiles = v.files;
        onboardData.briefUrl = u;
        const pasted = (onboardData.briefPastedText && String(onboardData.briefPastedText).trim()) || "";
        if (!u && !onboardingProjectFiles.length && !pasted) {
          setOnboardLineError("onboard-brief-error", "Context is required. Add a link, paste, or a file.");
          return;
        }
        clearBriefErr();
        onboardStep++;
        renderOnboardStep();
      });
      const fu = stage.querySelector("#onboard-brief-url");
      if (fu) setTimeout(function () { fu.focus(); }, 100);
      return;
    }
    let html = `<div class="onboard-question"><h1 class="onboard-title">${step.title}</h1>`;
    if (step.sub) html += `<p class="onboard-sub">${step.sub}</p>`;
    html += '<div class="onboard-form">';
    step.fields.forEach((f) => {
      if (f.row) {
        html += '<div class="onboard-field-row">';
        f.row.forEach((rf) => {
          html += `<div class="onboard-field"><label class="onboard-label">${rf.label}</label><input class="onboard-input" data-key="${rf.key}" type="${rf.type || "text"}" value="${escapeAttr(onboardData[rf.key] || "")}" ${rf.required ? "required" : ""} /></div>`;
        });
        html += "</div>";
      } else if (f.type === "phone") {
        html += onboardPhoneFieldHtml(f.key, f.label, onboardData[f.key] || "", !!f.required);
      } else if (f.type === "textarea") {
        const rows = f.compact ? 2 : 4;
        const cls = f.compact ? " onboard-textarea--compact" : "";
        html += `<div class="onboard-field"><label class="onboard-label">${f.label}</label><textarea class="onboard-textarea onboard-input${cls}" data-key="${f.key}" rows="${rows}" ${f.required ? "required" : ""}>${escapeHtml(onboardData[f.key] || "")}</textarea></div>`;
      } else if (f.type === "digits") {
        html += `<div class="onboard-field"><label class="onboard-label">${f.label}</label><input class="onboard-input onboard-input-digits" data-key="${f.key}" type="text" inputmode="numeric" pattern="[0-9]*" value="${escapeAttr(onboardData[f.key] || "")}" ${f.required ? "required" : ""} /></div>`;
      } else {
        html += `<div class="onboard-field"><label class="onboard-label">${f.label}</label><input class="onboard-input" data-key="${f.key}" type="${f.type || "text"}" value="${escapeAttr(onboardData[f.key] || "")}" ${f.required ? "required" : ""} /></div>`;
      }
    });
    html += '<p class="onboard-field-error" id="onboard-form-error" role="status" hidden></p></div><div class="onboard-actions"><button type="button" class="btn-primary" id="onboard-next">Continue</button>';
    html += '<button type="button" class="onboard-skip" id="onboard-back">Back</button></div></div>';
    stage.innerHTML = html;

    stage.querySelectorAll(".onboard-input-digits").forEach((inp) => {
      inp.addEventListener("input", () => { inp.value = phoneDigits(inp.value); });
    });
    stage.querySelectorAll(".phone-local-num").forEach((inp) => {
      window.AIRSUP_PHONE?.wirePhoneLocalInput(inp);
    });
    stage.querySelectorAll(".onboard-input-phone-tel").forEach((inp) => {
      inp.addEventListener("input", () => {
        inp.value = phoneDigits(inp.value);
      });
    });

    function collectOnboardFormFields() {
      stage.querySelectorAll("[data-phone-key]").forEach((wrap) => {
        const key = wrap.dataset.phoneKey;
        if (!key) return;
        const idBase = "onboard-ph-" + key;
        onboardData[key] = mergePhoneFromRow($(idBase + "-cc"), $(idBase + "-local"));
      });
      stage.querySelectorAll(".onboard-input[data-key]").forEach((inp) => {
        onboardData[inp.dataset.key] = (inp.value || "").trim();
      });
    }

    $("onboard-next")?.addEventListener("click", () => {
      collectOnboardFormFields();
      if (step.id === "factory" && onboardData.role === "supplier") {
        const w = (onboardData.website || "").trim();
        const v = validateOptionalHttpUrl(w);
        if (!v.ok) {
          setOnboardLineError("onboard-form-error", v.error || "Invalid website.");
          return;
        }
        onboardData.website = v.normalized ? v.normalized : "";
        setOnboardLineError("onboard-form-error", "");
      } else {
        setOnboardLineError("onboard-form-error", "");
      }
      for (const inp of stage.querySelectorAll(".onboard-input[required], textarea.onboard-input[required]")) {
        if (!(inp.value || "").trim()) { inp.focus(); return; }
      }
      onboardStep++;
      renderOnboardStep();
    });
    $("onboard-back")?.addEventListener("click", () => {
      collectOnboardFormFields();
      onboardStep--;
      renderOnboardStep();
    });
    const locIn = stage.querySelector('input.onboard-input[data-key="location"]');
    if (locIn) wireLocationAutocomplete(locIn);
    const firstInput = stage.querySelector(".onboard-input");
    if (firstInput) setTimeout(() => firstInput.focus(), 100);
  }

  async function saveOnboardingToSupabase() {
    if (!supabaseClient || !currentUser) return {};
    const d = onboardData;
    const displayName = d.role === "supplier"
      ? ((d.companyName || "").trim() || d.fullName || currentUser.displayName)
      : (d.fullName || currentUser.displayName);
    const letter = (displayName || "?").charAt(0).toUpperCase();

    await supabaseClient.from("profiles").upsert({
      id: currentUser.id, display_name: displayName, avatar_letter: letter,
      company: d.companyName, location: d.location,
      headline: d.role === "supplier" ? "supplier" : d.role,
      role: d.role === "supplier" ? "supplier" : "customer",
      phone: d.role === "supplier" ? (d.whatsapp1 || d.phone || "") : d.phone,
    }, { onConflict: "id" });

    await supabaseClient.from("user_settings").upsert({
      user_id: currentUser.id,
      preferred_name: displayName, company: d.companyName, phone: d.role === "supplier" ? (d.whatsapp1 || d.phone || "") : d.phone,
    }, { onConflict: "user_id" });

    if (d.role === "supplier") {
      const wa1 = (d.whatsapp1 || "").trim();
      const contacts = [{ whatsapp: wa1 }];
      const siteRaw = (d.website || "").trim();
      const siteV = siteRaw ? validateOptionalHttpUrl(siteRaw) : { ok: true };
      const cap = {
        description: (d.capabilities || "").trim(),
        project_price_range: (d.priceRange || "").trim(),
        moq_min: phoneDigits(d.moqMin || ""),
        moq_max: phoneDigits(d.moqMax || ""),
        moq: [phoneDigits(d.moqMin), phoneDigits(d.moqMax)].filter(Boolean).join(" – ") || "",
      };
      if (siteV.ok && siteV.normalized) cap.website = siteV.normalized;
      const facPayload = {
        name: d.companyName,
        location: d.location,
        category: d.specialization,
        capabilities: cap,
        contact_info: { contacts },
        active: true,
      };
      await apiCall("/api/factories/me", { method: "PUT", body: JSON.stringify(facPayload) });
      currentUser.displayName = displayName;
      updateAuthUI();
      return {};
    }

    const coPayload = {
      user_id: currentUser.id,
      name: d.companyName || "",
      industry: "",
      location: d.location || "",
      description: "",
      ai_knowledge: { role: d.role, onboarded_at: new Date().toISOString() },
    };
    const { data: coRow } = await supabaseClient.from("companies").select("id").eq("user_id", currentUser.id).maybeSingle();
    if (coRow?.id) await supabaseClient.from("companies").update(coPayload).eq("id", coRow.id);
    else await supabaseClient.from("companies").insert(coPayload);

    const hasUrl = d.briefUrl && String(d.briefUrl).trim();
    const files = onboardingProjectFiles || [];
    const hasFiles = files.length > 0;
    if (hasFiles) {
      var vFiles = validateOnboardingProjectFiles(files);
      if (!vFiles.ok) {
        currentUser.displayName = displayName;
        updateAuthUI();
        throw new Error(vFiles.error);
      }
    }
    var textFromFiles = hasFiles ? String((await buildTextForImportFromFiles(files)) || "").trim() : "";
    const pasted = (d.briefPastedText && String(d.briefPastedText).trim()) || "";
    var textForImport = textFromFiles || pasted;
    const hasTextImport = textForImport.length > 0;
    if (!hasUrl && !hasTextImport && !hasFiles) {
      currentUser.displayName = displayName;
      updateAuthUI();
      return {};
    }

    var projectId = null;
    if (hasUrl || hasTextImport) {
      const importBody = hasUrl
        ? { sourceType: "url", url: String(d.briefUrl).trim(), text: hasTextImport ? textForImport : "" }
        : { sourceType: "file", text: textForImport };
      const data = await apiCall("/api/intake/import", { method: "POST", body: JSON.stringify(importBody) });
      projectId = data.projectId || null;
    } else {
      const data = await apiCall("/api/projects/bootstrap", { method: "POST", body: JSON.stringify({}) });
      projectId = data.projectId || null;
    }
    if (hasFiles && projectId) {
      const up = await uploadFilesToProject(projectId, files);
      if (up.err) throw new Error(up.err);
      try {
        await apiCall("/api/projects/" + encodeURIComponent(projectId) + "/reingest-files", { method: "POST", body: "{}" });
      } catch (_) { /* each register-file may have already ingested */ }
    }
    if (projectId) latestProjectId = projectId;
    onboardingProjectFiles = [];
    currentUser.displayName = displayName;
    updateAuthUI();
    return { importedProjectId: projectId };
  }

  /* ── Settings ── */
  async function loadSettings() {
    const root = $("settings-root");
    if (!root) return;
    if (!(await ensureSession())) { root.innerHTML = '<p class="settings-hint">Could not load session.</p>'; return; }
    root.innerHTML = '<p class="settings-hint">Loading\u2026</p>';
    const { data: profile } = await supabaseClient.from("profiles").select("display_name, company, location, headline, bio, phone").eq("id", currentUser.id).maybeSingle();
    const { data: settings } = await supabaseClient.from("user_settings").select("phone, company, timezone").eq("user_id", currentUser.id).maybeSingle();
    const v = {
      displayName: profile?.display_name || currentUser.displayName || "",
      company: profile?.company || settings?.company || "", phone: profile?.phone || settings?.phone || "",
      location: profile?.location || "", headline: profile?.headline || "", bio: profile?.bio || "",
      timezone: settings?.timezone || "Europe/Berlin",
    };
    const onAdminPath = window.location.pathname.replace(/\/+$/, "") === "/admin";
    const settingsDangerZoneHtml = onAdminPath
      ? ""
      : `<div style="margin-top:40px;padding-top:24px;border-top:1px solid var(--border-light);">
        <p style="font-size:13px;color:var(--text-soft);margin-bottom:10px;">Danger zone</p>
        <button type="button" class="btn-danger" id="settings-delete-profile">Delete my profile</button>
      </div>`;
    root.innerHTML = `<div class="settings-section">
      <div class="settings-field"><label class="settings-label">Display name</label><input type="text" id="settings-displayName" class="settings-input" value="${escapeAttr(v.displayName)}" /></div>
      <div class="settings-field"><label class="settings-label">Company</label><input type="text" id="settings-company" class="settings-input" value="${escapeAttr(v.company)}" /></div>
      ${settingsPhoneRowHtml("Phone / WhatsApp", "settings-phone-cc", "settings-phone-local", v.phone)}
      <div class="settings-field"><label class="settings-label">Location</label><input type="text" id="settings-location" class="settings-input" value="${escapeAttr(v.location)}" /></div>
      <div class="settings-field"><label class="settings-label">Timezone</label><input type="text" id="settings-timezone" class="settings-input" value="${escapeAttr(v.timezone)}" /></div>
      <div class="settings-field"><label class="settings-label">Bio</label><textarea id="settings-bio" class="settings-input" rows="3">${escapeHtml(v.bio)}</textarea></div>
      <p class="settings-saved" id="settings-saved" hidden></p>
      <button type="button" class="btn-primary" id="settings-save">Save changes</button>
      <div class="settings-signin-block">
        <div class="settings-field"><label class="settings-label" for="settings-signin-pin">New password (min. 6 characters)</label><div class="password-input-wrap"><input type="password" id="settings-signin-pin" class="settings-input" autocomplete="new-password" minlength="6" maxlength="64" />${passwordToggleButtonHtml("settings-signin-pin")}</div></div>
        <div class="settings-field"><label class="settings-label" for="settings-signin-pin2">Confirm password</label><div class="password-input-wrap"><input type="password" id="settings-signin-pin2" class="settings-input" autocomplete="new-password" minlength="6" maxlength="64" />${passwordToggleButtonHtml("settings-signin-pin2")}</div></div>
        <button type="button" class="btn-outline" id="settings-save-signin">Save sign-in (phone + password)</button>
      </div>${settingsDangerZoneHtml}</div>`;
    root.querySelectorAll(".phone-local-num").forEach((el) => {
      window.AIRSUP_PHONE?.wirePhoneLocalInput(el);
    });
    var settingsLoc = $("settings-location");
    if (settingsLoc) wireLocationAutocomplete(settingsLoc);
    $("settings-save")?.addEventListener("click", saveSettings);
    $("settings-save-signin")?.addEventListener("click", saveSettingsSignIn);
    if (!onAdminPath) {
      $("settings-delete-profile")?.addEventListener("click", async () => {
        const ok = await showConfirmDialog(
          "Delete your profile? It will be moved to the admin bin. You can ask support to restore it.",
          { confirmLabel: "Delete", cancelLabel: "Cancel", danger: true }
        );
        if (!ok) return;
        try {
          const token = (await supabaseClient.auth.getSession()).data.session?.access_token;
          await fetch(`${API_BASE}/api/profile/me`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
          await supabaseClient.auth.signOut();
          window.location.href = "/";
        } catch (err) {
          if ($("settings-saved")) { $("settings-saved").hidden = false; $("settings-saved").textContent = "Could not delete: " + (err.message || String(err)); $("settings-saved").style.color = "#d93025"; }
        }
      });
    }
  }

  async function saveSettings() {
    if (!currentUser || !supabaseClient) return;
    const g = (k) => ($(`settings-${k}`)?.value || "").trim();
    const dn = g("displayName") || currentUser.displayName;
    const phone = readSettingsStoredPhone();
    const { error: pe } = await supabaseClient.from("profiles").upsert({ id: currentUser.id, display_name: dn, avatar_letter: (dn||"?").charAt(0).toUpperCase(), company: g("company"), phone, location: g("location"), bio: g("bio") }, { onConflict: "id" });
    const { error: se } = await supabaseClient.from("user_settings").upsert({ user_id: currentUser.id, company: g("company"), phone, timezone: g("timezone")||"Europe/Berlin", preferred_name: dn }, { onConflict: "user_id" });
    const saved = $("settings-saved");
    if (pe || se) { if (saved) { saved.hidden = false; saved.textContent = "Error: " + (pe?.message||se?.message||""); saved.style.color = "#d93025"; } return; }
    currentUser.displayName = dn; updateAuthUI();
    if (saved) { saved.hidden = false; saved.textContent = "Saved."; saved.style.color = ""; setTimeout(() => { saved.hidden = true; }, 2500); }
  }

  async function saveSettingsSignIn() {
    if (!currentUser || !supabaseClient) return;
    const phone = readSettingsStoredPhone();
    const p1 = ($("settings-signin-pin")?.value) || "";
    const p2 = ($("settings-signin-pin2")?.value) || "";
    if (!phone) {
      if ($("settings-saved")) { $("settings-saved").hidden = false; $("settings-saved").textContent = "Add your phone in Phone / WhatsApp first."; $("settings-saved").style.color = "#d93025"; }
      return;
    }
    const saved = $("settings-saved");
    const r = await applyPhonePinSignIn(phone, p1, p2);
    if (r.error) { if (saved) { saved.hidden = false; saved.textContent = r.error; saved.style.color = "#d93025"; } return; }
    const { error: e1 } = await supabaseClient.from("profiles").update({ phone }).eq("id", currentUser.id);
    const { error: e2 } = await supabaseClient.from("user_settings").update({ phone }).eq("user_id", currentUser.id);
    if (e1 || e2) { if (saved) { saved.hidden = false; saved.textContent = "Sign-in updated but profile phone save failed. " + (e1?.message || e2?.message || ""); saved.style.color = "#d93025"; } return; }
    var sp0 = $("settings-signin-pin");
    var sp1 = $("settings-signin-pin2");
    if (sp0) sp0.value = "";
    if (sp1) sp1.value = "";
    if (saved) { saved.hidden = false; saved.textContent = "Sign-in saved. You can use Login on the home page with this number and password."; saved.style.color = ""; setTimeout(function () { if (saved) saved.hidden = true; }, 5000); }
  }

  /* ══════════════════════════════════════
     CHAT
     ══════════════════════════════════════ */
  const SUPI_AVATAR_SRC = "assets/brand/logo-air-sup.png";

  function appendChatLine(container, role, text, metadata) {
    if (!container) return;
    if (container.id === "chat-messages") $("chat-welcome")?.remove();

    const supi = role === "assistant" && metadata && metadata.supi;
    const wrap = document.createElement("div");
    wrap.className = "chat-line chat-line--" + role + (supi ? " chat-line--supi" : "");

    if (supi) {
      wrap.innerHTML =
        '<img class="chat-line-avatar" src="' +
        escapeAttr(SUPI_AVATAR_SRC) +
        '" alt="" width="36" height="36" loading="lazy" />' +
        '<div class="chat-line-body"><div class="chat-line-name">Supi</div><div class="chat-bubble chat-bubble--assistant">' +
        simpleMarkdown(text) +
        "</div></div>";
      container.appendChild(wrap);
    } else {
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble chat-bubble--" + role;
      if (role === "assistant") bubble.innerHTML = simpleMarkdown(text);
      else bubble.textContent = text;
      wrap.appendChild(bubble);
      container.appendChild(wrap);
    }

    if (role === "assistant" && metadata) {
      if (metadata.options && metadata.options.length) {
        renderOptionButtons(container, metadata.options);
      }
      if (metadata.action) {
        renderActionButton(container, metadata.action);
      }
    }

    container.scrollTop = container.scrollHeight;
  }

  function appendMessage(role, text, metadata) {
    appendChatLine($("chat-messages"), role, text, metadata);
  }

  function renderOptionButtons(container, options) {
    const wrap = document.createElement("div");
    wrap.className = "chat-options";
    options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-option-btn";
      btn.textContent = opt.label;
      btn.addEventListener("click", () => {
        wrap.querySelectorAll(".chat-option-btn").forEach((b) => { b.disabled = true; b.classList.add("chat-option-btn--used"); });
        btn.classList.add("chat-option-btn--selected");
        const input = $("chat-input");
        if (input) input.value = opt.value;
        sendMessage();
      });
      wrap.appendChild(btn);
    });
    container.appendChild(wrap);
  }

  function renderActionButton(container, action) {
    const wrap = document.createElement("div");
    wrap.className = "chat-action-wrap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-primary chat-action-btn";
    btn.textContent = action.label || "Go";
    btn.addEventListener("click", () => {
      if (action.action === "navigate" && action.target) {
        setView(action.target);
      }
    });
    wrap.appendChild(btn);
    container.appendChild(wrap);
  }

  function appendStatus(text) {
    const container = $("chat-messages");
    const el = document.createElement("div");
    el.className = "chat-status";
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function showTyping() {
    const container = $("chat-messages");
    const el = document.createElement("div");
    el.className = "chat-typing"; el.id = "chat-typing";
    el.innerHTML = '<span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }
  function hideTyping() { $("chat-typing")?.remove(); }

  async function sendMessage() {
    const input = $("chat-input");
    const text = input.value.trim();
    if ((!text && !pendingFiles.length) || isSending) return;
    if (!(await ensureSession())) return;

    isSending = true;
    input.value = ""; input.style.height = "auto";
    $("chat-send").disabled = true;

    let msgText = text || "(See attached files.)";
    let uploadedNames = [];
    if (pendingFiles.length) {
      const up = await uploadChatFiles(pendingFiles);
      pendingFiles = [];
      renderPendingFiles();
      if (up.err) {
        isSending = false;
        $("chat-send").disabled = !input.value.trim();
        appendMessage("assistant", "Could not upload files: " + up.err);
        return;
      }
      uploadedNames = up.filenames;
    }
    if (uploadedNames.length) {
      msgText += "\n\n[Attached files: " + uploadedNames.join(", ") + "]";
    }

    appendMessage("user", msgText);
    appendStatus("AI is analyzing your request\u2026");
    showTyping();

    try {
      const data = await apiCall("/api/chat", { method: "POST", body: JSON.stringify({ message: msgText }) });
      hideTyping();
      document.querySelectorAll(".chat-status").forEach((el) => el.remove());
      if (data.reply != null && String(data.reply).trim() !== "") {
        appendMessage("assistant", data.reply, { options: data.options, action: data.action });
      } else if (data.pending_human) {
        appendStatus("Message sent. Supi will reply soon.");
      } else {
        appendMessage("assistant", data.reply || "(No reply)", { options: data.options, action: data.action });
      }
      await refreshLatestProject();
    } catch (err) {
      hideTyping();
      document.querySelectorAll(".chat-status").forEach((el) => el.remove());
      const errMsg = err.message || "Unknown error";
      appendMessage("assistant", `Could not process your message. (${errMsg})\n\nMake sure the ANTHROPIC_API_KEY environment variable is set in your Vercel project settings.`);
      console.error("[Airsup] chat error:", err);
    }
    isSending = false;
    $("chat-send").disabled = !input.value.trim();
  }

  async function loadChatHistory() {
    const container = $("chat-messages");
    if (!container) return;
    if (!(await ensureSession())) return;
    try {
      const { messages } = await apiCall("/api/chat/history");
      if (messages?.length) {
        container.innerHTML = "";
        messages.forEach((m) => appendMessage(m.role, m.content, m.metadata));
      } else {
        container.innerHTML = "";
        appendStatus("AI is preparing your first message\u2026");
        showTyping();
        try {
          const data = await apiCall("/api/chat/init", { method: "POST" });
          hideTyping();
          document.querySelectorAll(".chat-status").forEach((el) => el.remove());
          if (data.reply) {
            appendMessage("assistant", data.reply, { options: data.options, action: data.action });
          } else if (data.already_initialized) {
            const retry = await apiCall("/api/chat/history");
            if (retry.messages?.length) {
              retry.messages.forEach((m) => appendMessage(m.role, m.content, m.metadata));
            }
          }
        } catch (initErr) {
          hideTyping();
          document.querySelectorAll(".chat-status").forEach((el) => el.remove());
          console.error("[Airsup] chat init error:", initErr);
          appendMessage("assistant", "Could not start the conversation. (" + (initErr.message || "Unknown error") + ")\n\nMake sure the ANTHROPIC_API_KEY environment variable is set in your Vercel project settings.");
        }
      }
      await refreshLatestProject();
    } catch (outerErr) {
      hideTyping();
      $("chat-typing")?.remove();
      document.querySelectorAll(".chat-status").forEach((el) => el.remove());
      $("chat-welcome")?.remove();
      container.innerHTML = "";
      console.error("[Airsup] loadChatHistory:", outerErr);
      appendMessage("assistant", "Could not load chat (" + (outerErr.message || "unknown error") + "). Try refreshing the page. If it keeps happening, check Vercel deployment logs and that Supabase env vars are set for the API.");
    }
  }

  function renderPendingFiles() {
    const el = $("composer-files");
    if (!el) return;
    if (!pendingFiles.length) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.innerHTML = pendingFiles.map((f, i) =>
      `<span class="composer-file-tag">${escapeHtml(f.name)}<button type="button" class="composer-file-remove" data-idx="${i}">&times;</button></span>`
    ).join("");
    el.querySelectorAll(".composer-file-remove").forEach((btn) => {
      btn.addEventListener("click", () => { pendingFiles.splice(Number(btn.dataset.idx), 1); renderPendingFiles(); });
    });
  }

  /** Plain text status for project list/detail: yellow "Searching" until a real connection exists, then "Connected". */
  function projectStatusTextHtml(projectLike) {
    const status = projectLike.status || "";
    const matches = projectLike.matches || [];
    var connected = matches.some(function (m) {
      return m && m.status && m.status !== "cancelled" && m.status !== "disputed";
    });
    if (!connected && (status === "matched" || status === "in_progress" || status === "completed")) {
      connected = true;
    }
    if (connected) {
      return '<span class="project-status-text project-status-text--connected">Connected</span>';
    }
    if (status === "searching") {
      return '<span class="project-status-text project-status-text--searching">Searching</span>';
    }
    const label = String(status).replace(/_/g, " ");
    return '<span class="project-status-text project-status-text--neutral">' + escapeHtml(label) + "</span>";
  }

  function buildProjectPipelineStepper(project) {
    var step = Number(project.pipeline_step);
    if (!Number.isFinite(step) || step < 1) step = 1;
    if (step > 3) step = 3;
    var labels = ["Project", "Contact", "Sample"];
    var parts = [];
    for (var i = 1; i <= 3; i++) {
      var cls = "pipeline-node";
      if (step > i) cls += " pipeline-node--done";
      else if (step === i) cls += " pipeline-node--active";
      parts.push(
        '<div class="' +
          cls +
          '"><span class="pipeline-node-num">' +
          i +
          '</span><span class="pipeline-node-label">' +
          escapeHtml(labels[i - 1]) +
          "</span></div>"
      );
      if (i < 3) {
        var segCls = "pipeline-bridge";
        if (step > i) segCls += " pipeline-bridge--done";
        else if (step === i) segCls += " pipeline-bridge--active";
        parts.push('<div class="' + segCls + '"><div class="pipeline-bridge-line"></div></div>');
      }
    }
    return '<div class="project-pipeline" role="status"><div class="project-pipeline-track">' + parts.join("") + "</div></div>";
  }

  function buildProjectChatSection() {
    return (
      '<section class="project-detail-section project-detail-chat-block"><h3 class="project-detail-h">Messages</h3>' +
      '<div id="project-chat-messages" class="project-chat-messages chat-messages"></div>' +
      '<div class="project-chat-composer composer-inner">' +
      '<textarea id="project-chat-input" class="composer-input" rows="2" placeholder="Message\u2026"></textarea>' +
      '<button type="button" class="composer-send" id="project-chat-send" aria-label="Send">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg></button>' +
      "</div></section>"
    );
  }

  /** Buyer workspace: anyone who is not a supplier (including brief null/startup during load). */
  function isBuyerWorkspace() {
    return userRole !== "supplier";
  }

  async function loadProjectChatHistory(projectId) {
    const box = $("project-chat-messages");
    if (!box) return;
    try {
      const { messages } = await apiCall("/api/chat/history?project_id=" + encodeURIComponent(projectId));
      box.innerHTML = "";
      (messages || []).forEach(function (m) {
        if (isBuyerWorkspace() && m.metadata && m.metadata.supi) {
          return;
        }
        appendChatLine(box, m.role, m.content, m.metadata);
      });
    } catch (_) {
      box.innerHTML = '<p class="project-detail-muted">Could not load messages.</p>';
    }
  }

  async function sendProjectChat(projectId) {
    const inp = $("project-chat-input");
    const btn = $("project-chat-send");
    const box = $("project-chat-messages");
    const text = (inp && inp.value || "").trim();
    if (!text || !box) return;
    if (!(await ensureSession())) return;
    appendChatLine(box, "user", text, null);
    if (inp) inp.value = "";
    if (btn) btn.disabled = true;
    try {
      const data = await apiCall("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text, project_id: projectId }),
      });
      if (data.reply != null && String(data.reply).trim() !== "") {
        appendChatLine(box, "assistant", data.reply, { options: data.options, action: data.action });
      } else if (data.pending_human) {
        const st = document.createElement("div");
        st.className = "chat-status";
        st.textContent = "Sent. Supi will reply soon.";
        box.appendChild(st);
        box.scrollTop = box.scrollHeight;
      }
    } catch (e) {
      appendChatLine(box, "assistant", "Error: " + (e.message || String(e)), null);
    }
    if (btn) btn.disabled = false;
  }

  /* ── Projects ── */
  async function loadProjects() {
    setFormFlash("project-list-flash", "", false);
    const container = $("projects-list");
    try {
      const { projects } = await apiCall("/api/projects");
      if (!projects?.length) { container.innerHTML = '<div class="projects-empty">No projects yet. Complete onboarding with a share link, pasted chat, or uploaded files.</div>'; return; }
      container.innerHTML = projects.map((p) => {
        const line = teaserOneLine(p.description || "");
        return (
          '<div class="project-card" data-id="' +
          escapeAttr(p.id) +
          '"><div class="project-card-title">' +
          escapeHtml(p.title) +
          '</div><div class="project-card-desc">' +
          escapeHtml(line || "\u2014") +
          '</div><div class="project-card-meta">' +
          projectStatusTextHtml(p) +
          "</div></div>"
        );
      }).join("");
      container.querySelectorAll(".project-card").forEach((c) => c.addEventListener("click", () => { if (c.dataset.id) loadProjectDetail(c.dataset.id); }));
    } catch (_) { container.innerHTML = '<div class="projects-empty">Could not load projects.</div>'; }
  }

  async function loadProjectDetail(id) {
    setFormFlash("project-list-flash", "", false);
    const container = $("projects-list");
    try {
      const { project } = await apiCall(`/api/projects/${id}`);
      var files = [];
      var filesLoadError = null;
      try {
        const fr = await apiCall(`/api/projects/${id}/files`);
        if (fr && fr.files) files = fr.files;
      } catch (fe) {
        filesLoadError = (fe && fe.message) || "Could not load files.";
      }
      if (filesLoadError) setFormFlash("project-list-flash", filesLoadError, true);

      var fileItems = files.length
        ? files
            .map(function (f) {
              var link =
                f.signed_url &&
                '<a href="' +
                  escapeAttr(f.signed_url) +
                  '" target="_blank" rel="noopener">' +
                  escapeHtml(f.filename) +
                  "</a>";
              var label = link || escapeHtml(f.filename);
              return (
                "<li>" +
                label +
                (f.bytes ? ' <span class="project-file-meta">' + formatBytes(f.bytes) + "</span>" : "") +
                "</li>"
              );
            })
            .join("")
        : '<li class="project-files-empty">No files yet.</li>';
      var filesHtml =
        '<section class="project-detail-section project-files-block"><h3 class="project-detail-h">Files</h3><ul class="project-files-list">' +
        fileItems +
        '</ul><p class="project-files-upload-hint">Images, PDF, and documents (max 20 MB each).</p><div class="project-files-upload-row">' +
        '<input type="file" id="project-detail-file-input" multiple ' +
        'accept="image/*,.pdf,.doc,.docx,.txt,.md,.markdown,.mdown,.csv,.tsv,.xlsx,.xls,.ppt,.pptx,.odt,.ods,.odp,.rtf,.html,.htm,.json,.xml,.heic" hidden />' +
        '<button type="button" class="btn-outline project-files-pick-btn" id="project-detail-file-btn">Add files</button></div></section>';

      var dateLine = formatProjectDate(project.created_at);
      var isCustomerProjectView = isBuyerWorkspace();
      var overview;
      if (isCustomerProjectView) {
        overview =
          '<section class="project-detail-section project-detail-overview"><h2 class="project-detail-title">' +
          escapeHtml(project.title) +
          "</h2>" +
          (dateLine ? '<p class="project-detail-date">' + escapeHtml(dateLine) + "</p>" : "") +
          "</section>";
      } else {
        overview =
          '<section class="project-detail-section project-detail-overview"><h2 class="project-detail-title">' +
          escapeHtml(project.title) +
          "</h2>" +
          (dateLine
            ? '<p class="project-detail-date">' + escapeHtml(dateLine) + "</p>"
            : "") +
          '<p class="project-detail-description">' +
          escapeHtml(project.description || "") +
          "</p>" +
          buildProjectPipelineStepper(project) +
          '<p class="project-detail-status-row">' + projectStatusTextHtml(project) + "</p></section>";
      }

      var inner =
        '<div class="project-detail" data-project-id="' +
        escapeAttr(id) +
        '">' +
        overview +
        buildRequirementsSection(project.requirements) +
        (isCustomerProjectView ? "" : buildAiSummarySection(project.ai_summary, project.requirements)) +
        buildMatchesSection(project.matches) +
        (isCustomerProjectView ? "" : buildBriefSection(project)) +
        '<section class="project-detail-section project-chatlink-block"><h3 class="project-detail-h">Add chat link</h3>' +
        '<p class="project-detail-muted">Grok, ChatGPT, or Claude share URL.</p>' +
        '<div class="project-chatlink-row"><input type="text" id="project-chatlink-label" class="settings-input project-chatlink-label" placeholder="Label" maxlength="120" />' +
        '<input type="url" id="project-chatlink-url" class="settings-input project-chatlink-url" placeholder="https://..." />' +
        '<button type="button" class="btn-primary" id="project-chatlink-save">Add link</button></div>' +
        '<p id="project-chatlink-msg" class="form-message" role="status" hidden></p></section>' +
        filesHtml +
        "</div>";

      container.innerHTML = inner;
      const fileIn = $("project-detail-file-input");
      const fileBtn = $("project-detail-file-btn");
      if (fileBtn && fileIn) {
        fileBtn.addEventListener("click", function () {
          fileIn.click();
        });
        fileIn.addEventListener("change", async function (ev) {
          var t = ev.target;
          var raw = t && t.files && t.files.length ? Array.prototype.slice.call(t.files, 0) : [];
          t.value = "";
          if (!raw.length) return;
          if (!(await ensureSession())) return;
          const up = await uploadFilesToProject(id, raw);
          if (up.err) {
            setFormFlash("project-list-flash", up.err, true);
            return;
          }
          if (up.filenames && up.filenames.length) {
            try {
              await apiCall("/api/projects/" + encodeURIComponent(id) + "/reingest-files", { method: "POST", body: "{}" });
            } catch (_) { /* register-file may have already ingested */ }
            loadProjectDetail(id);
          }
        });
      }
      $("project-chatlink-save")?.addEventListener("click", async function () {
        var urlIn = $("project-chatlink-url");
        var labIn = $("project-chatlink-label");
        var msgEl = $("project-chatlink-msg");
        var u = urlIn && (urlIn.value || "").trim();
        if (!u) {
          if (msgEl) { msgEl.hidden = false; msgEl.textContent = "Paste a share URL."; msgEl.style.color = "#d93025"; }
          return;
        }
        if (!(await ensureSession())) return;
        var lab = (labIn && (labIn.value || "").trim()) || "";
        if (msgEl) { msgEl.hidden = false; msgEl.textContent = "Importing\u2026"; msgEl.style.color = ""; }
        try {
          await apiCall("/api/projects/" + encodeURIComponent(id) + "/import-chat-link", {
            method: "POST",
            body: JSON.stringify({ url: u, label: lab || undefined }),
          });
          if (urlIn) urlIn.value = "";
          if (labIn) labIn.value = "";
          if (msgEl) { msgEl.textContent = "Saved."; msgEl.style.color = ""; setTimeout(function () { if (msgEl) msgEl.hidden = true; }, 3000); }
          loadProjectDetail(id);
        } catch (e) {
          if (msgEl) { msgEl.hidden = false; msgEl.textContent = (e && e.message) || "Import failed."; msgEl.style.color = "#d93025"; }
        }
      });
    } catch (err) {
      if (container) {
        container.innerHTML =
          '<div class="projects-empty">Could not load this project' +
          (err && err.message ? ": " + escapeHtml(err.message) : "") +
          ".</div>";
      }
    }
  }

  function formatBytes(n) {
    if (n == null || n < 0) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  /** One line for project cards: first sentence or ~160 chars. */
  function teaserOneLine(text) {
    var t = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) return "";
    var m = t.match(/^[\s\S]{1,500}?[.!?](?=\s|$)/);
    if (m && m[0].length >= 2) return m[0].trim();
    if (t.length <= 160) return t;
    return t.slice(0, 157) + "\u2026";
  }

  function formatProjectDate(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch (_) {
      return "";
    }
  }

  var PROJECT_REQ_LABELS = {
    quantity: "Quantity",
    timeline: "Timeline",
    budget: "Budget",
    materials: "Materials",
    quality_requirements: "Quality",
    product_type: "Product type",
    additional_notes: "Notes",
  };

  function humanizeKey(k) {
    if (PROJECT_REQ_LABELS[k]) return PROJECT_REQ_LABELS[k];
    return String(k || "")
      .replace(/_/g, " ")
      .replace(/^\w/, function (c) { return c.toUpperCase(); });
  }

  function buildRequirementsSection(req) {
    if (!req || typeof req !== "object") return "";
    var keys = Object.keys(req).filter(function (k) {
      var v = req[k];
      return v != null && String(v).trim() !== "";
    });
    if (!keys.length) return "";
    var rows = keys
      .map(function (k) {
        return (
          "<div class=\"project-detail-dl-row\"><dt>" +
          escapeHtml(humanizeKey(k)) +
          "</dt><dd>" +
          escapeHtml(String(req[k])) +
          "</dd></div>"
        );
      })
      .join("");
    return (
      '<section class="project-detail-section"><h3 class="project-detail-h">Requirements</h3><dl class="project-detail-dl">' +
      rows +
      "</dl></section>"
    );
  }

  function buildAiSummarySection(sum, requirements) {
    if (!sum || typeof sum !== "object") return "";
    var req = requirements && typeof requirements === "object" ? requirements : {};
    var parts = [];
    var kreq = sum.key_requirements;
    if (Array.isArray(kreq) && kreq.length) {
      parts.push(
        "<p class=\"project-detail-p\"><strong>Key requirements</strong></p><ul class=\"project-detail-ul\">" +
          kreq
            .map(function (x) {
              return "<li>" + escapeHtml(String(x)) + "</li>";
            })
            .join("") +
          "</ul>"
      );
    }
    if (sum.ideal_factory_profile && String(sum.ideal_factory_profile).trim()) {
      parts.push(
        "<p class=\"project-detail-p\"><strong>Ideal factory profile</strong> " +
          escapeHtml(String(sum.ideal_factory_profile)) +
          "</p>"
      );
    }
    if (sum.readiness && String(sum.readiness).trim()) {
      parts.push(
        "<p class=\"project-detail-p\"><strong>Readiness</strong> " + escapeHtml(String(sum.readiness)) + "</p>"
      );
    }
    function addIfExtra(key, label) {
      var v = sum[key];
      if (v == null || !String(v).trim()) return;
      if (req[key] != null && String(req[key]) === String(v)) return;
      parts.push(
        "<p class=\"project-detail-p\"><strong>" + escapeHtml(label) + "</strong> " + escapeHtml(String(v)) + "</p>"
      );
    }
    addIfExtra("product", "Product");
    addIfExtra("quantity", "Quantity");
    addIfExtra("timeline", "Timeline");
    addIfExtra("budget", "Budget");
    if (!parts.length) return "";
    return (
      '<section class="project-detail-section"><h3 class="project-detail-h">AI summary</h3><div class="project-detail-ai">' +
        parts.join("") +
        "</div></section>"
    );
  }

  function buildMatchesSection(matches) {
    if (!Array.isArray(matches) || !matches.length) return "";
    var rows = matches
      .map(function (m) {
        var f = m.factories;
        var fn = f && f.name ? f.name : "Factory";
        var st = m.status ? String(m.status).replace(/_/g, " ") : "";
        return (
          "<li><span class=\"project-match-factory\">" +
          escapeHtml(fn) +
          "</span> <span class=\"project-card-badge badge--" +
          (m.status || "pending") +
          "\">" +
          escapeHtml(st) +
          "</span></li>"
        );
      })
      .join("");
    return (
      '<section class="project-detail-section"><h3 class="project-detail-h">Matches</h3><ul class="project-detail-ul project-detail-matches">' +
        rows +
        "</ul></section>"
    );
  }

  function buildBriefSection(project) {
    var src = project.brief_source_type;
    var url = project.brief_source_url;
    var raw = project.brief_raw;
    if (!src && !url && !raw) return "";
    var bits = [];
    if (src) bits.push("<p class=\"project-detail-p\"><strong>Source</strong> " + escapeHtml(String(src)) + "</p>");
    if (url)
      bits.push(
        "<p class=\"project-detail-p\"><a href=\"" +
          escapeAttr(url) +
          "\" target=\"_blank\" rel=\"noopener\">" +
          escapeHtml(url) +
          "</a></p>"
      );
    if (raw && String(raw).trim()) {
      bits.push(
        "<details class=\"project-brief-details\"><summary>Imported conversation text</summary><pre class=\"project-brief-raw\">" +
          escapeHtml(String(raw)) +
          "</pre></details>"
      );
    }
    return (
      '<section class="project-detail-section"><h3 class="project-detail-h">Brief import</h3><div class="project-brief-block">' +
        bits.join("") +
        "</div></section>"
    );
  }

  /* ══════════════════════════════════════
     CONNECTIONS
     ══════════════════════════════════════ */
  function markSupiRead() {
    try {
      localStorage.setItem("airsup_supi_last_read", new Date().toISOString());
    } catch (_) {}
  }

  function getSupiLastRead() {
    try {
      return localStorage.getItem("airsup_supi_last_read");
    } catch (_) {
      return null;
    }
  }

  async function refreshConnectionsNavBadge() {
    const badge = $("nav-connections-badge");
    if (!badge || userRole === "supplier") return;
    try {
      const { messages } = await apiCall("/api/chat/history?supi_thread=1");
      const lastRead = getSupiLastRead();
      const lastReadTs = lastRead ? new Date(lastRead).getTime() : 0;
      const unread = (messages || []).some(function (m) {
        if (m.role !== "assistant") return false;
        return new Date(m.created_at).getTime() > lastReadTs;
      });
      badge.hidden = !unread;
    } catch (_) {
      badge.hidden = true;
    }
  }

  async function openSupiConnectionChat() {
    activeConnectionMatchId = SUPI_THREAD_ID;
    const chatWrap = $("connection-chat-wrap");
    if (!chatWrap) return;
    chatWrap.classList.add("conn-chat-wrap--supi");
    const avatarEl = $("conn-chat-header-avatar");
    if (avatarEl) { avatarEl.src = "assets/brand/logo-air-sup.png"; avatarEl.style.visibility = ""; }
    if ($("conn-chat-title")) $("conn-chat-title").textContent = "Supi";
    if ($("conn-chat-input")) $("conn-chat-input").placeholder = "Message Supi…";
    const filesEl = $("conn-chat-files");
    if (filesEl) { filesEl.hidden = true; filesEl.innerHTML = ""; }
    const msgContainer = $("conn-chat-messages");
    msgContainer.innerHTML = '<div class="chat-status">Loading…</div>';
    try {
      const { messages } = await apiCall("/api/chat/history?supi_thread=1");
      msgContainer.innerHTML = "";
      if ((messages || []).length) {
        messages.forEach(function (m) {
          appendChatLine(msgContainer, m.role, m.content, m.metadata);
        });
      } else {
        appendChatLine(msgContainer, "assistant", "Got any questions about your projects or the platform? I’m here to help.", { supi: true });
      }
      markSupiRead();
    } catch (_) {
      msgContainer.innerHTML = '<div class="chat-status">Could not load messages.</div>';
    }
    void refreshConnectionsNavBadge();
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  async function loadConnections() {
    const container = $("connections-list");
    activeConnectionMatchId = null;

    try {
      const { matches } = await apiCall("/api/matches");
      const matchRows = (matches && matches.length)
        ? matches.map((m) => {
            const f = m.factories, p = m.projects, ctx = m.context_summary || {};
            const initial = (f?.name || "F").charAt(0).toUpperCase();
            const sub = p?.title ? "Project: " + (p.title.length > 28 ? p.title.slice(0, 28) + "…" : p.title) : ctx.short || "Connection established";
            return (
              '<div class="conn-item" data-match-id="' + escapeAttr(m.id) + '" role="button" tabindex="0">' +
              '<div class="conn-item-avatar-initial">' + escapeHtml(initial) + '</div>' +
              '<div class="conn-item-info">' +
              '<div class="conn-item-name">' + escapeHtml(f?.name || "Factory") + '</div>' +
              '<div class="conn-item-sub">' + escapeHtml(sub) + '</div>' +
              '</div></div>'
            );
          })
        : [];

      var supiItem = "";
      var supiUnread = false;
      if (userRole !== "supplier") {
        try {
          const sm = await apiCall("/api/chat/history?supi_thread=1");
          const lastReadTs = getSupiLastRead() ? new Date(getSupiLastRead()).getTime() : 0;
          supiUnread = (sm.messages || []).some(function (m) {
            return m.role === "assistant" && new Date(m.created_at).getTime() > lastReadTs;
          });
        } catch (_) {}
        supiItem =
          '<div class="conn-item conn-item--active" data-supi="1" role="button" tabindex="0">' +
          '<img class="conn-item-avatar" src="assets/brand/logo-air-sup.png" alt="" loading="lazy" />' +
          '<div class="conn-item-info">' +
          '<div class="conn-item-name">Supi</div>' +
          '<div class="conn-item-sub">Working at Airsup</div>' +
          '</div>' +
          (supiUnread ? '<div class="conn-item-unread-dot" aria-label="New message"></div>' : '') +
          '</div>';
      }

      container.innerHTML = (supiItem || "") + matchRows.join("");

      container.onclick = (e) => {
        const item = e.target.closest(".conn-item");
        if (!item) return;
        container.querySelectorAll(".conn-item--active").forEach((el) => el.classList.remove("conn-item--active"));
        item.classList.add("conn-item--active");
        if (item.getAttribute("data-supi") === "1") void openSupiConnectionChat();
        else {
          const matchId = item.getAttribute("data-match-id");
          if (matchId) void openConnectionChat(matchId, item);
        }
      };

      void refreshConnectionsNavBadge();
    } catch (_) {
      container.innerHTML = '<div class="connections-empty">Could not load connections.</div>';
    }
    if (userRole !== "supplier") void openSupiConnectionChat();
  }

  async function openConnectionChat(matchId, cardEl) {
    activeConnectionMatchId = matchId;
    const chatWrap = $("connection-chat-wrap");
    if (!chatWrap) return;
    chatWrap.classList.remove("conn-chat-wrap--supi");
    if ($("conn-chat-input")) $("conn-chat-input").placeholder = "Message the engineer…";

    const factoryName = cardEl?.querySelector(".conn-item-name")?.textContent || "Factory";
    const avatarEl = $("conn-chat-header-avatar");
    if (avatarEl) { avatarEl.src = ""; avatarEl.style.visibility = "hidden"; }
    if ($("conn-chat-title")) $("conn-chat-title").textContent = factoryName;

    const msgContainer = $("conn-chat-messages");
    const filesEl = $("conn-chat-files");
    if (filesEl) { filesEl.hidden = true; filesEl.innerHTML = ""; }
    msgContainer.innerHTML = '<div class="chat-status">Loading messages…</div>';

    try {
      const { messages } = await apiCall(`/api/connections/${matchId}/messages`);
      msgContainer.innerHTML = "";
      if (messages?.length) {
        messages.forEach((m) => {
          const isMe = m.sender_id === currentUser.id;
          const div = document.createElement("div");
          div.className = `chat-bubble chat-bubble--${isMe ? "user" : "assistant"}`;
          div.textContent = m.content;
          msgContainer.appendChild(div);
        });
      } else {
        msgContainer.innerHTML = '<div class="chat-status">No messages yet. Say hello to the engineer!</div>';
      }
      msgContainer.scrollTop = msgContainer.scrollHeight;
    } catch (err) {
      msgContainer.innerHTML = '<div class="chat-status">Could not load messages.</div>';
    }

    try {
      const { files } = await apiCall(`/api/matches/${matchId}/files`);
      if (filesEl && files?.length) {
        filesEl.hidden = false;
        filesEl.innerHTML =
          '<div class="conn-chat-files-label">Project files</div><ul class="conn-chat-files-list">' +
          files
            .map(function (f) {
              const url = f.signed_url || "#";
              return (
                "<li><a href=\"" +
                escapeAttr(url) +
                "\" target=\"_blank\" rel=\"noopener\">" +
                escapeHtml(f.filename) +
                "</a>" +
                (f.bytes ? " <span class=\"conn-chat-file-meta\">" + formatBytes(f.bytes) + "</span>" : "") +
                "</li>"
              );
            })
            .join("") +
          "</ul>";
      }
    } catch (_) {
      if (filesEl) { filesEl.hidden = true; filesEl.innerHTML = ""; }
    }
  }

  function closeConnectionChat() {
    activeConnectionMatchId = null;
    const filesEl = $("conn-chat-files");
    if (filesEl) { filesEl.hidden = true; filesEl.innerHTML = ""; }
    const chatWrap = $("connection-chat-wrap");
    if (chatWrap) chatWrap.classList.remove("conn-chat-wrap--supi");
    const list = $("connections-list");
    list?.querySelectorAll(".conn-item--active").forEach((el) => el.classList.remove("conn-item--active"));
  }

  async function sendConnectionMessage() {
    if (!activeConnectionMatchId) return;
    const input = $("conn-chat-input");
    const text = input.value.trim();
    if (!text) return;
    if (!(await ensureSession())) return;

    input.value = "";
    input.style.height = "auto";

    const msgContainer = $("conn-chat-messages");
    const statusEls = msgContainer.querySelectorAll(".chat-status");
    statusEls.forEach((el) => el.remove());

    const div = document.createElement("div");
    div.className = "chat-bubble chat-bubble--user";
    div.textContent = text;
    msgContainer.appendChild(div);
    msgContainer.scrollTop = msgContainer.scrollHeight;

    try {
      if (activeConnectionMatchId === SUPI_THREAD_ID) {
        const data = await apiCall("/api/chat", {
          method: "POST",
          body: JSON.stringify({ message: text, supi_thread: true }),
        });
        return;
      }
      await apiCall(`/api/connections/${activeConnectionMatchId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: text }),
      });
    } catch (err) {
      const errDiv = document.createElement("div");
      errDiv.className = "chat-status";
      errDiv.textContent = "Failed to send message.";
      msgContainer.appendChild(errDiv);
    }
  }

  /* ══════════════════════════════════════
     VISIT (factory day plans)
     ══════════════════════════════════════ */
  async function loadVisit() {
    const form = $("visit-plan-form");
    const msg = $("visit-plan-message");
    if (msg) {
      msg.hidden = true;
      msg.textContent = "";
    }
    if (!(await ensureSession())) return;
    try {
      const { matches } = await apiCall("/api/matches");
      visitsMatchesCache = matches || [];
      renderVisitsForm();
    } catch (_) {
      if (form) form.innerHTML = '<p class="projects-empty">Could not load connections.</p>';
    }
    await loadVisitPlans();
  }

  function renderVisitsForm() {
    const form = $("visit-plan-form");
    if (!form) return;
    const rows = (visitsMatchesCache || []).filter((m) => m.status !== "cancelled" && m.status !== "disputed");
    if (!rows.length) {
      form.innerHTML =
        '<p class="projects-empty">We connect you right now with suppliers. As soon as you are connected you will see a visit plan in here.</p>';
      return;
    }
    form.innerHTML =
      '<h2 class="section-title">Plan a trip</h2><p class="section-sub">Choose which connections to visit, then pick the first travel day.</p>' +
      '<div class="visit-match-grid">' +
      rows
        .map((m) => {
          const f = m.factories;
          const p = m.projects;
          return (
            '<label class="visit-match-row"><input type="checkbox" name="visit-m" value="' +
            escapeAttr(m.id) +
            '" /> <span class="visit-match-label"><strong>' +
            escapeHtml(f && f.name ? f.name : "Factory") +
            "</strong> · " +
            escapeHtml(p && p.title ? p.title : "") +
            "</span></label>"
          );
        })
        .join("") +
      '</div><div class="visit-date-row">' +
      '<label class="visit-date-label">Start date <input type="date" id="visit-start-date" class="settings-input visit-date-input" /></label> ' +
      '<button type="button" class="btn-primary" id="visit-plan-submit">Create plan</button></div>';
    const start = $("visit-start-date");
    if (start) {
      const t = new Date();
      t.setDate(t.getDate() + 1);
      start.value = t.toISOString().split("T")[0];
    }
    $("visit-plan-submit")?.addEventListener("click", submitVisitPlan);
  }

  async function submitVisitPlan() {
    const msg = $("visit-plan-message");
    const checked = Array.from(document.querySelectorAll('input[name="visit-m"]:checked')).map((el) => el.value);
    const startEl = $("visit-start-date");
    const start = startEl && startEl.value;
    if (!checked.length) {
      if (msg) {
        msg.hidden = false;
        msg.textContent = "Select at least one connection.";
      }
      return;
    }
    if (!start) {
      if (msg) {
        msg.hidden = false;
        msg.textContent = "Pick a start date.";
      }
      return;
    }
    if (!(await ensureSession())) return;
    if (msg) {
      msg.hidden = false;
      msg.textContent = "Planning…";
    }
    try {
      const data = await apiCall("/api/visits/plan", {
        method: "POST",
        body: JSON.stringify({ match_ids: checked, start_date: start }),
      });
      const warn = (data.warnings && data.warnings.length ? data.warnings.join(" ") + " " : "") + "Plan saved.";
      if (msg) msg.textContent = warn.trim();
      await loadVisitPlans();
    } catch (e) {
      if (msg) {
        msg.hidden = false;
        msg.textContent = e && e.message ? e.message : "Planning failed.";
      }
    }
  }

  function visitStopStatusClass(st) {
    const k = (st && String(st)) || "draft";
    if (k === "pending_supplier") return "status-await";
    if (k === "counter_proposed") return "status-counter";
    if (k === "confirmed") return "status-ok";
    if (k === "declined") return "status-bad";
    return "status-draft";
  }
  function visitStopStatusLabel(st) {
    const k = (st && String(st)) || "draft";
    var map = { draft: "Draft", pending_supplier: "Awaiting factory", counter_proposed: "Factory counter", confirmed: "Confirmed", declined: "Declined" };
    return map[k] || k;
  }

  async function loadVisitPlans() {
    const cal = $("visit-calendar");
    if (!cal) return;
    try {
      const data = await apiCall("/api/visits");
      var confirmed = data.confirmed_plans || data.plans || [];
      var pending = data.pending_plans || [];
      if (data.plans && !data.confirmed_plans) {
        confirmed = (data.plans || []).filter(function (p) {
          var st = p.visit_stops || [];
          if (!st.length) return false;
          return st.every(function (s) { return s.confirmation_status === "confirmed"; });
        });
        pending = (data.plans || []).filter(function (p) {
          var st = p.visit_stops || [];
          if (!st.length) return true;
          return st.some(function (s) { return s.confirmation_status !== "confirmed"; });
        });
      }
      if ((!confirmed || !confirmed.length) && (!pending || !pending.length)) {
        cal.innerHTML = '<p class="projects-empty visit-empty-hint">No visit days planned yet. Use the form above to create one.</p>';
        return;
      }
      const chunks = [];
      if (pending && pending.length) {
        chunks.push(
          "<h2 class=\"visit-section-h\">Awaiting factory</h2><p class=\"visit-section-hint\">These visits are not on your main calendar until the factory confirms.</p><div class=\"visit-plan-stack\">" +
            pending.map(function (p) { return renderVisitPlanCard(p, "pending"); }).join("") +
            "</div>"
        );
      }
      if (confirmed && confirmed.length) {
        chunks.push(
          "<h2 class=\"visit-section-h visit-section-h--confirmed\">Confirmed on your calendar</h2><div class=\"visit-plan-stack\">" +
            confirmed.map(function (p) { return renderVisitPlanCard(p, "confirmed"); }).join("") +
            "</div>"
        );
      }
      cal.innerHTML = chunks.join("");
      cal.querySelectorAll("[data-visit-delete]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var id = btn.getAttribute("data-visit-delete");
          if (!id || !(await ensureSession())) return;
          try {
            await apiCall("/api/visits/" + encodeURIComponent(id), { method: "DELETE" });
            setFormFlash("visit-plan-message", "Visit day removed.", false, 4000);
            await loadVisitPlans();
          } catch (e) {
            setFormFlash("visit-plan-message", e && e.message ? e.message : "Delete failed.", true);
          }
        });
      });
      cal.querySelectorAll("[data-visit-propose]").forEach(function (btn) {
        btn.addEventListener("click", function () { loadVisitProposalDrafts(btn.getAttribute("data-visit-propose")); });
      });
      cal.querySelectorAll("[data-visit-save-feedback]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var planId = btn.getAttribute("data-visit-save-feedback");
          var ta = planId && document.getElementById("visit-rf-" + planId);
          if (!ta || !planId || !(await ensureSession())) return;
          var mark = cal.querySelector("[data-visit-feedback-saved=\"" + planId + "\"]");
          if (mark) { mark.classList.add("is-saving"); }
          try {
            await apiCall("/api/visits/" + encodeURIComponent(planId) + "/route-feedback", {
              method: "PATCH",
              body: JSON.stringify({ feedback: (ta).value || "" }),
            });
            if (mark) { mark.hidden = false; mark.classList.remove("is-saving"); }
          } catch (e) {
            if (mark) { mark.classList.remove("is-saving"); }
            setFormFlash("visit-plan-message", e && e.message ? e.message : "Save failed.", true);
          }
        });
      });
      cal.querySelectorAll("[data-visit-submit-confirm]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var id = btn.getAttribute("data-visit-submit-confirm");
          if (!id || !(await ensureSession())) return;
          var prev = (btn).textContent;
          (btn).disabled = true;
          (btn).textContent = "Sending…";
          try {
            await apiCall("/api/visits/" + encodeURIComponent(id) + "/submit-confirmation", { method: "POST", body: "{}" });
            await loadVisitPlans();
          } catch (e) {
            setFormFlash("visit-plan-message", e && e.message ? e.message : "Could not send.", true);
            (btn).textContent = prev;
            (btn).disabled = false;
          }
        });
      });
      cal.querySelectorAll("[data-visit-buyer-confirm-stop]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var sid = btn.getAttribute("data-visit-buyer-confirm-stop");
          if (!sid || !(await ensureSession())) return;
          try {
            await apiCall("/api/visits/stops/" + encodeURIComponent(sid) + "/buyer-confirm-counter", { method: "POST", body: "{}" });
            await loadVisitPlans();
          } catch (e) {
            setFormFlash("visit-plan-message", e && e.message ? e.message : "Could not confirm.", true);
          }
        });
      });
    } catch (e) {
      console.error("loadVisitPlans failed", e);
      cal.innerHTML = "";
    }
  }

  function renderVisitPlanCard(p, section) {
    section = section || "pending";
    const route = p.route || {};
    const details = route.stop_details || [];
    const detailByFid = {};
    details.forEach(function (d) {
      if (d && typeof d.factory_id === "number") detailByFid[d.factory_id] = d;
    });
    const stops = p.visit_stops || [];
    const hasDraft = stops.some(function (s) { return (s.confirmation_status || "draft") === "draft"; });
    const mapUrl = p.map_static_url && typeof p.map_static_url === "string" ? p.map_static_url : null;
    const tableRows = stops
      .map(function (s) {
        const fac = s.factories;
        const det = detailByFid[s.factory_id];
        const zh = det && det.location_zh ? det.location_zh : fac && fac.location ? fac.location : "";
        const reason = det && det.project_title ? det.project_title : "";
        const time = s.scheduled_time || "";
        const note = s.notes ? String(s.notes) : "";
        const cst = s.confirmation_status || "draft";
        const bcls = visitStopStatusClass(cst);
        const blab = visitStopStatusLabel(cst);
        const counter = cst === "counter_proposed" && s.supplier_proposed_time
          ? '<div class="visit-schedule-note">' + escapeHtml("Factory suggests: " + s.supplier_proposed_time) + (s.supplier_counter_message ? " · " + escapeHtml(String(s.supplier_counter_message)) : "") + "</div>"
          : "";
        const buyerAct =
          section === "pending" && cst === "counter_proposed"
            ? '<div class="visit-stop-confirm"><button type="button" class="btn-primary btn-sm" data-visit-buyer-confirm-stop="' + escapeAttr(s.id) + '">Add to calendar (use factory time)</button></div>'
            : "";
        return (
          "<tr><td class=\"visit-schedule-time\">" +
          escapeHtml(time) +
          '<span class="visit-stop-badge ' + bcls + '">' + escapeHtml(blab) + "</span></td><td class=\"visit-schedule-main\"><div class=\"visit-schedule-factory\">" +
          escapeHtml(fac && fac.name ? fac.name : "Factory") +
          "</div>" +
          (reason ? '<div class="visit-schedule-project">' + escapeHtml(reason) + "</div>" : "") +
          (note ? '<div class="visit-schedule-note">' + escapeHtml(note) + "</div>" : "") +
          counter +
          '<div class="visit-schedule-addr" lang="zh">' +
          escapeHtml(zh) +
          "</div>" +
          buyerAct +
          "</td></tr>"
        );
      })
      .join("");
    const linkList = stops
      .map(function (s) {
        const det = detailByFid[s.factory_id];
        const fac = s.factories;
        const amap = det && det.amap_url ? det.amap_url : null;
        if (!amap) return "";
        return (
          '<li><a class="visit-map-link" href="' +
          escapeAttr(amap) +
          '" target="_blank" rel="noopener">' +
          escapeHtml(fac && fac.name ? fac.name : "Open in 高德") +
          "</a></li>"
        );
      })
      .filter(Boolean)
      .join("");
    const mapBlock = mapUrl
      ? '<div class="visit-day-map visit-day-map--image"><img class="visit-static-map" src="' +
        escapeAttr(mapUrl) +
        '" width="520" height="400" alt="Route map" loading="lazy" decoding="async" /></div>'
      : '<div class="visit-day-map visit-day-map--fallback"><p class="visit-map-fallback-p">Map preview needs saved coordinates and Amap key on the server. Open each stop in 高德 below.</p>' +
        (linkList ? "<ul class=\"visit-map-fallback-list\">" + linkList + "</ul>" : "") +
        "</div>";
    const rf = p.route_feedback != null ? String(p.route_feedback) : "";
    const showSaved = !!p.route_feedback_at;
    const sendBlock =
      section === "pending" && hasDraft
        ? '<div class="visit-submit-factory"><p class="visit-submit-factory-p">Sends a bilingual request to the factory in your connection chat and sets visits to “awaiting factory.”</p><button type="button" class="btn-primary btn-sm" data-visit-submit-confirm="' +
          escapeAttr(p.id) +
          '">Send to factory for confirmation</button></div>'
        : "";
    return (
      '<article class="visit-day-card" data-visit-plan-id="' +
      escapeAttr(p.id) +
      '"><div class="visit-day-head"><h2 class="visit-day-title">' +
      escapeHtml(p.travel_date) +
      " &mdash; " +
      escapeHtml(p.region || "Region TBD") +
      '</h2><div class="visit-day-actions"><button type="button" class="btn-outline btn-sm" data-visit-propose="' +
      escapeAttr(p.id) +
      '">Draft chat messages</button> <button type="button" class="btn-outline btn-sm btn-danger-outline" data-visit-delete="' +
      escapeAttr(p.id) +
      '">Delete</button></div></div><div class="visit-day-split"><div class="visit-day-schedule"><table class="visit-schedule-table" aria-label="Visit schedule"><thead><tr><th scope="col">Time</th><th scope="col">Factory / details</th></tr></thead><tbody>' +
      (tableRows || '<tr><td colspan="2" class="visit-schedule-empty">No stops</td></tr>') +
      "</tbody></table></div>" +
      mapBlock +
      "</div>" +
      '<div class="visit-route-feedback"><label for="visit-rf-' + escapeAttr(p.id) + '" class="visit-route-feedback-label">Route feedback (optional)</label><textarea id="visit-rf-' + escapeAttr(p.id) + '" class="visit-route-feedback-ta" rows="2" placeholder="Anything we should change about this route—saves to your team; no auto-replan.">' + escapeHtml(rf) + '</textarea><div class="visit-route-feedback-bar"><button type="button" class="btn-outline btn-sm" data-visit-save-feedback="' + escapeAttr(p.id) + '">Save note</button> <span class="visit-route-feedback-saved" data-visit-feedback-saved="' + escapeAttr(p.id) + '" ' + (showSaved ? "" : "hidden") + " aria-live=\"polite\">✓ Saved</span></div></div>" +
      sendBlock +
      '<div class="visit-drafts-host" id="visit-drafts-' +
      escapeAttr(p.id) +
      '" hidden></div></article>'
    );
  }

  async function loadVisitProposalDrafts(planId) {
    if (!planId || !(await ensureSession())) return;
    const host = document.getElementById("visit-drafts-" + planId);
    if (!host) return;
    host.hidden = false;
    host.innerHTML = '<p class="visit-drafts-loading">Drafting messages…</p>';
    try {
      const data = await apiCall("/api/visits/" + encodeURIComponent(planId) + "/propose-messages", {
        method: "POST",
        body: "{}",
      });
      const drafts = data.drafts || [];
      if (!drafts.length) {
        host.innerHTML = '<p class="visit-drafts-empty">No drafts.</p>';
        return;
      }
      host.innerHTML =
        '<h3 class="visit-drafts-h">Message drafts (review before sending in Connections)</h3><div class="visit-drafts-list">' +
        drafts
          .map((d) => {
            const combined = (d.en || "") + "\n\n" + (d.zh || "");
            const bid = "vdraft-" + planId + "-" + d.match_id;
            return (
              '<div class="visit-draft"><div class="visit-draft-title">' +
              escapeHtml(d.factory_name) +
              " · " +
              escapeHtml(d.scheduled_time || "") +
              '</div><textarea class="visit-draft-text" id="' +
              bid +
              '" rows="5" readonly>' +
              escapeHtml(combined) +
              '</textarea><div class="visit-draft-actions"><button type="button" class="btn-outline btn-sm" data-copy-target="' +
              bid +
              '">Copy</button></div></div>'
            );
          })
          .join("") +
        "</div>";
      host.querySelectorAll("[data-copy-target]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-copy-target");
          const el = id && document.getElementById(id);
          if (el && el.value) {
            void navigator.clipboard.writeText(el.value);
          }
        });
      });
    } catch (e) {
      host.innerHTML = '<p class="visit-drafts-error">' + escapeHtml((e && e.message) || "Failed to draft messages.") + "</p>";
    }
  }

  /* ── Supplier Dashboard ── */
  async function loadSupplierDashboard() {
    if (!supabaseClient || !currentUser) return;
    setFormFlash("supplier-dash-flash", "", false);
    const stats = $("supplier-stats");
    const briefs = $("supplier-briefs");
    const active = $("supplier-active");

    const { data: factory } = await supabaseClient.from("factories").select("id").eq("user_id", currentUser.id).maybeSingle();
    if (!factory) {
      if (stats) stats.innerHTML = "";
      if (briefs) briefs.innerHTML = '<div class="projects-empty">Set up your factory profile first.</div>';
      if (active) active.innerHTML = "";
      return;
    }

    const { data: outreach } = await supabaseClient
      .from("outreach_logs")
      .select("id, stage, outcome, factory_searches(projects(title, description, status, requirements))")
      .eq("factory_id", factory.id)
      .order("created_at", { ascending: false })
      .limit(20);
    const { data: matches } = await supabaseClient.from("matches").select("id, status, quote, context_summary, projects(title, description)").eq("factory_id", factory.id).order("created_at", { ascending: false }).limit(20);

    const briefCount = (outreach || []).filter((o) =>
      ["briefed", "negotiating", "await_supplier", "quoted"].includes(o.stage)
    ).length;
    const activeCount = (matches || []).filter((m) => m.status !== "cancelled").length;

    if (stats) stats.innerHTML = `<div class="stat-card"><div class="stat-value">${briefCount}</div><div class="stat-label">Incoming briefs</div></div><div class="stat-card"><div class="stat-value">${activeCount}</div><div class="stat-label">Active projects</div></div><div class="stat-card"><div class="stat-value">0</div><div class="stat-label">Completed</div></div>`;

    if (briefs) {
      if (!outreach?.length) { briefs.innerHTML = '<div class="projects-empty">No incoming briefs yet. Our AI will send matching projects as buyers describe them.</div>'; }
      else {
        briefs.innerHTML = outreach.map((o) => {
          const proj = o.factory_searches?.projects;
          const stageClass = String(o.stage || "").replace(/[^a-zA-Z0-9_-]/g, "_");
          const actions =
            o.stage === "await_supplier"
              ? `<div class="supplier-brief-actions"><button type="button" class="btn-primary supplier-accept-btn" data-outreach-id="${escapeAttr(o.id)}">Accept brief</button><button type="button" class="btn-secondary supplier-decline-btn" data-outreach-id="${escapeAttr(o.id)}">Decline</button></div>`
              : o.stage === "briefed" || o.stage === "negotiating"
                ? `<div class="supplier-brief-actions"><button type="button" class="btn-secondary supplier-decline-btn" data-outreach-id="${escapeAttr(o.id)}">Decline brief</button></div>`
                : "";
          var reqLine = summarizeProjectRequirements(proj?.requirements);
          var descPart = proj?.description ? String(proj.description).slice(0, 260) : "";
          var outcomePart = o.outcome || "";
          var bodyText = [descPart, outcomePart].filter(Boolean).join("\n\n");
          if (!bodyText && !reqLine) bodyText = "No project details yet.";
          var reqsHtml = reqLine ? `<div class="project-card-reqs">${escapeHtml(reqLine)}</div>` : "";
          return `<div class="project-card"><div class="project-card-title">${escapeHtml(proj?.title || "Untitled project")}</div><div class="project-card-desc">${escapeHtml(bodyText)}</div>${reqsHtml}<div class="project-card-meta"><span class="project-card-badge badge--${stageClass}">${escapeHtml(formatOutreachStage(o.stage))}</span></div>${actions}</div>`;
        }).join("");
        briefs.querySelectorAll(".supplier-accept-btn").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const id = btn.getAttribute("data-outreach-id");
            if (!id) return;
            try {
              await apiCall(`/api/outreach/${id}/accept`, { method: "POST", body: "{}" });
              await loadSupplierDashboard();
            } catch (e) {
              setFormFlash("supplier-dash-flash", e.message || "Could not accept brief.", true);
            }
          });
        });
        briefs.querySelectorAll(".supplier-decline-btn").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const id = btn.getAttribute("data-outreach-id");
            if (!id) return;
            try {
              await apiCall(`/api/outreach/${id}/decline`, { method: "POST", body: "{}" });
              await loadSupplierDashboard();
            } catch (e) {
              setFormFlash("supplier-dash-flash", e.message || "Could not decline brief.", true);
            }
          });
        });
      }
    }

    if (active) {
      if (!matches?.length) { active.innerHTML = '<div class="projects-empty">No active projects yet.</div>'; }
      else {
        active.innerHTML = matches.map((m) => {
          const p = m.projects;
          const q = m.quote || {};
          return `<div class="connection-card connection-card--clickable" data-match-id="${m.id}"><div class="connection-header"><div class="connection-header-left"><span class="connection-factory">${escapeHtml(p?.title || "Project")}</span></div><span class="project-card-badge badge--${m.status}">${escapeHtml(formatMatchStatusLabel(m.status))}</span></div><div class="connection-summary-bar">${escapeHtml(m.context_summary?.short || p?.description || "")}</div>${q.unit_price ? `<div class="connection-body"><div class="connection-quote">${escapeHtml(q.unit_price)}/unit</div></div>` : ""}</div>`;
        }).join("");
        active.querySelectorAll(".connection-card--clickable").forEach((card) => {
          card.addEventListener("click", () => {
            const matchId = card.dataset.matchId;
            if (matchId) {
              setView("connections");
              setTimeout(() => openConnectionChat(matchId, card), 100);
            }
          });
        });
      }
    }

    const visitC = $("supplier-visit-confirm");
    if (visitC) {
      try {
        const res = await apiCall("/api/visits/supplier/pending");
        const items = (res && res.items) || [];
        if (!items.length) {
          visitC.innerHTML = '<div class="projects-empty">No visit times waiting for you.</div>';
        } else {
          visitC.innerHTML = items
            .map((row) => {
              const m = row.visit_plans;
              const planDate = m?.travel_date || "—";
              const region = m?.region || "";
              const fac = row.factories;
              const fName = (fac && (Array.isArray(fac) ? fac[0] : fac)?.name) || "Factory";
              const mrow = row.matches;
              const proj = mrow && (Array.isArray(mrow) ? mrow[0] : mrow)?.projects;
              const pTitle = (proj && (Array.isArray(proj) ? proj[0] : proj)?.title) || "Project";
              const t = row.scheduled_time || "—";
              const st = row.confirmation_status || "";
              const isCounter = st === "counter_proposed";
              const altT = isCounter && row.supplier_proposed_time ? row.supplier_proposed_time : "";
              return (
                `<div class="supplier-visit-card" data-visit-stop-id="${escapeAttr(row.id)}">` +
                '<div class="supplier-visit-card-h">' + escapeHtml(fName) + " · " + escapeHtml(pTitle) + "</div>" +
                '<p class="supplier-visit-date">' + escapeHtml(planDate) + (region ? " — " + escapeHtml(region) : "") + " · " + (isCounter ? "Counter-proposed" : "Awaiting you") + "</p>" +
                (isCounter && altT ? '<p class="supplier-visit-alt">' + escapeHtml("You suggested: " + altT) + "</p>" : "") +
                (!isCounter
                  ? '<p class="supplier-visit-ask">Proposed time: <strong>' + escapeHtml(t) + "</strong></p>" +
                    '<div class="supplier-visit-row"><button type="button" class="btn-primary btn-sm" data-sv-accept>Accept this time</button></div>' +
                    '<div class="supplier-visit-suggest"><label>Or suggest a different time</label>' +
                    '<input type="text" class="settings-input" data-sv-ptime placeholder="e.g. 14:30 or Apr 28 afternoon" value="" />' +
                    '<textarea class="settings-input" rows="2" data-sv-pmsg placeholder="Optional message to the buyer"></textarea>' +
                    '<button type="button" class="btn-outline btn-sm" data-sv-counter>Send counter-proposal</button></div>'
                  : '<p class="supplier-visit-pending">Waiting for the buyer to confirm your suggested time.</p>') +
                "</div>"
              );
            })
            .join("");
          visitC.querySelectorAll("[data-sv-accept]").forEach((b) => {
            b.addEventListener("click", async () => {
              const card = b.closest(".supplier-visit-card");
              const id = card && card.getAttribute("data-visit-stop-id");
              if (!id) return;
              try {
                await apiCall("/api/visits/stops/" + encodeURIComponent(id) + "/supplier-accept", { method: "POST", body: "{}" });
                await loadSupplierDashboard();
              } catch (e) {
                setFormFlash("supplier-dash-flash", (e && e.message) || "Failed.", true);
              }
            });
          });
          visitC.querySelectorAll("[data-sv-counter]").forEach((b) => {
            b.addEventListener("click", async () => {
              const card = b.closest(".supplier-visit-card");
              const id = card && card.getAttribute("data-visit-stop-id");
              if (!card || !id) return;
              const pt = card.querySelector("[data-sv-ptime]");
              const pmsg = card.querySelector("[data-sv-pmsg]");
              var proposed = (pt && pt.value) || "";
              var msg = (pmsg && pmsg.value) || "";
              if (!proposed.trim()) {
                setFormFlash("supplier-dash-flash", "Enter a suggested time or time window.", true);
                return;
              }
              try {
                await apiCall("/api/visits/stops/" + encodeURIComponent(id) + "/supplier-counter", {
                  method: "POST",
                  body: JSON.stringify({ proposed_time: proposed, message: msg || undefined }),
                });
                await loadSupplierDashboard();
              } catch (e) {
                setFormFlash("supplier-dash-flash", (e && e.message) || "Failed.", true);
              }
            });
          });
        }
      } catch (e) {
        visitC.innerHTML = "<div class=\"projects-empty\">Could not load visit requests.</div>";
      }
    }
  }

  /* ── Admin password gate ── */
  const ADMIN_HASH = "3c8b484eeb21caeb34912fe71d43ad6df0ff0aa4d4846bc055da61587b63781c";

  async function hashPassword(pw) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function showAdminGate() {
    if (sessionStorage.getItem("admin_unlocked") === "1") {
      setView("admin");
      return;
    }
    // Show an overlay on top of the page — never wipe admin HTML
    let overlay = document.getElementById("admin-gate-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "admin-gate-overlay";
      overlay.style.cssText = "position:fixed;inset:0;background:var(--bg-page);color:var(--text);z-index:9999;display:flex;align-items:center;justify-content:center;";
      overlay.innerHTML = `
        <div style="text-align:center;max-width:320px;width:90%;padding:0 24px;">
          <h1 style="font-size:22px;font-weight:600;margin-bottom:8px;">Admin access</h1>
          <p style="font-size:14px;color:var(--text-muted);margin-bottom:24px;">Enter the admin password to continue.</p>
          <div style="display:flex;flex-direction:column;gap:12px;">
            <div class="password-input-wrap" style="position:relative;width:100%;">
            <input type="password" id="admin-pw-input" style="padding:11px 44px 11px 14px;border-radius:999px;border:1.5px solid var(--border);background:var(--bg);color:var(--text);font-size:14px;outline:none;width:100%;box-sizing:border-box;font-family:inherit;" placeholder="Password" autocomplete="current-password" />
            ${passwordToggleButtonHtml("admin-pw-input")}
            </div>
            <p id="admin-pw-error" style="color:#d93025;font-size:13px;display:none;margin:0;">Wrong password.</p>
            <button type="button" id="admin-pw-btn" style="padding:11px;border-radius:999px;background:var(--primary);color:var(--on-primary);font-size:14px;font-weight:500;border:none;cursor:pointer;">Unlock</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
    }
    overlay.style.display = "flex";
    const input = document.getElementById("admin-pw-input");
    const btn   = document.getElementById("admin-pw-btn");
    const err   = document.getElementById("admin-pw-error");
    async function tryUnlock() {
      const hash = await hashPassword((input?.value || "").trim());
      if (hash === ADMIN_HASH) {
        sessionStorage.setItem("admin_unlocked", "1");
        overlay.style.display = "none";
        setView("admin");
      } else {
        if (err) err.style.display = "block";
        if (input) { input.value = ""; input.focus(); }
      }
    }
    btn?.addEventListener("click", tryUnlock);
    input?.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
    setTimeout(() => input?.focus(), 100);
  }

  function wireAdminWorkspaceOnce() {
    if (adminWorkspaceBackWired) return;
    adminWorkspaceBackWired = true;
    $("admin-workspace-back")?.addEventListener("click", () => {
      closeAdminWorkspace();
      void loadAdminOverview();
    });
  }

  async function openAdminProjectWorkspace(projectId, customerId) {
    const ow = $("admin-overview-wrap");
    const ws = $("admin-workspace");
    if (ow) ow.hidden = true;
    if (ws) {
      ws.hidden = false;
      ws.dataset.projectId = projectId;
      if (customerId) ws.dataset.customerId = customerId;
    }
    const head = $("admin-workspace-heading");
    const left = $("admin-ws-left");
    const mid = $("admin-ws-messages");
    const right = $("admin-ws-right");
    if (mid) mid.innerHTML = '<div class="projects-empty">Loading\u2026</div>';
    if (left) left.innerHTML = "";
    if (right) right.innerHTML = "";

    try {
      const res = await fetch(`${API_BASE}/api/admin/projects/${encodeURIComponent(projectId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Load failed");

      if (head) head.textContent = (data.project && data.project.title) ? String(data.project.title).slice(0, 80) : "Project";

      const buyerLine = data.buyer_profile
        ? "<p class=\"admin-ws-buyer\">" +
          escapeHtml(data.buyer_profile.display_name || "") +
          (data.company && data.company.name ? " · " + escapeHtml(data.company.name) : "") +
          "</p>"
        : "";

      if (left) {
        left.innerHTML =
          (buyerLine || "") +
          buildRequirementsSection(data.project.requirements || {}) +
          buildAiSummarySection(data.project.ai_summary || {}, data.project.requirements || {}) +
          buildMatchesSection(data.matches || []);
      }

      if (mid) {
        mid.innerHTML = "";
        (data.conversations || []).forEach((m) => {
          appendChatLine(mid, m.role, m.content, m.metadata);
        });
        mid.scrollTop = mid.scrollHeight;
      }

      const sendSupi = async () => {
        const inp = $("admin-ws-input");
        const txt = (inp && inp.value || "").trim();
        if (!txt) return;
        try {
          const r = await fetch(`${API_BASE}/api/admin/projects/${encodeURIComponent(projectId)}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: txt }),
          });
          const j = await r.json();
          if (!r.ok) throw new Error(j?.error || "Failed");
          if (inp) inp.value = "";
          if (mid && j.message) appendChatLine(mid, j.message.role, j.message.content, j.message.metadata);
          if (mid) mid.scrollTop = mid.scrollHeight;
        } catch (err) {
          console.error(err);
        }
      };

      const rebindSupiComposer = () => {
        ["admin-ws-send", "admin-ws-input"].forEach((id) => {
          const el = $(id);
          if (!el || !el.parentNode) return;
          const nu = el.cloneNode(true);
          el.parentNode.replaceChild(nu, el);
        });
        $("admin-ws-send")?.addEventListener("click", () => void sendSupi());
        $("admin-ws-input")?.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void sendSupi();
          }
        });
      };

      if (right) {
        const st = Number(data.project.pipeline_step);
        const step = Number.isFinite(st) && st >= 1 && st <= 3 ? st : 1;
        const co = data.project.coordination_mode || "supi_manual";
        const facOpts = (adminWorkspaceFactoriesCache || [])
          .map((f) => '<option value="' + escapeAttr(String(f.id)) + '">' + escapeHtml(f.name || "#" + f.id) + "</option>")
          .join("");
        right.innerHTML =
          '<p class="admin-ws-h">Steps (Project \u2192 Contact \u2192 Sample)</p>' +
          '<div class="admin-step-btns">' +
          [1, 2, 3]
            .map(
              (n) => {
                const lab = n === 1 ? "Project" : n === 2 ? "Contact" : "Sample";
                return (
                  '<button type="button" class="btn-outline btn-sm admin-step-btn" data-step="' +
                  n +
                  '" title="Step ' +
                  n +
                  " — " +
                  lab +
                  '"><span class="admin-step-num">' +
                  n +
                  '</span><span class="admin-step-lab">' +
                  lab +
                  "</span></button>"
                );
              }
            )
            .join("") +
          "</div>" +
          '<p class="admin-ws-h">AI replies</p>' +
          '<label class="admin-ws-toggle"><input type="checkbox" id="admin-ws-ai-toggle" ' +
          (co === "ai" ? "checked" : "") +
          " /> Claude handles buyer chat</label>" +
          '<p class="admin-ws-h">Link factory</p>' +
          '<select id="admin-ws-factory" class="settings-input">' +
          '<option value="">Choose factory\u2026</option>' +
          facOpts +
          "</select>" +
          '<button type="button" class="btn-primary btn-sm" id="admin-ws-link-factory" style="margin-top:8px;width:100%;">Connect</button>' +
          '<p id="admin-ws-flash" class="form-message" role="status" hidden></p>';

        right.querySelectorAll(".admin-step-btn").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const n = parseInt(btn.getAttribute("data-step") || "1", 10);
            const flash = $("admin-ws-flash");
            try {
              const r = await fetch(`${API_BASE}/api/admin/projects/${encodeURIComponent(projectId)}/pipeline`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pipeline_step: n }),
              });
              const j = await r.json();
              if (!r.ok) throw new Error(j?.error || "Failed");
              if (flash) {
                flash.hidden = false;
                flash.textContent = "Step " + n + " saved.";
                flash.style.color = "";
              }
            } catch (e) {
              if (flash) {
                flash.hidden = false;
                flash.textContent = e.message || "Error";
                flash.style.color = "#d93025";
              }
            }
          });
        });

        $("admin-ws-ai-toggle")?.addEventListener("change", async (ev) => {
          const mode = ev.target.checked ? "ai" : "supi_manual";
          try {
            const r = await fetch(`${API_BASE}/api/admin/projects/${encodeURIComponent(projectId)}/coordination`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ coordination_mode: mode }),
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j?.error || "Failed");
          } catch (e) {
            console.error(e);
          }
        });

        $("admin-ws-link-factory")?.addEventListener("click", async () => {
          const sel = $("admin-ws-factory");
          const fid = sel && parseInt(String(sel.value || ""), 10);
          const flash = $("admin-ws-flash");
          if (!fid) return;
          try {
            const r = await fetch(`${API_BASE}/api/admin/matches`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ project_id: projectId, factory_id: fid }),
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j?.error || "Failed");
            if (flash) {
              flash.hidden = false;
              flash.textContent = j.deduped ? "Already linked." : "Connected.";
              flash.style.color = "";
            }
            void openAdminProjectWorkspace(projectId, customerId || "");
          } catch (e) {
            if (flash) {
              flash.hidden = false;
              flash.textContent = e.message || "Error";
              flash.style.color = "#d93025";
            }
          }
        });
      }

      rebindSupiComposer();
    } catch (e) {
      if (mid) mid.innerHTML = '<div class="projects-empty">' + escapeHtml(e.message || "Error") + "</div>";
    }
  }

  function applyAdminSoftDeleteToCache(type, id) {
    if (!adminOverviewCache) return false;
    const sid = String(id);
    if (type === "customer") {
      adminOverviewCache.customers = (adminOverviewCache.customers || []).filter((c) => String(c.id) !== sid);
      adminOverviewCache.connections = (adminOverviewCache.connections || []).filter(
        (conn) => !conn.buyer || String(conn.buyer.id) !== sid
      );
    } else if (type === "factory") {
      adminOverviewCache.factories = (adminOverviewCache.factories || []).filter((f) => String(f.id) !== sid);
      adminOverviewCache.connections = (adminOverviewCache.connections || []).filter(
        (conn) => !conn.factory || String(conn.factory.id) !== sid
      );
    } else {
      return false;
    }
    return true;
  }

  function renderAdminOverviewData(data) {
    const customers = data.customers || [];
    const factories = data.factories || [];
    const connections = data.connections || [];
    adminWorkspaceFactoriesCache = factories;

    wireAdminWorkspaceOnce();

    const stats = $("admin-stats");
    const custEl = $("admin-customers");
    const facEl = $("admin-factories");
    const connEl = $("admin-connections");
    if (stats) {
      const connectedBuyers = customers.filter((c) => c.connected).length;
      const connectedFactories = factories.filter((f) => f.connected).length;
      stats.innerHTML =
        `<div class="stat-card"><div class="stat-value">${customers.length}</div><div class="stat-label">Customers</div></div>` +
        `<div class="stat-card"><div class="stat-value">${factories.length}</div><div class="stat-label">Factories</div></div>` +
        `<div class="stat-card"><div class="stat-value">${connections.length}</div><div class="stat-label">AI connections</div></div>` +
        `<div class="stat-card"><div class="stat-value">${connectedBuyers}/${customers.length}</div><div class="stat-label">Customers matched</div></div>` +
        `<div class="stat-card"><div class="stat-value">${connectedFactories}/${factories.length}</div><div class="stat-label">Factories matched</div></div>`;
    }

    const renderCustomerCard = (c) => {
      const title = escapeHtml(c.company || c.display_name || "Unnamed customer");
      const sub = [c.location, c.display_name && c.display_name !== c.company ? c.display_name : ""].filter(Boolean).join(" · ");
      const desc = c.company_description ? String(c.company_description).slice(0, 220) : (c.project_titles || []).slice(0, 2).join(" · ");
      const badge = c.connected
        ? `<span class="project-card-badge badge--accepted">Connected</span>`
        : `<span class="project-card-badge badge--pending">Not connected</span>`;
      const meta = `<span class="project-card-meta-item">${c.project_count} project${c.project_count === 1 ? "" : "s"}</span>` +
        `<span class="project-card-meta-item">${c.match_count} match${c.match_count === 1 ? "" : "es"}</span>`;
      const chips =
        c.projects && c.projects.length
          ? `<div class="admin-proj-chips">${c.projects
              .map(
                (p) =>
                  `<button type="button" class="admin-proj-chip" data-customer-id="${escapeAttr(c.id)}" data-project-id="${escapeAttr(p.id)}">${escapeHtml(
                    String(p.title || "Project").slice(0, 42)
                  )}</button>`
              )
              .join("")}</div>`
          : "";
      return `<div class="project-card" style="position:relative;">
        <button class="admin-delete-btn" data-type="customer" data-id="${escapeAttr(c.id)}" title="Move to bin">&#128465;</button>
        <div class="project-card-title">${title}</div>
        ${sub ? `<div class="project-card-sub">${escapeHtml(sub)}</div>` : ""}
        <div class="project-card-desc">${escapeHtml(desc || "No description")}</div>
        ${chips}
        <div class="project-card-meta">${badge}${meta}</div>
      </div>`;
    };

    const renderFactoryCard = (f) => {
      const title = escapeHtml(f.name || "Unnamed factory");
      const sub = [f.category, f.location].filter(Boolean).join(" · ");
      const desc = f.capabilities_description ? String(f.capabilities_description).slice(0, 220) : "";
      const badge = f.connected
        ? `<span class="project-card-badge badge--accepted">Connected</span>`
        : `<span class="project-card-badge badge--pending">Not connected</span>`;
      const meta = `<span class="project-card-meta-item">${f.brief_count} brief${f.brief_count === 1 ? "" : "s"}</span>` +
        `<span class="project-card-meta-item">${f.match_count} match${f.match_count === 1 ? "" : "es"}</span>`;
      return `<div class="project-card" style="position:relative;">
        <button class="admin-delete-btn" data-type="factory" data-id="${escapeAttr(String(f.id))}" title="Move to bin">&#128465;</button>
        <div class="project-card-title">${title}</div>
        ${sub ? `<div class="project-card-sub">${escapeHtml(sub)}</div>` : ""}
        <div class="project-card-desc">${escapeHtml(desc || "No description")}</div>
        <div class="project-card-meta">${badge}${meta}</div>
      </div>`;
    };

    if (custEl) {
      if (!customers.length) custEl.innerHTML = '<div class="projects-empty">No customers yet.</div>';
      else {
        custEl.innerHTML = customers.map(renderCustomerCard).join("");
        if (!custEl.dataset.projChipWired) {
          custEl.dataset.projChipWired = "1";
          custEl.addEventListener("click", (e) => {
            const chip = e.target.closest(".admin-proj-chip");
            if (!chip) return;
            e.preventDefault();
            const pid = chip.getAttribute("data-project-id");
            const cid = chip.getAttribute("data-customer-id") || "";
            if (pid) void openAdminProjectWorkspace(pid, cid);
          });
        }
      }
    }

    if (facEl) {
      if (!factories.length) facEl.innerHTML = '<div class="projects-empty">No factories yet.</div>';
      else facEl.innerHTML = factories.map(renderFactoryCard).join("");
    }

    if (connEl) {
      if (!connections.length) connEl.innerHTML = '<div class="projects-empty">No AI-made connections yet.</div>';
      else connEl.innerHTML = connections.map((m) => {
        const buyer = m.buyer?.company || m.buyer?.display_name || "Unknown buyer";
        const factory = m.factory?.name || "Unknown factory";
        const proj = m.project?.title || "Untitled project";
        const statusClass = String(m.status || "").replace(/[^a-zA-Z0-9_-]/g, "_");
        return `<div class="project-card"><div class="project-card-title">${escapeHtml(buyer)} <span class="admin-arrow">&rarr;</span> ${escapeHtml(factory)}</div><div class="project-card-sub">${escapeHtml(proj)}</div><div class="project-card-meta"><span class="project-card-badge badge--${statusClass}">${escapeHtml(m.status || "pending")}</span></div></div>`;
      }).join("");
    }

    document.querySelectorAll(".admin-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const type = btn.getAttribute("data-type");
        const id = btn.getAttribute("data-id");
        const pathKind = type === "customer" ? "customers" : "factories";
        if (!id || btn.disabled) return;
        btn.disabled = true;
        try {
          const res = await fetch(`${API_BASE}/api/admin/${pathKind}/${encodeURIComponent(id)}`, { method: "DELETE" });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) {
            var delMsg = (j && j.error) || "Could not move to bin.";
            if (j && j.hint) delMsg += " " + j.hint;
            setFormFlash("admin-flash", delMsg, true);
            return;
          }
          if (applyAdminSoftDeleteToCache(type, id)) {
            renderAdminOverviewData(adminOverviewCache);
            setFormFlash("admin-flash", "Moved to bin.", false, 4000);
            void loadAdminBin();
          } else {
            adminOverviewCache = null;
            await loadAdminOverview();
          }
        } catch (err) {
          setFormFlash("admin-flash", err instanceof Error ? err.message : "Could not move to bin.", true);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  async function loadAdminOverview() {
    setFormFlash("admin-flash", "", false);
    const stats = $("admin-stats");
    const custEl = $("admin-customers");
    const facEl = $("admin-factories");
    const connEl = $("admin-connections");
    if (stats) stats.innerHTML = '<div class="projects-empty">Loading\u2026</div>';
    if (custEl) custEl.innerHTML = "";
    if (facEl) facEl.innerHTML = "";
    if (connEl) connEl.innerHTML = "";

    let data;
    try {
      const res = await fetch(`${API_BASE}/api/admin/overview`, { headers: { "Content-Type": "application/json" } });
      data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not load admin data");
    } catch (err) {
      if (stats) stats.innerHTML = `<div class="projects-empty">${escapeHtml(err.message || "Failed to load")}</div>`;
      return;
    }

    adminOverviewCache = data;
    renderAdminOverviewData(data);
    await loadAdminBin();
  }

  async function loadAdminBin() {
    const binEl = $("admin-bin");
    if (!binEl) return;
    try {
      const res = await fetch(`${API_BASE}/api/admin/bin`);
      const data = await res.json();
      const customers = data.customers || [];
      const factories = data.factories || [];
      if (data.hint && !customers.length && !factories.length) {
        binEl.innerHTML =
          '<div class="projects-empty">' +
          escapeHtml("Bin needs database column deleted_at. " + String(data.hint).slice(0, 500)) +
          "</div>";
        setFormFlash("admin-flash", String(data.hint).slice(0, 400), true);
        return;
      }
      if (!customers.length && !factories.length) {
        binEl.innerHTML = '<div class="projects-empty">Bin is empty.</div>';
        return;
      }
      const renderBinItem = (item, type) => {
        const label = type === "customer"
          ? escapeHtml(item.company || item.display_name || "Unnamed customer")
          : escapeHtml(item.name || "Unnamed factory");
        const sub = escapeHtml(item.location || "");
        const deletedAt = item.deleted_at ? new Date(item.deleted_at).toLocaleDateString() : "";
        return `<div class="project-card bin-card" style="position:relative;">
          <div class="project-card-title">${label} <span class="bin-card-type">${type}</span></div>
          ${sub ? `<div class="project-card-sub">${sub}</div>` : ""}
          ${deletedAt ? `<div class="bin-card-meta">Deleted ${deletedAt}</div>` : ""}
          <div class="bin-actions">
            <button class="bin-btn bin-restore-btn" data-type="${type}" data-id="${escapeAttr(String(item.id))}">Restore</button>
            <button class="bin-btn bin-btn--danger bin-hard-delete-btn" data-type="${type}" data-id="${escapeAttr(String(item.id))}">Delete forever</button>
          </div>
        </div>`;
      };
      binEl.innerHTML = [
        ...customers.map((c) => renderBinItem(c, "customer")),
        ...factories.map((f) => renderBinItem(f, "factory")),
      ].join("");

      binEl.querySelectorAll(".bin-restore-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const type = btn.getAttribute("data-type");
          const id = btn.getAttribute("data-id");
          const path = type === "customer" ? "customers" : "factories";
          if (!id) return;
          try {
            const res = await fetch(`${API_BASE}/api/admin/bin/${path}/${encodeURIComponent(id)}/restore`, { method: "POST" });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) {
              setFormFlash("admin-flash", (j && j.error) || "Could not restore.", true);
              return;
            }
            await loadAdminOverview();
            setFormFlash("admin-flash", "Restored.", false, 4000);
          } catch (err) {
            setFormFlash("admin-flash", err instanceof Error ? err.message : "Could not restore.", true);
          }
        });
      });

      binEl.querySelectorAll(".bin-hard-delete-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const type = btn.getAttribute("data-type");
          const id = btn.getAttribute("data-id");
          const path = type === "customer" ? "customers" : "factories";
          if (!id) return;
          try {
            const res = await fetch(`${API_BASE}/api/admin/bin/${path}/${encodeURIComponent(id)}`, { method: "DELETE" });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) {
              setFormFlash("admin-flash", (j && j.error) || "Could not delete.", true);
              return;
            }
            void loadAdminBin();
            setFormFlash("admin-flash", "Deleted permanently.", false, 4000);
          } catch (err) {
            setFormFlash("admin-flash", err instanceof Error ? err.message : "Could not delete.", true);
          }
        });
      });
    } catch (err) {
      binEl.innerHTML = `<div class="projects-empty">Could not load bin: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }

  async function loadSupplierProfile() {
    const root = $("supplier-profile-root");
    if (!root) return;
    root.innerHTML = '<p class="settings-hint">Loading\u2026</p>';
    let factory;
    try {
      const res = await apiCall("/api/factories/me");
      factory = res.factory;
    } catch (err) {
      root.innerHTML = `<p class="settings-hint">Could not load factory profile: ${escapeHtml(err.message || String(err))}</p>`;
      return;
    }
    if (!factory) { root.innerHTML = '<p class="settings-hint">No factory profile found. Complete onboarding as a supplier.</p>'; return; }
    const c = factory.capabilities || {};
    const ci = factory.contact_info || {};
    const contacts = Array.isArray(ci.contacts) ? ci.contacts : [];
    const c0 = contacts[0] || {};
    const wa0 = c0.whatsapp != null ? String(c0.whatsapp) : ci.phone != null ? String(ci.phone) : "";
    const websiteV = c.website != null ? String(c.website) : "";
    let moqMinV = c.moq_min != null ? String(c.moq_min) : "";
    let moqMaxV = c.moq_max != null ? String(c.moq_max) : "";
    if (!moqMinV && !moqMaxV && c.moq) {
      const legacy = String(c.moq).trim();
      const parts = legacy.split(/\s*[–-]\s*/);
      if (parts.length >= 2) {
        moqMinV = phoneDigits(parts[0]);
        moqMaxV = phoneDigits(parts[1]);
      } else if (legacy) {
        moqMinV = phoneDigits(legacy);
      }
    }
    const priceR =
      (c.project_price_range != null && String(c.project_price_range).trim()) ||
      (c.certifications != null && String(c.certifications)) ||
      "";
    const onAdminPath = window.location.pathname.replace(/\/+$/, "") === "/admin";
    const fpDangerHtml = onAdminPath
      ? ""
      : `<div style="margin-top:40px;padding-top:24px;border-top:1px solid var(--border-light);">
        <p style="font-size:13px;color:var(--text-soft);margin-bottom:10px;">Danger zone</p>
        <button type="button" class="btn-danger" id="fp-delete-profile">Delete my profile</button>
      </div>`;
    root.innerHTML = `<div class="settings-section">
      <div class="settings-field"><label class="settings-label">Company name</label><input type="text" id="fp-name" class="settings-input" value="${escapeAttr(factory.name)}" /></div>
      <div class="settings-field"><label class="settings-label">Location</label><input type="text" id="fp-location" class="settings-input" value="${escapeAttr(factory.location)}" /></div>
      <div class="settings-field"><label class="settings-label">Website</label><input type="url" id="fp-website" class="settings-input" placeholder="https://example.com" value="${escapeAttr(websiteV)}" /></div>
      <div class="settings-field"><label class="settings-label">What do you manufacture?</label><input type="text" id="fp-category" class="settings-input" value="${escapeAttr(factory.category)}" /></div>
      <div class="settings-field"><label class="settings-label">Additional information about your company</label><textarea id="fp-capabilities" class="settings-input onboard-textarea--compact" rows="2">${escapeHtml(c.description || "")}</textarea></div>
      <div class="settings-field"><label class="settings-label">Project price range</label><input type="text" id="fp-price-range" class="settings-input" value="${escapeAttr(priceR)}" /></div>
      <div class="settings-field"><label class="settings-label">Minimal order quantity</label><input type="text" inputmode="numeric" pattern="[0-9]*" id="fp-moq-min" class="settings-input fp-digits" value="${escapeAttr(moqMinV)}" /></div>
      <div class="settings-field"><label class="settings-label">Maximal order quantity</label><input type="text" inputmode="numeric" pattern="[0-9]*" id="fp-moq-max" class="settings-input fp-digits" value="${escapeAttr(moqMaxV)}" /></div>
      ${settingsPhoneRowHtml("Phone / WhatsApp", "fp-wa1-cc", "fp-wa1-local", wa0)}
      <p class="settings-saved" id="fp-saved" hidden></p>
      <button type="button" class="btn-primary" id="fp-save">Save profile</button>
      ${fpDangerHtml}</div>`;
    root.querySelectorAll(".phone-local-num").forEach((el) => {
      window.AIRSUP_PHONE?.wirePhoneLocalInput(el);
    });
    root.querySelectorAll(".fp-digits").forEach((inp) => {
      inp.addEventListener("input", () => { inp.value = phoneDigits(inp.value); });
    });
    var fpLoc = $("fp-location");
    if (fpLoc) wireLocationAutocomplete(fpLoc);
    $("fp-save")?.addEventListener("click", async () => {
      const g = (k) => ($(`fp-${k}`)?.value || "").trim();
      const saved = $("fp-saved");
      try {
        const siteRaw = (g("website") || "").trim();
        const siteCheck = validateOptionalHttpUrl(siteRaw);
        if (!siteCheck.ok) {
          if (saved) { saved.hidden = false; saved.textContent = siteCheck.error || "Invalid website."; saved.style.color = "#d93025"; }
          return;
        }
        const wa1 = mergePhoneFromRow($("fp-wa1-cc"), $("fp-wa1-local"));
        const contacts = [{ whatsapp: wa1 }];
        const cap = {
          description: g("capabilities"),
          project_price_range: g("price-range"),
          moq_min: phoneDigits(g("moq-min")),
          moq_max: phoneDigits(g("moq-max")),
          moq: [phoneDigits(g("moq-min")), phoneDigits(g("moq-max"))].filter(Boolean).join(" – ") || "",
        };
        cap.website = siteCheck.normalized ? siteCheck.normalized : "";
        await apiCall("/api/factories/me", { method: "PUT", body: JSON.stringify({
          name: g("name"), location: g("location"), category: g("category"),
          capabilities: cap,
          contact_info: { contacts },
        })});
        if (saved) { saved.hidden = false; saved.textContent = "Saved."; saved.style.color = ""; setTimeout(() => { saved.hidden = true; }, 2500); }
      } catch (err) {
        if (saved) { saved.hidden = false; saved.textContent = "Error: " + (err.message || String(err)); saved.style.color = "#d93025"; }
      }
    });
    if (!onAdminPath) {
      $("fp-delete-profile")?.addEventListener("click", async () => {
        const ok = await showConfirmDialog(
          "Delete your factory profile? It will be moved to the admin bin. You can ask support to restore it.",
          { confirmLabel: "Delete", cancelLabel: "Cancel", danger: true }
        );
        if (!ok) return;
        try {
          await apiCall("/api/factories/me", { method: "DELETE" });
          await supabaseClient.auth.signOut();
          window.location.href = "/";
        } catch (err) {
          const saved = $("fp-saved");
          if (saved) { saved.hidden = false; saved.textContent = "Could not delete: " + (err.message || String(err)); saved.style.color = "#d93025"; }
        }
      });
    }
  }

  /* ── Event wiring ── */
  $("logo-home")?.addEventListener("click", () => {
    const onAdmin = window.location.pathname.replace(/\/+$/, "") === "/admin";
    if (onAdmin) {
      if (sessionStorage.getItem("admin_unlocked") === "1") {
        setView("admin");
      }
      return;
    }
    // Not logged in or still in onboarding → go to landing page
    if (!currentUser || currentView === "onboarding") {
      window.location.href = "/";
      return;
    }
    // Fully onboarded → go to their dashboard
    setView(userRole === "supplier" ? "supplier-dashboard" : "projects");
  });
  $("user-menu-trigger")?.addEventListener("click", () => { const dd = $("user-menu-dropdown"); if (dd) dd.hidden = !dd.hidden; });
  document.addEventListener("click", (e) => { const dd = $("user-menu-dropdown"); if (dd && !dd.hidden && !e.target.closest("#user-menu-trigger") && !e.target.closest("#user-menu-dropdown")) dd.hidden = true; });
  $("menu-settings")?.addEventListener("click", () => { $("user-menu-dropdown").hidden = true; setView("settings"); });
  $("menu-signout")?.addEventListener("click", () => { $("user-menu-dropdown").hidden = true; handleSignOut(); });

  const chatInput = $("chat-input"), chatSend = $("chat-send");
  chatInput?.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + "px";
    chatSend.disabled = !chatInput.value.trim();
  });
  chatInput?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  chatSend?.addEventListener("click", sendMessage);

  $("chat-file-input")?.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    files.forEach((f) => pendingFiles.push(f));
    renderPendingFiles();
    e.target.value = "";
    chatSend.disabled = false;
  });

  $("conn-chat-back")?.addEventListener("click", closeConnectionChat);

  const connInput = $("conn-chat-input"), connSend = $("conn-chat-send");
  connInput?.addEventListener("input", () => {
    connInput.style.height = "auto";
    connInput.style.height = Math.min(connInput.scrollHeight, 150) + "px";
    if (connSend) connSend.disabled = !connInput.value.trim();
  });
  connInput?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendConnectionMessage(); } });
  connSend?.addEventListener("click", sendConnectionMessage);

  /* ── Init ── */
  updateAuthUI();
  setupAuthListener();
  // Pre-select role when arriving from the landing page (/workspace?role=startup|supplier)
  const roleParam = new URLSearchParams(window.location.search).get("role");
  if (roleParam === "startup" || roleParam === "supplier") {
    onboardData.role = roleParam;
    onboardStep = 1; // skip the "who are you?" choice screen
    window.history.replaceState(null, "", window.location.pathname);
  }

  if (window.location.pathname.replace(/\/+$/, "") === "/admin") {
    const account = $("header-account");
    if (account) account.hidden = true;
    const nav = $("header-nav");
    if (nav) nav.style.display = "none";
    showAdminGate();
  } else {
    ensureSession().then(() => initAuthState());
  }
})();
