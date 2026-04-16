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
    await supabaseClient.from("user_settings").upsert({ user_id: user.id, email: user.email || "", preferred_name: displayName }, { onConflict: "user_id" });
    currentUser = { id: user.id, email: user.email || "", displayName };
    updateAuthUI();
  }

  /* ── State ── */
  let currentUser = null;
  let currentView = "onboarding";
  let userRole = null; // "startup" | "supplier"
  let isSending = false;
  let sessionBootstrapLock = false;
  let onboardStep = 0;
  let onboardData = {};
  let pendingFiles = [];

  function resetOnboardData() {
    onboardData = { role: "", fullName: "", email: "", phone: "", companyName: "", industry: "", location: "", productType: "", quantity: "", timeline: "", capabilities: "", certifications: "", moq: "", specialization: "" };
  }
  resetOnboardData();

  /* ── Helpers ── */
  function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function escapeAttr(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

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
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
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
    updateAuthUI(); setView("onboarding");
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
  }

  /* ══════════════════════════════════════
     ONBOARDING
     ══════════════════════════════════════ */
  const STARTUP_STEPS = [
    { id: "company", type: "form", title: "Tell us about your company.", sub: "Our AI remembers everything \u2014 so the factory\u2019s engineer gets full context from day one.",
      fields: [
        { key: "companyName", label: "Company name", placeholder: "Acme Inc.", required: true },
        { key: "industry", label: "Industry", placeholder: "Consumer electronics, Fashion, etc." },
        { key: "location", label: "Location", placeholder: "Berlin, Germany" },
      ] },
    { id: "needs", type: "form", title: "What do you need manufactured?", sub: "Be as specific or vague as you want. The goal is to get you a first drawing or sample as fast as possible.",
      fields: [
        { key: "productType", label: "Product type", placeholder: "Custom PCBs, Injection-molded parts, Apparel\u2026", required: true },
        { row: [
          { key: "quantity", label: "Estimated quantity", placeholder: "1,000 units" },
          { key: "timeline", label: "Timeline", placeholder: "Q3 2026" },
        ]},
      ] },
    { id: "contact", type: "form", title: "How can we reach you?", sub: "Your info is stored securely and only shared when we find a real match.",
      fields: [
        { row: [
          { key: "fullName", label: "Full name", placeholder: "Jane Doe", required: true },
          { key: "email", label: "Email", placeholder: "jane@acme.com", type: "email", required: true },
        ]},
        { key: "phone", label: "Phone (optional)", placeholder: "+49 170 1234567", type: "tel" },
      ] },
  ];

  const SUPPLIER_STEPS = [
    { id: "factory", type: "form", title: "Tell us about your factory.", sub: "Buyers never talk to sales \u2014 AI briefs your designers and engineers directly. Less overhead, faster iterations.",
      fields: [
        { key: "companyName", label: "Factory / company name", placeholder: "Shenzhen Precision Mfg.", required: true },
        { key: "location", label: "Location", placeholder: "Shenzhen, China", required: true },
        { key: "specialization", label: "Specialization", placeholder: "CNC machining, Injection molding, PCB assembly\u2026", required: true },
      ] },
    { id: "capabilities", type: "form", title: "What can you produce?", sub: "This helps our AI match you with the right projects. Be specific about what your team excels at.",
      fields: [
        { key: "capabilities", label: "Core capabilities", placeholder: "Aluminum CNC, 3-axis & 5-axis, surface finishing\u2026", type: "textarea" },
        { row: [
          { key: "certifications", label: "Certifications", placeholder: "ISO 9001, CE, UL\u2026" },
          { key: "moq", label: "Typical MOQ", placeholder: "100 units" },
        ]},
      ] },
    { id: "contact", type: "form", title: "Who should buyers work with?", sub: "We\u2019ll connect projects directly to your designer or engineer \u2014 not a sales team. This is your competitive advantage.",
      fields: [
        { row: [
          { key: "fullName", label: "Contact name", placeholder: "Wei Zhang", required: true },
          { key: "email", label: "Email", placeholder: "wei@factory.com", type: "email", required: true },
        ]},
        { key: "phone", label: "Phone / WeChat", placeholder: "+86 138 0000 0000", type: "tel" },
      ] },
  ];

  function getSteps() { return onboardData.role === "supplier" ? SUPPLIER_STEPS : STARTUP_STEPS; }

  function renderOnboardStep() {
    const stage = $("onboard-stage");
    const bar = $("onboard-bar");
    if (!stage || !bar) return;

    const steps = getSteps();
    const totalSteps = steps.length + 2; // role + steps + done
    const pct = ((onboardStep + 1) / totalSteps) * 100;
    bar.style.width = pct + "%";

    // Step 0: role selection
    if (onboardStep === 0) {
      stage.innerHTML = `
        <div class="onboard-question">
          <h1 class="onboard-title">Welcome to Airsup.</h1>
          <p class="onboard-sub">We use AI to connect startups directly with factory engineers \u2014 no sales people, no middlemen. Faster iterations, better products.</p>
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

    // Done screen
    const stepIdx = onboardStep - 1;
    if (stepIdx >= steps.length) {
      const isSupplier = onboardData.role === "supplier";
      stage.innerHTML = `
        <div class="onboard-question">
          <h1 class="onboard-title">${isSupplier ? "Your factory is live." : "You\u2019re all set."}</h1>
          <p class="onboard-sub">${isSupplier
            ? "Our AI will start sending you project briefs that match your capabilities. You\u2019ll work directly with buyers \u2014 no sales needed."
            : "Our AI now knows your business. We\u2019ll find the right factory and connect you directly with the engineer who\u2019ll build your product."}</p>
          <div class="onboard-actions">
            <button type="button" class="btn-primary btn-lg" id="onboard-go">${isSupplier ? "Go to dashboard" : "Start chatting"}</button>
          </div>
        </div>`;
      $("onboard-go")?.addEventListener("click", async () => {
        if (await ensureSession()) {
          await saveOnboardingToSupabase();
          userRole = isSupplier ? "supplier" : "startup";
          buildNav();
          setView(isSupplier ? "supplier-dashboard" : "chat");
        }
      });
      return;
    }

    // Form steps
    const step = steps[stepIdx];
    let html = `<div class="onboard-question"><h1 class="onboard-title">${step.title}</h1>`;
    if (step.sub) html += `<p class="onboard-sub">${step.sub}</p>`;
    html += '<div class="onboard-form">';
    step.fields.forEach((f) => {
      if (f.row) {
        html += '<div class="onboard-field-row">';
        f.row.forEach((rf) => {
          html += `<div class="onboard-field"><label class="onboard-label">${rf.label}</label><input class="onboard-input" data-key="${rf.key}" type="${rf.type || "text"}" placeholder="${rf.placeholder || ""}" value="${escapeAttr(onboardData[rf.key] || "")}" ${rf.required ? "required" : ""} /></div>`;
        });
        html += "</div>";
      } else if (f.type === "textarea") {
        html += `<div class="onboard-field"><label class="onboard-label">${f.label}</label><textarea class="onboard-textarea onboard-input" data-key="${f.key}" placeholder="${f.placeholder || ""}" ${f.required ? "required" : ""}>${escapeHtml(onboardData[f.key] || "")}</textarea></div>`;
      } else {
        html += `<div class="onboard-field"><label class="onboard-label">${f.label}</label><input class="onboard-input" data-key="${f.key}" type="${f.type || "text"}" placeholder="${f.placeholder || ""}" value="${escapeAttr(onboardData[f.key] || "")}" ${f.required ? "required" : ""} /></div>`;
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
    if (!supabaseClient || !currentUser) return;
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
      user_id: currentUser.id, email: d.email || currentUser.email || "",
      preferred_name: displayName, company: d.companyName, phone: d.phone,
    }, { onConflict: "user_id" });

    if (d.role === "supplier") {
      await supabaseClient.from("factories").upsert({
        user_id: currentUser.id,
        name: d.companyName,
        location: d.location,
        category: d.specialization,
        capabilities: { description: d.capabilities, certifications: d.certifications, moq: d.moq },
        contact_info: { name: d.fullName, email: d.email, phone: d.phone },
        active: true,
      }, { onConflict: "user_id" });
    } else {
      await supabaseClient.from("companies").upsert({
        user_id: currentUser.id, name: d.companyName, industry: d.industry, location: d.location,
        ai_knowledge: { role: d.role, product_type: d.productType, quantity: d.quantity, timeline: d.timeline, onboarded_at: new Date().toISOString() },
      }, { onConflict: "user_id" });
    }
    currentUser.displayName = displayName;
    updateAuthUI();
  }

  /* ── Settings ── */
  async function loadSettings() {
    const root = $("settings-root");
    if (!root) return;
    if (!(await ensureSession())) { root.innerHTML = '<p class="settings-hint">Could not load session.</p>'; return; }
    root.innerHTML = '<p class="settings-hint">Loading\u2026</p>';
    const { data: profile } = await supabaseClient.from("profiles").select("display_name, company, location, headline, bio, phone").eq("id", currentUser.id).maybeSingle();
    const { data: settings } = await supabaseClient.from("user_settings").select("email, phone, company, timezone").eq("user_id", currentUser.id).maybeSingle();
    const v = {
      displayName: profile?.display_name || currentUser.displayName || "", email: settings?.email || currentUser.email || "",
      company: profile?.company || settings?.company || "", phone: profile?.phone || settings?.phone || "",
      location: profile?.location || "", headline: profile?.headline || "", bio: profile?.bio || "",
      timezone: settings?.timezone || "Europe/Berlin",
    };
    root.innerHTML = `<div class="settings-section">
      ${[["Display name","displayName","text"],["Email","email","email"],["Company","company","text"],["Phone","phone","tel"],["Location","location","text"],["Timezone","timezone","text"]].map(([l,k,t]) =>
        `<div class="settings-field"><label class="settings-label">${l}</label><input type="${t}" id="settings-${k}" class="settings-input" value="${escapeAttr(v[k])}" ${k==="email"?"readonly":""} /></div>`).join("")}
      <div class="settings-field"><label class="settings-label">Bio</label><textarea id="settings-bio" class="settings-input" rows="3">${escapeHtml(v.bio)}</textarea></div>
      <p class="settings-saved" id="settings-saved" hidden></p>
      <button type="button" class="btn-primary" id="settings-save">Save changes</button></div>`;
    $("settings-save")?.addEventListener("click", saveSettings);
  }

  async function saveSettings() {
    if (!currentUser || !supabaseClient) return;
    const g = (k) => ($(`settings-${k}`)?.value || "").trim();
    const dn = g("displayName") || currentUser.displayName;
    const { error: pe } = await supabaseClient.from("profiles").upsert({ id: currentUser.id, display_name: dn, avatar_letter: (dn||"?").charAt(0).toUpperCase(), company: g("company"), phone: g("phone"), location: g("location"), bio: g("bio") }, { onConflict: "id" });
    const { error: se } = await supabaseClient.from("user_settings").upsert({ user_id: currentUser.id, email: currentUser.email||"", company: g("company"), phone: g("phone"), timezone: g("timezone")||"Europe/Berlin", preferred_name: dn }, { onConflict: "user_id" });
    const saved = $("settings-saved");
    if (pe || se) { if (saved) { saved.hidden = false; saved.textContent = "Error: " + (pe?.message||se?.message||""); saved.style.color = "#d93025"; } return; }
    currentUser.displayName = dn; updateAuthUI();
    if (saved) { saved.hidden = false; saved.textContent = "Saved."; saved.style.color = ""; setTimeout(() => { saved.hidden = true; }, 2500); }
  }

  /* ── Chat ── */
  function appendMessage(role, text) {
    $("chat-welcome")?.remove();
    const container = $("chat-messages");
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble chat-bubble--${role}`;
    if (role === "assistant") { bubble.innerHTML = simpleMarkdown(text); } else { bubble.textContent = text; }
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
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
    if (!text || isSending) return;
    if (!(await ensureSession())) return;

    isSending = true;
    input.value = ""; input.style.height = "auto";
    $("chat-send").disabled = true;

    let msgText = text;
    if (pendingFiles.length) {
      msgText += "\n\n[Attached files: " + pendingFiles.map((f) => f.name).join(", ") + "]";
      pendingFiles = [];
      renderPendingFiles();
    }

    appendMessage("user", msgText);
    appendStatus("AI is analyzing your request\u2026");
    showTyping();

    try {
      const { reply } = await apiCall("/api/chat", { method: "POST", body: JSON.stringify({ message: msgText }) });
      hideTyping();
      document.querySelectorAll(".chat-status").forEach((el) => el.remove());
      appendMessage("assistant", reply);
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
    try {
      const { messages } = await apiCall("/api/chat/history");
      if (messages?.length) {
        container.innerHTML = "";
        messages.forEach((m) => appendMessage(m.role, m.content));
      }
    } catch (_) {}
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
    try {
      const { projects } = await apiCall("/api/projects");
      if (!projects?.length) { container.innerHTML = '<div class="projects-empty">No projects yet. Start a conversation to create one.</div>'; return; }
      container.innerHTML = projects.map((p) => {
        const s = p.ai_summary || {};
        const reqs = [s.quantity, s.budget, s.timeline].filter(Boolean);
        return `<div class="project-card" data-id="${p.id}"><div class="project-card-title">${escapeHtml(p.title)}</div><div class="project-card-desc">${escapeHtml(p.description || "")}</div>${reqs.length ? `<div class="project-card-reqs">${reqs.map(r=>escapeHtml(r)).join(" \u00b7 ")}</div>` : ""}<div class="project-card-meta"><span class="project-card-badge badge--${p.status}">${p.status.replace(/_/g," ")}</span></div></div>`;
      }).join("");
      container.querySelectorAll(".project-card").forEach((c) => c.addEventListener("click", () => { if (c.dataset.id) loadProjectDetail(c.dataset.id); }));
    } catch (_) { container.innerHTML = '<div class="projects-empty">Could not load projects.</div>'; }
  }

  async function loadProjectDetail(id) {
    const container = $("projects-list"), lead = $("projects-lead");
    try {
      const { project } = await apiCall(`/api/projects/${id}`);
      if (lead) lead.innerHTML = '<button type="button" class="btn-outline" id="projects-back" style="font-size:13px;padding:8px 16px;">&larr; Back</button>';
      const s = project.ai_summary || {}, m = project.matches || [];
      container.innerHTML = `<div><h2 style="font-size:22px;font-weight:600;margin-bottom:4px;">${escapeHtml(project.title)}</h2><p style="color:var(--text-muted);margin-bottom:16px;">${escapeHtml(project.description||"")}</p><span class="project-card-badge badge--${project.status}">${project.status.replace(/_/g," ")}</span>${s.product?`<div style="margin:16px 0;"><strong>Product:</strong> ${escapeHtml(s.product)}</div>`:""}</div>`;
      $("projects-back")?.addEventListener("click", () => { if (lead) lead.textContent = "Sourcing requests created from your conversations."; loadProjects(); });
    } catch (_) {}
  }

  /* ── Connections ── */
  async function loadConnections() {
    const container = $("connections-list");
    try {
      const { matches } = await apiCall("/api/matches");
      if (!matches?.length) { container.innerHTML = '<div class="connections-empty">No connections yet. Once AI matches you with a factory, you\u2019ll get a direct line to their engineer here.</div>'; return; }
      container.innerHTML = matches.map((m) => {
        const f = m.factories, p = m.projects, ctx = m.context_summary || {};
        const contact = ctx.direct_contact || {};
        const contactLine = contact.name ? `${contact.name}${contact.role ? ` \u00b7 ${contact.role}` : ""}` : "";
        const iter = ctx.iteration_terms || {};
        const q = m.quote || {};
        return `<div class="connection-card"><div class="connection-header"><div class="connection-header-left"><span class="connection-factory">${escapeHtml(f?.name||"Factory")}</span><span class="connection-location">${escapeHtml(f?.location||"")}</span></div><span class="project-card-badge badge--${m.status}">${m.status.replace(/_/g," ")}</span></div>${contactLine?`<div class="connection-summary-bar" style="font-weight:500;">Your contact: ${escapeHtml(contactLine)}</div>`:""}<div class="connection-summary-bar">${escapeHtml(ctx.short||"Connection established")}</div><div class="connection-body"><div class="connection-project-line">Project: ${escapeHtml(p?.title||"")}</div>${q.unit_price?`<div class="connection-quote">${escapeHtml(q.unit_price)}/unit \u00b7 ${escapeHtml(q.lead_time||"TBD")}</div>`:""}</div></div>`;
      }).join("");
    } catch (_) { container.innerHTML = '<div class="connections-empty">Could not load connections.</div>'; }
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

    const { data: outreach } = await supabaseClient.from("outreach_logs").select("id, stage, outcome, factory_searches(projects(title, description, status))").eq("factory_id", factory.id).order("created_at", { ascending: false }).limit(20);
    const { data: matches } = await supabaseClient.from("matches").select("id, status, quote, context_summary, projects(title, description)").eq("factory_id", factory.id).order("created_at", { ascending: false }).limit(20);

    const briefCount = (outreach || []).filter((o) => o.stage === "briefed" || o.stage === "quoted").length;
    const activeCount = (matches || []).filter((m) => m.status !== "cancelled").length;

    if (stats) stats.innerHTML = `<div class="stat-card"><div class="stat-value">${briefCount}</div><div class="stat-label">Incoming briefs</div></div><div class="stat-card"><div class="stat-value">${activeCount}</div><div class="stat-label">Active projects</div></div><div class="stat-card"><div class="stat-value">0</div><div class="stat-label">Completed</div></div>`;

    if (briefs) {
      if (!outreach?.length) { briefs.innerHTML = '<div class="projects-empty">No incoming briefs yet. Our AI will send matching projects as buyers describe them.</div>'; }
      else {
        briefs.innerHTML = outreach.map((o) => {
          const proj = o.factory_searches?.projects;
          return `<div class="project-card"><div class="project-card-title">${escapeHtml(proj?.title || "Untitled project")}</div><div class="project-card-desc">${escapeHtml(o.outcome || proj?.description || "")}</div><div class="project-card-meta"><span class="project-card-badge badge--${o.stage}">${o.stage}</span></div></div>`;
        }).join("");
      }
    }

    if (active) {
      if (!matches?.length) { active.innerHTML = '<div class="projects-empty">No active projects yet.</div>'; }
      else {
        active.innerHTML = matches.map((m) => {
          const p = m.projects;
          const q = m.quote || {};
          return `<div class="project-card"><div class="project-card-title">${escapeHtml(p?.title || "Project")}</div><div class="project-card-desc">${escapeHtml(m.context_summary?.short || p?.description || "")}</div>${q.unit_price ? `<div class="project-card-reqs">${escapeHtml(q.unit_price)}/unit</div>` : ""}<div class="project-card-meta"><span class="project-card-badge badge--${m.status}">${m.status.replace(/_/g," ")}</span></div></div>`;
        }).join("");
      }
    }
  }

  async function loadSupplierProfile() {
    const root = $("supplier-profile-root");
    if (!root || !supabaseClient || !currentUser) return;
    root.innerHTML = '<p class="settings-hint">Loading\u2026</p>';
    const { data: factory } = await supabaseClient.from("factories").select("*").eq("user_id", currentUser.id).maybeSingle();
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
      <div class="settings-field"><label class="settings-label">Contact email</label><input type="email" id="fp-contact-email" class="settings-input" value="${escapeAttr(ci.email || "")}" /></div>
      <div class="settings-field"><label class="settings-label">Contact phone</label><input type="tel" id="fp-contact-phone" class="settings-input" value="${escapeAttr(ci.phone || "")}" /></div>
      <p class="settings-saved" id="fp-saved" hidden></p>
      <button type="button" class="btn-primary" id="fp-save">Save profile</button></div>`;
    $("fp-save")?.addEventListener("click", async () => {
      const g = (k) => ($(`fp-${k}`)?.value || "").trim();
      const { error } = await supabaseClient.from("factories").update({
        name: g("name"), location: g("location"), category: g("category"),
        capabilities: { description: g("capabilities"), certifications: g("certifications"), moq: g("moq") },
        contact_info: { name: g("contact-name"), email: g("contact-email"), phone: g("contact-phone") },
      }).eq("user_id", currentUser.id);
      const saved = $("fp-saved");
      if (error) { if (saved) { saved.hidden = false; saved.textContent = "Error: " + error.message; saved.style.color = "#d93025"; } return; }
      if (saved) { saved.hidden = false; saved.textContent = "Saved."; saved.style.color = ""; setTimeout(() => { saved.hidden = true; }, 2500); }
    });
  }

  /* ── Event wiring ── */
  $("logo-home")?.addEventListener("click", () => {
    if (!currentUser) { setView("onboarding"); return; }
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

  /* ── Init ── */
  updateAuthUI();
  setupAuthListener();
  ensureSession().then(() => initAuthState());
})();
