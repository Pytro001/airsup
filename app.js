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

  /** Sync auth user into public.profiles + public.user_settings (RLS allows own row). */
  async function syncUserProfileFromAuth(user) {
    if (!supabaseClient || !user) return;
    const meta = user.user_metadata || {};
    const displayName = String(
      meta.full_name || meta.name || meta.preferred_username || user.email?.split("@")[0] || ""
    ).trim() || "User";
    const letter = displayName.charAt(0).toUpperCase();

    const { error: pe } = await supabaseClient.from("profiles").upsert(
      { id: user.id, display_name: displayName, avatar_letter: letter },
      { onConflict: "id" }
    );
    if (pe) console.warn("[Airsup] profiles sync:", pe);

    const { error: se } = await supabaseClient.from("user_settings").upsert(
      { user_id: user.id, email: user.email || "", preferred_name: displayName },
      { onConflict: "user_id" }
    );
    if (se) console.warn("[Airsup] user_settings sync:", se);

    currentUser = { id: user.id, email: user.email, displayName };
    updateAuthUI();
  }

  /* ── State ── */
  let currentUser = null;
  let currentView = "landing";
  let pendingAuthCallback = null;
  let authModalTab = "login";
  let isSending = false;
  let authRequestInFlight = false;

  /* ── Helpers ── */
  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
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

  /* ── Auth modal ── */
  function openAuthModal(tab, callback) {
    authModalTab = tab || "login";
    pendingAuthCallback = callback || null;
    $("auth-modal").hidden = false;
    document.body.style.overflow = "hidden";
    syncAuthModalTab();
    const nameField = $("auth-name-field");
    if (nameField) nameField.hidden = authModalTab !== "signup";
    $("auth-error")?.setAttribute("hidden", "");
    $("auth-email")?.focus();
  }

  function closeAuthModal() {
    $("auth-modal").hidden = true;
    document.body.style.overflow = "";
    $("auth-form")?.reset();
    $("auth-error")?.setAttribute("hidden", "");
  }

  function syncAuthModalTab() {
    document.querySelectorAll(".auth-tab").forEach((t) => {
      const tab = t.getAttribute("data-auth-tab");
      t.classList.toggle("active", tab === authModalTab);
      t.setAttribute("aria-selected", String(tab === authModalTab));
    });
    const nameField = $("auth-name-field");
    if (nameField) nameField.hidden = authModalTab !== "signup";
    const pwdInput = $("auth-password");
    if (pwdInput) pwdInput.autocomplete = authModalTab === "signup" ? "new-password" : "current-password";
    const submitBtn = $("auth-submit");
    if (submitBtn) submitBtn.textContent = authModalTab === "signup" ? "Sign up" : "Log in";
  }

  function formatAuthError(err) {
    const raw = err?.message || String(err || "");
    const m = raw.toLowerCase();
    const code = err?.code || "";
    if (
      code === "over_email_send_rate_limit" ||
      code === "too_many_requests" ||
      m.includes("rate limit") ||
      m.includes("email rate") ||
      m.includes("too many requests") ||
      err?.status === 429
    ) {
      return (
        "Supabase hit its email / auth rate limit (this is not fixed by SQL migrations). Do this:\n\n" +
        "1) Authentication → Providers → Email → turn OFF “Confirm email” (stops confirmation emails on every sign-up).\n" +
        "2) Wait 30–60 minutes for the limit to reset, or use “Continue with Google”.\n" +
        "3) Optional: Authentication → Rate Limits — relax signup / email settings.\n" +
        "4) For higher email volume long-term, add Custom SMTP in Authentication → Emails."
      );
    }
    return raw;
  }

  function showAuthError(msg) {
    const el = $("auth-error");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }

  function requireAuth(callback) {
    if (currentUser) { callback(); return; }
    openAuthModal("login", callback);
  }

  async function handleEmailAuth(e) {
    e.preventDefault();
    if (authRequestInFlight) return;
    if (!supabaseClient) return showAuthError("Supabase not configured. Set your anon key in config.js.");
    const email = ($("auth-email")?.value || "").trim();
    const password = $("auth-password")?.value || "";
    if (!email || !password) return showAuthError("Email and password are required.");
    const submitBtn = $("auth-submit");
    authRequestInFlight = true;
    if (submitBtn) submitBtn.disabled = true;
    $("auth-error")?.setAttribute("hidden", "");

    try {
      let result;
      if (authModalTab === "signup") {
        const name = ($("auth-name")?.value || "").trim();
        result = await supabaseClient.auth.signUp({
          email, password,
          options: {
            data: { full_name: name || email.split("@")[0] },
            emailRedirectTo: window.location.origin + window.location.pathname,
          },
        });
      } else {
        result = await supabaseClient.auth.signInWithPassword({ email, password });
      }

      if (result.error) return showAuthError(formatAuthError(result.error));

      if (authModalTab === "signup" && result.data?.user && !result.data.session) {
        showAuthError(
          "Email confirmation is still on in Supabase. Turn off “Confirm email” under Authentication → Providers → Email, then try again."
        );
        authModalTab = "login";
        syncAuthModalTab();
        return;
      }
      if (result.data?.session?.user) await syncUserProfileFromAuth(result.data.session.user);
      closeAuthModal();
    } finally {
      authRequestInFlight = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  async function handleGoogleAuth() {
    if (authRequestInFlight) return;
    if (!supabaseClient) return showAuthError("Supabase not configured. Set your anon key in config.js.");
    const googleBtn = $("auth-google");
    authRequestInFlight = true;
    if (googleBtn) googleBtn.disabled = true;
    try {
      const redirectTo = window.location.origin + window.location.pathname.replace(/\/$/, "");
      const { error } = await supabaseClient.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) showAuthError(formatAuthError(error));
    } finally {
      authRequestInFlight = false;
      if (googleBtn) googleBtn.disabled = false;
    }
  }

  async function handleSignOut() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    currentUser = null;
    updateAuthUI();
    setView("landing");
  }

  /* ── Auth state ── */
  function updateAuthUI() {
    const loggedIn = !!currentUser;
    $("dropdown-logged-out").hidden = loggedIn;
    $("dropdown-logged-in").hidden = !loggedIn;
    const avatarEl = $("avatar-letter");
    const avatarBtn = $("user-menu-trigger");
    if (loggedIn) {
      const letter = (currentUser.displayName || currentUser.email || "?").charAt(0).toUpperCase();
      avatarEl.textContent = letter;
      avatarBtn.classList.remove("avatar-btn--anon");
    } else {
      avatarEl.textContent = "?";
      avatarBtn.classList.add("avatar-btn--anon");
    }
    $("header-nav").style.display = loggedIn ? "" : "none";
  }

  function setupAuthListener() {
    if (!supabaseClient) return;
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        syncUserProfileFromAuth(session.user).then(() => {
          if (currentView === "landing") setView("chat");
          if (pendingAuthCallback) {
            const cb = pendingAuthCallback;
            pendingAuthCallback = null;
            cb();
          }
        });
      } else if (event === "SIGNED_OUT") {
        currentUser = null;
        updateAuthUI();
      }
    });
  }

  async function initAuthState() {
    if (!supabaseClient) return;

    // Handle OAuth redirect — Supabase puts tokens in the URL hash
    const hash = window.location.hash;
    if (hash && (hash.includes("access_token") || hash.includes("error"))) {
      // Let Supabase client process the hash (it does this automatically via detectSessionInUrl)
      // Clean the URL after processing
      const { data } = await supabaseClient.auth.getSession();
      if (data?.session) {
        window.history.replaceState(null, "", window.location.pathname);
      }
    }

    const { data } = await supabaseClient.auth.getSession();
    if (data?.session?.user) {
      await syncUserProfileFromAuth(data.session.user);
      setView("chat");
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
    if (name === "settings") loadSettings();
  }

  async function loadSettings() {
    const root = $("settings-root");
    if (!root) return;
    if (!currentUser || !supabaseClient) {
      root.innerHTML = '<p class="settings-hint">Log in to manage your profile.</p>';
      return;
    }

    root.innerHTML = '<p class="settings-hint">Loading…</p>';

    const { data: profile, error: pErr } = await supabaseClient
      .from("profiles")
      .select("display_name, company, location, headline, bio, phone")
      .eq("id", currentUser.id)
      .maybeSingle();

    const { data: settings, error: sErr } = await supabaseClient
      .from("user_settings")
      .select("email, phone, company, timezone")
      .eq("user_id", currentUser.id)
      .maybeSingle();

    if (pErr || sErr) {
      root.innerHTML = '<p class="settings-hint">Could not load settings. Check that migrations ran in Supabase.</p>';
      console.warn("[Airsup] settings load:", pErr || sErr);
      return;
    }

    const email = settings?.email || currentUser.email || "";
    const displayName = profile?.display_name || currentUser.displayName || "";
    const company = profile?.company || settings?.company || "";
    const phone = profile?.phone || settings?.phone || "";
    const location = profile?.location || "";
    const headline = profile?.headline || "";
    const bio = profile?.bio || "";
    const timezone = settings?.timezone || "Europe/Berlin";

    root.innerHTML = `
      <div class="settings-section">
        <p class="settings-banner">Your profile is stored in Supabase (<code>profiles</code> & <code>user_settings</code>).</p>
        <div class="settings-field">
          <label class="settings-label" for="settings-display-name">Display name</label>
          <input type="text" id="settings-display-name" class="settings-input" value="${escapeAttr(displayName)}" maxlength="200" />
        </div>
        <div class="settings-field">
          <label class="settings-label" for="settings-email">Email</label>
          <input type="email" id="settings-email" class="settings-input" value="${escapeAttr(email)}" readonly />
        </div>
        <div class="settings-field">
          <label class="settings-label" for="settings-company">Company</label>
          <input type="text" id="settings-company" class="settings-input" value="${escapeAttr(company)}" maxlength="200" />
        </div>
        <div class="settings-field">
          <label class="settings-label" for="settings-phone">Phone</label>
          <input type="tel" id="settings-phone" class="settings-input" value="${escapeAttr(phone)}" maxlength="40" />
        </div>
        <div class="settings-field">
          <label class="settings-label" for="settings-location">Location</label>
          <input type="text" id="settings-location" class="settings-input" value="${escapeAttr(location)}" maxlength="200" />
        </div>
        <div class="settings-field">
          <label class="settings-label" for="settings-headline">Headline</label>
          <input type="text" id="settings-headline" class="settings-input" value="${escapeAttr(headline)}" maxlength="300" />
        </div>
        <div class="settings-field">
          <label class="settings-label" for="settings-bio">Bio</label>
          <textarea id="settings-bio" class="settings-input" rows="3" maxlength="2000">${escapeHtml(bio)}</textarea>
        </div>
        <div class="settings-field">
          <label class="settings-label" for="settings-timezone">Timezone</label>
          <input type="text" id="settings-timezone" class="settings-input" value="${escapeAttr(timezone)}" maxlength="80" placeholder="e.g. Europe/Berlin" />
        </div>
        <p class="settings-saved" id="settings-saved" hidden>Saved to Supabase.</p>
        <button type="button" class="btn-primary" id="settings-save">Save changes</button>
      </div>`;

    $("settings-save")?.addEventListener("click", saveSettings);
  }

  async function saveSettings() {
    if (!currentUser || !supabaseClient) return;
    const displayName = ($("settings-display-name")?.value || "").trim();
    const company = ($("settings-company")?.value || "").trim();
    const phone = ($("settings-phone")?.value || "").trim();
    const location = ($("settings-location")?.value || "").trim();
    const headline = ($("settings-headline")?.value || "").trim();
    const bio = ($("settings-bio")?.value || "").trim();
    const timezone = ($("settings-timezone")?.value || "").trim() || "Europe/Berlin";

    const letter = (displayName || currentUser.displayName || "?").charAt(0).toUpperCase();

    const { error: pe } = await supabaseClient.from("profiles").upsert(
      {
        id: currentUser.id,
        display_name: displayName || currentUser.displayName,
        avatar_letter: letter,
        company,
        phone,
        location,
        headline,
        bio,
      },
      { onConflict: "id" }
    );

    const { error: se } = await supabaseClient
      .from("user_settings")
      .upsert(
        {
          user_id: currentUser.id,
          email: currentUser.email || "",
          company,
          phone,
          timezone,
          preferred_name: displayName || currentUser.displayName,
        },
        { onConflict: "user_id" }
      );

    const saved = $("settings-saved");
    if (pe || se) {
      if (saved) {
        saved.hidden = false;
        saved.textContent = "Could not save. " + (pe?.message || se?.message || "Unknown error");
        saved.style.color = "#d93025";
      }
      console.warn("[Airsup] save settings:", pe || se);
      return;
    }

    currentUser.displayName = displayName || currentUser.displayName;
    updateAuthUI();
    if (saved) {
      saved.hidden = false;
      saved.textContent = "Saved to Supabase.";
      saved.style.color = "";
      setTimeout(() => { saved.hidden = true; }, 3000);
    }
  }

  /* ── Chat ── */
  function appendMessage(role, text) {
    const welcome = $("chat-welcome");
    if (welcome) welcome.remove();
    const container = $("chat-messages");
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble chat-bubble--${role}`;
    if (role === "assistant") {
      bubble.innerHTML = simpleMarkdown(text);
    } else {
      bubble.textContent = text;
    }
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
  }

  function showTyping() {
    const container = $("chat-messages");
    const el = document.createElement("div");
    el.className = "chat-typing";
    el.id = "chat-typing";
    el.innerHTML = '<span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function hideTyping() {
    $("chat-typing")?.remove();
  }

  async function sendMessage() {
    const input = $("chat-input");
    const text = input.value.trim();
    if (!text || isSending) return;

    isSending = true;
    input.value = "";
    input.style.height = "auto";
    $("chat-send").disabled = true;
    appendMessage("user", text);
    showTyping();

    try {
      const { reply } = await apiCall("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });
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
    } catch (_) {
      // First visit or no history — keep welcome message
    }
  }

  /* ── Projects ── */
  async function loadProjects() {
    const container = $("projects-list");
    try {
      const { projects } = await apiCall("/api/projects");
      if (!projects?.length) {
        container.innerHTML = '<div class="projects-empty">No projects yet. Start a conversation to describe what you need manufactured.</div>';
        return;
      }
      container.innerHTML = projects.map((p) => {
        const summary = p.ai_summary || {};
        const reqs = [];
        if (summary.quantity) reqs.push(summary.quantity);
        if (summary.budget) reqs.push(summary.budget);
        if (summary.timeline) reqs.push(summary.timeline);
        const reqLine = reqs.length ? `<div class="project-card-reqs">${reqs.map((r) => escapeHtml(r)).join(" · ")}</div>` : "";
        return `
        <div class="project-card" data-id="${p.id}">
          <div class="project-card-title">${escapeHtml(p.title)}</div>
          <div class="project-card-desc">${escapeHtml(p.description || "")}</div>
          ${reqLine}
          <div class="project-card-meta">
            <span class="project-card-badge badge--${p.status}">${p.status.replace(/_/g, " ")}</span>
            ${p.matches?.length ? `<span style="font-size:13px;color:var(--text-muted)">${p.matches.length} match${p.matches.length > 1 ? "es" : ""}</span>` : ""}
          </div>
        </div>`;
      }).join("");

      container.querySelectorAll(".project-card").forEach((card) => {
        card.addEventListener("click", () => {
          const id = card.getAttribute("data-id");
          if (id) loadProjectDetail(id);
        });
      });
    } catch (err) {
      container.innerHTML = '<div class="projects-empty">Could not load projects.</div>';
      console.error("[Airsup] loadProjects:", err);
    }
  }

  async function loadProjectDetail(id) {
    const container = $("projects-list");
    const lead = $("projects-lead");
    try {
      const { project } = await apiCall(`/api/projects/${id}`);
      if (lead) lead.innerHTML = `<button type="button" class="btn-outline" id="projects-back" style="font-size:13px;padding:6px 14px;margin-right:8px;">&larr; All projects</button>`;
      const summary = project.ai_summary || {};
      const matches = project.matches || [];
      container.innerHTML = `
        <div class="project-detail">
          <h2 style="font-size:22px;font-weight:700;margin-bottom:4px;">${escapeHtml(project.title)}</h2>
          <p style="color:var(--text-muted);margin-bottom:16px;">${escapeHtml(project.description || "")}</p>
          <span class="project-card-badge badge--${project.status}" style="margin-bottom:16px;display:inline-block;">${project.status.replace(/_/g, " ")}</span>
          ${summary.product ? `<div style="margin:16px 0;"><strong>Product:</strong> ${escapeHtml(summary.product)}</div>` : ""}
          ${summary.key_requirements?.length ? `<div style="margin-bottom:12px;"><strong>Requirements:</strong><ul style="padding-left:20px;margin-top:4px;">${summary.key_requirements.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></div>` : ""}
          ${matches.length ? `
            <h3 style="font-size:16px;font-weight:600;margin:20px 0 12px;">Matches (${matches.length})</h3>
            ${matches.map((m) => `
              <div class="connection-card" style="margin-bottom:8px;">
                <div class="connection-info">
                  <div class="connection-factory">${escapeHtml(m.factories?.name || "Factory")}</div>
                  <div class="connection-project">${escapeHtml(m.factories?.location || "")} · ${escapeHtml(m.factories?.category || "")}</div>
                </div>
                <span class="project-card-badge badge--${m.status}">${m.status.replace(/_/g, " ")}</span>
              </div>`).join("")}` : ""}
        </div>`;
      $("projects-back")?.addEventListener("click", () => {
        if (lead) lead.textContent = "Sourcing requests created from your conversations.";
        loadProjects();
      });
    } catch (err) {
      console.error("[Airsup] loadProjectDetail:", err);
    }
  }

  /* ── Connections ── */
  async function loadConnections() {
    const container = $("connections-list");
    try {
      const { matches } = await apiCall("/api/matches");
      if (!matches?.length) {
        container.innerHTML = '<div class="connections-empty">No connections yet. Once AI finds matching factories, they\'ll appear here with summaries and WhatsApp links.</div>';
        return;
      }
      container.innerHTML = matches.map((m) => {
        const factory = m.factories;
        const project = m.projects;
        const ctx = m.context_summary || {};
        const summary = ctx.short || "Connection established";
        const nextSteps = ctx.next_steps || "";
        const waLink = m.wa_group_id ? `https://wa.me/${m.wa_group_id}` : "";
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
          <div class="connection-summary-bar">${escapeHtml(summary)}</div>
          <div class="connection-body">
            <div class="connection-project-line">Project: ${escapeHtml(project?.title || "")}</div>
            ${quoteLine ? `<div class="connection-quote">${escapeHtml(quoteLine)}</div>` : ""}
            ${nextSteps ? `<div class="connection-next">Next: ${escapeHtml(nextSteps)}</div>` : ""}
          </div>
          <div class="connection-actions">
            ${waLink ? `<a href="${waLink}" target="_blank" class="btn-primary" style="font-size:13px;padding:8px 16px;">Open WhatsApp</a>` : ""}
            <button type="button" class="btn-outline" style="font-size:13px;padding:8px 16px;" onclick="document.querySelectorAll('.nav-link')[0].click()">Discuss with AI</button>
          </div>
        </div>`;
      }).join("");
    } catch (err) {
      container.innerHTML = '<div class="connections-empty">Could not load connections.</div>';
      console.error("[Airsup] loadConnections:", err);
    }
  }

  /* ── Event wiring ── */
  // Header nav
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.getAttribute("data-view");
      if (view) requireAuth(() => setView(view));
    });
  });

  $("logo-home")?.addEventListener("click", () => {
    setView(currentUser ? "chat" : "landing");
  });

  // Account menu
  $("user-menu-trigger")?.addEventListener("click", () => {
    const dd = $("user-menu-dropdown");
    dd.hidden = !dd.hidden;
  });
  document.addEventListener("click", (e) => {
    const dd = $("user-menu-dropdown");
    if (!dd?.hidden && !e.target.closest("#user-menu-trigger") && !e.target.closest("#user-menu-dropdown")) {
      dd.hidden = true;
    }
  });
  $("menu-login")?.addEventListener("click", () => { $("user-menu-dropdown").hidden = true; openAuthModal("login"); });
  $("menu-signup")?.addEventListener("click", () => { $("user-menu-dropdown").hidden = true; openAuthModal("signup"); });
  $("menu-settings")?.addEventListener("click", () => { $("user-menu-dropdown").hidden = true; setView("settings"); });
  $("menu-signout")?.addEventListener("click", () => { $("user-menu-dropdown").hidden = true; handleSignOut(); });

  // Landing CTA
  $("landing-start")?.addEventListener("click", () => {
    requireAuth(() => setView("chat"));
  });

  // Auth modal
  document.querySelectorAll(".auth-tab").forEach((t) => {
    t.addEventListener("click", () => {
      authModalTab = t.getAttribute("data-auth-tab") || "login";
      syncAuthModalTab();
    });
  });
  $("auth-close")?.addEventListener("click", closeAuthModal);
  $("auth-form")?.addEventListener("submit", handleEmailAuth);
  $("auth-google")?.addEventListener("click", handleGoogleAuth);
  $("auth-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "auth-modal") closeAuthModal();
  });

  // Chat composer
  const chatInput = $("chat-input");
  const chatSend = $("chat-send");

  chatInput?.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + "px";
    chatSend.disabled = !chatInput.value.trim();
  });

  chatInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  chatSend?.addEventListener("click", sendMessage);

  // Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modal = $("auth-modal");
      if (modal && !modal.hidden) closeAuthModal();
    }
  });

  /* ── Init ── */
  updateAuthUI();
  setupAuthListener();
  initAuthState();
})();
