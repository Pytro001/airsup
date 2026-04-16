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

    await supabaseClient.from("profiles").upsert(
      { id: user.id, display_name: displayName, avatar_letter: letter },
      { onConflict: "id" }
    );
    await supabaseClient.from("user_settings").upsert(
      { user_id: user.id, email: user.email || "", preferred_name: displayName },
      { onConflict: "user_id" }
    );

    currentUser = { id: user.id, email: user.email || "", displayName };
    updateAuthUI();
  }

  /* ── State ── */
  let currentUser = null;
  let currentView = "onboarding";
  let isSending = false;
  let sessionBootstrapLock = false;
  let onboardStep = 0;
  let onboardData = { role: "", fullName: "", email: "", phone: "", companyName: "", industry: "", location: "", productType: "", quantity: "", timeline: "" };

  /* ── Helpers ── */
  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function showAuthBanner(message) {
    const el = $("auth-banner");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  }

  function hideAuthBanner() {
    const el = $("auth-banner");
    if (el) { el.hidden = true; el.textContent = ""; }
  }

  async function ensureSession() {
    hideAuthBanner();
    if (currentUser) return true;
    if (!supabaseClient) {
      showAuthBanner("Add your Supabase anon key in config.js.");
      return false;
    }
    if (sessionBootstrapLock) return false;
    const { data: sess0 } = await supabaseClient.auth.getSession();
    if (sess0?.session?.user) {
      await syncUserProfileFromAuth(sess0.session.user);
      return true;
    }
    sessionBootstrapLock = true;
    try {
      const { data, error } = await supabaseClient.auth.signInAnonymously();
      if (error) {
        showAuthBanner("Enable Anonymous sign-ins in Supabase → Authentication → Providers, then reload.");
        return false;
      }
      if (data?.user) await syncUserProfileFromAuth(data.user);
      return true;
    } finally {
      sessionBootstrapLock = false;
    }
  }

  async function handleSignOut() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    currentUser = null;
    onboardStep = 0;
    onboardData = { role: "", fullName: "", email: "", phone: "", companyName: "", industry: "", location: "", productType: "", quantity: "", timeline: "" };
    updateAuthUI();
    setView("onboarding");
  }

  /* ── Auth state ── */
  function updateAuthUI() {
    const loggedIn = !!currentUser;
    const account = $("header-account");
    if (account) account.hidden = !loggedIn;
    const avatarEl = $("avatar-letter");
    const avatarBtn = $("user-menu-trigger");
    if (loggedIn) {
      const letter = (currentUser.displayName || currentUser.email || "?").charAt(0).toUpperCase();
      if (avatarEl) avatarEl.textContent = letter;
      if (avatarBtn) avatarBtn.classList.remove("avatar-btn--anon");
    } else {
      if (avatarEl) avatarEl.textContent = "?";
      if (avatarBtn) avatarBtn.classList.add("avatar-btn--anon");
    }
    const nav = $("header-nav");
    if (nav) nav.style.display = loggedIn ? "" : "none";
  }

  function setupAuthListener() {
    if (!supabaseClient) return;
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        syncUserProfileFromAuth(session.user);
      } else if (event === "SIGNED_OUT") {
        currentUser = null;
        updateAuthUI();
      }
    });
  }

  async function initAuthState() {
    if (!supabaseClient) return;
    const hash = window.location.hash;
    if (hash && (hash.includes("access_token") || hash.includes("error"))) {
      const { data } = await supabaseClient.auth.getSession();
      if (data?.session) window.history.replaceState(null, "", window.location.pathname);
    }
    const { data } = await supabaseClient.auth.getSession();
    if (data?.session?.user) {
      await syncUserProfileFromAuth(data.session.user);
      const { data: profile } = await supabaseClient.from("profiles").select("company, headline").eq("id", currentUser.id).maybeSingle();
      if (profile?.company || profile?.headline) {
        setView("chat");
      } else {
        setView("onboarding");
      }
    }
  }

  /* ── View switching ── */
  function setView(name) {
    currentView = name;
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    const page = $(`page-${name}`);
    if (page) page.classList.add("active");

    document.querySelectorAll(".nav-link").forEach((n) => {
      n.classList.toggle("active", n.getAttribute("data-view") === name);
    });

    if (name === "chat") loadChatHistory();
    if (name === "projects") loadProjects();
    if (name === "connections") loadConnections();
    if (name === "settings") void loadSettings();
    if (name === "onboarding") renderOnboardStep();
  }

  /* ══════════════════════════════════════
     ONBOARDING — animated step-by-step
     ══════════════════════════════════════ */
  const ONBOARD_STEPS = [
    { id: "role", type: "choices", title: "How would you describe yourself?", sub: "We'll connect you directly with the right engineer or designer at the factory — no sales people in between.",
      choices: [
        { value: "founder", label: "I'm a Founder / Business Owner" },
        { value: "procurement", label: "I work in Procurement" },
        { value: "designer", label: "I'm a Product Designer" },
        { value: "engineer", label: "I'm an Engineer" },
        { value: "other", label: "Other" },
      ] },
    { id: "company", type: "form", title: "Tell us about your company.", sub: "The AI remembers everything — so the factory's engineer gets full context from day one.",
      fields: [
        { key: "companyName", label: "Company name", placeholder: "Acme Inc.", required: true },
        { key: "industry", label: "Industry", placeholder: "Consumer electronics, Fashion, etc." },
        { key: "location", label: "Location", placeholder: "Berlin, Germany" },
      ] },
    { id: "needs", type: "form", title: "What do you need manufactured?", sub: "Be as specific or vague as you want. The goal is to get you a first drawing or sample as fast as possible.",
      fields: [
        { key: "productType", label: "Product type", placeholder: "Custom PCBs, Injection-molded parts, Apparel…", required: true },
        { row: [
          { key: "quantity", label: "Estimated quantity", placeholder: "1,000 units" },
          { key: "timeline", label: "Timeline", placeholder: "Q3 2026" },
        ]},
      ] },
    { id: "contact", type: "form", title: "Last step — how can we reach you?", sub: "Your info is stored securely and only shared when we find a real match.",
      fields: [
        { row: [
          { key: "fullName", label: "Full name", placeholder: "Jane Doe", required: true },
          { key: "email", label: "Email", placeholder: "jane@acme.com", type: "email", required: true },
        ]},
        { key: "phone", label: "Phone (optional)", placeholder: "+49 170 1234567", type: "tel" },
      ] },
  ];

  function renderOnboardStep() {
    const stage = $("onboard-stage");
    const bar = $("onboard-bar");
    if (!stage || !bar) return;

    const pct = ((onboardStep + 1) / (ONBOARD_STEPS.length + 1)) * 100;
    bar.style.width = pct + "%";

    if (onboardStep >= ONBOARD_STEPS.length) {
      stage.innerHTML = `
        <div class="onboard-question">
          <h1 class="onboard-title">You're all set.</h1>
          <p class="onboard-sub">Our AI now knows your business. We'll find the right factory and connect you directly with the engineer who'll work on your product — no sales middleman.</p>
          <div class="onboard-actions">
            <button type="button" class="btn-primary btn-lg" id="onboard-go">Start chatting</button>
          </div>
        </div>`;
      $("onboard-go")?.addEventListener("click", async () => {
        if (await ensureSession()) {
          await saveOnboardingToSupabase();
          setView("chat");
        }
      });
      return;
    }

    const step = ONBOARD_STEPS[onboardStep];
    let html = `<div class="onboard-question"><h1 class="onboard-title">${step.title}</h1>`;
    if (step.sub) html += `<p class="onboard-sub">${step.sub}</p>`;

    if (step.type === "choices") {
      html += '<div class="onboard-choices">';
      step.choices.forEach((c) => {
        const sel = onboardData.role === c.value ? " selected" : "";
        html += `<button type="button" class="onboard-choice${sel}" data-value="${c.value}">${c.label}</button>`;
      });
      html += "</div>";
    } else if (step.type === "form") {
      html += '<div class="onboard-form">';
      step.fields.forEach((f) => {
        if (f.row) {
          html += '<div class="onboard-field-row">';
          f.row.forEach((rf) => {
            html += `<div class="onboard-field"><label class="onboard-label">${rf.label}</label><input class="onboard-input" data-key="${rf.key}" type="${rf.type || "text"}" placeholder="${rf.placeholder || ""}" value="${escapeAttr(onboardData[rf.key])}" ${rf.required ? "required" : ""} /></div>`;
          });
          html += "</div>";
        } else {
          html += `<div class="onboard-field"><label class="onboard-label">${f.label}</label><input class="onboard-input" data-key="${f.key}" type="${f.type || "text"}" placeholder="${f.placeholder || ""}" value="${escapeAttr(onboardData[f.key])}" ${f.required ? "required" : ""} /></div>`;
        }
      });
      html += "</div>";
      html += '<div class="onboard-actions"><button type="button" class="btn-primary" id="onboard-next">Continue</button>';
      if (onboardStep > 0) html += '<button type="button" class="onboard-skip" id="onboard-back">Back</button>';
      html += "</div>";
    }

    html += "</div>";
    stage.innerHTML = html;

    if (step.type === "choices") {
      stage.querySelectorAll(".onboard-choice").forEach((btn) => {
        btn.addEventListener("click", () => {
          onboardData.role = btn.dataset.value;
          onboardStep++;
          renderOnboardStep();
        });
      });
    } else {
      $("onboard-next")?.addEventListener("click", () => {
        stage.querySelectorAll(".onboard-input").forEach((inp) => {
          onboardData[inp.dataset.key] = inp.value.trim();
        });
        const reqInputs = stage.querySelectorAll(".onboard-input[required]");
        for (const inp of reqInputs) {
          if (!inp.value.trim()) { inp.focus(); return; }
        }
        onboardStep++;
        renderOnboardStep();
      });
      $("onboard-back")?.addEventListener("click", () => {
        stage.querySelectorAll(".onboard-input").forEach((inp) => {
          onboardData[inp.dataset.key] = inp.value.trim();
        });
        onboardStep--;
        renderOnboardStep();
      });
      const firstInput = stage.querySelector(".onboard-input");
      if (firstInput) setTimeout(() => firstInput.focus(), 100);
    }
  }

  async function saveOnboardingToSupabase() {
    if (!supabaseClient || !currentUser) return;
    const d = onboardData;
    const displayName = d.fullName || currentUser.displayName;
    const letter = (displayName || "?").charAt(0).toUpperCase();

    await supabaseClient.from("profiles").upsert({
      id: currentUser.id,
      display_name: displayName,
      avatar_letter: letter,
      company: d.companyName,
      location: d.location,
      headline: d.role,
      phone: d.phone,
    }, { onConflict: "id" });

    await supabaseClient.from("user_settings").upsert({
      user_id: currentUser.id,
      email: d.email || currentUser.email || "",
      preferred_name: displayName,
      company: d.companyName,
      phone: d.phone,
    }, { onConflict: "user_id" });

    await supabaseClient.from("companies").upsert({
      user_id: currentUser.id,
      name: d.companyName,
      industry: d.industry,
      location: d.location,
      ai_knowledge: {
        role: d.role,
        product_type: d.productType,
        quantity: d.quantity,
        timeline: d.timeline,
        onboarded_at: new Date().toISOString(),
      },
    }, { onConflict: "user_id" });

    currentUser.displayName = displayName;
    updateAuthUI();
  }

  /* ── Settings ── */
  async function loadSettings() {
    const root = $("settings-root");
    if (!root) return;
    if (!(await ensureSession())) {
      root.innerHTML = '<p class="settings-hint">Could not load session.</p>';
      return;
    }
    root.innerHTML = '<p class="settings-hint">Loading…</p>';

    const { data: profile } = await supabaseClient.from("profiles").select("display_name, company, location, headline, bio, phone").eq("id", currentUser.id).maybeSingle();
    const { data: settings } = await supabaseClient.from("user_settings").select("email, phone, company, timezone").eq("user_id", currentUser.id).maybeSingle();

    const vals = {
      displayName: profile?.display_name || currentUser.displayName || "",
      email: settings?.email || currentUser.email || "",
      company: profile?.company || settings?.company || "",
      phone: profile?.phone || settings?.phone || "",
      location: profile?.location || "",
      headline: profile?.headline || "",
      bio: profile?.bio || "",
      timezone: settings?.timezone || "Europe/Berlin",
    };

    root.innerHTML = `
      <div class="settings-section">
        ${Object.entries({
          "Display name": ["displayName", "text"],
          "Email": ["email", "email"],
          "Company": ["company", "text"],
          "Phone": ["phone", "tel"],
          "Location": ["location", "text"],
          "Headline": ["headline", "text"],
          "Timezone": ["timezone", "text"],
        }).map(([label, [key, type]]) => `
          <div class="settings-field">
            <label class="settings-label">${label}</label>
            <input type="${type}" id="settings-${key}" class="settings-input" value="${escapeAttr(vals[key])}" ${key === "email" ? "readonly" : ""} />
          </div>`).join("")}
        <div class="settings-field">
          <label class="settings-label">Bio</label>
          <textarea id="settings-bio" class="settings-input" rows="3">${escapeHtml(vals.bio)}</textarea>
        </div>
        <p class="settings-saved" id="settings-saved" hidden></p>
        <button type="button" class="btn-primary" id="settings-save">Save changes</button>
      </div>`;
    $("settings-save")?.addEventListener("click", saveSettings);
  }

  async function saveSettings() {
    if (!currentUser || !supabaseClient) return;
    const g = (key) => ($(`settings-${key}`)?.value || "").trim();
    const displayName = g("displayName") || currentUser.displayName;
    const letter = (displayName || "?").charAt(0).toUpperCase();

    const { error: pe } = await supabaseClient.from("profiles").upsert({
      id: currentUser.id, display_name: displayName, avatar_letter: letter,
      company: g("company"), phone: g("phone"), location: g("location"),
      headline: g("headline"), bio: g("bio"),
    }, { onConflict: "id" });

    const { error: se } = await supabaseClient.from("user_settings").upsert({
      user_id: currentUser.id, email: currentUser.email || "",
      company: g("company"), phone: g("phone"),
      timezone: g("timezone") || "Europe/Berlin", preferred_name: displayName,
    }, { onConflict: "user_id" });

    const saved = $("settings-saved");
    if (pe || se) {
      if (saved) { saved.hidden = false; saved.textContent = "Could not save. " + (pe?.message || se?.message || ""); saved.style.color = "#d93025"; }
      return;
    }
    currentUser.displayName = displayName;
    updateAuthUI();
    if (saved) { saved.hidden = false; saved.textContent = "Saved."; saved.style.color = ""; setTimeout(() => { saved.hidden = true; }, 2500); }
  }

  /* ── Chat ── */
  function appendMessage(role, text) {
    const welcome = $("chat-welcome");
    if (welcome) welcome.remove();
    const container = $("chat-messages");
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble chat-bubble--${role}`;
    if (role === "assistant") { bubble.innerHTML = simpleMarkdown(text); } else { bubble.textContent = text; }
    container.appendChild(bubble);
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
    if (!text || isSending) return;
    if (!(await ensureSession())) return;

    isSending = true;
    input.value = "";
    input.style.height = "auto";
    $("chat-send").disabled = true;
    appendMessage("user", text);
    showTyping();

    try {
      const { reply } = await apiCall("/api/chat", { method: "POST", body: JSON.stringify({ message: text }) });
      hideTyping();
      appendMessage("assistant", reply);
    } catch (err) {
      hideTyping();
      appendMessage("assistant", "Sorry, something went wrong. Please try again.");
      console.error("[Airsup] chat error:", err);
    }

    isSending = false;
    $("chat-send").disabled = !input.value.trim();
  }

  async function loadChatHistory() {
    const container = $("chat-messages");
    try {
      const { messages } = await apiCall("/api/chat/history");
      if (messages?.length) {
        container.innerHTML = "";
        messages.forEach((m) => appendMessage(m.role, m.content));
      }
    } catch (_) {}
  }

  /* ── Projects ── */
  async function loadProjects() {
    const container = $("projects-list");
    try {
      const { projects } = await apiCall("/api/projects");
      if (!projects?.length) {
        container.innerHTML = '<div class="projects-empty">No projects yet. Start a conversation to create one.</div>';
        return;
      }
      container.innerHTML = projects.map((p) => {
        const summary = p.ai_summary || {};
        const reqs = [summary.quantity, summary.budget, summary.timeline].filter(Boolean);
        const reqLine = reqs.length ? `<div class="project-card-reqs">${reqs.map((r) => escapeHtml(r)).join(" · ")}</div>` : "";
        return `
        <div class="project-card" data-id="${p.id}">
          <div class="project-card-title">${escapeHtml(p.title)}</div>
          <div class="project-card-desc">${escapeHtml(p.description || "")}</div>
          ${reqLine}
          <div class="project-card-meta">
            <span class="project-card-badge badge--${p.status}">${p.status.replace(/_/g, " ")}</span>
          </div>
        </div>`;
      }).join("");
      container.querySelectorAll(".project-card").forEach((card) => {
        card.addEventListener("click", () => { const id = card.dataset.id; if (id) loadProjectDetail(id); });
      });
    } catch (err) {
      container.innerHTML = '<div class="projects-empty">Could not load projects.</div>';
    }
  }

  async function loadProjectDetail(id) {
    const container = $("projects-list");
    const lead = $("projects-lead");
    try {
      const { project } = await apiCall(`/api/projects/${id}`);
      if (lead) lead.innerHTML = '<button type="button" class="btn-outline" id="projects-back" style="font-size:13px;padding:8px 16px;">&larr; Back</button>';
      const summary = project.ai_summary || {};
      const matches = project.matches || [];
      container.innerHTML = `
        <div>
          <h2 style="font-size:22px;font-weight:600;margin-bottom:4px;">${escapeHtml(project.title)}</h2>
          <p style="color:var(--text-muted);margin-bottom:16px;">${escapeHtml(project.description || "")}</p>
          <span class="project-card-badge badge--${project.status}">${project.status.replace(/_/g, " ")}</span>
          ${summary.product ? `<div style="margin:16px 0;"><strong>Product:</strong> ${escapeHtml(summary.product)}</div>` : ""}
          ${matches.length ? `<h3 style="font-size:16px;font-weight:600;margin:24px 0 12px;">Matches (${matches.length})</h3>${matches.map((m) => `<div class="connection-card" style="margin-bottom:8px;"><div class="connection-header"><div class="connection-header-left"><span class="connection-factory">${escapeHtml(m.factories?.name || "Factory")}</span><span class="connection-location">${escapeHtml(m.factories?.location || "")}</span></div><span class="project-card-badge badge--${m.status}">${m.status.replace(/_/g, " ")}</span></div></div>`).join("")}` : ""}
        </div>`;
      $("projects-back")?.addEventListener("click", () => { if (lead) lead.textContent = "Sourcing requests created from your conversations."; loadProjects(); });
    } catch (err) { console.error("[Airsup] loadProjectDetail:", err); }
  }

  /* ── Connections ── */
  async function loadConnections() {
    const container = $("connections-list");
    try {
      const { matches } = await apiCall("/api/matches");
      if (!matches?.length) {
        container.innerHTML = '<div class="connections-empty">No connections yet. Once AI matches you with a factory, you\'ll get a direct line to their designer or engineer here.</div>';
        return;
      }
      container.innerHTML = matches.map((m) => {
        const factory = m.factories;
        const project = m.projects;
        const ctx = m.context_summary || {};
        const summary = ctx.short || "Connection established";
        const nextSteps = ctx.next_steps || "";
        const contact = ctx.direct_contact || {};
        const contactLine = contact.name ? `${contact.name}${contact.role ? ` · ${contact.role}` : ""}` : "";
        const iter = ctx.iteration_terms || {};
        const iterLine = iter.first_deliverable ? `First: ${iter.first_deliverable}${iter.first_deliverable_timeline ? ` (${iter.first_deliverable_timeline})` : ""}` : "";
        const freeIter = iter.free_iterations ? `${iter.free_iterations} free iterations` : "";
        const quote = m.quote || {};
        const quoteLine = quote.unit_price ? `${quote.unit_price}/unit · ${quote.lead_time || "TBD"}` : "";
        return `
        <div class="connection-card">
          <div class="connection-header">
            <div class="connection-header-left">
              <span class="connection-factory">${escapeHtml(factory?.name || "Factory")}</span>
              <span class="connection-location">${escapeHtml(factory?.location || "")}</span>
            </div>
            <span class="project-card-badge badge--${m.status}">${m.status.replace(/_/g, " ")}</span>
          </div>
          ${contactLine ? `<div class="connection-summary-bar" style="font-weight:500;">Your contact: ${escapeHtml(contactLine)}</div>` : ""}
          <div class="connection-summary-bar">${escapeHtml(summary)}</div>
          <div class="connection-body">
            <div class="connection-project-line">Project: ${escapeHtml(project?.title || "")}</div>
            ${quoteLine ? `<div class="connection-quote">${escapeHtml(quoteLine)}</div>` : ""}
            ${iterLine ? `<div class="connection-next">${escapeHtml(iterLine)}${freeIter ? ` · ${escapeHtml(freeIter)}` : ""}</div>` : ""}
            ${nextSteps ? `<div class="connection-next">Next: ${escapeHtml(nextSteps)}</div>` : ""}
          </div>
          <div class="connection-actions">
            <button type="button" class="btn-outline" style="font-size:13px;padding:8px 16px;" onclick="document.querySelectorAll('.nav-link')[0].click()">Discuss with AI</button>
          </div>
        </div>`;
      }).join("");
    } catch (err) {
      container.innerHTML = '<div class="connections-empty">Could not load connections.</div>';
    }
  }

  /* ── Event wiring ── */
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.getAttribute("data-view");
      if (view) ensureSession().then((ok) => { if (ok) setView(view); });
    });
  });

  $("logo-home")?.addEventListener("click", () => {
    setView(currentUser ? "chat" : "onboarding");
  });

  $("user-menu-trigger")?.addEventListener("click", () => {
    const dd = $("user-menu-dropdown");
    if (dd) dd.hidden = !dd.hidden;
  });
  document.addEventListener("click", (e) => {
    const dd = $("user-menu-dropdown");
    if (dd && !dd.hidden && !e.target.closest("#user-menu-trigger") && !e.target.closest("#user-menu-dropdown")) dd.hidden = true;
  });
  $("menu-settings")?.addEventListener("click", () => { $("user-menu-dropdown").hidden = true; setView("settings"); });
  $("menu-signout")?.addEventListener("click", () => { $("user-menu-dropdown").hidden = true; handleSignOut(); });

  const chatInput = $("chat-input");
  const chatSend = $("chat-send");
  chatInput?.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + "px";
    chatSend.disabled = !chatInput.value.trim();
  });
  chatInput?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  chatSend?.addEventListener("click", sendMessage);

  /* ── Init ── */
  updateAuthUI();
  setupAuthListener();
  ensureSession().then(() => initAuthState());
})();
