(function () {
  "use strict";

  /** Supabase browser client; null until config.js has a valid anon key. */
  let supabaseClient = null;

  function initSupabase() {
    const W = typeof window !== "undefined" ? window : null;
    if (!W) return null;
    const cfg = W.AIRSUP_CONFIG;
    const lib = W.supabase;
    if (!cfg || !cfg.supabaseUrl) {
      console.warn("[Airsup] Supabase: set window.AIRSUP_CONFIG in config.js.");
      return null;
    }
    const key = String(cfg.supabaseAnonKey || "").trim();
    if (!key || key === "YOUR_SUPABASE_ANON_KEY") {
      console.warn(
        "[Airsup] Supabase: add supabaseAnonKey in config.js (Dashboard → Settings → API → anon public)."
      );
      return null;
    }
    if (!lib || typeof lib.createClient !== "function") {
      console.warn("[Airsup] Supabase: UMD bundle missing (check script order in index.html).");
      return null;
    }
    try {
      const client = lib.createClient(cfg.supabaseUrl, key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
      W.__airsupSupabase = client;
      return client;
    } catch (err) {
      console.error("[Airsup] Supabase createClient failed:", err);
      return null;
    }
  }

  supabaseClient = initSupabase();
  if (typeof window !== "undefined") {
    window.AIRSUP = { getSupabase: () => supabaseClient };
  }

  /* ── Auth state ── */
  let currentUser = null;
  let pendingAuthCallback = null;
  let authModalTab = "login";

  /* ── Auth modal helpers ── */
  function openAuthModal(tab, callback) {
    authModalTab = tab || "login";
    pendingAuthCallback = callback || null;
    const modal = document.getElementById("auth-modal");
    if (!modal) return;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    syncAuthModalTab();
    const nameField = document.getElementById("auth-name-field");
    if (nameField) nameField.hidden = authModalTab !== "signup";
    document.getElementById("auth-error")?.setAttribute("hidden", "");
    document.getElementById("auth-email")?.focus();
  }

  function closeAuthModal() {
    const modal = document.getElementById("auth-modal");
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = "";
    document.getElementById("auth-form")?.reset();
    document.getElementById("auth-error")?.setAttribute("hidden", "");
  }

  function syncAuthModalTab() {
    document.querySelectorAll(".auth-tab").forEach((t) => {
      const tab = t.getAttribute("data-auth-tab");
      t.classList.toggle("active", tab === authModalTab);
      t.setAttribute("aria-selected", String(tab === authModalTab));
    });
    const nameField = document.getElementById("auth-name-field");
    if (nameField) nameField.hidden = authModalTab !== "signup";
    const pwdInput = document.getElementById("auth-password");
    if (pwdInput) pwdInput.autocomplete = authModalTab === "signup" ? "new-password" : "current-password";
    const submitBtn = document.getElementById("auth-submit");
    if (submitBtn) submitBtn.textContent = authModalTab === "signup" ? "Sign up" : "Log in";
  }

  function showAuthError(msg) {
    const el = document.getElementById("auth-error");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }

  function requireAuth(callback) {
    if (currentUser) {
      callback();
      return;
    }
    openAuthModal("login", callback);
  }

  /* ── Auth actions ── */
  async function handleEmailAuth(e) {
    e.preventDefault();
    if (!supabaseClient) return showAuthError("Supabase not configured.");
    const email = (document.getElementById("auth-email")?.value || "").trim();
    const password = document.getElementById("auth-password")?.value || "";
    if (!email || !password) return showAuthError("Email and password are required.");
    const submitBtn = document.getElementById("auth-submit");
    if (submitBtn) submitBtn.disabled = true;
    document.getElementById("auth-error")?.setAttribute("hidden", "");

    let result;
    if (authModalTab === "signup") {
      const name = (document.getElementById("auth-name")?.value || "").trim();
      result = await supabaseClient.auth.signUp({
        email,
        password,
        options: { data: { full_name: name || email.split("@")[0] } },
      });
    } else {
      result = await supabaseClient.auth.signInWithPassword({ email, password });
    }

    if (submitBtn) submitBtn.disabled = false;
    if (result.error) return showAuthError(result.error.message);
    if (authModalTab === "signup" && result.data?.user && !result.data.session) {
      showAuthError("Check your email to confirm your account, then log in.");
      authModalTab = "login";
      syncAuthModalTab();
      return;
    }
    closeAuthModal();
  }

  async function handleGoogleAuth() {
    if (!supabaseClient) return showAuthError("Supabase not configured.");
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) showAuthError(error.message);
  }

  async function handleSignOut() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    currentUser = null;
    savedFactoryIds = [];
    persistSavedFactoryIds();
    updateHeaderForAuth();
    goHome();
  }

  /* ── Data sync layer ── */
  async function loadUserDataFromSupabase() {
    if (!supabaseClient || !currentUser) return;
    const uid = currentUser.id;
    try {
      const { data: profile } = await supabaseClient.from("profiles").select("*").eq("id", uid).single();
      if (profile) {
        currentUser.displayName = profile.display_name || currentUser.displayName;
        currentUser.avatarLetter = profile.avatar_letter || currentUser.avatarLetter;
        const pid = signedInProfileId();
        if (profilesById[pid]) {
          profilesById[pid].displayName = profile.display_name || profilesById[pid].displayName;
          profilesById[pid].location = profile.location || profilesById[pid].location;
          profilesById[pid].headline = profile.headline || profilesById[pid].headline;
          profilesById[pid].bio = profile.bio || profilesById[pid].bio;
          profilesById[pid].avatarLetter = profile.avatar_letter || profilesById[pid].avatarLetter;
        }
      }
      const { data: settings } = await supabaseClient.from("user_settings").select("*").eq("user_id", uid).single();
      if (settings) {
        accountSettings.legalName = settings.legal_name || currentUser.displayName || "";
        accountSettings.preferredName = settings.preferred_name || "";
        accountSettings.email = settings.email || currentUser.email || "";
        accountSettings.phone = settings.phone || "";
        accountSettings.company = settings.company || "";
        accountSettings.timezone = settings.timezone || "Europe/Berlin";
        accountSettings.emailNewMessages = settings.email_new_messages ?? true;
        accountSettings.emailDigest = settings.email_digest ?? false;
        accountSettings.profileVisibility = settings.profile_visibility || "matched";
        accountSettings.showPhoneToMatched = settings.show_phone_to_matched ?? true;
      }
      const { data: saved } = await supabaseClient
        .from("saved_factories")
        .select("factory_id")
        .eq("user_id", uid)
        .order("saved_at", { ascending: false });
      if (saved) {
        savedFactoryIds = saved.map((r) => r.factory_id).filter((id) => factories.some((f) => f.id === id));
        persistSavedFactoryIds();
      }
      const { data: msgs } = await supabaseClient
        .from("messages")
        .select("*")
        .eq("sender_id", uid)
        .order("created_at", { ascending: true });
      if (msgs && msgs.length) {
        msgs.forEach((m) => {
          if (!chatTemplates[m.factory_id]) chatTemplates[m.factory_id] = [];
          const already = chatTemplates[m.factory_id].some((c) => c._dbId === m.id);
          if (!already) {
            chatTemplates[m.factory_id].push({
              from: m.direction === "sent" ? "me" : "them",
              time: new Date(m.created_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
              dateLabel: new Date(m.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
              text: m.body,
              _dbId: m.id,
            });
          }
        });
        threads = buildThreads();
      }
    } catch (err) {
      console.warn("[Airsup] loadUserData:", err);
    }
  }

  async function dbSaveMessage(factoryId, text) {
    if (!supabaseClient || !currentUser) return;
    try {
      await supabaseClient.from("messages").insert({
        sender_id: currentUser.id,
        factory_id: factoryId,
        direction: "sent",
        body: text,
      });
    } catch (err) {
      console.warn("[Airsup] dbSaveMessage:", err);
    }
  }

  async function dbSyncSavedFactory(factoryId, saved) {
    if (!supabaseClient || !currentUser) return;
    try {
      if (saved) {
        await supabaseClient.from("saved_factories").upsert(
          { user_id: currentUser.id, factory_id: factoryId },
          { onConflict: "user_id,factory_id" }
        );
      } else {
        await supabaseClient
          .from("saved_factories")
          .delete()
          .eq("user_id", currentUser.id)
          .eq("factory_id", factoryId);
      }
    } catch (err) {
      console.warn("[Airsup] dbSyncSaved:", err);
    }
  }

  async function dbSaveSettings() {
    if (!supabaseClient || !currentUser) return;
    try {
      await supabaseClient.from("user_settings").upsert({
        user_id: currentUser.id,
        legal_name: accountSettings.legalName,
        preferred_name: accountSettings.preferredName,
        email: accountSettings.email,
        phone: accountSettings.phone,
        company: accountSettings.company,
        timezone: accountSettings.timezone,
        email_new_messages: accountSettings.emailNewMessages,
        email_digest: accountSettings.emailDigest,
        profile_visibility: accountSettings.profileVisibility,
        show_phone_to_matched: accountSettings.showPhoneToMatched,
      });
    } catch (err) {
      console.warn("[Airsup] dbSaveSettings:", err);
    }
  }

  async function dbSaveProfile() {
    if (!supabaseClient || !currentUser) return;
    const p = getDisplayedProfile();
    if (!p) return;
    try {
      await supabaseClient.from("profiles").update({
        display_name: p.displayName,
        avatar_letter: p.avatarLetter,
        location: p.location,
        headline: p.headline,
        bio: p.bio,
        company: accountSettings.company,
      }).eq("id", currentUser.id);
    } catch (err) {
      console.warn("[Airsup] dbSaveProfile:", err);
    }
  }

  /* ── Header auth state ── */
  function updateHeaderForAuth() {
    const loggedIn = !!currentUser;
    document.querySelectorAll(".dropdown-logged-out").forEach((el) => { el.hidden = loggedIn; });
    document.querySelectorAll(".dropdown-logged-in").forEach((el) => { el.hidden = !loggedIn; });
    const avatar = document.querySelector(".user-avatar");
    if (avatar) {
      avatar.textContent = loggedIn ? (currentUser.avatarLetter || "U") : "";
      avatar.classList.toggle("user-avatar--anon", !loggedIn);
    }
  }

  /* ── onAuthStateChange ── */
  function setupAuthListener() {
    if (!supabaseClient) return;
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_IN" && session?.user) {
        const u = session.user;
        currentUser = {
          id: u.id,
          email: u.email,
          displayName: u.user_metadata?.full_name || u.email?.split("@")[0] || "",
          avatarLetter: (u.user_metadata?.full_name || u.email || "U").charAt(0).toUpperCase(),
        };
        updateHeaderForAuth();
        await loadUserDataFromSupabase();
        updateHeaderForAuth();
        if (view === "home") renderGrid();
        if (view === "saved") renderSaved();
        if (pendingAuthCallback) {
          const cb = pendingAuthCallback;
          pendingAuthCallback = null;
          cb();
        }
      } else if (event === "SIGNED_OUT") {
        currentUser = null;
        updateHeaderForAuth();
      }
    });
  }

  async function initAuthState() {
    if (!supabaseClient) return;
    const { data } = await supabaseClient.auth.getSession();
    if (data?.session?.user) {
      const u = data.session.user;
      currentUser = {
        id: u.id,
        email: u.email,
        displayName: u.user_metadata?.full_name || u.email?.split("@")[0] || "",
        avatarLetter: (u.user_metadata?.full_name || u.email || "U").charAt(0).toUpperCase(),
      };
      updateHeaderForAuth();
      await loadUserDataFromSupabase();
      updateHeaderForAuth();
      if (view === "home") renderGrid();
    }
  }

  const factories = [
    {
      id: 1,
      name: "Shenzhen ProTech Electronics",
      location: "Shenzhen, China",
      category: "Electronics",
      moq: "500 units",
      leadTime: "15 days",
      rating: 4.97,
      reviews: 214,
      badge: "Top Manufacturer",
      price: "From $0.80 / unit",
      img: "assets/placeholders/factory-01-electronics.png",
      tags: ["PCB assembly", "IoT devices", "Smart hardware"],
      verified: true,
      responseHours: 3,
      contact: "Wei Chen",
      profileId: "pf-supplier-wei",
    },
    {
      id: 2,
      name: "Guangzhou Precision Metals",
      location: "Guangzhou, China",
      category: "Metal Parts",
      moq: "200 units",
      leadTime: "10 days",
      rating: 4.94,
      reviews: 178,
      badge: "Top Manufacturer",
      price: "From $2.40 / unit",
      img: "assets/placeholders/factory-02-metal.png",
      tags: ["CNC machining", "Sheet metal", "Aluminum"],
      verified: true,
      responseHours: 2,
      contact: "Lin Yao",
    },
    {
      id: 3,
      name: "Yiwu Fashion Collective",
      location: "Yiwu, China",
      category: "Apparel",
      moq: "300 units",
      leadTime: "21 days",
      rating: 4.88,
      reviews: 312,
      badge: "Top Manufacturer",
      price: "From $4.20 / unit",
      img: "assets/placeholders/factory-03-apparel.png",
      tags: ["Custom apparel", "Embroidery", "Private label"],
      verified: true,
      responseHours: 5,
      contact: "Anna Guo",
    },
    {
      id: 4,
      name: "Dongguan Plastics Mfg",
      location: "Dongguan, China",
      category: "Plastics",
      moq: "1,000 units",
      leadTime: "18 days",
      rating: 4.92,
      reviews: 97,
      badge: "Top Manufacturer",
      price: "From $0.30 / unit",
      img: "assets/placeholders/factory-04-plastics.png",
      tags: ["Injection molding", "ABS / PP", "Custom colors"],
      verified: true,
      responseHours: 4,
      contact: "Jason Hu",
    },
    {
      id: 5,
      name: "Hangzhou Smart Packaging",
      location: "Hangzhou, China",
      category: "Packaging",
      moq: "5,000 units",
      leadTime: "12 days",
      rating: 5.0,
      reviews: 63,
      badge: "Top Manufacturer",
      price: "From $0.12 / unit",
      img: "assets/placeholders/factory-05-packaging.png",
      tags: ["Custom boxes", "Eco-friendly", "Branding"],
      verified: true,
      responseHours: 3,
      contact: "Mira Song",
    },
    {
      id: 6,
      name: "Foshan Furniture Works",
      location: "Foshan, China",
      category: "Furniture",
      moq: "50 units",
      leadTime: "30 days",
      rating: 4.85,
      reviews: 145,
      badge: "Top Manufacturer",
      price: "From $38 / unit",
      img: "assets/placeholders/factory-06-furniture.png",
      tags: ["Wood & metal", "OEM", "Custom design"],
      verified: false,
      responseHours: 8,
      contact: "David Zhou",
    },
    {
      id: 7,
      name: "Chengdu Auto Components",
      location: "Chengdu, China",
      category: "Auto Parts",
      moq: "100 units",
      leadTime: "25 days",
      rating: 4.9,
      reviews: 89,
      badge: "Top Manufacturer",
      price: "From $12 / unit",
      img: "assets/placeholders/factory-07-auto.png",
      tags: ["Interior parts", "Stamping", "OEM grade"],
      verified: true,
      responseHours: 6,
      contact: "Rui Zhang",
    },
    {
      id: 8,
      name: "Ningbo Lighting Factory",
      location: "Ningbo, China",
      category: "Lighting",
      moq: "500 units",
      leadTime: "14 days",
      rating: 4.78,
      reviews: 201,
      badge: "Top Manufacturer",
      price: "From $1.80 / unit",
      img: "assets/placeholders/factory-08-lighting.png",
      tags: ["LED", "Smart lighting", "Certified"],
      verified: false,
      responseHours: 4,
      contact: "Elena Wu",
    },
  ];

  /** @type {Record<number, Array<{from:'me'|'them',name?:string,role?:string,time:string,dateLabel:string,text:string,read?:string}>>} */
  const chatTemplates = {
    1: [
      { from: "them", name: "Wei Chen", role: "Manufacturer", time: "9:12 AM", dateLabel: "Apr 12, 2026", text: "Hi — thanks for reaching out. We can support PCB assembly and testing for IoT devices. What volumes are you targeting for the first run?" },
      { from: "me", time: "9:40 AM", dateLabel: "Apr 12, 2026", text: "First run around 800 units, with potential to scale. Can you share typical lead time for that MOQ?" },
      { from: "them", name: "Wei Chen", role: "Manufacturer", time: "11:05 AM", dateLabel: "Apr 12, 2026", text: "For 800 units, production is usually 12–16 days after samples are approved. I can send a simple checklist for your BOM tomorrow.", read: "Read by you" },
    ],
    2: [
      { from: "them", name: "Lin Yao", role: "Manufacturer", time: "2:30 PM", dateLabel: "Apr 11, 2026", text: "Hello — we specialize in aluminum CNC parts. Please send drawings (STEP/IGES) and your tolerance requirements." },
    ],
    3: [
      { from: "me", time: "10:02 AM", dateLabel: "Apr 10, 2026", text: "We’re looking for a private-label hoodie run — do you offer fabric sourcing support?" },
      { from: "them", name: "Anna Guo", role: "Manufacturer", time: "4:18 PM", dateLabel: "Apr 10, 2026", text: "Yes — we can propose fabric options and labels. If you share target price and quantities, we’ll reply with 2–3 routes.", read: "Read by you" },
    ],
  };

  const whatSuggestions = [
    {
      query: "electronics",
      title: "Electronics & PCB assembly",
      subtitle: "Boards, IoT devices, and smart hardware",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="10" rx="1"/><path d="M8 19h8M12 15v4"/><path d="M9 9h6M9 12h4"/></svg>',
    },
    {
      query: "metal",
      title: "Metal parts & CNC",
      subtitle: "Machining, sheet metal, and aluminum",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
    },
    {
      query: "apparel",
      title: "Apparel & textiles",
      subtitle: "Private label, embroidery, and cut-and-sew",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 8l3-4h6l3 4v14H6V8z"/><path d="M9 8V6M15 8V6"/></svg>',
    },
    {
      query: "plastics",
      title: "Plastics & molding",
      subtitle: "Injection molding, ABS, PP, and custom colors",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3c-3 4-6 7-6 10a6 6 0 0012 0c0-3-3-6-6-10z"/></svg>',
    },
    {
      query: "packaging",
      title: "Packaging & boxes",
      subtitle: "Custom cartons, inserts, and branding",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 3l8 4v10l-8 4-8-4V7l8-4z"/><path d="M12 12l8-4M12 12v10M12 12L4 8"/></svg>',
    },
    {
      query: "furniture",
      title: "Furniture & woodwork",
      subtitle: "OEM furniture, metal-and-wood builds",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 21V10h14v11"/><path d="M3 10h18v3H3z"/><path d="M9 14h6"/></svg>',
    },
    {
      query: "auto",
      title: "Auto & mobility parts",
      subtitle: "Interior, stamping, and OEM-grade components",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 5v2M12 17v2M5 12h2M17 12h2"/></svg>',
    },
    {
      query: "lighting",
      title: "Lighting & LED",
      subtitle: "LED modules, fixtures, and certification support",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a6 6 0 016 6c0 4-3 6-3 6H9s-3-2-3-6a6 6 0 016-6z"/></svg>',
    },
  ];

  /** Region rows in the search popover (0/1 = off/on). Keywords match `factory.location` (case-insensitive). */
  const regionOptions = [
    {
      id: "china",
      label: "China",
      subtitle: "Electronics, apparel, plastics — major export hubs",
      keywords: ["china"],
    },
    {
      id: "vietnam",
      label: "Vietnam",
      subtitle: "Textiles, footwear, and electronics assembly",
      keywords: ["vietnam"],
    },
    {
      id: "india",
      label: "India",
      subtitle: "Engineering, textiles, and metal parts",
      keywords: ["india"],
    },
    {
      id: "mexico",
      label: "Mexico",
      subtitle: "Nearshoring for North America",
      keywords: ["mexico"],
    },
    {
      id: "usa",
      label: "United States",
      subtitle: "Domestic runs, tooling, and specialty batches",
      keywords: ["usa", "united states", "u.s."],
    },
    {
      id: "europe",
      label: "Europe",
      subtitle: "EU standards — Germany, Italy, Poland, and more",
      keywords: ["germany", "italy", "france", "spain", "poland", "portugal", "netherlands", "europe"],
    },
  ];

  const regionCounts = Object.fromEntries(regionOptions.map((r) => [r.id, 0]));

  /**
   * Profile registry — one object per public identity. Reference `profileId` from factories, users, etc.
   * When you add many users, load or merge into this map (or replace with API responses keyed by id).
   */
  const PROFILE_CUSTOMER_DEMO = "pf-customer-alex";
  const PROFILE_SUPPLIER_WEI = "pf-supplier-wei";

  const profilesById = {
    [PROFILE_CUSTOMER_DEMO]: {
      id: PROFILE_CUSTOMER_DEMO,
      role: "customer",
      displayName: "Alex Chen",
      location: "Berlin, Germany",
      headline: "Sourcing lead · Electronics & hardware",
      bio: "I run procurement for a hardware startup. I value clear MOQs, realistic lead times, and suppliers who respond with specifics—not vague promises.",
      avatarLetter: "A",
      verified: true,
      stats: {
        a: { label: "Active inquiries", value: "3" },
        b: { label: "Reviews", value: "2" },
        c: { label: "Years on platform", value: "2" },
      },
      details: [
        { id: "company", icon: "briefcase", label: "Company", value: "Northline Devices GmbH" },
        { id: "focus", icon: "target", label: "Sourcing focus", value: "PCB assemblies, small-batch consumer devices" },
        { id: "lang", icon: "globe", label: "Languages", value: "English, German" },
      ],
      tags: [
        { icon: "chip", label: "Electronics" },
        { icon: "package", label: "Packaging" },
        { icon: "metal", label: "Metal parts" },
      ],
      reviewsReceived: [
        {
          id: "rv-c-1",
          reviewerRole: "supplier",
          reviewerName: "Wei Chen",
          reviewerLocation: "Shenzhen, China",
          date: "Mar 2026",
          rating: 5,
          body: "Clear requirements and fast feedback on samples. Would work with again.",
        },
        {
          id: "rv-c-2",
          reviewerRole: "supplier",
          reviewerName: "Lin Yao",
          reviewerLocation: "Guangzhou, China",
          date: "Feb 2026",
          rating: 5,
          body: "Professional buyer — drawings and quantities were well prepared.",
        },
      ],
    },
    [PROFILE_SUPPLIER_WEI]: {
      id: PROFILE_SUPPLIER_WEI,
      role: "supplier",
      displayName: "Wei Chen",
      location: "Shenzhen, China",
      headline: "Shenzhen ProTech Electronics — account lead",
      bio: "We support PCB assembly, testing, and small-series production for hardware teams worldwide. Ask for DFM feedback early—we’d rather save you a respin.",
      avatarLetter: "W",
      verified: true,
      stats: {
        a: { label: "Open inquiries", value: "4" },
        b: { label: "Reviews", value: "214" },
        c: { label: "Years on platform", value: "3" },
      },
      details: [
        { id: "cap", icon: "briefcase", label: "Capabilities", value: "PCB assembly, ICT, box build" },
        { id: "cert", icon: "shield", label: "Certifications", value: "ISO 9001 (in progress)" },
        { id: "lang", icon: "globe", label: "Languages", value: "English, Mandarin" },
      ],
      tags: [
        { icon: "chip", label: "PCB & SMT" },
        { icon: "cpu", label: "IoT devices" },
        { icon: "package", label: "Box build" },
      ],
      reviewsReceived: [
        {
          id: "rv-s-1",
          reviewerRole: "customer",
          reviewerName: "Alex Chen",
          reviewerLocation: "Berlin, Germany",
          date: "Apr 2026",
          rating: 5,
          body: "Responsive team and transparent on lead times. Samples matched spec.",
        },
        {
          id: "rv-s-2",
          reviewerRole: "customer",
          reviewerName: "Jordan Lee",
          reviewerLocation: "Toronto, Canada",
          date: "Jan 2026",
          rating: 5,
          body: "Solid communication through the first production run.",
        },
        {
          id: "rv-s-3",
          reviewerRole: "customer",
          reviewerName: "Samira Okonkwo",
          reviewerLocation: "Lagos, Nigeria",
          date: "Nov 2025",
          rating: 5,
          body: "Helped us navigate component shortages without pushing unsuitable substitutes.",
        },
      ],
    },
  };

  function buildThreads() {
    return factories.map((f) => {
      const msgs = chatTemplates[f.id];
      const last = msgs && msgs.length ? msgs[msgs.length - 1] : null;
      const snippet = last ? last.text : "Start a conversation about your project.";
      const initials = f.contact
        .split(" ")
        .map((p) => p[0])
        .join("")
        .slice(0, 2);
      return {
        id: f.id,
        factoryId: f.id,
        participantName: f.contact,
        factoryName: f.name,
        contextLine: `${f.category} · ${f.location.split(",")[0]}`,
        lastMessage: snippet,
        lastDate: last ? last.dateLabel?.split(",")[0]?.trim() || "Apr 12" : "—",
        unread: f.id === 2,
        avatarLetter: initials,
      };
    });
  }

  let threads = buildThreads();

  const SAVED_FACTORY_IDS_KEY = "airsup_saved_factory_ids";
  /** @type {number[]} newest saved first */
  let savedFactoryIds = loadSavedFactoryIds();

  function loadSavedFactoryIds() {
    try {
      const raw = localStorage.getItem(SAVED_FACTORY_IDS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.map(Number).filter((id) => factories.some((f) => f.id === id));
    } catch {
      return [];
    }
  }

  function persistSavedFactoryIds() {
    try {
      localStorage.setItem(SAVED_FACTORY_IDS_KEY, JSON.stringify(savedFactoryIds));
    } catch {
      /* ignore quota / private mode */
    }
  }

  function isSavedFactoryId(id) {
    return savedFactoryIds.includes(id);
  }

  function toggleSavedFactoryId(id) {
    const i = savedFactoryIds.indexOf(id);
    const nowSaved = i === -1;
    if (nowSaved) savedFactoryIds.unshift(id);
    else savedFactoryIds.splice(i, 1);
    persistSavedFactoryIds();
    dbSyncSavedFactory(id, nowSaved);
  }

  function getSavedFactories() {
    const seen = new Set();
    return savedFactoryIds
      .map((fid) => factoryById(fid))
      .filter((f) => {
        if (!f || seen.has(f.id)) return false;
        seen.add(f.id);
        return true;
      });
  }

  function syncDetailSaveButton(f) {
    if (!f) return;
    const btn = $("detail-save-top");
    if (!btn) return;
    const saved = isSavedFactoryId(f.id);
    btn.classList.toggle("is-saved", saved);
    btn.setAttribute("aria-label", saved ? "Remove from saved manufacturers" : "Save manufacturer");
    const label = btn.querySelector(".detail-save-label");
    if (label) label.textContent = saved ? "Saved" : "Save";
  }

  function syncSaveUiAfterToggle() {
    if (view === "home") renderGrid();
    else if (view === "saved") renderSaved();
    if (view === "detail" && selectedFactoryId != null) syncDetailSaveButton(factoryById(selectedFactoryId));
  }

  function factoryCardHtml(f) {
    const saved = isSavedFactoryId(f.id);
    return `<article class="factory-card-wrap">
      <button type="button" class="factory-card" data-fid="${f.id}">
      <div class="card-img-wrap">
        <img class="card-img" src="${f.img}" alt="" loading="lazy"/>
        <span class="card-badge">${escapeHtml(f.badge)}</span>
      </div>
      <div class="card-name">${escapeHtml(f.name)}${f.verified ? verifiedSVG : ""}</div>
      <div class="card-meta">${escapeHtml(f.location)} · MOQ ${escapeHtml(f.moq)} · ${escapeHtml(f.leadTime)}</div>
      <div class="card-foot">
        <div class="card-price">${escapeHtml(f.price)}<span class="card-reviews"> · ${f.reviews} reviews</span></div>
        <div class="card-rating">${starSVG} ${f.rating}</div>
      </div>
      </button>
      <button type="button" class="card-heart-btn${saved ? " is-saved" : ""}" data-fid="${f.id}" aria-label="${saved ? "Remove from saved" : "Save manufacturer"}" aria-pressed="${saved}">
        <span aria-hidden="true">${saved ? "♥" : "♡"}</span>
      </button>
    </article>`;
  }

  function bindFactoryCardWraps(container) {
    if (!container) return;
    container.querySelectorAll(".factory-card").forEach((card) => {
      card.addEventListener("click", () => openDetail(Number(card.getAttribute("data-fid"))));
    });
    container.querySelectorAll(".card-heart-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = Number(btn.getAttribute("data-fid"));
        requireAuth(() => {
          toggleSavedFactoryId(id);
          syncSaveUiAfterToggle();
        });
      });
    });
  }

  let view = "home";
  /** "customer" = sourcing marketplace; "supplier" = factory dashboard + host nav */
  let appMode = "customer";
  let supplierTab = "today";
  let selectedFactoryId = null;
  let activeThreadId = null;
  let messageFilter = "all";
  let detailHeroIndex = 0;
  /** Prefills the message composer when opening messages from “Message for quote” on a listing. */
  let detailQuotePrefill = null;
  /** When set, profile page shows this record; when null, profile follows signed-in role (customer vs supplier). */
  let viewingProfileId = null;
  let profileEditMode = false;
  let profileReviewsExpanded = false;
  /** @type {{ view: string, factoryId: number | null, threadId: number | null }} */
  let profileReturnTarget = { view: "home", factoryId: null, threadId: null };
  let settingsSection = "personal";
  /** @type {string | null} */
  let settingsEditingField = null;
  /** Editable account preferences — swap for API-backed state later. */
  let accountSettings = {
    legalName: "Alex Chen",
    preferredName: "",
    email: "alex.chen@example.com",
    phone: "+49 30 •••• 2841",
    company: "Northline Devices GmbH",
    timezone: "Europe/Berlin",
    emailNewMessages: true,
    emailDigest: false,
    profileVisibility: "matched",
    showPhoneToMatched: true,
  };

  const $ = (id) => document.getElementById(id);

  const verifiedSVG = `<span class="verified-dot" aria-hidden="true"><svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1.5 4l2 2L6.5 2" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  const starSVG = `<svg width="12" height="12" viewBox="0 0 12 12" fill="#222" aria-hidden="true"><path d="M6 1l1.3 2.6L10 4l-2 2 .5 2.8L6 7.5 3.5 8.8 4 6 2 4l2.7-.4L6 1z"/></svg>`;

  function factoryById(id) {
    return factories.find((f) => f.id === id) || null;
  }

  function getProfileById(id) {
    return id && profilesById[id] ? profilesById[id] : null;
  }

  function signedInProfileId() {
    return appMode === "supplier" ? PROFILE_SUPPLIER_WEI : PROFILE_CUSTOMER_DEMO;
  }

  function getDisplayedProfile() {
    if (viewingProfileId && profilesById[viewingProfileId]) return profilesById[viewingProfileId];
    return profilesById[signedInProfileId()];
  }

  function canEditDisplayedProfile() {
    return getDisplayedProfile().id === signedInProfileId();
  }

  function galleryForFactory(f) {
    const img = f.img;
    return [img, img, img, img, img];
  }

  function closeListingGallery() {
    const modal = $("listing-gallery-modal");
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = "";
  }

  function openListingGallery(f) {
    closeListingGallery();
    let modal = $("listing-gallery-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "listing-gallery-modal";
      modal.className = "listing-gallery-modal";
      modal.hidden = true;
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "listing-gallery-modal-title");
      modal.setAttribute("tabindex", "-1");
      modal.innerHTML = `
        <button type="button" class="listing-gallery-modal-backdrop" data-close-gallery aria-label="Close photo gallery"></button>
        <div class="listing-gallery-modal-panel">
          <div class="listing-gallery-modal-head">
            <h2 id="listing-gallery-modal-title" class="listing-gallery-modal-title">Photos</h2>
            <button type="button" class="listing-gallery-modal-close" aria-label="Close">&times;</button>
          </div>
          <div class="listing-gallery-modal-grid" id="listing-gallery-modal-grid"></div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelector("[data-close-gallery]")?.addEventListener("click", closeListingGallery);
      modal.querySelector(".listing-gallery-modal-close")?.addEventListener("click", closeListingGallery);
    }
    const urls = galleryForFactory(f);
    const titleEl = modal.querySelector("#listing-gallery-modal-title");
    if (titleEl) titleEl.textContent = `Photos · ${f.name}`;
    const grid = modal.querySelector("#listing-gallery-modal-grid");
    if (grid) {
      grid.innerHTML = urls
        .map(
          (src, i) =>
            `<button type="button" class="listing-gallery-modal-tile" data-idx="${i}">
            <img src="${escapeAttr(src)}" alt="${escapeAttr(`${f.name} — photo ${i + 1}`)}" loading="lazy" />
          </button>`
        )
        .join("");
      grid.querySelectorAll(".listing-gallery-modal-tile").forEach((tile) => {
        tile.addEventListener("click", () => {
          detailHeroIndex = Number(tile.getAttribute("data-idx"));
          closeListingGallery();
          renderDetail();
        });
      });
    }
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      modal.focus();
    });
  }

  function factoryListingBlurb(f) {
    return `${f.name} focuses on ${f.category.toLowerCase()} for teams that need clear MOQs, traceable production, and fast answers on technical questions. Share quantities and specs to get a tailored quote.`;
  }

  /** Amenity-style rows for “What this supplier offers” (tags + standard services). */
  function factoryOffers(f) {
    const tagOffers = (f.tags || []).map((label) => ({ icon: "check", label }));
    const common = [
      { icon: "msg", label: "Dedicated chat thread per inquiry" },
      { icon: "sample", label: "Sample and pilot-run support" },
      { icon: "doc", label: "Packing lists & export documentation" },
      { icon: "clock", label: "Stated lead times before you commit" },
    ];
    const merged = [...tagOffers, ...common];
    const seen = new Set();
    return merged.filter((o) => {
      const k = o.label.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function offerIconSvg(kind) {
    const c =
      'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
    const m = {
      check: `<svg ${c} aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>`,
      msg: `<svg ${c} aria-hidden="true"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>`,
      sample: `<svg ${c} aria-hidden="true"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>`,
      doc: `<svg ${c} aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>`,
      clock: `<svg ${c} aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
    };
    return m[kind] || m.check;
  }

  /** Short sample reviews for listing page (deterministic per factory). */
  function factoryReviewSamples(f) {
    const bodies = [
      `Clear communication on ${f.category.toLowerCase()} specs and realistic timelines. We'd use them again for a second SKU.`,
      `Quoted within two days and stuck to the MOQ we needed. Samples matched the drawings.`,
      `Responsive on WeChat and email. Production photos before ship were a nice touch.`,
      `Straightforward on payment milestones. No surprises on duties paperwork.`,
    ];
    const names = ["Jordan K.", "Samira O.", "Chris L.", "Priya M."];
    const locs = ["Berlin", "Toronto", "Austin", "Singapore"];
    const n = Math.min(4, bodies.length);
    return Array.from({ length: n }, (_, i) => ({
      name: names[(f.id + i) % names.length],
      meta: `${locs[(f.id + i) % locs.length]} · ${f.category}`,
      rating: i === 1 ? 4.9 : 5,
      date: ["Mar 2026", "Feb 2026", "Jan 2026", "Dec 2025"][(f.id + i) % 4],
      text: bodies[(f.id + i) % bodies.length],
    }));
  }

  function mapsSearchUrl(location) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
  }

  function isMobileMsg() {
    return window.matchMedia("(max-width: 699px)").matches;
  }

  function syncMsgMobileBody() {
    const body = document.body;
    body.classList.remove("msg-mobile-chat");
    if (view !== "messages" || !isMobileMsg()) return;
    if (activeThreadId != null) body.classList.add("msg-mobile-chat");
  }

  /** Hysteresis avoids flicker when scroll position hovers near the threshold. */
  const SCROLL_COMPACT_DOWN = 96;
  const SCROLL_COMPACT_UP = 24;
  /** Ignore further compact/expanded toggles briefly after a switch to avoid scroll-anchoring feedback loops. */
  const HEADER_HOME_MODE_COOLDOWN_MS = 380;
  let headerScrollCompact = false;
  let lastHomeHeaderModeChange = 0;

  function syncHomeHeaderScroll() {
    const header = $("site-header");
    if (!header || view !== "home" || header.classList.contains("search-hidden")) return;
    if (performance.now() - lastHomeHeaderModeChange < HEADER_HOME_MODE_COOLDOWN_MS) return;
    const y = window.scrollY || document.documentElement.scrollTop;

    if (!headerScrollCompact && y >= SCROLL_COMPACT_DOWN) {
      headerScrollCompact = true;
      lastHomeHeaderModeChange = performance.now();
      header.classList.add("header--home-compact");
      header.classList.remove("header--home-expanded");
    } else if (headerScrollCompact && y <= SCROLL_COMPACT_UP) {
      headerScrollCompact = false;
      lastHomeHeaderModeChange = performance.now();
      header.classList.remove("header--home-compact");
      header.classList.add("header--home-expanded");
    }
  }

  let scrollRaf = false;
  function onWindowScroll() {
    if (scrollRaf) return;
    scrollRaf = true;
    requestAnimationFrame(() => {
      scrollRaf = false;
      if (whatSuggestionsOpen || regionPopoverOpen) closeSearchDropdowns();
      if (accountMenuOpen) closeAccountMenu();
      syncHomeHeaderScroll();
    });
  }

  function showSupplierPanel(tab) {
    const allowed = ["today", "calendar", "listing"];
    const t = allowed.includes(tab) ? tab : "today";
    document.querySelectorAll(".supplier-panel").forEach((p) => {
      p.classList.toggle("active", p.id === `supplier-panel-${t}`);
    });
  }

  function updateHostNav() {
    const hostNav = $("host-nav");
    const header = $("site-header");
    if (!hostNav || !header) return;
    const showHostNav = appMode === "supplier" && view === "supplier";
    hostNav.hidden = !showHostNav;
    /** Hide duplicate header “Messages” only while supplier tabs occupy the header. */
    const supplierHeaderChrome = appMode === "supplier" && view === "supplier";
    header.classList.toggle("header--supplier", supplierHeaderChrome);
    const highlightTab = supplierTab === "messages" ? "today" : supplierTab;
    hostNav.querySelectorAll(".host-nav-link").forEach((btn) => {
      const tab = btn.getAttribute("data-supplier-tab");
      btn.classList.toggle("active", tab === highlightTab);
    });
  }

  function setSupplierTab(tab) {
    if (!tab) return;
    supplierTab = tab;
    if (tab === "messages") {
      openMessages(activeThreadId);
      return;
    }
    setView("supplier");
    window.scrollTo(0, 0);
  }

  function setView(next) {
    view = next;
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    const header = $("site-header");
    header.classList.toggle("search-hidden", view !== "home");
    header.classList.toggle("messages-mode", view === "messages");

    if (view === "home") {
      header.classList.add("header--home");
      syncHomeHeaderScroll();
      $("page-home").classList.add("active");
      selectedFactoryId = null;
    } else if (view === "detail") {
      $("page-detail").classList.add("active");
    } else if (view === "profile") {
      $("page-profile").classList.add("active");
      renderProfile();
    } else if (view === "saved") {
      $("page-saved").classList.add("active");
      selectedFactoryId = null;
      renderSaved();
    } else if (view === "settings") {
      $("page-settings").classList.add("active");
      renderSettings();
    } else if (view === "supplier") {
      $("page-supplier").classList.add("active");
      const panelTab = supplierTab === "messages" ? "today" : supplierTab;
      showSupplierPanel(panelTab);
    } else if (view === "messages") {
      $("page-messages").classList.add("active");
    }

    if (view !== "home") {
      headerScrollCompact = false;
      lastHomeHeaderModeChange = 0;
      header.classList.remove("header--home", "header--home-expanded", "header--home-compact");
      closeSearchDropdowns();
    }

    if (view !== "detail") closeListingGallery();

    updateModeSwitchLabel();
    syncMsgMobileBody();
    updateHostNav();
    closeAccountMenu();
  }

  function closeAccountMenu() {
    const drop = $("user-menu-dropdown");
    const trigger = $("user-menu-trigger");
    accountMenuOpen = false;
    if (drop) drop.hidden = true;
    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
      trigger.classList.remove("is-open");
    }
  }

  function openAccountMenu() {
    closeSearchDropdowns();
    const drop = $("user-menu-dropdown");
    const trigger = $("user-menu-trigger");
    if (!drop || !trigger) return;
    accountMenuOpen = true;
    drop.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    trigger.classList.add("is-open");
  }

  function toggleAccountMenu() {
    if (accountMenuOpen) closeAccountMenu();
    else openAccountMenu();
  }

  function updateModeSwitchLabel() {
    const el = $("mode-switch-link");
    if (!el) return;
    if (appMode === "supplier") {
      el.textContent = "Switch to customer";
    } else {
      el.textContent = "Switch to supplier";
    }
  }

  function goHome() {
    viewingProfileId = null;
    settingsEditingField = null;
    appMode = "customer";
    selectedFactoryId = null;
    detailHeroIndex = 0;
    setView("home");
    renderGrid();
    window.scrollTo(0, 0);
    syncHomeHeaderScroll();
  }

  function openDetail(id) {
    selectedFactoryId = id;
    detailHeroIndex = 0;
    setView("detail");
    renderDetail();
  }

  function openSupplier() {
    appMode = "supplier";
    supplierTab = "today";
    setView("supplier");
    window.scrollTo(0, 0);
  }

  function openCustomer() {
    goHome();
  }

  function openMessages(threadId, fromDetail) {
    closeAccountMenu();
    settingsEditingField = null;
    if (appMode === "supplier") supplierTab = "messages";
    setView("messages");
    if (threadId != null) {
      activeThreadId = threadId;
    } else if (isMobileMsg() && !fromDetail) {
      activeThreadId = null;
    } else {
      activeThreadId = threads[0]?.id ?? null;
    }
    renderThreadList();
    renderConversation();
    renderContextPanel();
    syncMsgMobileBody();
    const inp = $("msg-input");
    if (inp && detailQuotePrefill) {
      inp.value = detailQuotePrefill;
      detailQuotePrefill = null;
      requestAnimationFrame(() => {
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      });
    }
  }

  function getSearchTerms() {
    const what = ($("search-what") && $("search-what").value.trim().toLowerCase()) || "";
    const regionKeywords = regionOptions.filter((r) => regionCounts[r.id] > 0).flatMap((r) => r.keywords);
    return { what, regionKeywords };
  }

  function factoryMatchesSearch(f, terms) {
    const blob = `${f.name} ${f.category} ${f.location} ${f.tags.join(" ")}`.toLowerCase();
    if (terms.what && !blob.includes(terms.what)) return false;
    if (terms.regionKeywords.length > 0) {
      const loc = f.location.toLowerCase();
      if (!terms.regionKeywords.some((kw) => loc.includes(kw))) return false;
    }
    return true;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  let whatSuggestionsOpen = false;
  let regionPopoverOpen = false;
  let accountMenuOpen = false;

  function syncSearchBarDropdownClass() {
    const bar = $("search-bar");
    if (!bar) return;
    bar.classList.toggle("search-bar--dropdown-open", whatSuggestionsOpen || regionPopoverOpen);
  }

  function closeSearchDropdowns() {
    closeWhatSuggestions();
    closeRegionPopover();
  }

  function renderWhatSuggestionList() {
    const root = $("what-suggestions-list");
    if (!root) return;
    root.innerHTML = whatSuggestions
      .map(
        (s, i) =>
          `<button type="button" class="search-suggestion-btn" role="option" data-query="${escapeAttr(s.query)}" id="what-opt-${i}">
            <span class="search-suggestion-icon">${s.icon}</span>
            <span class="search-suggestion-text">
              <span class="search-suggestion-title">${escapeHtml(s.title)}</span>
              <span class="search-suggestion-sub">${escapeHtml(s.subtitle)}</span>
            </span>
          </button>`
      )
      .join("");

    root.querySelectorAll(".search-suggestion-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const q = btn.getAttribute("data-query");
        if ($("search-what")) $("search-what").value = q;
        closeWhatSuggestions();
        renderGrid();
      });
    });
  }

  function openWhatSuggestions() {
    if (view !== "home") return;
    closeAccountMenu();
    closeRegionPopover();
    const panel = $("what-suggestions");
    const input = $("search-what");
    if (!panel || !input) return;
    whatSuggestionsOpen = true;
    syncSearchBarDropdownClass();
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function closeWhatSuggestions() {
    const panel = $("what-suggestions");
    const input = $("search-what");
    whatSuggestionsOpen = false;
    if (panel) panel.hidden = true;
    if (input) input.setAttribute("aria-expanded", "false");
    syncSearchBarDropdownClass();
  }

  function updateRegionSummary() {
    const el = $("region-field-summary");
    if (!el) return;
    const selected = regionOptions.filter((r) => regionCounts[r.id] > 0).map((r) => r.label);
    if (selected.length === 0) {
      el.textContent = "Add regions";
      el.classList.add("region-field-value--placeholder");
    } else {
      el.textContent = selected.join(", ");
      el.classList.remove("region-field-value--placeholder");
    }
  }

  function syncRegionRow(id) {
    const list = $("region-popover-list");
    const row = list?.querySelector(`[data-region-id="${id}"]`);
    if (!row) return;
    const n = regionCounts[id];
    const valEl = row.querySelector(".region-stepper-val");
    const dec = row.querySelector('[data-act="dec"]');
    const inc = row.querySelector('[data-act="inc"]');
    if (valEl) valEl.textContent = String(n);
    if (dec) dec.disabled = n <= 0;
    if (inc) inc.disabled = n >= 1;
  }

  function renderRegionStepperRows() {
    const root = $("region-popover-list");
    if (!root) return;
    root.innerHTML = regionOptions
      .map(
        (r) =>
          `<div class="region-popover-row" data-region-id="${escapeAttr(r.id)}">
            <div class="region-popover-row-text">
              <span class="region-popover-row-title">${escapeHtml(r.label)}</span>
              <span class="region-popover-row-sub">${escapeHtml(r.subtitle)}</span>
            </div>
            <div class="region-popover-stepper" role="group" aria-label="${escapeAttr(r.label)}">
              <button type="button" class="region-stepper-btn" data-act="dec" aria-label="Remove ${escapeAttr(r.label)}">−</button>
              <span class="region-stepper-val" aria-live="polite">0</span>
              <button type="button" class="region-stepper-btn" data-act="inc" aria-label="Add ${escapeAttr(r.label)}">+</button>
            </div>
          </div>`
      )
      .join("");
    regionOptions.forEach((r) => syncRegionRow(r.id));
    updateRegionSummary();
  }

  function onRegionStepperClick(e) {
    const btn = e.target.closest(".region-stepper-btn");
    if (!btn || btn.disabled) return;
    const row = btn.closest("[data-region-id]");
    if (!row) return;
    const id = row.getAttribute("data-region-id");
    const act = btn.getAttribute("data-act");
    if (act === "inc" && regionCounts[id] < 1) regionCounts[id] = 1;
    if (act === "dec" && regionCounts[id] > 0) regionCounts[id] = 0;
    syncRegionRow(id);
    updateRegionSummary();
    renderGrid();
  }

  function openRegionPopover() {
    if (view !== "home") return;
    closeAccountMenu();
    closeWhatSuggestions();
    const panel = $("region-popover");
    const trigger = $("region-field-trigger");
    const wrap = document.querySelector(".region-field-wrap");
    if (!panel || !trigger) return;
    regionPopoverOpen = true;
    syncSearchBarDropdownClass();
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    if (wrap) wrap.classList.add("is-open");
  }

  function closeRegionPopover() {
    const panel = $("region-popover");
    const trigger = $("region-field-trigger");
    const wrap = document.querySelector(".region-field-wrap");
    regionPopoverOpen = false;
    if (panel) panel.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    if (wrap) wrap.classList.remove("is-open");
    syncSearchBarDropdownClass();
  }

  function resetRegionFilters() {
    regionOptions.forEach((r) => {
      regionCounts[r.id] = 0;
    });
    regionOptions.forEach((r) => syncRegionRow(r.id));
    updateRegionSummary();
  }

  function openProfileNavigation() {
    profileReturnTarget = { view, factoryId: selectedFactoryId, threadId: activeThreadId };
    profileEditMode = false;
    profileReviewsExpanded = false;
    settingsEditingField = null;
    closeAccountMenu();
    setView("profile");
  }

  function profileIconSvg(kind) {
    const c =
      'class="profile-detail-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    const icons = {
      briefcase: `<svg ${c}><path d="M20 7h-3V5a2 2 0 00-2-2H9a2 2 0 00-2 2v2H4a2 2 0 00-2 2v11a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM9 5h6v2H9V5z"/></svg>`,
      globe: `<svg ${c}><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg>`,
      shield: `<svg ${c}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
      target: `<svg ${c}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
      chip: `<svg ${c}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>`,
      package: `<svg ${c}><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>`,
      metal: `<svg ${c}><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>`,
      cpu: `<svg ${c}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3"/></svg>`,
    };
    return icons[kind] || icons.briefcase;
  }

  function profileStars(n) {
    const x = Math.min(5, Math.max(0, Math.round(Number(n) || 0)));
    const spans = Array.from({ length: 5 }, (_, i) => `<span class="profile-star${i < x ? " is-on" : ""}" aria-hidden="true">★</span>`).join("");
    return `<span class="profile-star-row" aria-label="${x} out of 5 stars">${spans}</span>`;
  }

  function renderProfile() {
    const root = $("profile-root");
    if (!root) return;
    const p = getDisplayedProfile();
    const editable = canEditDisplayedProfile();
    const reviews = p.reviewsReceived || [];
    const reviewsSubtitle =
      p.role === "customer" ? "From suppliers you’ve worked with" : "From buyers who messaged you";
    const previewCount = 2;
    const showExpand = reviews.length > previewCount && !profileReviewsExpanded;
    const visibleReviews = profileReviewsExpanded ? reviews : reviews.slice(0, previewCount);

    const reviewsHtml = `
      <section class="profile-reviews-block" aria-label="Reviews">
        <h3 class="profile-reviews-heading">Reviews</h3>
        <p class="profile-reviews-lead">${escapeHtml(reviewsSubtitle)}</p>
        <div class="profile-review-grid">
          ${visibleReviews
            .map(
              (r) => `
            <article class="profile-review-card">
              <div class="profile-review-top">
                <span class="profile-review-avatar" aria-hidden="true">${escapeHtml(r.reviewerName.trim().charAt(0))}</span>
                <div>
                  <div class="profile-review-name">${escapeHtml(r.reviewerName)}</div>
                  <div class="profile-review-meta">${escapeHtml(r.reviewerLocation)} · ${escapeHtml(r.date)} · ${r.reviewerRole === "supplier" ? "Supplier" : "Buyer"}</div>
                </div>
              </div>
              ${profileStars(r.rating)}
              <p class="profile-review-body">${escapeHtml(r.body)}</p>
            </article>`
            )
            .join("")}
        </div>
        ${
          showExpand
            ? `<button type="button" class="profile-show-all-btn" id="profile-reviews-expand">Show all ${reviews.length} reviews</button>`
            : ""
        }
      </section>`;

    const aboutMain = `
      <div class="profile-main-head">
        <h2 class="profile-main-title">About</h2>
        ${
          editable && !profileEditMode
            ? `<div class="profile-main-actions">
                <button type="button" class="profile-edit-btn" id="profile-edit-toggle">Edit</button>
              </div>`
            : editable && profileEditMode
              ? `<p class="profile-editing-label">Editing profile</p>`
              : ""
        }
      </div>
      <div class="profile-summary-card">
        <div class="profile-summary-left">
          <div class="profile-photo-wrap">
            <span class="profile-photo">${escapeHtml(p.avatarLetter)}</span>
            ${p.verified ? `<span class="profile-verified-badge" title="Verified">${verifiedSVG}</span>` : ""}
          </div>
          ${
            profileEditMode && editable
              ? `<label class="profile-field-label">Display name<input class="profile-input" id="profile-input-name" value="${escapeAttr(p.displayName)}" /></label>
                 <label class="profile-field-label">Location<input class="profile-input" id="profile-input-location" value="${escapeAttr(p.location)}" /></label>`
              : `<h3 class="profile-name">${escapeHtml(p.displayName)}</h3>
                 <p class="profile-location">${escapeHtml(p.location)}</p>`
          }
        </div>
        <div class="profile-summary-stats">
          <div class="profile-stat"><span class="profile-stat-value">${escapeHtml(p.stats.a.value)}</span><span class="profile-stat-label">${escapeHtml(p.stats.a.label)}</span></div>
          <div class="profile-stat"><span class="profile-stat-value">${escapeHtml(p.stats.b.value)}</span><span class="profile-stat-label">${escapeHtml(p.stats.b.label)}</span></div>
          <div class="profile-stat"><span class="profile-stat-value">${escapeHtml(p.stats.c.value)}</span><span class="profile-stat-label">${escapeHtml(p.stats.c.label)}</span></div>
        </div>
      </div>
      ${
        profileEditMode && editable
          ? `<label class="profile-field-label profile-field-label--full">Headline<textarea class="profile-textarea profile-textarea--sm" id="profile-input-headline" rows="2">${escapeHtml(p.headline)}</textarea></label>`
          : `<p class="profile-headline">${escapeHtml(p.headline)}</p>`
      }
      <ul class="profile-detail-list">
        ${p.details
          .map((d) => {
            if (profileEditMode && editable) {
              return `<li class="profile-detail-row">
                <span class="profile-detail-icon">${profileIconSvg(d.icon)}</span>
                <div class="profile-detail-body">
                  <span class="profile-detail-label">${escapeHtml(d.label)}</span>
                  <input class="profile-input profile-input--flat" data-profile-detail-id="${escapeAttr(d.id)}" value="${escapeAttr(d.value)}" />
                </div>
              </li>`;
            }
            return `<li class="profile-detail-row">
              <span class="profile-detail-icon">${profileIconSvg(d.icon)}</span>
              <div class="profile-detail-body">
                <span class="profile-detail-label">${escapeHtml(d.label)}</span>
                <span class="profile-detail-value">${escapeHtml(d.value)}</span>
              </div>
            </li>`;
          })
          .join("")}
      </ul>
      <h4 class="profile-tags-title">Focus & interests</h4>
      <div class="profile-tags-grid">
        ${p.tags
          .map(
            (t) =>
              `<div class="profile-tag-cell"><span class="profile-tag-icon">${profileIconSvg(t.icon)}</span><span>${escapeHtml(t.label)}</span></div>`
          )
          .join("")}
      </div>
      ${
        profileEditMode && editable
          ? `<label class="profile-field-label profile-field-label--full">About you<textarea class="profile-textarea" id="profile-input-bio" rows="4">${escapeHtml(p.bio)}</textarea></label>
             <div class="profile-edit-actions">
               <button type="button" class="cta-btn cta-btn-outline" id="profile-edit-cancel">Cancel</button>
               <button type="button" class="cta-btn" id="profile-edit-save">Save</button>
             </div>`
          : `<p class="profile-bio">${escapeHtml(p.bio)}</p>`
      }
      ${reviewsHtml}`;

    root.innerHTML = `
      <div class="profile-layout profile-layout--single">
        <h1 class="profile-page-title">Profile</h1>
        <div class="profile-main">${aboutMain}</div>
      </div>`;

    const expandBtn = root.querySelector("#profile-reviews-expand");
    if (expandBtn) {
      expandBtn.addEventListener("click", () => {
        profileReviewsExpanded = true;
        renderProfile();
      });
    }

    const editToggle = root.querySelector("#profile-edit-toggle");
    if (editToggle) {
      editToggle.addEventListener("click", () => {
        profileEditMode = true;
        renderProfile();
      });
    }

    const saveBtn = root.querySelector("#profile-edit-save");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        const nameEl = root.querySelector("#profile-input-name");
        const locEl = root.querySelector("#profile-input-location");
        const headEl = root.querySelector("#profile-input-headline");
        const bioEl = root.querySelector("#profile-input-bio");
        if (nameEl) p.displayName = nameEl.value.trim() || p.displayName;
        if (locEl) p.location = locEl.value.trim() || p.location;
        if (headEl) p.headline = headEl.value.trim() || p.headline;
        if (bioEl) p.bio = bioEl.value.trim() || p.bio;
        root.querySelectorAll("[data-profile-detail-id]").forEach((inp) => {
          const id = inp.getAttribute("data-profile-detail-id");
          const row = p.details.find((d) => d.id === id);
          if (row) row.value = inp.value.trim() || row.value;
        });
        profileEditMode = false;
        renderProfile();
        dbSaveProfile();
      });
    }

    const cancelBtn = root.querySelector("#profile-edit-cancel");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        profileEditMode = false;
        renderProfile();
      });
    }
  }

  function syncProfileFromAccountSettings() {
    const p = profilesById[signedInProfileId()];
    if (!p) return;
    p.displayName = accountSettings.legalName.trim() || p.displayName;
    if (p.role === "customer") {
      const row = p.details.find((d) => d.id === "company");
      if (row) row.value = accountSettings.company.trim() || row.value;
    }
  }

  function openSettingsNavigation() {
    settingsEditingField = null;
    closeAccountMenu();
    setView("settings");
  }

  function renderSettings() {
    const root = $("settings-root");
    if (!root) return;

    const sectionTitles = {
      personal: "Personal information",
      notifications: "Notifications",
      privacy: "Privacy",
    };
    const mainTitle = sectionTitles[settingsSection] || "Settings";

    const tzOptions = [
      { value: "Europe/Berlin", label: "Berlin (GMT+1)" },
      { value: "Europe/London", label: "London (GMT)" },
      { value: "America/New_York", label: "New York (GMT-5)" },
      { value: "America/Los_Angeles", label: "Los Angeles (GMT-8)" },
      { value: "Asia/Shanghai", label: "Shanghai (GMT+8)" },
    ];

    const visOptions = [
      { value: "matched", label: "Matched contacts only" },
      { value: "public", label: "Public on marketplace" },
      { value: "private", label: "Minimal visibility" },
    ];

    function fieldRow(key, label, opt = {}) {
      const { hint, type = "text", optional, inputKind = "input", options } = opt;
      const raw = accountSettings[key];
      const str = raw == null ? "" : String(raw);
      const editing = settingsEditingField === key;
      const empty = !str.trim();
      const valueHtml = empty
        ? optional
          ? `<span class="settings-field-value settings-field-value--empty">Not provided</span>`
          : `<span class="settings-field-value">—</span>`
        : `<span class="settings-field-value">${escapeHtml(str)}</span>`;

      let fieldControl = "";
      let actions = "";
      if (editing) {
        if (inputKind === "select" && options) {
          fieldControl = `<select class="settings-input" id="settings-input-${key}" aria-label="${escapeAttr(label)}">${options
            .map(
              (o) =>
                `<option value="${escapeAttr(o.value)}"${o.value === str ? " selected" : ""}>${escapeHtml(o.label)}</option>`
            )
            .join("")}</select>`;
        } else {
          fieldControl = `<input class="settings-input" id="settings-input-${key}" type="${escapeAttr(type)}" value="${escapeAttr(str)}" aria-label="${escapeAttr(label)}" />`;
        }
        actions = `<button type="button" class="settings-link-btn" data-settings-save="${escapeAttr(key)}">Save</button><button type="button" class="settings-link-btn settings-link-btn--muted" data-settings-cancel>Cancel</button>`;
      } else {
        const linkLabel = empty && optional ? "Add" : "Edit";
        actions = `<button type="button" class="settings-link-btn" data-settings-edit="${escapeAttr(key)}">${linkLabel}</button>`;
      }

      return `
        <div class="settings-field${editing ? " is-editing" : ""}">
          <div class="settings-field-grid">
            <div class="settings-field-main">
              <div class="settings-field-label">${escapeHtml(label)}</div>
              ${editing ? fieldControl : valueHtml}
              ${hint ? `<p class="settings-field-hint">${escapeHtml(hint)}</p>` : ""}
            </div>
            <div class="settings-field-actions">${actions}</div>
          </div>
        </div>`;
    }

    function toggleRow(key, title, hint) {
      const on = !!accountSettings[key];
      return `
        <div class="settings-field settings-field--toggle">
          <div class="settings-field-grid">
            <div class="settings-field-main">
              <div class="settings-field-label">${escapeHtml(title)}</div>
              <p class="settings-field-hint">${escapeHtml(hint)}</p>
            </div>
            <button type="button" class="settings-toggle${on ? " is-on" : ""}" role="switch" aria-checked="${on}" aria-label="${escapeAttr(title)}" data-settings-toggle="${escapeAttr(key)}"><span class="settings-toggle-knob" aria-hidden="true"></span></button>
          </div>
        </div>`;
    }

    let mainInner = "";
    if (settingsSection === "personal") {
      mainInner = [
        fieldRow("legalName", "Legal name", {
          hint: "Your official name for contracts and verification.",
        }),
        fieldRow("preferredName", "Preferred first name", {
          optional: true,
          hint: "Shown to suppliers in messages when provided.",
        }),
        fieldRow("email", "Email address", { type: "email", hint: "Used for login and inquiry updates." }),
        fieldRow("phone", "Phone number", {
          type: "tel",
          hint: "We only share this with factories you choose to connect with.",
        }),
        fieldRow("company", "Company or organization", { hint: "Helps suppliers understand who they’re quoting." }),
        fieldRow("timezone", "Time zone", {
          inputKind: "select",
          options: tzOptions,
          hint: "Used for scheduling and message timestamps.",
        }),
      ].join("");
    } else if (settingsSection === "notifications") {
      mainInner =
        toggleRow("emailNewMessages", "Email for new messages", "When a factory sends a reply in your thread.") +
        toggleRow("emailDigest", "Weekly sourcing digest", "Open inquiries, saved factories, and tips.");
    } else {
      const visStr = accountSettings.profileVisibility;
      const visLabel = visOptions.find((o) => o.value === visStr)?.label || visStr;
      const editingVis = settingsEditingField === "profileVisibility";
      mainInner =
        (editingVis
          ? fieldRow("profileVisibility", "Profile visibility", {
              inputKind: "select",
              options: visOptions,
              hint: "Who can see your name, company, and public profile details.",
            })
          : `<div class="settings-field">
          <div class="settings-field-grid">
            <div class="settings-field-main">
              <div class="settings-field-label">Profile visibility</div>
              <span class="settings-field-value">${escapeHtml(visLabel)}</span>
              <p class="settings-field-hint">Who can see your name, company, and public profile details.</p>
            </div>
            <div class="settings-field-actions"><button type="button" class="settings-link-btn" data-settings-edit="profileVisibility">Edit</button></div>
          </div>
        </div>`) + toggleRow("showPhoneToMatched", "Show phone to matched factories", "After you message a supplier, they can see your number if enabled.");
    }

    root.innerHTML = `
      <div class="settings-layout">
        <aside class="settings-sidebar" aria-label="Settings sections">
          <h1 class="settings-sidebar-title">Settings</h1>
          <nav class="settings-nav">
            <button type="button" class="settings-nav-item${settingsSection === "personal" ? " is-active" : ""}" data-settings-nav="personal">
              <span class="settings-nav-ico" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
              Personal information
            </button>
            <button type="button" class="settings-nav-item${settingsSection === "notifications" ? " is-active" : ""}" data-settings-nav="notifications">
              <span class="settings-nav-ico" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg></span>
              Notifications
            </button>
            <button type="button" class="settings-nav-item${settingsSection === "privacy" ? " is-active" : ""}" data-settings-nav="privacy">
              <span class="settings-nav-ico" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>
              Privacy
            </button>
          </nav>
        </aside>
        <div class="settings-main">
          <h2 class="settings-main-title">${escapeHtml(mainTitle)}</h2>
          <div class="settings-panel">${mainInner}</div>
        </div>
      </div>`;

    root.querySelectorAll("[data-settings-nav]").forEach((btn) => {
      btn.addEventListener("click", () => {
        settingsSection = btn.getAttribute("data-settings-nav") || "personal";
        settingsEditingField = null;
        renderSettings();
      });
    });

    root.querySelectorAll("[data-settings-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        settingsEditingField = btn.getAttribute("data-settings-edit");
        renderSettings();
        requestAnimationFrame(() => document.getElementById(`settings-input-${settingsEditingField}`)?.focus());
      });
    });

    root.querySelectorAll("[data-settings-save]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-settings-save");
        if (!key) return;
        const inp = document.getElementById(`settings-input-${key}`);
        if (inp) accountSettings[key] = inp.value.trim();
        if (key === "legalName" || key === "company") syncProfileFromAccountSettings();
        settingsEditingField = null;
        renderSettings();
        dbSaveSettings();
      });
    });

    root.querySelectorAll("[data-settings-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        settingsEditingField = null;
        renderSettings();
      });
    });

    root.querySelectorAll("[data-settings-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-settings-toggle");
        if (!key || !(key in accountSettings)) return;
        accountSettings[key] = !accountSettings[key];
        renderSettings();
        dbSaveSettings();
      });
    });
  }

  function renderGrid() {
    const terms = getSearchTerms();
    const hasFilter = !!(terms.what || terms.regionKeywords.length);
    const data = factories.filter((f) => factoryMatchesSearch(f, terms));
    $("grid-title").textContent = hasFilter ? `Manufacturers (${data.length})` : "Top manufacturers";

    if (data.length === 0) {
      $("factory-grid").innerHTML =
        '<p class="grid-empty">No manufacturers match your search. Try broader keywords or clear filters.</p>';
      return;
    }

    $("factory-grid").innerHTML = data.map((f) => factoryCardHtml(f)).join("");
    bindFactoryCardWraps($("factory-grid"));
  }

  function renderSaved() {
    const root = $("saved-root");
    if (!root) return;
    const data = getSavedFactories();
    if (data.length === 0) {
      root.innerHTML = `<div class="saved-empty">
        <p class="saved-empty-lead">You have not saved any manufacturers yet.</p>
        <p class="saved-empty-hint">Use the heart on a listing card or Save on a manufacturer page.</p>
        <button type="button" class="cta-btn" id="saved-browse-btn">Browse manufacturers</button>
      </div>`;
      $("saved-browse-btn")?.addEventListener("click", () => goHome());
      return;
    }
    root.innerHTML = `<div class="factory-grid" id="saved-grid">${data.map((f) => factoryCardHtml(f)).join("")}</div>`;
    bindFactoryCardWraps($("saved-grid"));
  }

  function renderDetail() {
    const f = factoryById(selectedFactoryId);
    const root = $("detail-root");
    if (!f) {
      root.innerHTML = "";
      return;
    }
    const gallery = galleryForFactory(f);
    closeListingGallery();
    const hero = gallery[detailHeroIndex % gallery.length] || f.img;
    const g1 = gallery[0] || f.img;
    const g2 = gallery[1] || f.img;
    const g3 = gallery[2] || f.img;
    const g4 = gallery[3] || f.img;
    const g5 = gallery[4] || f.img;
    const offers = factoryOffers(f);
    const reviews = factoryReviewSamples(f);
    const contactFirst = f.contact.split(" ")[0];
    const initials = f.contact
      .split(" ")
      .map((p) => p[0])
      .join("")
      .slice(0, 2);

    const offerCells = offers
      .map(
        (o) =>
          `<div class="listing-offer-cell"><span class="listing-offer-ico">${offerIconSvg(o.icon)}</span><span>${escapeHtml(o.label)}</span></div>`
      )
      .join("");

    const reviewCards = reviews
      .map(
        (r) => `
      <article class="listing-review-card">
        <div class="listing-review-head">
          <span class="listing-review-avatar" aria-hidden="true">${escapeHtml(r.name.charAt(0))}</span>
          <div>
            <div class="listing-review-name">${escapeHtml(r.name)}</div>
            <div class="listing-review-meta">${escapeHtml(r.meta)}</div>
          </div>
        </div>
        <div class="listing-review-stars">${starSVG} <strong>${r.rating}</strong> · <span class="listing-review-date">${escapeHtml(r.date)}</span></div>
        <p class="listing-review-text">${escapeHtml(r.text)}</p>
      </article>`
      )
      .join("");

    root.innerHTML = `
      <div class="listing-page">
        <div class="listing-title-row">
          <h1 class="listing-title">${escapeHtml(f.name)}${f.verified ? verifiedSVG : ""}</h1>
          <div class="listing-title-actions">
            <button type="button" class="listing-icon-btn" id="detail-share" aria-label="Share listing">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13"/></svg>
              Share
            </button>
            <button type="button" class="listing-icon-btn${isSavedFactoryId(f.id) ? " is-saved" : ""}" id="detail-save-top" aria-label="${isSavedFactoryId(f.id) ? "Remove from saved manufacturers" : "Save manufacturer"}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
              <span class="detail-save-label">${isSavedFactoryId(f.id) ? "Saved" : "Save"}</span>
            </button>
          </div>
        </div>

        <div class="listing-gallery-grid" id="listing-photos">
          <button type="button" class="listing-g-hero" data-idx="0" aria-label="Main photo">
            <img src="${hero}" alt="${escapeHtml(f.name)}" />
          </button>
          <button type="button" class="listing-g-cell" data-idx="1" aria-label="Photo 2"><img src="${g1}" alt="" /></button>
          <button type="button" class="listing-g-cell" data-idx="2" aria-label="Photo 3"><img src="${g2}" alt="" /></button>
          <button type="button" class="listing-g-cell" data-idx="3" aria-label="Photo 4"><img src="${g4}" alt="" /></button>
          <button type="button" class="listing-g-cell listing-g-cell--more" id="listing-open-all-photos" aria-label="Show all photos">
            <img src="${g5}" alt="" />
            <span class="listing-show-photos">Show all photos</span>
          </button>
        </div>

        <nav class="listing-anchor-nav" aria-label="Jump to section">
          <a class="listing-anchor-link" href="#listing-offers">What they offer</a>
          <a class="listing-anchor-link" href="#listing-reviews">Reviews</a>
          <a class="listing-anchor-link" href="#listing-location">Location</a>
        </nav>

        <div class="listing-columns">
          <div class="listing-col-main">
            <p class="listing-kicker">${escapeHtml(f.category)} in ${escapeHtml(f.location.split(",")[0] || f.location)}</p>
            <p class="listing-subline">MOQ ${escapeHtml(f.moq)} · Typical ${escapeHtml(f.leadTime)} · ${escapeHtml(f.price)}</p>

            <div class="listing-top-badge-banner">
              <span class="listing-top-badge-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg></span>
              <div>
                <strong>${escapeHtml(f.badge)}</strong>
                <span class="listing-top-badge-stats">${starSVG} ${f.rating} · <a class="listing-anchor-link listing-anchor-inline" href="#listing-reviews">${f.reviews} reviews</a></span>
              </div>
            </div>

            <section class="listing-host-card" aria-label="Supplier contact">
              <div class="listing-host-photo" aria-hidden="true">${escapeHtml(initials)}</div>
              <div class="listing-host-body">
                <div class="listing-host-name">Hosted by ${escapeHtml(f.contact)}</div>
                <div class="listing-host-meta">${f.verified ? "Verified manufacturer" : "Manufacturer"} · Responds in about ${f.responseHours} hours</div>
              </div>
            </section>

            <p class="listing-about">${escapeHtml(factoryListingBlurb(f))}</p>

            <section class="listing-section" id="listing-offers">
              <h2 class="listing-section-title">What this supplier offers</h2>
              <p class="listing-section-lead">Capabilities and services you can ask about in your quote thread.</p>
              <div class="listing-offers-grid">${offerCells}</div>
            </section>

            <section class="listing-section" id="listing-reviews">
              <h2 class="listing-section-title">Reviews</h2>
              <p class="listing-section-lead">${starSVG} <strong>${f.rating}</strong> · ${f.reviews} reviews from buyers · sample feedback below</p>
              <div class="listing-review-pills" role="list">
                <span class="listing-pill" role="listitem">Quality ${Math.min(99, f.reviews)}</span>
                <span class="listing-pill" role="listitem">Communication ${Math.min(88, f.reviews - 5)}</span>
                <span class="listing-pill" role="listitem">On-time ${Math.min(76, f.reviews - 12)}</span>
              </div>
              <div class="listing-review-grid">${reviewCards}</div>
            </section>

            <section class="listing-section" id="listing-location">
              <h2 class="listing-section-title">Location</h2>
              <p class="listing-location-line">${escapeHtml(f.location)}</p>
              <a class="listing-map-link" href="${escapeAttr(mapsSearchUrl(f.location))}" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>
              <div class="listing-map-placeholder" role="img" aria-label="Map preview for ${escapeAttr(f.location)}">
                <span class="listing-map-pin" aria-hidden="true"></span>
                <span class="listing-map-label">${escapeHtml(f.location.split(",")[0] || f.location)}</span>
              </div>
            </section>
          </div>

          <aside class="listing-col-aside" aria-label="Request a quote">
            <div class="listing-quote-card">
              <p class="listing-quote-badge">${f.verified ? "High inquiry volume · reply within hours" : "Message to confirm capacity"}</p>
              <p class="listing-quote-price">${escapeHtml(f.price)}</p>
              <p class="listing-quote-sub">Indicative unit pricing — final quote depends on volume and specs.</p>

              <div class="listing-quote-fields">
                <label class="listing-quote-label">
                  <span class="listing-quote-label-text">Quantity needed</span>
                  <input type="text" class="listing-quote-input" id="detail-quote-qty" placeholder="e.g. 800 units" autocomplete="off" />
                </label>
                <label class="listing-quote-label">
                  <span class="listing-quote-label-text">Target timeline (optional)</span>
                  <input type="text" class="listing-quote-input" id="detail-quote-time" placeholder="e.g. First ship by Q3" autocomplete="off" />
                </label>
                <label class="listing-quote-label">
                  <span class="listing-quote-label-text">Notes for supplier</span>
                  <textarea class="listing-quote-textarea" id="detail-quote-notes" rows="3" placeholder="SKU, materials, certifications, destination…"></textarea>
                </label>
              </div>

              <button type="button" class="listing-quote-cta" id="detail-message-quote">Message for quote</button>
              <button type="button" class="listing-quote-secondary" id="detail-message-quick">Message ${escapeHtml(contactFirst)}</button>
              <p class="listing-quote-foot">No payment through this preview — you agree scope in chat before any deposit.</p>
              ${
                f.profileId
                  ? `<button type="button" class="listing-quote-link" id="detail-view-profile">View supplier profile</button>`
                  : ""
              }
            </div>
          </aside>
        </div>
      </div>`;

    root.querySelectorAll(".listing-gallery-grid button").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.id === "listing-open-all-photos") {
          openListingGallery(f);
          return;
        }
        const idx = btn.getAttribute("data-idx");
        if (idx != null) {
          detailHeroIndex = Number(idx);
          renderDetail();
        }
      });
    });

    function buildQuotePrefill() {
      const qty = root.querySelector("#detail-quote-qty")?.value?.trim() || "";
      const time = root.querySelector("#detail-quote-time")?.value?.trim() || "";
      const notes = root.querySelector("#detail-quote-notes")?.value?.trim() || "";
      let t = `Hi ${contactFirst} — I'd like a quote`;
      if (qty) t += ` for about ${qty}`;
      else t += ` for my project`;
      if (time) t += `. Target timeline: ${time}`;
      if (notes) t += `. ${notes}`;
      t += ". Can you share MOQ, lead time, and next steps?";
      return t;
    }

    root.querySelector("#detail-message-quote")?.addEventListener("click", () => {
      requireAuth(() => {
        detailQuotePrefill = buildQuotePrefill();
        openMessages(f.id, true);
      });
    });
    root.querySelector("#detail-message-quick")?.addEventListener("click", () => {
      requireAuth(() => {
        detailQuotePrefill = null;
        openMessages(f.id, true);
      });
    });

    const viewProf = root.querySelector("#detail-view-profile");
    if (viewProf) {
      viewProf.addEventListener("click", () => {
        if (!f.profileId) return;
        viewingProfileId = f.profileId;
        openProfileNavigation();
      });
    }

    root.querySelector("#detail-share")?.addEventListener("click", () => {
      const url = window.location.href.split("#")[0];
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).catch(() => {});
      }
    });

    root.querySelector("#detail-save-top")?.addEventListener("click", () => {
      requireAuth(() => {
        toggleSavedFactoryId(f.id);
        syncSaveUiAfterToggle();
      });
    });
  }

  function filteredThreads() {
    if (messageFilter === "unread") return threads.filter((t) => t.unread);
    return threads;
  }

  function renderThreadList() {
    const list = $("msg-thread-list");
    const rows = filteredThreads();
    list.innerHTML = rows
      .map(
        (t) => `<button type="button" class="msg-thread ${t.id === activeThreadId ? "active" : ""}${t.unread ? " unread" : ""}" data-tid="${t.id}">
      <span class="thread-avatar" aria-hidden="true">${escapeHtml(t.avatarLetter)}</span>
      <span>
        <span class="thread-top"><span class="thread-name">${escapeHtml(t.participantName)}</span><span class="thread-date">${escapeHtml(t.lastDate)}</span></span>
        <div class="thread-context">${escapeHtml(t.contextLine)}</div>
        <div class="thread-snippet">${escapeHtml(t.lastMessage)}</div>
      </span>
    </button>`
      )
      .join("");

    list.querySelectorAll(".msg-thread").forEach((row) => {
      row.addEventListener("click", () => {
        activeThreadId = Number(row.getAttribute("data-tid"));
        const th = threads.find((t) => t.id === activeThreadId);
        if (th) th.unread = false;
        renderThreadList();
        renderConversation();
        renderContextPanel();
        syncMsgMobileBody();
      });
    });
  }

  function renderConversation() {
    const empty = $("msg-main-empty");
    const conv = $("msg-conversation");
    const f = factoryById(activeThreadId);

    if (!f) {
      empty.hidden = false;
      conv.hidden = true;
      return;
    }

    empty.hidden = true;
    conv.hidden = false;

    $("thread-avatar").textContent = f.contact
      .split(" ")
      .map((p) => p[0])
      .join("")
      .slice(0, 2);
    $("thread-name").textContent = `${f.contact} · ${f.name}`;
    $("thread-meta").textContent = `${f.category} · ${f.location}`;

    const msgs = chatTemplates[f.id] || [];
    let lastDate = "";
    let feedHtml = "";
    msgs.forEach((m) => {
      if (m.dateLabel !== lastDate) {
        feedHtml += `<div class="msg-day">${escapeHtml(m.dateLabel)}</div>`;
        lastDate = m.dateLabel;
      }
      if (m.from === "them") {
        const meta = `<div class="msg-meta-line">${escapeHtml(m.name)} · ${m.role || "Manufacturer"} · ${escapeHtml(m.time)}</div>`;
        const read = m.read ? `<div class="msg-read">${escapeHtml(m.read)}</div>` : "";
        feedHtml += `<div class="msg-row them">
        <span class="msg-avatar-sm" aria-hidden="true">${escapeHtml((m.name || "M").slice(0, 1))}</span>
        <div class="msg-bubble-wrap">${meta}<div class="msg-bubble">${escapeHtml(m.text)}</div>${read}</div>
      </div>`;
      } else {
        feedHtml += `<div class="msg-row me"><div class="msg-bubble-wrap"><div class="msg-bubble">${escapeHtml(m.text)}</div></div></div>`;
      }
    });
    $("msg-feed").innerHTML = feedHtml;

    $("response-hint-text").textContent = `Typical response time: ${f.responseHours} hours`;

    const scroll = $("msg-scroll");
    requestAnimationFrame(() => {
      scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    });
  }

  function renderContextPanel() {
    const f = factoryById(activeThreadId);
    const body = $("context-body");
    if (!f) {
      body.innerHTML = "<p class=\"context-note\">Select a conversation to see inquiry details.</p>";
      return;
    }
    body.innerHTML = `
      <div class="context-photo"><img src="${f.img}" alt="" /></div>
      <div class="context-factory">${escapeHtml(f.name)}</div>
      <p class="context-line">${escapeHtml(f.category)} · ${escapeHtml(f.location)}</p>
      <div class="context-boxes">
        <div class="context-box"><div class="context-box-label">MOQ</div><div class="context-box-value">${escapeHtml(f.moq)}</div></div>
        <div class="context-box"><div class="context-box-label">Lead time</div><div class="context-box-value">${escapeHtml(f.leadTime)}</div></div>
      </div>
      <p class="context-note">This inquiry is tied to this manufacturer so both sides always see the same context — unlike long email chains off-marketplace.</p>`;
  }

  function doSearch() {
    renderGrid();
  }

  function toggleModeFromHeader() {
    if (appMode === "supplier") openCustomer();
    else requireAuth(() => openSupplier());
  }

  const logoHome = $("logo-home");
  if (logoHome) {
    logoHome.addEventListener("click", () => {
      if (appMode === "supplier") {
        supplierTab = "today";
        setView("supplier");
        window.scrollTo(0, 0);
        return;
      }
      goHome();
    });
  }
  $("mode-switch-link").addEventListener("click", toggleModeFromHeader);
  $("supplier-back-customer").addEventListener("click", (e) => {
    e.preventDefault();
    openCustomer();
  });
  $("nav-messages").addEventListener("click", () => requireAuth(() => openMessages(activeThreadId)));

  const hostNavRoot = $("host-nav");
  if (hostNavRoot) {
    hostNavRoot.querySelectorAll("[data-supplier-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setSupplierTab(btn.getAttribute("data-supplier-tab")));
    });
  }

  document.querySelectorAll(".quick-action-btn[data-supplier-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setSupplierTab(btn.getAttribute("data-supplier-tab")));
  });

  const dashOpenThread2 = $("dash-open-thread-2");
  if (dashOpenThread2) {
    dashOpenThread2.addEventListener("click", () => {
      appMode = "supplier";
      supplierTab = "messages";
      openMessages(2);
    });
  }

  $("search-submit").addEventListener("click", () => {
    closeSearchDropdowns();
    doSearch();
  });
  $("search-what").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      closeSearchDropdowns();
      doSearch();
    }
  });

  $("search-what").addEventListener("focus", () => openWhatSuggestions());

  const regionListEl = $("region-popover-list");
  if (regionListEl) regionListEl.addEventListener("click", onRegionStepperClick);

  $("region-field-trigger").addEventListener("click", () => {
    if (regionPopoverOpen) closeRegionPopover();
    else openRegionPopover();
  });

  document.addEventListener(
    "pointerdown",
    (e) => {
      const whatBox = $("what-field-combobox");
      const regionBox = $("region-field-combobox");
      const userWrap = $("header-user-wrap");
      if (whatSuggestionsOpen && whatBox && !whatBox.contains(e.target)) closeWhatSuggestions();
      if (regionPopoverOpen && regionBox && !regionBox.contains(e.target)) closeRegionPopover();
      if (accountMenuOpen && userWrap && !userWrap.contains(e.target)) closeAccountMenu();
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (whatSuggestionsOpen || regionPopoverOpen)) {
      closeSearchDropdowns();
      $("search-what")?.blur();
      $("region-field-trigger")?.blur();
    } else if (e.key === "Escape" && accountMenuOpen) {
      closeAccountMenu();
      $("user-menu-trigger")?.blur();
    }
  });

  const userMenuTrigger = $("user-menu-trigger");
  if (userMenuTrigger) {
    userMenuTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleAccountMenu();
    });
  }

  $("account-menu-saved")?.addEventListener("click", () => {
    closeAccountMenu();
    setView("saved");
    window.scrollTo(0, 0);
  });

  $("account-menu-profile")?.addEventListener("click", () => {
    viewingProfileId = null;
    openProfileNavigation();
  });

  $("account-menu-settings")?.addEventListener("click", () => {
    openSettingsNavigation();
  });

  $("account-menu-help")?.addEventListener("click", () => {
    closeAccountMenu();
    document.querySelector(".footer")?.scrollIntoView({ behavior: "smooth", block: "end" });
  });

  $("account-menu-signout")?.addEventListener("click", () => {
    closeAccountMenu();
    $("search-what").value = "";
    resetRegionFilters();
    handleSignOut();
  });

  $("show-all-btn").addEventListener("click", () => {
    $("search-what").value = "";
    resetRegionFilters();
    closeSearchDropdowns();
    renderGrid();
  });

  document.querySelectorAll(".pill-filter").forEach((p) => {
    p.addEventListener("click", () => {
      document.querySelectorAll(".pill-filter").forEach((x) => x.classList.remove("active"));
      p.classList.add("active");
      messageFilter = p.getAttribute("data-filter") || "all";
      renderThreadList();
    });
  });

  $("btn-back-msg").addEventListener("click", () => {
    activeThreadId = null;
    renderThreadList();
    renderConversation();
    renderContextPanel();
    syncMsgMobileBody();
  });

  $("msg-send").addEventListener("click", () => {
    const input = $("msg-input");
    const text = (input.value || "").trim();
    if (!text || !activeThreadId) return;
    const f = factoryById(activeThreadId);
    if (!f) return;
    if (!chatTemplates[f.id]) chatTemplates[f.id] = [];
    const now = new Date();
    const dateLabel = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    chatTemplates[f.id].push({ from: "me", time, dateLabel, text });
    const th = threads.find((t) => t.id === f.id);
    if (th) {
      th.lastMessage = text;
      th.lastDate = "Now";
      th.unread = false;
    }
    input.value = "";
    renderThreadList();
    renderConversation();
    dbSaveMessage(f.id, text);
  });

  function closeInquiryOverlay() {
    const ctx = $("msg-context");
    if (!ctx) return;
    ctx.classList.remove("msg-context-overlay");
    ctx.style.cssText = "";
  }

  $("context-close").addEventListener("click", closeInquiryOverlay);

  $("btn-show-inquiry").addEventListener("click", () => {
    const ctx = $("msg-context");
    if (window.matchMedia("(min-width: 1100px)").matches) return;
    const open = ctx.style.display !== "flex";
    if (open) {
      ctx.classList.add("msg-context-overlay");
      ctx.style.display = "flex";
      ctx.style.position = "fixed";
      ctx.style.inset = "0";
      ctx.style.zIndex = "200";
      ctx.style.background = "#fff";
      ctx.style.flexDirection = "column";
    } else {
      closeInquiryOverlay();
    }
  });

  window.addEventListener("resize", () => {
    syncMsgMobileBody();
    syncHomeHeaderScroll();
    if (window.matchMedia("(min-width: 1100px)").matches) closeInquiryOverlay();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const m = $("listing-gallery-modal");
    if (m && !m.hidden) closeListingGallery();
  });

  window.addEventListener("scroll", onWindowScroll, { passive: true });

  /* ── Auth modal event wiring ── */
  $("auth-modal-close")?.addEventListener("click", closeAuthModal);
  document.getElementById("auth-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "auth-modal") closeAuthModal();
  });
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      authModalTab = tab.getAttribute("data-auth-tab") || "login";
      syncAuthModalTab();
    });
  });
  $("auth-form")?.addEventListener("submit", handleEmailAuth);
  $("auth-google")?.addEventListener("click", handleGoogleAuth);

  $("account-menu-login")?.addEventListener("click", () => {
    closeAccountMenu();
    openAuthModal("login");
  });
  $("account-menu-signup")?.addEventListener("click", () => {
    closeAccountMenu();
    openAuthModal("signup");
  });
  $("account-menu-help-out")?.addEventListener("click", () => {
    closeAccountMenu();
    document.querySelector(".footer")?.scrollIntoView({ behavior: "smooth", block: "end" });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modal = document.getElementById("auth-modal");
      if (modal && !modal.hidden) closeAuthModal();
    }
  });

  renderWhatSuggestionList();
  renderRegionStepperRows();
  renderGrid();
  setView("home");
  updateModeSwitchLabel();
  updateHeaderForAuth();
  requestAnimationFrame(() => syncHomeHeaderScroll());

  setupAuthListener();
  initAuthState();
})();
