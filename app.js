(function () {
  "use strict";

  const API_BASE = window.AIRSUP_CONFIG?.apiUrl || "";
  const $ = (id) => document.getElementById(id);

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
    currentUser = { id: user.id, email: user.email || "", displayName };
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
  let latestProjectId = null;
  let activeConnectionMatchId = null;

  function resetOnboardData() {
    onboardData = {
      role: "", fullName: "", phone: "", companyName: "", location: "",
      briefUrl: "", briefText: "", briefSource: "", briefFileName: "",
      capabilities: "", certifications: "", moq: "", specialization: "",
    };
  }
  resetOnboardData();

  /* ── Helpers ── */
  function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function escapeAttr(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || "")); };
      r.onerror = function () { reject(new Error("Could not read file")); };
      r.readAsText(file);
    });
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
    const session = (await supabaseClient.auth.getSession()).data.session;
    if (!session?.user) return { filenames: [], err: "Not signed in" };
    const uid = session.user.id;

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
            " [Storage upload, Network tab: storage/v1/object/...] First path segment must be your user id; apply migrations 010 and 011.";
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
      nav.innerHTML = '<button type="button" class="nav-link active" data-view="chat">Chat</button><button type="button" class="nav-link" data-view="projects">Projects</button><button type="button" class="nav-link" data-view="connections">Connections</button>';
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
        userRole = "startup"; buildNav(); setView("chat");
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

  /* ── View switching ── */
  function setView(name) {
    currentView = name;
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    const page = $(`page-${name}`);
    if (page) page.classList.add("active");
    const nav = $("header-nav");
    if (nav) nav.querySelectorAll(".nav-link").forEach((n) => n.classList.toggle("active", n.dataset.view === name));
    updateAuthUI();

    if (name === "chat") loadChatHistory();
    if (name === "projects") loadProjects();
    if (name === "connections") loadConnections();
    if (name === "settings") void loadSettings();
    if (name === "onboarding") renderOnboardStep();
    if (name === "supplier-dashboard") loadSupplierDashboard();
    if (name === "supplier-profile") loadSupplierProfile();
    if (name === "admin") loadAdminOverview();
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
    { id: "brief", type: "brief", title: "Bring your brief", sub: "Paste a public share link to your chat, or paste the conversation, or upload a .txt or .md export. We will turn it into a manufacturing project on the platform. Nothing is sent to a factory until you are ready to connect." },
    { id: "contact", type: "form", title: "How can we reach you?", sub: "Your info is stored securely and only shared when we find a real match.",
      fields: [
        { key: "fullName", label: "Full name", required: true },
        { key: "phone", label: "Phone / WhatsApp", type: "tel", required: true },
      ] },
  ];

  const SUPPLIER_STEPS = [
    { id: "factory", type: "form", title: "Tell us about your factory.", sub: "Buyers hate talking to sales. Our AI briefs your designers and engineers directly. Less overhead, faster iterations.",
      fields: [
        { key: "companyName", label: "Factory / company name", required: true },
        { key: "location", label: "Location", required: true },
        { key: "specialization", label: "Specialization", required: true },
      ] },
    { id: "capabilities", type: "form", title: "What can you produce?", sub: "This helps our AI match you with the right projects. Be specific about what your team excels at.",
      fields: [
        { key: "capabilities", label: "Core capabilities", type: "textarea" },
        { row: [
          { key: "certifications", label: "Certifications" },
          { key: "moq", label: "Typical MOQ" },
        ]},
      ] },
    { id: "contact", type: "form", title: "Who should buyers work with?", sub: "We\u2019ll connect projects directly to your designer or engineer, not a sales team. This is your competitive advantage.",
      fields: [
        { key: "fullName", label: "Contact name", required: true },
        { key: "phone", label: "Phone / WeChat / WhatsApp", type: "tel", required: true },
      ] },
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
            : "We will read your chat export and start searching for matching factories. You can review your project, files, and connections in the app."}</p>
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
          setView("chat");
        } catch (err) {
          alert(err && err.message ? err.message : String(err));
        } finally {
          if (goBtn) { goBtn.disabled = false; if (prev) goBtn.textContent = prev; }
        }
      });
      return;
    }

    const step = steps[stepIdx];
    if (step.type === "brief") {
      const htmlB =
        '<div class="onboard-question"><h1 class="onboard-title">' + step.title + "</h1>" +
        (step.sub ? '<p class="onboard-sub">' + step.sub + "</p>" : "") +
        '<div class="onboard-form onboard-brief">' +
        '<p class="onboard-brief-hint">We pull product, materials, quantity, and timing from the chat if they are there. Prototype and speed are fine as defaults. Your chat stays in Airsup until you choose to connect with a factory.</p>' +
        '<div class="onboard-field"><label class="onboard-label" for="onboard-brief-url">Share link (optional)</label>' +
        '<input class="onboard-input" type="url" id="onboard-brief-url" name="onboard-brief-url" value="' +
        escapeAttr(onboardData.briefUrl || "") +
        '" autocomplete="url" />' +
        '<p class="onboard-brief-fine">Public share links from ChatGPT, Claude, or Grok only. If a link does not work, use paste or a file below.</p></div>' +
        '<div class="onboard-field"><label class="onboard-label" for="onboard-brief-text">Paste the conversation (optional)</label>' +
        '<textarea class="onboard-textarea" id="onboard-brief-text" rows="6" placeholder="">' +
        escapeHtml(onboardData.briefText || "") +
        "</textarea></div>" +
        '<div class="onboard-field"><label class="onboard-label" for="onboard-brief-file">Or upload a file</label>' +
        '<input class="onboard-brief-file" type="file" id="onboard-brief-file" accept=".txt,.md,text/plain" />' +
        (onboardData.briefFileName ? '<p class="onboard-brief-fine">Last selected: ' + escapeHtml(onboardData.briefFileName) + "</p>" : "") +
        "</div></div>" +
        '<div class="onboard-actions"><button type="button" class="btn-primary" id="onboard-next">Continue</button>' +
        '<button type="button" class="onboard-skip" id="onboard-back">Back</button></div></div>';
      stage.innerHTML = htmlB;
      $("onboard-back")?.addEventListener("click", () => {
        var u = $("onboard-brief-url");
        var tx = $("onboard-brief-text");
        if (u) onboardData.briefUrl = (u.value || "").trim();
        if (tx) onboardData.briefText = (tx.value || "").trim();
        onboardStep--;
        renderOnboardStep();
      });
      $("onboard-next")?.addEventListener("click", function () {
        (async function () {
          const urlEl = $("onboard-brief-url");
          const textEl = $("onboard-brief-text");
          const fileEl = $("onboard-brief-file");
          const u = (urlEl && urlEl.value ? urlEl.value : "").trim();
          const pasted = (textEl && textEl.value ? textEl.value : "").trim();
          var file = fileEl && fileEl.files && fileEl.files[0] ? fileEl.files[0] : null;
          var fromFile = "";
          if (file) {
            try {
              fromFile = await readFileAsText(file);
            } catch (e) {
              alert("Could not read the file. Try a .txt or .md file.");
              return;
            }
          }
          onboardData.briefUrl = u;
          if (file) {
            onboardData.briefText = fromFile;
            onboardData.briefSource = "file";
            onboardData.briefFileName = file.name;
          } else {
            onboardData.briefText = pasted;
            onboardData.briefSource = "text";
            onboardData.briefFileName = "";
          }
          if (!u && !pasted && !fromFile) {
            alert("Add a share link, paste your chat, or upload a .txt or .md file.");
            return;
          }
          onboardStep++;
          renderOnboardStep();
        })();
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
      } else if (f.type === "textarea") {
        html += `<div class="onboard-field"><label class="onboard-label">${f.label}</label><textarea class="onboard-textarea onboard-input" data-key="${f.key}" ${f.required ? "required" : ""}>${escapeHtml(onboardData[f.key] || "")}</textarea></div>`;
      } else {
        html += `<div class="onboard-field"><label class="onboard-label">${f.label}</label><input class="onboard-input" data-key="${f.key}" type="${f.type || "text"}" value="${escapeAttr(onboardData[f.key] || "")}" ${f.required ? "required" : ""} /></div>`;
      }
    });
    html += '</div><div class="onboard-actions"><button type="button" class="btn-primary" id="onboard-next">Continue</button>';
    html += '<button type="button" class="onboard-skip" id="onboard-back">Back</button></div></div>';
    stage.innerHTML = html;

    $("onboard-next")?.addEventListener("click", () => {
      stage.querySelectorAll(".onboard-input").forEach((inp) => { onboardData[inp.dataset.key] = (inp.value || inp.textContent || "").trim(); });
      for (const inp of stage.querySelectorAll(".onboard-input[required]")) {
        if (!(inp.value || "").trim()) { inp.focus(); return; }
      }
      onboardStep++;
      renderOnboardStep();
    });
    $("onboard-back")?.addEventListener("click", () => {
      stage.querySelectorAll(".onboard-input").forEach((inp) => { onboardData[inp.dataset.key] = (inp.value || inp.textContent || "").trim(); });
      onboardStep--;
      renderOnboardStep();
    });
    const firstInput = stage.querySelector(".onboard-input");
    if (firstInput) setTimeout(() => firstInput.focus(), 100);
  }

  async function saveOnboardingToSupabase() {
    if (!supabaseClient || !currentUser) return {};
    const d = onboardData;
    const displayName = d.fullName || currentUser.displayName;
    const letter = (displayName || "?").charAt(0).toUpperCase();

    await supabaseClient.from("profiles").upsert({
      id: currentUser.id, display_name: displayName, avatar_letter: letter,
      company: d.companyName, location: d.location,
      headline: d.role === "supplier" ? "supplier" : d.role,
      phone: d.phone,
    }, { onConflict: "id" });

    await supabaseClient.from("user_settings").upsert({
      user_id: currentUser.id,
      preferred_name: displayName, company: d.companyName, phone: d.phone,
    }, { onConflict: "user_id" });

    if (d.role === "supplier") {
      const facPayload = {
        name: d.companyName,
        location: d.location,
        category: d.specialization,
        capabilities: { description: d.capabilities, certifications: d.certifications, moq: d.moq },
        contact_info: { name: d.fullName, phone: d.phone },
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
    const hasText = d.briefText && String(d.briefText).trim();
    if (!hasUrl && !hasText) {
      currentUser.displayName = displayName;
      updateAuthUI();
      return {};
    }

    const importBody = hasUrl
      ? { sourceType: "url", url: String(d.briefUrl).trim(), text: hasText ? String(d.briefText) : "" }
      : { sourceType: d.briefSource === "file" ? "file" : "text", text: String(d.briefText) };
    const data = await apiCall("/api/intake/import", { method: "POST", body: JSON.stringify(importBody) });
    currentUser.displayName = displayName;
    updateAuthUI();
    return { importedProjectId: data.projectId || null };
  }

  /* ── Theme helpers (used in Settings + Supplier profile) ── */
  function renderThemePills() {
    const current = (window.AirsupTheme && window.AirsupTheme.get()) || document.documentElement.dataset.theme || "dark";
    const pill = (value, label) =>
      `<button type="button" class="theme-pill${current === value ? " theme-pill--active" : ""}" data-theme-value="${value}">${label}</button>`;
    return `<div class="theme-pills">${pill("light", "Light")}${pill("dark", "Dark")}</div>`;
  }
  function wireThemePills(scopeEl) {
    const root = scopeEl || document;
    const syncActive = (v) => {
      root.querySelectorAll("[data-theme-value]").forEach((b) => {
        b.classList.toggle("theme-pill--active", b.getAttribute("data-theme-value") === v);
      });
    };
    root.querySelectorAll("[data-theme-value]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.getAttribute("data-theme-value");
        if (window.AirsupTheme) window.AirsupTheme.set(v);
        syncActive(v);
      });
    });
    window.addEventListener("airsup:themechange", (e) => {
      if (!root.isConnected || !root.querySelector("[data-theme-value]")) return;
      syncActive(e.detail?.theme || (window.AirsupTheme && window.AirsupTheme.get()) || "light");
    });
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
    root.innerHTML = `<div class="settings-section">
      ${[["Display name","displayName","text"],["Company","company","text"],["Phone / WhatsApp","phone","tel"],["Location","location","text"],["Timezone","timezone","text"]].map(([l,k,t]) =>
        `<div class="settings-field"><label class="settings-label">${l}</label><input type="${t}" id="settings-${k}" class="settings-input" value="${escapeAttr(v[k])}" /></div>`).join("")}
      <div class="settings-field"><label class="settings-label">Bio</label><textarea id="settings-bio" class="settings-input" rows="3">${escapeHtml(v.bio)}</textarea></div>
      <div class="settings-field">
        <label class="settings-label">Theme</label>
        ${renderThemePills()}
      </div>
      <p class="settings-saved" id="settings-saved" hidden></p>
      <button type="button" class="btn-primary" id="settings-save">Save changes</button>
      <div style="margin-top:40px;padding-top:24px;border-top:1px solid var(--border-light);">
        <p style="font-size:13px;color:var(--text-soft);margin-bottom:10px;">Danger zone</p>
        <button type="button" class="btn-danger" id="settings-delete-profile">Delete my profile</button>
      </div></div>`;
    wireThemePills(root);
    $("settings-save")?.addEventListener("click", saveSettings);
    $("settings-delete-profile")?.addEventListener("click", async () => {
      if (!confirm("Delete your profile? It will be moved to the admin bin. You can ask support to restore it.")) return;
      try {
        const token = (await supabaseClient.auth.getSession()).data.session?.access_token;
        await fetch(`${API_BASE}/api/profile/me`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
        await supabaseClient.auth.signOut();
        window.location.href = "/";
      } catch (err) {
        alert("Could not delete profile: " + (err.message || String(err)));
      }
    });
  }

  async function saveSettings() {
    if (!currentUser || !supabaseClient) return;
    const g = (k) => ($(`settings-${k}`)?.value || "").trim();
    const dn = g("displayName") || currentUser.displayName;
    const { error: pe } = await supabaseClient.from("profiles").upsert({ id: currentUser.id, display_name: dn, avatar_letter: (dn||"?").charAt(0).toUpperCase(), company: g("company"), phone: g("phone"), location: g("location"), bio: g("bio") }, { onConflict: "id" });
    const { error: se } = await supabaseClient.from("user_settings").upsert({ user_id: currentUser.id, company: g("company"), phone: g("phone"), timezone: g("timezone")||"Europe/Berlin", preferred_name: dn }, { onConflict: "user_id" });
    const saved = $("settings-saved");
    if (pe || se) { if (saved) { saved.hidden = false; saved.textContent = "Error: " + (pe?.message||se?.message||""); saved.style.color = "#d93025"; } return; }
    currentUser.displayName = dn; updateAuthUI();
    if (saved) { saved.hidden = false; saved.textContent = "Saved."; saved.style.color = ""; setTimeout(() => { saved.hidden = true; }, 2500); }
  }

  /* ══════════════════════════════════════
     CHAT
     ══════════════════════════════════════ */
  function appendMessage(role, text, metadata) {
    $("chat-welcome")?.remove();
    const container = $("chat-messages");
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble chat-bubble--${role}`;
    if (role === "assistant") { bubble.innerHTML = simpleMarkdown(text); } else { bubble.textContent = text; }
    container.appendChild(bubble);

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
      appendMessage("assistant", data.reply, { options: data.options, action: data.action });
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

  /* ── Projects ── */
  async function loadProjects() {
    const container = $("projects-list");
    const lead = $("projects-lead");
    if (lead) lead.textContent = "Sourcing requests created from your conversations.";
    try {
      const { projects } = await apiCall("/api/projects");
      if (!projects?.length) { container.innerHTML = '<div class="projects-empty">No projects yet. Complete onboarding with a share link or pasted chat, or use Chat to add one later.</div>'; return; }
      container.innerHTML = projects.map((p) => {
        const s = p.ai_summary || {};
        const reqs = [s.quantity, s.budget, s.timeline].filter(Boolean);
        return `<div class="project-card" data-id="${p.id}"><div class="project-card-title">${escapeHtml(p.title)}</div><div class="project-card-desc">${escapeHtml(p.description || "")}</div>${reqs.length ? `<div class="project-card-reqs">${reqs.map(r=>escapeHtml(r)).join(" \u00b7 ")}</div>` : ""}<div class="project-card-meta"><span class="project-card-badge badge--${p.status}">${p.status.replace(/_/g," ")}</span></div></div>`;
      }).join("");
      container.querySelectorAll(".project-card").forEach((c) => c.addEventListener("click", () => { if (c.dataset.id) loadProjectDetail(c.dataset.id); }));
    } catch (_) { container.innerHTML = '<div class="projects-empty">Could not load projects.</div>'; }
  }

  async function loadProjectDetail(id) {
    const container = $("projects-list");
    const lead = $("projects-lead");
    if (lead) lead.textContent = "Sourcing requests created from your conversations.";
    try {
      const { project } = await apiCall(`/api/projects/${id}`);
      const s = project.ai_summary || {};
      let filesHtml = "";
      try {
        const { files } = await apiCall(`/api/projects/${id}/files`);
        if (files?.length) {
          filesHtml =
            '<div class="project-files-block"><h3 class="project-files-heading">Files</h3><ul class="project-files-list">' +
            files
              .map(function (f) {
                const link =
                  f.signed_url &&
                  '<a href="' +
                    escapeAttr(f.signed_url) +
                    '" target="_blank" rel="noopener">' +
                    escapeHtml(f.filename) +
                    "</a>";
                const label = link || escapeHtml(f.filename);
                return "<li>" + label + (f.bytes ? ' <span class="project-file-meta">' + formatBytes(f.bytes) + "</span>" : "") + "</li>";
              })
              .join("") +
            "</ul></div>";
        }
      } catch (_) { /* no files yet */ }
      container.innerHTML = `<div class="project-detail"><h2 style="font-size:22px;font-weight:600;margin-bottom:4px;">${escapeHtml(project.title)}</h2><p style="color:var(--text-muted);margin-bottom:16px;">${escapeHtml(project.description||"")}</p><span class="project-card-badge badge--${project.status}">${project.status.replace(/_/g," ")}</span>${s.product?`<div style="margin:16px 0;"><strong>Product:</strong> ${escapeHtml(s.product)}</div>`:""}${filesHtml}</div>`;
    } catch (_) {}
  }

  function formatBytes(n) {
    if (n == null || n < 0) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  /* ══════════════════════════════════════
     CONNECTIONS
     ══════════════════════════════════════ */
  async function loadConnections() {
    const container = $("connections-list");
    const chatWrap = $("connection-chat-wrap");
    if (chatWrap) chatWrap.hidden = true;
    if (container) container.hidden = false;
    activeConnectionMatchId = null;

    try {
      const { matches } = await apiCall("/api/matches");
      if (!matches?.length) { container.innerHTML = '<div class="connections-empty">No connections yet. Once AI matches you with a factory, you\u2019ll get a direct line to their engineer here.</div>'; return; }
      container.innerHTML = matches.map((m) => {
        const f = m.factories, p = m.projects, ctx = m.context_summary || {};
        const contact = ctx.direct_contact || {};
        const contactLine = contact.name ? `${contact.name}${contact.role ? ` \u00b7 ${contact.role}` : ""}` : "";
        const q = m.quote || {};
        return `<div class="connection-card connection-card--clickable" data-match-id="${m.id}"><div class="connection-header"><div class="connection-header-left"><span class="connection-factory">${escapeHtml(f?.name||"Factory")}</span><span class="connection-location">${escapeHtml(f?.location||"")}</span></div><span class="project-card-badge badge--${m.status}">${escapeHtml(formatMatchStatusLabel(m.status))}</span></div>${contactLine?`<div class="connection-summary-bar" style="font-weight:500;">Your contact: ${escapeHtml(contactLine)}</div>`:""}<div class="connection-summary-bar">${escapeHtml(ctx.short||"Connection established")}</div><div class="connection-body"><div class="connection-project-line">Project: ${escapeHtml(p?.title||"")}</div>${q.unit_price?`<div class="connection-quote">${escapeHtml(q.unit_price)}/unit \u00b7 ${escapeHtml(q.lead_time||"TBD")}</div>`:""}</div></div>`;
      }).join("");
      container.querySelectorAll(".connection-card--clickable").forEach((card) => {
        card.addEventListener("click", () => {
          const matchId = card.dataset.matchId;
          if (matchId) openConnectionChat(matchId, card);
        });
      });
    } catch (_) { container.innerHTML = '<div class="connections-empty">Could not load connections.</div>'; }
  }

  async function openConnectionChat(matchId, cardEl) {
    activeConnectionMatchId = matchId;
    const list = $("connections-list");
    const chatWrap = $("connection-chat-wrap");
    if (!chatWrap) return;

    const factoryName = cardEl?.querySelector(".connection-factory")?.textContent || "Factory";
    $("conn-chat-title").textContent = factoryName;

    if (list) list.hidden = true;
    chatWrap.hidden = false;

    const msgContainer = $("conn-chat-messages");
    const filesEl = $("conn-chat-files");
    if (filesEl) {
      filesEl.hidden = true;
      filesEl.innerHTML = "";
    }
    msgContainer.innerHTML = '<div class="chat-status">Loading messages\u2026</div>';

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
      if (filesEl) {
        filesEl.hidden = true;
        filesEl.innerHTML = "";
      }
    }
  }

  function closeConnectionChat() {
    activeConnectionMatchId = null;
    const list = $("connections-list");
    const chatWrap = $("connection-chat-wrap");
    const filesEl = $("conn-chat-files");
    if (filesEl) {
      filesEl.hidden = true;
      filesEl.innerHTML = "";
    }
    if (list) list.hidden = false;
    if (chatWrap) chatWrap.hidden = true;
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

  /* ── Supplier Dashboard ── */
  async function loadSupplierDashboard() {
    if (!supabaseClient || !currentUser) return;
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
              alert(e.message || "Could not accept brief");
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
              alert(e.message || "Could not decline brief");
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
            <input type="password" id="admin-pw-input" style="padding:11px 14px;border-radius:999px;border:1.5px solid var(--border);background:var(--bg);color:var(--text);font-size:14px;outline:none;width:100%;font-family:inherit;" placeholder="Password" autocomplete="current-password" />
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

  async function loadAdminOverview() {
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

    const customers = data.customers || [];
    const factories = data.factories || [];
    const connections = data.connections || [];

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
      return `<div class="project-card" style="position:relative;">
        <button class="admin-delete-btn" data-type="customer" data-id="${escapeAttr(c.id)}" title="Move to bin">&#128465;</button>
        <div class="project-card-title">${title}</div>
        ${sub ? `<div class="project-card-sub">${escapeHtml(sub)}</div>` : ""}
        <div class="project-card-desc">${escapeHtml(desc || "No description")}</div>
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
      else custEl.innerHTML = customers.map(renderCustomerCard).join("");
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

    // Wire up delete buttons (soft-delete -> move to bin)
    document.querySelectorAll(".admin-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const type = btn.getAttribute("data-type");
        const id = btn.getAttribute("data-id");
        const label = type === "customer" ? "customer" : "factory";
        if (!confirm(`Move this ${label} to the bin? You can restore or permanently delete it from the bin.`)) return;
        try {
          await fetch(`${API_BASE}/api/admin/${label === "customer" ? "customers" : "factories"}/${id}`, { method: "DELETE" });
          btn.closest(".project-card")?.remove();
        } catch (err) {
          alert("Could not delete: " + (err.message || String(err)));
        }
      });
    });

    // Load bin section
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
          await fetch(`${API_BASE}/api/admin/bin/${path}/${id}/restore`, { method: "POST" });
          await loadAdminBin();
          await loadAdminOverview();
        });
      });

      binEl.querySelectorAll(".bin-hard-delete-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const type = btn.getAttribute("data-type");
          const id = btn.getAttribute("data-id");
          if (!confirm("Permanently delete? This cannot be undone.")) return;
          const path = type === "customer" ? "customers" : "factories";
          await fetch(`${API_BASE}/api/admin/bin/${path}/${id}`, { method: "DELETE" });
          await loadAdminBin();
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
    root.innerHTML = `<div class="settings-section">
      <div class="settings-field"><label class="settings-label">Factory name</label><input type="text" id="fp-name" class="settings-input" value="${escapeAttr(factory.name)}" /></div>
      <div class="settings-field"><label class="settings-label">Location</label><input type="text" id="fp-location" class="settings-input" value="${escapeAttr(factory.location)}" /></div>
      <div class="settings-field"><label class="settings-label">Specialization</label><input type="text" id="fp-category" class="settings-input" value="${escapeAttr(factory.category)}" /></div>
      <div class="settings-field"><label class="settings-label">Capabilities</label><textarea id="fp-capabilities" class="settings-input" rows="3">${escapeHtml(c.description || "")}</textarea></div>
      <div class="settings-field"><label class="settings-label">Certifications</label><input type="text" id="fp-certifications" class="settings-input" value="${escapeAttr(c.certifications || "")}" /></div>
      <div class="settings-field"><label class="settings-label">Typical MOQ</label><input type="text" id="fp-moq" class="settings-input" value="${escapeAttr(c.moq || "")}" /></div>
      <div class="settings-field"><label class="settings-label">Contact name</label><input type="text" id="fp-contact-name" class="settings-input" value="${escapeAttr(ci.name || "")}" /></div>
      <div class="settings-field"><label class="settings-label">Contact phone</label><input type="tel" id="fp-contact-phone" class="settings-input" value="${escapeAttr(ci.phone || "")}" /></div>
      <div class="settings-field">
        <label class="settings-label">Theme</label>
        ${renderThemePills()}
      </div>
      <p class="settings-saved" id="fp-saved" hidden></p>
      <button type="button" class="btn-primary" id="fp-save">Save profile</button>
      <div style="margin-top:40px;padding-top:24px;border-top:1px solid var(--border-light);">
        <p style="font-size:13px;color:var(--text-soft);margin-bottom:10px;">Danger zone</p>
        <button type="button" class="btn-danger" id="fp-delete-profile">Delete my profile</button>
      </div></div>`;
    wireThemePills(root);
    $("fp-save")?.addEventListener("click", async () => {
      const g = (k) => ($(`fp-${k}`)?.value || "").trim();
      const saved = $("fp-saved");
      try {
        await apiCall("/api/factories/me", { method: "PUT", body: JSON.stringify({
          name: g("name"), location: g("location"), category: g("category"),
          capabilities: { description: g("capabilities"), certifications: g("certifications"), moq: g("moq") },
          contact_info: { name: g("contact-name"), phone: g("contact-phone") },
        })});
        if (saved) { saved.hidden = false; saved.textContent = "Saved."; saved.style.color = ""; setTimeout(() => { saved.hidden = true; }, 2500); }
      } catch (err) {
        if (saved) { saved.hidden = false; saved.textContent = "Error: " + (err.message || String(err)); saved.style.color = "#d93025"; }
      }
    });
    $("fp-delete-profile")?.addEventListener("click", async () => {
      if (!confirm("Delete your factory profile? It will be moved to the admin bin. You can ask support to restore it.")) return;
      try {
        await apiCall("/api/factories/me", { method: "DELETE" });
        await supabaseClient.auth.signOut();
        window.location.href = "/";
      } catch (err) {
        alert("Could not delete profile: " + (err.message || String(err)));
      }
    });
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
    setView(userRole === "supplier" ? "supplier-dashboard" : "chat");
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
