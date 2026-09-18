(function () {
  "use strict";

  // Same-origin "/api" by default (Cloudflare Pages); config.js can point
  // this at a standalone Worker's URL instead, for when the site is hosted
  // somewhere that can't run the API itself (e.g. GitHub Pages).
  const API = (window.NOTICE_BOARD_API_BASE || "").trim() || "/api";
  const VAPID_PUBLIC_KEY = (window.NOTICE_BOARD_VAPID_PUBLIC_KEY || "").trim();
  // Bump this alongside CACHE_NAME in public/sw.js on every frontend
  // change, so it's a reliable way to confirm a given device/deployment
  // actually picked up the latest build (see the org page, where it's
  // shown) rather than a stale cached PWA or an un-redeployed hosting
  // target (e.g. GitHub Pages vs. Cloudflare Pages).
  const APP_VERSION = "v14";
  const STORAGE_TOKEN = "nb_token";
  const STORAGE_USER = "nb_user";
  const STORAGE_ORG = "nb_org_id";

  function safeParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  const state = {
    token: localStorage.getItem(STORAGE_TOKEN) || null,
    user: safeParse(localStorage.getItem(STORAGE_USER)),
    orgId: localStorage.getItem(STORAGE_ORG) || null,
    orgs: [], // cached list of { id, name, role } for the current user
    // Which of the Group/Personal toggle is showing on the Tasks and
    // Checklists tabs. In-memory only (not persisted) — each tab defaults
    // back to "group" the next time the app is opened fresh, but keeps
    // whatever you last picked for the rest of this session.
    taskView: "group",
    checklistView: "group",
  };

  function setAuth(token, user) {
    state.token = token;
    state.user = user;
    try {
      if (token) {
        localStorage.setItem(STORAGE_TOKEN, token);
        localStorage.setItem(STORAGE_USER, JSON.stringify(user));
      } else {
        localStorage.removeItem(STORAGE_TOKEN);
        localStorage.removeItem(STORAGE_USER);
      }
    } catch {
      /* private browsing / storage disabled — session just won't persist */
    }
  }

  function setCurrentOrg(orgId) {
    state.orgId = orgId ? String(orgId) : null;
    try {
      if (state.orgId) localStorage.setItem(STORAGE_ORG, state.orgId);
      else localStorage.removeItem(STORAGE_ORG);
    } catch {
      /* ignore */
    }
  }

  function currentOrgMeta() {
    return state.orgs.find((o) => String(o.id) === String(state.orgId)) || null;
  }

  function isManagerFlag(orgData) {
    return orgData.my_role === "admin" || !!orgData.my_management;
  }

  // Stricter than isManagerFlag(): creating checklists is limited to org
  // admins and global owners (management-flagged non-admins can still add
  // tasks, just not checklists) — see lib/handlers/checklists.js create().
  function canCreateChecklists(orgData) {
    return orgData.my_role === "admin" || !!(state.user && state.user.is_owner);
  }

  function pickableDepartmentsFor(orgData) {
    return isManagerFlag(orgData)
      ? orgData.departments
      : (orgData.members.find((m) => m.id === state.user.id) || { departments: [] }).departments;
  }

  function truncate(str, n) {
    const s = String(str ?? "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // ---------- Photo uploads ----------
  // Every photo is resized client-side to a typical "web photo" size before
  // it's ever sent to the API — keeps things quick to upload and light on
  // the database.

  const PHOTO_MAX_DIMENSION = 1280;
  const PHOTO_QUALITY = 0.72;

  function resizeImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Couldn't read that file"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Couldn't read that image"));
        img.onload = () => {
          let { width, height } = img;
          if (width > PHOTO_MAX_DIMENSION || height > PHOTO_MAX_DIMENSION) {
            if (width >= height) {
              height = Math.round((height * PHOTO_MAX_DIMENSION) / width);
              width = PHOTO_MAX_DIMENSION;
            } else {
              width = Math.round((width * PHOTO_MAX_DIMENSION) / height);
              height = PHOTO_MAX_DIMENSION;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", PHOTO_QUALITY));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function resizeImageFiles(fileList, maxCount) {
    const files = Array.from(fileList || []).slice(0, Math.max(0, maxCount));
    const out = [];
    for (const file of files) {
      try {
        out.push(await resizeImageFile(file));
      } catch {
        /* skip a file that failed to load/decode */
      }
    }
    return out;
  }

  function photoStripHtml(images, opts) {
    opts = opts || {};
    const max = opts.max || 3;
    const thumbs = images
      .map(
        (src, i) => `
        <div class="photo-thumb-wrap">
          <img class="photo-thumb" src="${src}" alt="" />
          ${opts.removeAttr ? `<button type="button" class="photo-remove" ${opts.removeAttr(i)}>×</button>` : ""}
        </div>`
      )
      .join("");
    const addBtn =
      opts.addAttr && images.length < max
        ? `<label class="photo-add-btn" ${opts.addAttr}>${iconCamera()}<input type="file" accept="image/*" multiple hidden /></label>`
        : "";
    if (!thumbs && !addBtn) return "";
    return `<div class="photo-strip">${thumbs}${addBtn}</div>`;
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function formatDateTime(value) {
    if (!value) return "";
    const iso = value.includes("T") ? value : value.replace(" ", "T") + "Z";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  // ---------- Photo lightbox ----------
  // A single delegated click listener (rather than wiring one per photo)
  // covers every photoStripHtml() usage at once — tasks, checklist items,
  // messages and replies — including read-only strips that never got an
  // addAttr/removeAttr. Message cards wrap their photo strip in a clickable
  // <a>, so we stop the click from also following that link.

  function openLightbox(src) {
    const overlay = document.createElement("div");
    overlay.className = "lightbox-overlay";
    overlay.innerHTML = `<img src="${src}" alt="" />`;
    overlay.addEventListener("click", () => overlay.remove());
    document.body.appendChild(overlay);
  }

  document.addEventListener("click", (e) => {
    const thumb = e.target.closest(".photo-thumb");
    if (!thumb) return;
    e.preventDefault();
    e.stopPropagation();
    openLightbox(thumb.src);
  });

  function seenByText(seenBy) {
    const names = seenBy.filter((s) => s.id !== state.user.id).map((s) => s.name);
    if (!names.length) return "Seen by no one else yet";
    if (names.length <= 4) return `Seen by ${names.map(escapeHtml).join(", ")}`;
    return `Seen by ${names.slice(0, 4).map(escapeHtml).join(", ")} and ${names.length - 4} more`;
  }

  let bannerTimer = null;
  function showBanner(message, isError = true) {
    const el = document.getElementById("banner");
    el.textContent = message;
    el.hidden = false;
    el.style.background = isError ? "var(--danger)" : "var(--green)";
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      el.hidden = true;
    }, 4000);
  }

  async function api(path, opts = {}) {
    const headers = { "content-type": "application/json" };
    if (state.token) headers.authorization = "Bearer " + state.token;

    const res = await fetch(API + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    let data = {};
    try {
      data = await res.json();
    } catch {
      /* empty/non-JSON body */
    }

    if (!res.ok) {
      if (res.status === 401) {
        setAuth(null, null);
        if (location.hash !== "#/login") location.hash = "#/login";
      }
      throw new Error(data.error || "Something went wrong");
    }
    return data;
  }

  // ---------- Push notifications ----------
  // Per-device opt-in: this device's browser registers a push subscription
  // with the browser's push service, and we hand that subscription to the
  // API so it knows where to send things. Nothing here is org-specific —
  // it's the same subscription regardless of which organization you're
  // currently viewing.

  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && !!VAPID_PUBLIC_KEY;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function currentPushSubscription() {
    if (!pushSupported()) return null;
    try {
      const reg = await navigator.serviceWorker.ready;
      return await reg.pushManager.getSubscription();
    } catch {
      return null;
    }
  }

  async function enablePushOnThisDevice() {
    const reg = await navigator.serviceWorker.ready;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notifications were blocked for this site");

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const subJson = sub.toJSON();
    await api("/push/subscribe", { method: "POST", body: { endpoint: subJson.endpoint, keys: subJson.keys } });
    return sub;
  }

  async function disablePushOnThisDevice() {
    const sub = await currentPushSubscription();
    if (!sub) return;
    try {
      await api("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
    } catch {
      /* still unsubscribe locally even if the server call fails */
    }
    await sub.unsubscribe();
  }

  // ---------- App icon badges ----------
  // The number on the home-screen icon. The service worker sets it
  // instantly from the count embedded in each push payload (see
  // lib/push.js / public/sw.js); syncBadge() re-derives the true count
  // from the server so it stays right even across devices or if a push
  // was missed. "Seen" is per-surface: messages clear via the existing
  // read-receipt tracking, tasks clear on opening the Tasks tab (for that
  // organization), checklists clear on opening that specific checklist.

  function badgeSupported() {
    return "setAppBadge" in navigator && "clearAppBadge" in navigator;
  }

  async function syncBadge() {
    if (!badgeSupported()) return;
    try {
      const counts = await api("/notifications/badge");
      if (counts.total > 0) await navigator.setAppBadge(counts.total);
      else await navigator.clearAppBadge();
    } catch {
      /* best-effort */
    }
  }

  async function markTasksViewed(orgId) {
    try {
      await api("/notifications/tasks-viewed", { method: "POST", body: { org_id: orgId } });
    } catch {
      /* best-effort */
    }
    syncBadge();
  }

  async function markChecklistViewed(checklistId) {
    try {
      await api(`/checklists/${checklistId}/viewed`, { method: "POST" });
    } catch {
      /* best-effort */
    }
    syncBadge();
  }

  // ---------- Icons (inline SVG, currentColor) ----------

  function iconChecklist() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="6" height="6" rx="1.3"></rect><path d="M5.2 7.2l1 1 2-2.2"></path><rect x="3" y="14" width="6" height="6" rx="1.3"></rect><path d="M5.2 17.2l1 1 2-2.2"></path><path d="M12 6h9M12 17h9"></path></svg>`;
  }
  function iconTasks() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>`;
  }
  function iconLogout() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="M16 17l5-5-5-5"></path><path d="M21 12H9"></path></svg>`;
  }
  function iconChevron() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"></path></svg>`;
  }
  function iconChevronLeft() {
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>`;
  }
  function iconPlus() {
    return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>`;
  }
  function iconOrg() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="1.3"></rect><path d="M9 8h1M14 8h1M9 12h1M14 12h1M9 21v-4h6v4"></path></svg>`;
  }
  function iconTrash() {
    return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"></path></svg>`;
  }
  function iconMessage() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`;
  }
  function iconCamera() {
    return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>`;
  }
  function iconBell() {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`;
  }

  // ---------- Shell (header + bottom tab bar) ----------

  const app = document.getElementById("app");

  // Hidden feature: tapping the logo 5 times in a row forces a full reload
  // from the server — unregisters the service worker and clears its caches
  // first, so an installed PWA that's stuck on an old cached build picks up
  // whatever's actually live. Handy for troubleshooting without needing to
  // walk someone through clearing Safari/Chrome's site data by hand.
  let logoTapCount = 0;
  let logoTapTimer = null;

  async function forceUpdate() {
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      /* best-effort — reload anyway */
    }
    location.reload();
  }

  function handleLogoTap() {
    logoTapCount += 1;
    clearTimeout(logoTapTimer);
    logoTapTimer = setTimeout(() => {
      logoTapCount = 0;
    }, 3000);
    if (logoTapCount >= 5) {
      logoTapCount = 0;
      clearTimeout(logoTapTimer);
      showBanner("Reloading the latest version…", false);
      setTimeout(forceUpdate, 400);
    }
  }

  function shell(activeTab, innerHtml, opts) {
    opts = opts || {};
    const org = currentOrgMeta();
    const orgTabHref = state.orgId ? `#/orgs/${state.orgId}` : "#/orgs";

    app.innerHTML = `
      <header class="topbar">
        <a class="brand" href="#/messages" aria-label="Notice Board home">
          <img src="brand/banner.png" alt="Notice Board" />
        </a>
        <div class="who">
          <span>${escapeHtml(state.user && state.user.name)}</span>
          <button class="icon-btn" id="logoutBtn" title="Switch user" aria-label="Switch user">${iconLogout()}</button>
        </div>
      </header>
      ${org && !opts.hideOrgStrip ? `<a class="org-strip" href="#/orgs">${iconOrg()}<span>${escapeHtml(org.name)}</span><span class="switch">Switch</span></a>` : ""}
      <main id="view">${innerHtml}</main>
      <nav class="tabbar">
        <a href="#/messages" class="${activeTab === "messages" ? "active" : ""}">
          ${iconMessage()}<span>Message board</span>
        </a>
        <a href="#/checklists" class="${activeTab === "checklists" ? "active" : ""}">
          ${iconChecklist()}<span>Checklists</span>
        </a>
        <a href="#/tasks" class="${activeTab === "tasks" ? "active" : ""}">
          ${iconTasks()}<span>Tasks</span>
        </a>
        <a href="${orgTabHref}" class="${activeTab === "org" ? "active" : ""}">
          ${iconOrg()}<span>Org</span>
        </a>
      </nav>
    `;
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);
    const brandLink = app.querySelector(".topbar .brand");
    if (brandLink) {
      // Normal taps still navigate home as usual; this just also counts
      // them toward the hidden 5-tap force-reload trick above.
      brandLink.addEventListener("click", handleLogoTap);
    }
  }

  async function handleLogout() {
    try {
      await api("/logout", { method: "POST" });
    } catch {
      /* log out locally regardless */
    }
    setAuth(null, null);
    location.hash = "#/login";
  }

  // ---------- Login / register ----------

  function renderLogin() {
    app.innerHTML = `
      <div class="auth-shell">
        <img class="logo" src="icons/icon-192.png" alt="" />
        <h1>Notice Board</h1>
        <p class="sub">Shared checklists &amp; tasks</p>
        <div class="tabs-toggle">
          <button type="button" data-mode="login" class="active">Log in</button>
          <button type="button" data-mode="register">New here</button>
        </div>
        <form id="authForm">
          <div class="field">
            <label for="authName">Your name</label>
            <input type="text" id="authName" autocomplete="username" required maxlength="40" />
          </div>
          <div class="field">
            <label for="authPin">PIN</label>
            <input type="tel" inputmode="numeric" pattern="[0-9]*" id="authPin" autocomplete="current-password" required minlength="4" maxlength="8" placeholder="4-8 digits" />
          </div>
          <div class="field" id="authCodeField" hidden>
            <label for="authCode">Invite code</label>
            <input type="text" id="authCode" maxlength="6" placeholder="From an owner" style="text-transform:uppercase;" />
            <p class="meta" style="margin-top:4px;">Ask an owner for a one-time code — it's what gets you straight into their organization.</p>
          </div>
          <div class="error-text" id="authError" hidden></div>
          <button type="submit" class="btn block" id="authSubmit">Log in</button>
        </form>
      </div>
    `;

    let mode = "login";
    const toggleBtns = app.querySelectorAll(".tabs-toggle button");
    const codeField = document.getElementById("authCodeField");
    toggleBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        mode = btn.dataset.mode;
        toggleBtns.forEach((b) => b.classList.toggle("active", b === btn));
        document.getElementById("authSubmit").textContent = mode === "login" ? "Log in" : "Create account";
        codeField.hidden = mode !== "register";
      });
    });

    document.getElementById("authForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("authName").value.trim();
      const pin = document.getElementById("authPin").value.trim();
      const code = document.getElementById("authCode").value.trim();
      const errorEl = document.getElementById("authError");
      errorEl.hidden = true;
      if (!name || !pin) return;

      const submitBtn = document.getElementById("authSubmit");
      submitBtn.disabled = true;
      try {
        const data = await api(mode === "login" ? "/login" : "/register", {
          method: "POST",
          body: mode === "login" ? { name, pin } : { name, pin, code },
        });
        setAuth(data.token, data.user);
        location.hash = "#/messages";
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // ---------- Checklist list ----------

  // Shared Group/Personal segmented toggle for the Tasks and Checklists
  // tabs — sits right below the org switcher strip. `stateKey` is either
  // "taskView" or "checklistView" so each tab remembers its own choice
  // independently (in-memory only — resets to "group" on a fresh app
  // open); `onSwitch` re-renders that tab's screen.
  function viewToggleHtml(current) {
    return `
      <div class="tabs-toggle view-toggle">
        <button type="button" data-view-toggle="group" class="${current === "group" ? "active" : ""}">Group</button>
        <button type="button" data-view-toggle="personal" class="${current === "personal" ? "active" : ""}">Personal</button>
      </div>
    `;
  }

  function wireViewToggle(view, stateKey, onSwitch) {
    view.querySelectorAll("[data-view-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.viewToggle;
        if (state[stateKey] === next) return;
        state[stateKey] = next;
        onSwitch();
      });
    });
  }

  async function renderChecklistList() {
    shell("checklists", `<div class="empty">Loading…</div>`);
    let data;
    try {
      data = await api(`/checklists?org_id=${state.orgId}`);
    } catch (err) {
      showBanner(err.message);
      return;
    }

    const groupChecklists = data.checklists.filter((c) => c.visibility !== "personal");
    const personalChecklists = data.checklists.filter((c) => c.visibility === "personal");
    const showingPersonal = state.checklistView === "personal";
    const shown = showingPersonal ? personalChecklists : groupChecklists;

    const view = document.getElementById("view");
    view.innerHTML = `
      ${viewToggleHtml(state.checklistView)}
      ${
        showingPersonal
          ? `<p class="meta" style="margin:0 0 10px;">Only visible to you — not even an admin or owner can see these.</p>`
          : ""
      }
      ${
        shown.length
          ? shown.map(checklistCardHtml).join("")
          : `<div class="empty">No ${showingPersonal ? "personal" : "group"} checklists yet.</div>`
      }
    `;

    wireViewToggle(view, "checklistView", renderChecklistList);

    // Anyone can create a personal checklist; only an admin/owner can also
    // create a group one — that choice lives inside the new-checklist form.
    const fab = document.createElement("button");
    fab.className = "btn-fab";
    fab.setAttribute("aria-label", "New checklist");
    fab.innerHTML = iconPlus();
    fab.addEventListener("click", () => {
      location.hash = "#/checklists/new";
    });
    app.appendChild(fab);
  }

  function checklistCardHtml(cl) {
    const run = cl.current_run;
    const pct = run.total ? Math.round((run.done / run.total) * 100) : 0;
    const isDone = run.status === "completed";
    return `
      <a class="card checklist-card" href="#/checklists/${cl.id}">
        <div class="top">
          <h3>${escapeHtml(cl.title)}</h3>
          <span class="badge ${isDone ? "done" : ""}">${isDone ? "Done" : recurrenceLabel(cl)}</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="meta">${escapeHtml(run.period_label)} · ${run.done}/${run.total} checked${scopeSuffix(cl.scopes)}</div>
      </a>
    `;
  }

  function scopeSuffix(scopes) {
    if (!scopes || !scopes.length) return "";
    return ` · ${scopes.map((s) => escapeHtml(s.name)).join(", ")} only`;
  }

  function recurrenceLabel(cl) {
    if (cl.recurrence === "daily") return "Daily";
    if (cl.recurrence === "weekly") return "Weekly";
    if (cl.recurrence === "monthly") return "Monthly";
    if (cl.recurrence === "every_n_days") return `Every ${cl.recurrence_n}d`;
    return cl.recurrence;
  }

  // ---------- New checklist ----------

  async function renderChecklistForm() {
    shell("checklists", `<div class="empty">Loading…</div>`);

    let orgData;
    try {
      orgData = await api(`/organizations/${state.orgId}`);
    } catch (err) {
      showBanner(err.message);
      location.hash = "#/checklists";
      return;
    }

    const canGroup = canCreateChecklists(orgData);
    const pickableDepartments = pickableDepartmentsFor(orgData);

    const view = document.getElementById("view");
    view.innerHTML = `
      <a class="back-link" href="#/checklists">${iconChevronLeft()} Checklists</a>
      <h2>New checklist</h2>
      <form id="newChecklistForm">
        ${
          canGroup
            ? `<div class="field">
                 <label>Who can see this?</label>
                 <div class="dept-checks">
                   <label class="dept-check"><input type="radio" name="clVisibility" value="group" checked /> Group — my organization</label>
                   <label class="dept-check"><input type="radio" name="clVisibility" value="personal" /> Personal — just me</label>
                 </div>
               </div>`
            : `<p class="meta" style="margin-bottom:10px;">This will be a personal checklist, visible only to you — only an admin or owner can create a group checklist.</p>`
        }
        <div class="field">
          <label for="clTitle">Title</label>
          <input type="text" id="clTitle" required maxlength="80" placeholder="e.g. Close-down checklist" />
        </div>
        <div class="field">
          <label for="clDesc">Description (optional)</label>
          <textarea id="clDesc" maxlength="300" placeholder="What's this for?"></textarea>
        </div>
        <div class="row">
          <div class="field">
            <label for="clRecurrence">Repeats</label>
            <select id="clRecurrence">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="every_n_days">Every N days</option>
            </select>
          </div>
          <div class="field" id="clNField" hidden>
            <label for="clN">Every how many days?</label>
            <input type="number" id="clN" min="1" max="365" value="3" />
          </div>
        </div>
        ${
          pickableDepartments.length
            ? `<div class="field" id="clDeptField">
                 <label>Visible to</label>
                 <div class="dept-checks">
                   ${pickableDepartments
                     .map((d) => `<label class="dept-check"><input type="checkbox" name="clDept" value="${d.id}" /> ${escapeHtml(d.name)}</label>`)
                     .join("")}
                 </div>
                 <div class="meta" style="margin-top:4px;">Leave unchecked for the whole organization.</div>
               </div>`
            : ""
        }
        <div class="field">
          <label>Items</label>
          <div id="itemRows"></div>
          <button type="button" class="add-item-link" id="addItemBtn">+ Add item</button>
        </div>
        <div class="error-text" id="clError" hidden></div>
        <button type="submit" class="btn block">Create checklist</button>
      </form>
    `;

    const visibilityRadios = view.querySelectorAll('input[name="clVisibility"]');
    const deptField = document.getElementById("clDeptField");
    function syncDeptFieldVisibility() {
      if (!deptField) return;
      const chosen = view.querySelector('input[name="clVisibility"]:checked');
      deptField.hidden = !!chosen && chosen.value === "personal";
    }
    visibilityRadios.forEach((r) => r.addEventListener("change", syncDeptFieldVisibility));
    syncDeptFieldVisibility();

    const itemRows = document.getElementById("itemRows");
    function addItemRow(value, requiresPhoto, answerType) {
      const row = document.createElement("div");
      row.className = "item-input-row";
      row.innerHTML = `
        <input type="text" maxlength="120" placeholder="Item" value="${escapeHtml(value || "")}" />
        <select class="itemAnswerType" title="How this item is answered">
          <option value="checkbox" ${!answerType || answerType === "checkbox" ? "selected" : ""}>Checkbox</option>
          <option value="text" ${answerType === "text" ? "selected" : ""}>Text</option>
          <option value="number" ${answerType === "number" ? "selected" : ""}>Number</option>
        </select>
        <label class="photo-req-toggle" title="Require a photo before this item can be checked off">
          <input type="checkbox" class="itemPhotoReq" ${requiresPhoto ? "checked" : ""} />${iconCamera()}
        </label>
        <button type="button" aria-label="Remove item">×</button>
      `;
      row.querySelector('button[aria-label="Remove item"]').addEventListener("click", () => row.remove());
      itemRows.appendChild(row);
    }
    addItemRow();
    addItemRow();
    addItemRow();
    document.getElementById("addItemBtn").addEventListener("click", () => addItemRow());

    const recurrenceSelect = document.getElementById("clRecurrence");
    const nField = document.getElementById("clNField");
    recurrenceSelect.addEventListener("change", () => {
      nField.hidden = recurrenceSelect.value !== "every_n_days";
    });

    document.getElementById("newChecklistForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("clError");
      errorEl.hidden = true;

      const title = document.getElementById("clTitle").value.trim();
      const description = document.getElementById("clDesc").value.trim();
      const recurrence = recurrenceSelect.value;
      const recurrence_n = parseInt(document.getElementById("clN").value, 10) || 3;
      const items = Array.from(itemRows.children)
        .map((row) => ({
          label: row.querySelector('input[type="text"]').value.trim(),
          requires_photo: row.querySelector(".itemPhotoReq").checked,
          answer_type: row.querySelector(".itemAnswerType").value,
        }))
        .filter((it) => it.label);

      if (!title) {
        errorEl.textContent = "Title is required";
        errorEl.hidden = false;
        return;
      }
      if (!items.length) {
        errorEl.textContent = "Add at least one item";
        errorEl.hidden = false;
        return;
      }

      const chosenVisibility = view.querySelector('input[name="clVisibility"]:checked');
      const visibility = chosenVisibility ? chosenVisibility.value : "personal";
      const department_ids =
        visibility === "group"
          ? Array.from(view.querySelectorAll('input[name="clDept"]:checked')).map((cb) => parseInt(cb.value, 10))
          : [];

      try {
        const data = await api("/checklists", {
          method: "POST",
          body: { title, description, recurrence, recurrence_n, items, org_id: state.orgId, department_ids, visibility },
        });
        location.hash = `#/checklists/${data.id}`;
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    });
  }

  // ---------- Checklist detail / today's run ----------

  async function renderChecklistDetail(id) {
    shell("checklists", `<div class="empty">Loading…</div>`);
    let data;
    try {
      data = await api(`/checklists/${id}`);
    } catch (err) {
      showBanner(err.message);
      location.hash = "#/checklists";
      return;
    }

    markChecklistViewed(id);

    const { checklist, run } = data;
    const isDone = run.status === "completed";
    const allChecked = run.items.length > 0 && run.items.every((i) => i.checked);

    const view = document.getElementById("view");
    view.innerHTML = `
      <a class="back-link" href="#/checklists">${iconChevronLeft()} Checklists</a>
      <h2>${escapeHtml(checklist.title)}</h2>
      ${checklist.description ? `<p class="meta">${escapeHtml(checklist.description)}</p>` : ""}
      <div class="meta" style="margin-bottom:14px;">
        ${escapeHtml(run.period_label)} ·
        ${isDone
          ? `Completed by ${escapeHtml(run.completed_by_name || "someone")} · ${formatDateTime(run.completed_at)}`
          : `${run.items.filter((i) => i.checked).length}/${run.items.length} checked`}
      </div>
      <ul class="item-list" id="itemList">
        ${run.items.map((item) => itemRowHtml(item, isDone)).join("")}
      </ul>
      ${isDone
        ? `<a class="btn secondary block" href="#/checklists/${id}/history">View past reports</a>`
        : `<button class="btn block" id="completeBtn">Mark checklist complete</button>
           <a class="btn secondary block" style="margin-top:8px;" href="#/checklists/${id}/history">View past reports</a>`}
    `;

    // Checkbox items report their done state as {checked}; text/number
    // items don't have a checkbox at all — entering a value is what marks
    // them done (see toggleItem() on the server) — so they report
    // {answer} instead, read from their own input's current value.
    function currentDoneStatePayload(itemId) {
      const itemData = run.items.find((i) => String(i.item_id) === String(itemId));
      const isCheckbox = !itemData || !itemData.answer_type || itemData.answer_type === "checkbox";
      if (isCheckbox) {
        const cb = view.querySelector(`[data-item="${itemId}"]`);
        return { checked: cb ? cb.checked : false };
      }
      const answerEl = view.querySelector(`[data-answer="${itemId}"]`);
      return { answer: answerEl ? answerEl.value : itemData.answer };
    }

    view.querySelectorAll("[data-item]").forEach((cb) => {
      cb.addEventListener("change", async () => {
        const itemId = cb.dataset.item;
        const noteEl = view.querySelector(`[data-note="${itemId}"]`);
        try {
          await api(`/runs/${run.id}/items/${itemId}`, {
            method: "PATCH",
            body: { checked: cb.checked, note: noteEl ? noteEl.value : undefined },
          });
          renderChecklistDetail(id);
        } catch (err) {
          cb.checked = !cb.checked;
          showBanner(err.message);
        }
      });
    });

    view.querySelectorAll("[data-answer]").forEach((input) => {
      input.addEventListener("change", async () => {
        const itemId = input.dataset.answer;
        const noteEl = view.querySelector(`[data-note="${itemId}"]`);
        try {
          await api(`/runs/${run.id}/items/${itemId}`, {
            method: "PATCH",
            body: { answer: input.value, note: noteEl ? noteEl.value : undefined },
          });
          renderChecklistDetail(id);
        } catch (err) {
          showBanner(err.message);
        }
      });
    });

    view.querySelectorAll("[data-note]").forEach((input) => {
      input.addEventListener("change", async () => {
        const itemId = input.dataset.note;
        try {
          await api(`/runs/${run.id}/items/${itemId}`, {
            method: "PATCH",
            body: { ...currentDoneStatePayload(itemId), note: input.value },
          });
        } catch (err) {
          showBanner(err.message);
        }
      });
    });

    view.querySelectorAll("[data-item-photo-add]").forEach((label) => {
      const input = label.querySelector("input[type=file]");
      input.addEventListener("change", async () => {
        const itemId = label.dataset.itemPhotoAdd;
        const itemData = run.items.find((i) => String(i.item_id) === String(itemId));
        const existing = (itemData && itemData.images) || [];
        const room = 3 - existing.length;
        if (room <= 0) return;
        const newOnes = await resizeImageFiles(input.files, room);
        if (!newOnes.length) return;
        const noteEl = view.querySelector(`[data-note="${itemId}"]`);
        try {
          await api(`/runs/${run.id}/items/${itemId}`, {
            method: "PATCH",
            body: { ...currentDoneStatePayload(itemId), note: noteEl ? noteEl.value : undefined, images: existing.concat(newOnes) },
          });
          renderChecklistDetail(id);
        } catch (err) {
          showBanner(err.message);
        }
      });
    });

    view.querySelectorAll("[data-item-photo-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const [itemId, idxStr] = btn.dataset.itemPhotoRemove.split(":");
        const itemData = run.items.find((i) => String(i.item_id) === String(itemId));
        const images = ((itemData && itemData.images) || []).slice();
        images.splice(parseInt(idxStr, 10), 1);
        const noteEl = view.querySelector(`[data-note="${itemId}"]`);
        try {
          await api(`/runs/${run.id}/items/${itemId}`, {
            method: "PATCH",
            body: { ...currentDoneStatePayload(itemId), note: noteEl ? noteEl.value : undefined, images },
          });
          renderChecklistDetail(id);
        } catch (err) {
          showBanner(err.message);
        }
      });
    });

    const completeBtn = document.getElementById("completeBtn");
    if (completeBtn) {
      completeBtn.addEventListener("click", async () => {
        if (!allChecked && !confirm("Not everything is checked yet — mark this checklist complete anyway?")) {
          return;
        }
        completeBtn.disabled = true;
        try {
          await api(`/runs/${run.id}/complete`, { method: "POST" });
          renderChecklistDetail(id);
        } catch (err) {
          showBanner(err.message);
          completeBtn.disabled = false;
        }
      });
    }
  }

  function itemRowHtml(item, readonly) {
    const images = item.images || [];
    const strip = readonly
      ? photoStripHtml(images)
      : photoStripHtml(images, {
          addAttr: `data-item-photo-add="${item.item_id}"`,
          removeAttr: (i) => `data-item-photo-remove="${item.item_id}:${i}"`,
        });
    const isCheckbox = !item.answer_type || item.answer_type === "checkbox";
    const doneControl = isCheckbox
      ? `<input type="checkbox" data-item="${item.item_id}" ${item.checked ? "checked" : ""} ${readonly ? "disabled" : ""} />`
      : `<span class="item-done-dot ${item.checked ? "done" : ""}" aria-hidden="true">${item.checked ? "✓" : ""}</span>`;
    const answerField = isCheckbox
      ? ""
      : `<input class="item-answer" type="${item.answer_type === "number" ? "number" : "text"}" inputmode="${item.answer_type === "number" ? "decimal" : "text"}" maxlength="500" placeholder="${item.answer_type === "number" ? "Enter a number…" : "Enter an answer…"}" value="${escapeHtml(item.answer || "")}" data-answer="${item.item_id}" ${readonly ? "disabled" : ""} />`;
    return `
      <li class="item ${item.checked ? "done" : ""}">
        <label class="item-main">
          ${doneControl}
          <span>${escapeHtml(item.label)}</span>
          ${item.requires_photo ? '<span class="badge photo-req">📷 Photo required</span>' : ""}
        </label>
        ${answerField}
        <input class="item-note" type="text" maxlength="2000" placeholder="Add a note…" value="${escapeHtml(item.note || "")}" data-note="${item.item_id}" ${readonly ? "disabled" : ""} />
        ${strip}
        <div class="item-meta">${
          item.checked_by_name
            ? `✓ ${escapeHtml(item.checked_by_name)}${item.checked_at ? " · " + formatDateTime(item.checked_at) : ""}`
            : ""
        }</div>
      </li>
    `;
  }

  // ---------- Checklist history (past reports) ----------

  async function renderChecklistHistory(id) {
    shell("checklists", `<div class="empty">Loading…</div>`);
    let data;
    try {
      data = await api(`/checklists/${id}/runs`);
    } catch (err) {
      showBanner(err.message);
      location.hash = "#/checklists";
      return;
    }

    const { checklist, runs } = data;
    const view = document.getElementById("view");
    view.innerHTML = `
      <a class="back-link" href="#/checklists/${id}">${iconChevronLeft()} ${escapeHtml(checklist.title)}</a>
      <h2>Past reports</h2>
      ${runs.length ? runs.map((r) => reportRowHtml(id, r)).join("") : `<div class="empty">No reports yet.</div>`}
    `;
  }

  function reportRowHtml(checklistId, run) {
    const isDone = run.status === "completed";
    return `
      <a class="card report-row" href="#/checklists/${checklistId}/reports/${run.id}">
        <div class="left">
          <h4>${escapeHtml(run.period_label)}</h4>
          <p>${
            isDone
              ? `Completed by ${escapeHtml(run.completed_by_name || "someone")} · ${formatDateTime(run.completed_at)}`
              : `In progress · ${run.done}/${run.total}`
          }</p>
        </div>
        <div class="chev">${iconChevron()}</div>
      </a>
    `;
  }

  // ---------- Single report (read-only) ----------

  async function renderChecklistReport(id, runId) {
    shell("checklists", `<div class="empty">Loading…</div>`);
    let data;
    try {
      data = await api(`/checklists/${id}/runs/${runId}`);
    } catch (err) {
      showBanner(err.message);
      location.hash = `#/checklists/${id}/history`;
      return;
    }

    const { checklist, run } = data;
    const view = document.getElementById("view");
    view.innerHTML = `
      <a class="back-link" href="#/checklists/${id}/history">${iconChevronLeft()} Past reports</a>
      <h2>${escapeHtml(checklist.title)}</h2>
      <div class="meta" style="margin-bottom:14px;">
        ${escapeHtml(run.period_label)} ·
        ${run.status === "completed"
          ? `Completed by ${escapeHtml(run.completed_by_name || "someone")} · ${formatDateTime(run.completed_at)}`
          : "Still in progress"}
      </div>
      <ul class="item-list">
        ${run.items.map((item) => itemRowHtml(item, true)).join("")}
      </ul>
    `;
  }

  // ---------- Shared tasks ----------

  async function renderTasks() {
    shell("tasks", `<div class="empty">Loading…</div>`);
    let data;
    let orgData;
    try {
      data = await api(`/tasks?org_id=${state.orgId}`);
      orgData = await api(`/organizations/${state.orgId}`);
    } catch (err) {
      showBanner(err.message);
      return;
    }

    markTasksViewed(state.orgId);

    const canCreateGroup = isManagerFlag(orgData);
    const pickableDepartments = pickableDepartmentsFor(orgData);
    const myId = state.user && state.user.id;

    const view = document.getElementById("view");

    // Group tasks: the usual shared list. Personal tasks: things only you
    // created for yourself, PLUS any group task a manager assigned
    // straight to you (cross-listed here for convenience — it's still a
    // normal group task, visible to everyone per the usual rules).
    const groupTasks = data.tasks.filter((t) => t.visibility !== "personal");
    const personalTasks = data.tasks.filter(
      (t) => t.visibility === "personal" || (t.assigned_to && String(t.assigned_to) === String(myId))
    );
    const groupOpen = groupTasks.filter((t) => !t.done);
    const groupDone = groupTasks.filter((t) => t.done);
    const personalOpen = personalTasks.filter((t) => !t.done);
    const personalDone = personalTasks.filter((t) => t.done);
    const showingPersonal = state.taskView === "personal";

    let pendingGroupImages = [];
    let pendingPersonalImages = [];

    const groupSectionHtml = `
      ${
        canCreateGroup
          ? `<form id="newGroupTaskForm" class="card">
               <div class="field" style="margin-bottom:10px;">
                 <input type="text" id="groupTaskTitle" maxlength="120" placeholder="Add a group task…" required />
               </div>
               ${
                 pickableDepartments.length
                   ? `<div class="field" style="margin-bottom:10px;">
                        <select id="groupTaskDept">
                          <option value="">Whole organization</option>
                          ${pickableDepartments.map((d) => `<option value="${d.id}">${escapeHtml(d.name)} only</option>`).join("")}
                        </select>
                      </div>`
                   : ""
               }
               <div class="field" style="margin-bottom:10px;">
                 <select id="groupTaskAssignee">
                   <option value="">Not assigned to anyone in particular</option>
                   ${orgData.members.map((m) => `<option value="${m.id}">Assign to ${escapeHtml(m.name)}</option>`).join("")}
                 </select>
               </div>
               <div class="field" id="newGroupTaskPhotoField" style="margin-bottom:10px;">
                 ${photoStripHtml([], { addAttr: 'id="newGroupTaskPhotoAdd"' })}
               </div>
               <button type="submit" class="btn block">Add group task</button>
             </form>`
          : `<div class="empty">Only managers can add group tasks. You can still check them off, add notes and photos.</div>`
      }
      <div class="section-title" style="margin-top:10px;">To do (${groupOpen.length})</div>
      <ul class="item-list" id="openGroupTasks">
        ${groupOpen.length ? groupOpen.map(taskRowHtml).join("") : `<div class="empty">Nothing to do — nice.</div>`}
      </ul>
      ${
        groupDone.length
          ? `<div class="section-title">Done (${groupDone.length})</div><ul class="item-list" id="doneGroupTasks">${groupDone.map(taskRowHtml).join("")}</ul>`
          : ""
      }
    `;

    const personalSectionHtml = `
      <p class="meta" style="margin:0 0 10px;">Only visible to you — plus anything a manager assigns to you.</p>
      <form id="newPersonalTaskForm" class="card">
        <div class="field" style="margin-bottom:10px;">
          <input type="text" id="personalTaskTitle" maxlength="120" placeholder="Add a personal task…" required />
        </div>
        <div class="field" id="newPersonalTaskPhotoField" style="margin-bottom:10px;">
          ${photoStripHtml([], { addAttr: 'id="newPersonalTaskPhotoAdd"' })}
        </div>
        <button type="submit" class="btn block">Add personal task</button>
      </form>
      <div class="section-title" style="margin-top:10px;">To do (${personalOpen.length})</div>
      <ul class="item-list" id="openPersonalTasks">
        ${personalOpen.length ? personalOpen.map(taskRowHtml).join("") : `<div class="empty">Nothing to do — nice.</div>`}
      </ul>
      ${
        personalDone.length
          ? `<div class="section-title">Done (${personalDone.length})</div><ul class="item-list" id="donePersonalTasks">${personalDone.map(taskRowHtml).join("")}</ul>`
          : ""
      }
    `;

    view.innerHTML = `
      ${viewToggleHtml(state.taskView)}
      ${showingPersonal ? personalSectionHtml : groupSectionHtml}
    `;

    wireViewToggle(view, "taskView", renderTasks);

    // Sets up one pending-photo picker (the "add a task" card's photo
    // strip). getPending/setPending read and write the closure variable
    // for that specific form (pendingGroupImages or pendingPersonalImages)
    // — every render (initial, after adding, after removing) re-wires
    // both the add tile and any remove buttons, since innerHTML always
    // replaces the previous elements.
    function setupPendingPhotos(fieldId, addId, getPending, setPending, removeAttrName) {
      function render() {
        const field = document.getElementById(fieldId);
        if (!field) return;
        field.innerHTML = photoStripHtml(getPending(), {
          addAttr: `id="${addId}"`,
          removeAttr: (i) => `${removeAttrName}="${i}"`,
        });
        wireAdd();
        field.querySelectorAll(`[${removeAttrName}]`).forEach((btn) => {
          btn.addEventListener("click", () => {
            getPending().splice(parseInt(btn.getAttribute(removeAttrName), 10), 1);
            render();
          });
        });
      }
      function wireAdd() {
        const addLabel = document.getElementById(addId);
        if (!addLabel) return;
        const input = addLabel.querySelector("input[type=file]");
        input.addEventListener("change", async () => {
          const pending = getPending();
          const room = 3 - pending.length;
          if (room <= 0) return;
          const newOnes = await resizeImageFiles(input.files, room);
          setPending(pending.concat(newOnes));
          render();
        });
      }
      wireAdd();
    }

    if (!showingPersonal) {
      setupPendingPhotos(
        "newGroupTaskPhotoField",
        "newGroupTaskPhotoAdd",
        () => pendingGroupImages,
        (v) => (pendingGroupImages = v),
        "data-new-group-task-photo-remove"
      );
    } else {
      setupPendingPhotos(
        "newPersonalTaskPhotoField",
        "newPersonalTaskPhotoAdd",
        () => pendingPersonalImages,
        (v) => (pendingPersonalImages = v),
        "data-new-personal-task-photo-remove"
      );
    }

    const newGroupTaskForm = document.getElementById("newGroupTaskForm");
    if (newGroupTaskForm) {
      newGroupTaskForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("groupTaskTitle");
        const title = input.value.trim();
        if (!title) return;
        const deptSelect = document.getElementById("groupTaskDept");
        const department_ids = deptSelect && deptSelect.value ? [parseInt(deptSelect.value, 10)] : [];
        const assigneeSelect = document.getElementById("groupTaskAssignee");
        const assigned_to = assigneeSelect && assigneeSelect.value ? parseInt(assigneeSelect.value, 10) : null;
        try {
          await api("/tasks", {
            method: "POST",
            body: { title, org_id: state.orgId, department_ids, assigned_to, images: pendingGroupImages, visibility: "group" },
          });
          renderTasks();
        } catch (err) {
          showBanner(err.message);
        }
      });
    }

    const newPersonalTaskForm = document.getElementById("newPersonalTaskForm");
    if (newPersonalTaskForm) {
      newPersonalTaskForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("personalTaskTitle");
        const title = input.value.trim();
        if (!title) return;
        try {
          await api("/tasks", {
            method: "POST",
            body: { title, org_id: state.orgId, images: pendingPersonalImages, visibility: "personal" },
          });
          renderTasks();
        } catch (err) {
          showBanner(err.message);
        }
      });
    }

    view.querySelectorAll("[data-task-done]").forEach((cb) => {
      cb.addEventListener("change", async () => {
        try {
          await api(`/tasks/${cb.dataset.taskDone}`, { method: "PATCH", body: { done: cb.checked } });
          renderTasks();
        } catch (err) {
          cb.checked = !cb.checked;
          showBanner(err.message);
        }
      });
    });

    view.querySelectorAll("[data-task-note]").forEach((input) => {
      input.addEventListener("change", async () => {
        try {
          await api(`/tasks/${input.dataset.taskNote}`, { method: "PATCH", body: { note: input.value } });
        } catch (err) {
          showBanner(err.message);
        }
      });
    });

    view.querySelectorAll("[data-task-del]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this task?")) return;
        try {
          await api(`/tasks/${btn.dataset.taskDel}`, { method: "DELETE" });
          renderTasks();
        } catch (err) {
          showBanner(err.message);
        }
      });
    });

    view.querySelectorAll("[data-task-photo-add]").forEach((label) => {
      const input = label.querySelector("input[type=file]");
      input.addEventListener("change", async () => {
        const taskId = label.dataset.taskPhotoAdd;
        const task = data.tasks.find((t) => String(t.id) === String(taskId));
        const existing = (task && task.comment_images) || [];
        const room = 3 - existing.length;
        if (room <= 0) return;
        const newOnes = await resizeImageFiles(input.files, room);
        if (!newOnes.length) return;
        try {
          await api(`/tasks/${taskId}`, { method: "PATCH", body: { images: existing.concat(newOnes) } });
          renderTasks();
        } catch (err) {
          showBanner(err.message);
        }
      });
    });

    view.querySelectorAll("[data-task-photo-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const [taskId, idxStr] = btn.dataset.taskPhotoRemove.split(":");
        const task = data.tasks.find((t) => String(t.id) === String(taskId));
        const images = ((task && task.comment_images) || []).slice();
        images.splice(parseInt(idxStr, 10), 1);
        try {
          await api(`/tasks/${taskId}`, { method: "PATCH", body: { images } });
          renderTasks();
        } catch (err) {
          showBanner(err.message);
        }
      });
    });
  }

  function taskRowHtml(task) {
    const createImages = task.create_images || [];
    const commentImages = task.comment_images || [];
    return `
      <li class="task ${task.done ? "done" : ""}">
        <div class="task-top">
          <input type="checkbox" data-task-done="${task.id}" ${task.done ? "checked" : ""} />
          <input class="task-title" type="text" value="${escapeHtml(task.title)}" disabled />
          <button class="task-del" data-task-del="${task.id}" aria-label="Remove task">×</button>
        </div>
        ${photoStripHtml(createImages)}
        <input class="item-note" type="text" maxlength="2000" placeholder="Add a note…" value="${escapeHtml(task.note || "")}" data-task-note="${task.id}" />
        ${photoStripHtml(commentImages, {
          addAttr: `data-task-photo-add="${task.id}"`,
          removeAttr: (i) => `data-task-photo-remove="${task.id}:${i}"`,
        })}
        <div class="task-meta">
          ${
            task.done && task.done_by_name
              ? `✓ ${escapeHtml(task.done_by_name)}${task.done_at ? " · " + formatDateTime(task.done_at) : ""}`
              : task.created_by_name
              ? `Added by ${escapeHtml(task.created_by_name)}`
              : ""
          }${scopeSuffix(task.scopes)}${task.assigned_to_name ? ` · Assigned to ${escapeHtml(task.assigned_to_name)}` : ""}
        </div>
      </li>
    `;
  }

  // ---------- Message board ----------
  // Reads across every organization this person belongs to (fetched in
  // parallel, merged, and tagged by org) with org + department filters.
  // Composing still targets one organization at a time — that's a
  // deliberate scope cut for this round; cross-org posting is planned
  // separately. The "current org" strip is hidden on this tab specifically
  // since the board itself isn't tied to one organization any more.

  async function renderMessageBoard() {
    shell("messages", `<div class="empty">Loading…</div>`, { hideOrgStrip: true });

    let perOrg;
    try {
      perOrg = await Promise.all(
        state.orgs.map(async (org) => {
          const [msgData, orgData] = await Promise.all([api(`/messages?org_id=${org.id}`), api(`/organizations/${org.id}`)]);
          return { org, messages: msgData.messages, orgData };
        })
      );
    } catch (err) {
      showBanner(err.message);
      return;
    }

    const showOrgUi = state.orgs.length > 1;

    let allMessages = [];
    perOrg.forEach(({ org, messages }) => {
      messages.forEach((m) => allMessages.push({ ...m, org_id: org.id, org_name: org.name }));
    });
    allMessages.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

    function entryForOrg(orgId) {
      return perOrg.find((p) => String(p.org.id) === String(orgId));
    }

    const composeOrgId = state.orgId && entryForOrg(state.orgId) ? state.orgId : perOrg[0].org.id;

    const view = document.getElementById("view");
    let pendingMessageImages = [];
    let filterOrgId = "";
    let filterDeptId = "";

    view.innerHTML = `
      <form id="newMessageForm" class="card">
        <div class="field" style="margin-bottom:10px;">
          <textarea id="msgBody" maxlength="4000" placeholder="Write a message…" required></textarea>
        </div>
        ${
          showOrgUi
            ? `<div class="field" style="margin-bottom:10px;">
                 <label for="msgOrg">Post to</label>
                 <select id="msgOrg">
                   ${perOrg
                     .map(
                       ({ org }) =>
                         `<option value="${org.id}" ${String(org.id) === String(composeOrgId) ? "selected" : ""}>${escapeHtml(org.name)}</option>`
                     )
                     .join("")}
                 </select>
               </div>`
            : ""
        }
        <div class="field" style="margin-bottom:10px;">
          <select id="msgDept"></select>
        </div>
        <div class="field" id="newMessagePhotoField" style="margin-bottom:10px;">
          ${photoStripHtml([], { addAttr: 'id="newMessagePhotoAdd"' })}
        </div>
        <button type="submit" class="btn block">Post</button>
      </form>
      <div class="section-title">Message board</div>
      ${
        showOrgUi
          ? `<div class="row" style="margin-bottom:10px;">
               <select id="filterOrg">
                 <option value="">All organizations</option>
                 ${perOrg.map(({ org }) => `<option value="${org.id}">${escapeHtml(org.name)}</option>`).join("")}
               </select>
               <select id="filterDept" disabled>
                 <option value="">All departments</option>
               </select>
             </div>`
          : ""
      }
      <div id="messageList">${allMessages.length ? allMessages.map((m) => messageCardHtml(m, showOrgUi)).join("") : `<div class="empty">No messages yet.</div>`}</div>
    `;

    function renderPendingMessagePhotos() {
      const field = document.getElementById("newMessagePhotoField");
      if (!field) return;
      field.innerHTML = photoStripHtml(pendingMessageImages, {
        addAttr: 'id="newMessagePhotoAdd"',
        removeAttr: (i) => `data-new-message-photo-remove="${i}"`,
      });
      wireNewMessagePhotoAdd();
      field.querySelectorAll("[data-new-message-photo-remove]").forEach((btn) => {
        btn.addEventListener("click", () => {
          pendingMessageImages.splice(parseInt(btn.dataset.newMessagePhotoRemove, 10), 1);
          renderPendingMessagePhotos();
        });
      });
    }

    function wireNewMessagePhotoAdd() {
      const addLabel = document.getElementById("newMessagePhotoAdd");
      if (!addLabel) return;
      const input = addLabel.querySelector("input[type=file]");
      input.addEventListener("change", async () => {
        const room = 3 - pendingMessageImages.length;
        if (room <= 0) return;
        const newOnes = await resizeImageFiles(input.files, room);
        pendingMessageImages = pendingMessageImages.concat(newOnes);
        renderPendingMessagePhotos();
      });
    }
    wireNewMessagePhotoAdd();

    const msgOrgSelect = document.getElementById("msgOrg");
    const msgDeptSelect = document.getElementById("msgDept");
    function refreshComposeDepartments() {
      const orgId = msgOrgSelect ? msgOrgSelect.value : composeOrgId;
      const entry = entryForOrg(orgId);
      const pickable = entry ? pickableDepartmentsFor(entry.orgData) : [];
      msgDeptSelect.innerHTML =
        `<option value="">Whole organization</option>` +
        pickable.map((d) => `<option value="${d.id}">${escapeHtml(d.name)} only</option>`).join("");
    }
    refreshComposeDepartments();
    if (msgOrgSelect) msgOrgSelect.addEventListener("change", refreshComposeDepartments);

    document.getElementById("newMessageForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const bodyEl = document.getElementById("msgBody");
      const text = bodyEl.value.trim();
      if (!text) return;
      const orgId = msgOrgSelect ? msgOrgSelect.value : composeOrgId;
      const department_id = msgDeptSelect.value ? parseInt(msgDeptSelect.value, 10) : null;
      try {
        await api("/messages", {
          method: "POST",
          body: { body: text, org_id: orgId, department_id, images: pendingMessageImages },
        });
        renderMessageBoard();
      } catch (err) {
        showBanner(err.message);
      }
    });

    const filterOrgSelect = document.getElementById("filterOrg");
    const filterDeptSelect = document.getElementById("filterDept");

    function renderFilteredList() {
      const listEl = document.getElementById("messageList");
      const msgs = allMessages.filter((m) => {
        if (filterOrgId && String(m.org_id) !== String(filterOrgId)) return false;
        if (filterDeptId === "org-wide" && m.department_id) return false;
        if (filterDeptId && filterDeptId !== "org-wide" && String(m.department_id) !== String(filterDeptId)) return false;
        return true;
      });
      listEl.innerHTML = msgs.length ? msgs.map((m) => messageCardHtml(m, showOrgUi)).join("") : `<div class="empty">No messages match this filter.</div>`;
    }

    if (filterOrgSelect) {
      filterOrgSelect.addEventListener("change", () => {
        filterOrgId = filterOrgSelect.value;
        filterDeptId = "";
        if (!filterOrgId) {
          filterDeptSelect.innerHTML = `<option value="">All departments</option>`;
          filterDeptSelect.disabled = true;
        } else {
          const entry = entryForOrg(filterOrgId);
          const depts = entry ? entry.orgData.departments : [];
          filterDeptSelect.innerHTML =
            `<option value="">All departments</option><option value="org-wide">Org-wide only</option>` +
            depts.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("");
          filterDeptSelect.disabled = false;
        }
        renderFilteredList();
      });
      filterDeptSelect.addEventListener("change", () => {
        filterDeptId = filterDeptSelect.value;
        renderFilteredList();
      });
    }
  }

  // A small "Automatic" badge distinguishes a system-posted message (task
  // added / checklist completed — see lib/systemMessages.js) from
  // something a person actually typed.
  function systemBadgeHtml(m) {
    return m.is_system ? ` <span class="badge">Automatic</span>` : "";
  }

  function messageCardHtml(m, showOrg) {
    const images = m.images || [];
    return `
      <a class="card report-row" href="#/messages/${m.id}">
        <div class="left">
          <h4>${escapeHtml(m.author_name || "Someone")}${systemBadgeHtml(m)}${showOrg && m.org_name ? ` <span class="badge">${escapeHtml(m.org_name)}</span>` : ""}${m.department_name ? ` <span class="badge">${escapeHtml(m.department_name)}</span>` : ""}</h4>
          <p>${escapeHtml(truncate(m.body, 140))}</p>
          ${images.length ? photoStripHtml(images) : ""}
          <p class="meta">${formatDateTime(m.created_at)} · ${m.reply_count} repl${m.reply_count === 1 ? "y" : "ies"}</p>
        </div>
        <div class="chev">${iconChevron()}</div>
      </a>
    `;
  }

  async function renderMessageDetail(id) {
    shell("messages", `<div class="empty">Loading…</div>`, { hideOrgStrip: true });
    let data;
    try {
      data = await api(`/messages/${id}`);
    } catch (err) {
      showBanner(err.message);
      location.hash = "#/messages";
      return;
    }

    syncBadge(); // the detail fetch above just recorded this message as read

    const { message, replies } = data;
    const isMine = message.author_id === state.user.id;
    const view = document.getElementById("view");

    let pendingReplyImages = [];

    view.innerHTML = `
      <a class="back-link" href="#/messages">${iconChevronLeft()} Message board</a>
      <div class="card">
        <div class="member-top">
          <div>
            <h4>${escapeHtml(message.author_name || "Someone")}${systemBadgeHtml(message)}${message.org_name ? ` <span class="badge">${escapeHtml(message.org_name)}</span>` : ""}${message.department_name ? ` <span class="badge">${escapeHtml(message.department_name)}</span>` : ""}</h4>
            <p class="meta">${formatDateTime(message.created_at)}</p>
          </div>
          <button class="task-del" id="deleteMsgBtn" aria-label="Delete message">${iconTrash()}</button>
        </div>
        <p style="white-space:pre-wrap;margin:10px 0 0;">${escapeHtml(message.body)}</p>
        ${photoStripHtml(message.images || [])}
        <p class="meta" style="margin-top:10px;">${seenByText(message.seen_by || [])}</p>
      </div>
      <div class="section-title">Replies (${replies.length})</div>
      ${replies.map(replyHtml).join("") || `<div class="empty">No replies yet.</div>`}
      <form id="replyForm" class="card" style="margin-top:10px;">
        <div class="field" style="margin-bottom:10px;">
          <textarea id="replyBody" maxlength="2000" placeholder="Reply…" required></textarea>
        </div>
        <div class="field" id="newReplyPhotoField" style="margin-bottom:10px;">
          ${photoStripHtml([], { addAttr: 'id="newReplyPhotoAdd"' })}
        </div>
        <button type="submit" class="btn block">Reply</button>
      </form>
    `;

    function renderPendingReplyPhotos() {
      const field = document.getElementById("newReplyPhotoField");
      if (!field) return;
      field.innerHTML = photoStripHtml(pendingReplyImages, {
        addAttr: 'id="newReplyPhotoAdd"',
        removeAttr: (i) => `data-new-reply-photo-remove="${i}"`,
      });
      wireNewReplyPhotoAdd();
      field.querySelectorAll("[data-new-reply-photo-remove]").forEach((btn) => {
        btn.addEventListener("click", () => {
          pendingReplyImages.splice(parseInt(btn.dataset.newReplyPhotoRemove, 10), 1);
          renderPendingReplyPhotos();
        });
      });
    }

    function wireNewReplyPhotoAdd() {
      const addLabel = document.getElementById("newReplyPhotoAdd");
      if (!addLabel) return;
      const input = addLabel.querySelector("input[type=file]");
      input.addEventListener("change", async () => {
        const room = 3 - pendingReplyImages.length;
        if (room <= 0) return;
        const newOnes = await resizeImageFiles(input.files, room);
        pendingReplyImages = pendingReplyImages.concat(newOnes);
        renderPendingReplyPhotos();
      });
    }
    wireNewReplyPhotoAdd();

    document.getElementById("replyForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const el = document.getElementById("replyBody");
      const text = el.value.trim();
      if (!text) return;
      try {
        await api(`/messages/${id}/replies`, { method: "POST", body: { body: text, images: pendingReplyImages } });
        renderMessageDetail(id);
      } catch (err) {
        showBanner(err.message);
      }
    });

    document.getElementById("deleteMsgBtn").addEventListener("click", async () => {
      if (!confirm(isMine ? "Delete this message?" : "Delete this message? (You're deleting it as a manager, not the author.)")) return;
      try {
        await api(`/messages/${id}`, { method: "DELETE" });
        location.hash = "#/messages";
      } catch (err) {
        showBanner(err.message);
      }
    });
  }

  function replyHtml(r) {
    const images = r.images || [];
    return `
      <div class="card">
        <h4 style="margin:0 0 3px;font-size:14px;">${escapeHtml(r.author_name || "Someone")}</h4>
        <p class="meta" style="margin:0 0 6px;">${formatDateTime(r.created_at)}</p>
        <p style="white-space:pre-wrap;margin:0;">${escapeHtml(r.body)}</p>
        ${images.length ? photoStripHtml(images) : ""}
      </div>
    `;
  }

  // ---------- Organizations ----------

  async function renderOrgs() {
    shell("org", `<div class="empty">Loading…</div>`);
    const view = document.getElementById("view");

    const isOwner = !!(state.user && state.user.is_owner);

    view.innerHTML = `
      ${
        state.orgs.length
          ? `<div class="section-title">Your organizations</div>${state.orgs.map(orgRowHtml).join("")}`
          : `<div class="empty">You're not part of an organization yet.<br />${
              isOwner ? "Create one below, or ask an admin to add you by your name." : "Ask an owner to create one, or an admin to add you by your name."
            }</div>`
      }
      ${
        isOwner
          ? `<div class="section-title">Create an organization</div>
             <form id="newOrgForm" class="card">
               <div class="field" style="margin-bottom:10px;">
                 <input type="text" id="orgName" maxlength="80" placeholder="Organization name" required />
               </div>
               <button type="submit" class="btn block">Create organization</button>
             </form>`
          : `<div class="section-title">Create an organization</div>
             <div class="empty">Only an owner can create new organizations.</div>`
      }
    `;

    view.querySelectorAll("[data-org-switch]").forEach((row) => {
      row.addEventListener("click", () => {
        setCurrentOrg(row.dataset.orgSwitch);
        location.hash = `#/orgs/${row.dataset.orgSwitch}`;
      });
    });

    const newOrgForm = document.getElementById("newOrgForm");
    if (newOrgForm) {
      newOrgForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("orgName");
        const name = input.value.trim();
        if (!name) return;
        try {
          const data = await api("/organizations", { method: "POST", body: { name } });
          setCurrentOrg(data.id);
          location.hash = `#/orgs/${data.id}`;
        } catch (err) {
          showBanner(err.message);
        }
      });
    }
  }

  function orgRowHtml(org) {
    const isCurrent = String(org.id) === String(state.orgId);
    return `
      <div class="card report-row org-row" data-org-switch="${org.id}">
        <div class="left">
          <h4>${escapeHtml(org.name)}${isCurrent ? ' <span class="badge done">Current</span>' : ""}</h4>
          <p>${org.role === "admin" ? "Admin" : "Member"}</p>
        </div>
        <div class="chev">${iconChevron()}</div>
      </div>
    `;
  }

  async function renderOrgDetail(id, opts) {
    opts = opts || {};
    shell("org", `<div class="empty">Loading…</div>`);
    let data;
    try {
      data = await api(`/organizations/${id}`);
    } catch (err) {
      showBanner(err.message);
      location.hash = "#/orgs";
      return;
    }

    const {
      organization,
      my_role,
      departments,
      members,
      photo_retention_messages_days,
      photo_retention_checklist_days,
      photo_retention_tasks_days,
    } = data;
    const isAdmin = my_role === "admin";
    const isOwner = !!(state.user && state.user.is_owner);
    const isCurrent = String(id) === String(state.orgId);
    const editingMemberId = opts.editingMemberId || null;

    let ownersData = null;
    let invitesData = null;
    if (isOwner) {
      try {
        ownersData = await api("/owners");
        invitesData = await api(`/invite-codes?org_id=${id}`);
      } catch (err) {
        showBanner(err.message);
      }
    }

    const view = document.getElementById("view");
    view.innerHTML = `
      <a class="back-link" href="#/orgs">${iconChevronLeft()} Organizations</a>
      <h2>${escapeHtml(organization.name)}</h2>
      ${
        isCurrent
          ? `<p class="meta" style="margin-bottom:16px;">This is your current organization.</p>`
          : `<button class="btn secondary block" id="makeCurrentBtn" style="margin-bottom:16px;">Make this my current organization</button>`
      }

      ${
        isOwner
          ? `<div class="section-title">Owners</div>
             <p class="meta" style="margin:0 0 10px;">Owners can create organizations, create/remove departments anywhere, and set anyone's role or owner status.</p>
             ${(ownersData && ownersData.owners ? ownersData.owners : []).map(ownerRowHtml).join("")}
             <form id="newOwnerForm" class="row" style="margin-top:10px;">
               <input type="text" id="newOwnerName" maxlength="40" placeholder="Add an owner by name" required />
               <button type="submit" class="btn">Add</button>
             </form>`
          : ""
      }

      ${
        isOwner
          ? `<div class="section-title">Invite people</div>
             <p class="meta" style="margin:0 0 10px;">Registering a new Notice Board account now needs a one-time code from an owner. Generate one for this organization (and optionally a department), then send it to the person however you like — text, WhatsApp, in person.</p>
             <form id="newInviteForm" class="card" style="margin-bottom:10px;">
               ${
                 departments.length
                   ? `<div class="field" style="margin-bottom:10px;">
                        <label for="inviteDept">Department (optional)</label>
                        <select id="inviteDept">
                          <option value="">Whole organization</option>
                          ${departments.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("")}
                        </select>
                      </div>`
                   : ""
               }
               <button type="submit" class="btn block">Generate invite code</button>
             </form>
             <div id="inviteCodeResult">
               ${
                 opts.justGeneratedCode
                   ? `<div class="card" style="margin-bottom:10px;">
                        <p class="meta" style="margin:0 0 6px;">Give this code to the new person — it works once:</p>
                        <div class="row">
                          <input type="text" readonly value="${escapeHtml(opts.justGeneratedCode)}" style="font-weight:600; letter-spacing:2px; text-align:center;" />
                          <button type="button" class="btn secondary" id="copyInviteCodeBtn">Copy</button>
                        </div>
                      </div>`
                   : ""
               }
             </div>
             ${
               invitesData && invitesData.invite_codes && invitesData.invite_codes.some((c) => !c.used_by)
                 ? invitesData.invite_codes.filter((c) => !c.used_by).map(inviteRowHtml).join("")
                 : `<div class="empty">No outstanding invite codes.</div>`
             }`
          : ""
      }

      ${
        pushSupported()
          ? `<div class="section-title">Notifications</div>
             <div class="card" id="notifCard">
               <p class="meta" id="notifStatus">Checking…</p>
               <button type="button" class="btn secondary block" id="notifToggleBtn" style="margin-top:8px;" disabled>…</button>
               <p class="meta" style="margin-top:8px;">Get notified on this device for new tasks, new message board posts, and completed checklists. Turned on separately per device.</p>
             </div>`
          : ""
      }

      <div class="section-title">Departments</div>
      ${departments.length ? departments.map((d) => departmentRowHtml(d, isOwner)).join("") : `<div class="empty">No departments yet.</div>`}
      ${
        isOwner
          ? `<form id="newDeptForm" class="row" style="margin-top:10px;">
               <input type="text" id="deptName" maxlength="60" placeholder="New department name" required />
               <button type="submit" class="btn">Add</button>
             </form>`
          : ""
      }

      <div class="section-title">Members</div>
      ${members.map((m) => memberRowHtml(m, isAdmin, isOwner, departments, editingMemberId === m.id)).join("")}
      ${isAdmin ? newMemberFormHtml(departments) : ""}

      ${
        isAdmin
          ? `<div class="section-title">Photo retention</div>
             <form id="retentionForm" class="card">
               <p class="meta" style="margin:0 0 10px;">Automatically delete photos after this many days. Leave blank to keep them forever.</p>
               <div class="field" style="margin-bottom:10px;">
                 <label for="retMessages">Message board photos (days)</label>
                 <input type="number" id="retMessages" min="1" step="1" placeholder="Never" value="${photo_retention_messages_days ?? ""}" />
               </div>
               <div class="field" style="margin-bottom:10px;">
                 <label for="retChecklist">Checklist photos (days)</label>
                 <input type="number" id="retChecklist" min="1" step="1" placeholder="Never" value="${photo_retention_checklist_days ?? ""}" />
               </div>
               <div class="field" style="margin-bottom:10px;">
                 <label for="retTasks">Task photos (days)</label>
                 <input type="number" id="retTasks" min="1" step="1" placeholder="Never" value="${photo_retention_tasks_days ?? ""}" />
               </div>
               <button type="submit" class="btn block">Save retention settings</button>
             </form>`
          : ""
      }

      <p class="meta" style="margin-top:20px; text-align:center;">Notice Board ${APP_VERSION}</p>
    `;

    const makeCurrentBtn = document.getElementById("makeCurrentBtn");
    if (makeCurrentBtn) {
      makeCurrentBtn.addEventListener("click", () => {
        setCurrentOrg(id);
        renderOrgDetail(id);
      });
    }

    const notifToggleBtn = document.getElementById("notifToggleBtn");
    if (notifToggleBtn) {
      const notifStatus = document.getElementById("notifStatus");

      function paintNotifState(subscribed) {
        if (Notification.permission === "denied") {
          notifStatus.textContent = "Notifications are blocked for this site in your browser settings.";
          notifToggleBtn.textContent = "Blocked";
          notifToggleBtn.disabled = true;
          return;
        }
        notifStatus.textContent = subscribed
          ? "Notifications are on for this device."
          : "Notifications are off for this device.";
        notifToggleBtn.textContent = subscribed ? "Turn off" : "Turn on";
        notifToggleBtn.disabled = false;
      }

      currentPushSubscription().then((sub) => paintNotifState(!!sub));

      notifToggleBtn.addEventListener("click", async () => {
        notifToggleBtn.disabled = true;
        try {
          const sub = await currentPushSubscription();
          if (sub) {
            await disablePushOnThisDevice();
            paintNotifState(false);
          } else {
            await enablePushOnThisDevice();
            paintNotifState(true);
          }
        } catch (err) {
          showBanner(err.message);
          const sub = await currentPushSubscription();
          paintNotifState(!!sub);
        }
      });
    }

    const newOwnerForm = document.getElementById("newOwnerForm");
    if (newOwnerForm) {
      newOwnerForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("newOwnerName");
        const name = input.value.trim();
        if (!name) return;
        try {
          await api("/owners", { method: "POST", body: { name } });
          renderOrgDetail(id, opts);
        } catch (err) {
          showBanner(err.message);
        }
      });
    }

    view.querySelectorAll("[data-owner-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Remove ${btn.dataset.ownerName} as an owner?`)) return;
        try {
          await api(`/owners/${btn.dataset.ownerRemove}`, { method: "DELETE" });
          renderOrgDetail(id, opts);
        } catch (err) {
          showBanner(err.message);
        }
      });
    });

    const newInviteForm = document.getElementById("newInviteForm");
    if (newInviteForm) {
      newInviteForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const deptSelect = document.getElementById("inviteDept");
        const department_id = deptSelect && deptSelect.value ? parseInt(deptSelect.value, 10) : null;
        try {
          const result = await api("/invite-codes", { method: "POST", body: { org_id: id, department_id } });
          renderOrgDetail(id, { ...opts, justGeneratedCode: result.code });
        } catch (err) {
          showBanner(err.message);
        }
      });
    }

    const copyInviteCodeBtn = document.getElementById("copyInviteCodeBtn");
    if (copyInviteCodeBtn) {
      copyInviteCodeBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(opts.justGeneratedCode);
          showBanner("Code copied", false);
        } catch {
          showBanner("Couldn't copy automatically — select and copy it manually");
        }
      });
    }

    view.querySelectorAll("[data-invite-revoke]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Revoke invite code ${btn.dataset.inviteCode}? It'll no longer work.`)) return;
        try {
          await api(`/invite-codes/${btn.dataset.inviteRevoke}`, { method: "DELETE" });
          renderOrgDetail(id, opts);
        } catch (err) {
          showBanner(err.message);
        }
      });
    });

    const newDeptForm = document.getElementById("newDeptForm");
    if (newDeptForm) {
      newDeptForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("deptName");
        const name = input.value.trim();
        if (!name) return;
        try {
          await api(`/organizations/${id}/departments`, { method: "POST", body: { name } });
          renderOrgDetail(id);
        } catch (err) {
          showBanner(err.message);
        }
      });
    }

    view.querySelectorAll("[data-dept-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this department? People assigned to it will lose access to anything scoped there.")) return;
        try {
          await api(`/organizations/${id}/departments/${btn.dataset.deptRemove}`, { method: "DELETE" });
          renderOrgDetail(id);
        } catch (err) {
          showBanner(err.message);
        }
      });
    });

    view.querySelectorAll("[data-member-manage]").forEach((btn) => {
      btn.addEventListener("click", () => {
        renderOrgDetail(id, { editingMemberId: parseInt(btn.dataset.memberManage, 10) });
      });
    });
    view.querySelectorAll("[data-member-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => renderOrgDetail(id));
    });
    view.querySelectorAll("[data-member-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.memberSave;
        const row = view.querySelector(`[data-member-row="${userId}"]`);
        const deptIds = Array.from(row.querySelectorAll('.dept-checks input[type="checkbox"]:checked')).map((cb) =>
          parseInt(cb.value, 10)
        );
        // Only an owner can actually change role/management — the role
        // select is disabled (but still visible) for everyone else, so
        // omit it from the request rather than resend an unchanged value
        // the server would otherwise reject as an attempt to change it.
        const body = { department_ids: deptIds };
        if (isOwner) {
          const roleValue = row.querySelector('[name="role"]').value; // member | management | admin
          body.role = roleValue === "admin" ? "admin" : "member";
          // Leave the management flag untouched when promoting to admin —
          // isManager() already treats admins as managers regardless of
          // that column, same as before this dropdown replaced the
          // separate checkbox.
          if (roleValue !== "admin") body.management = roleValue === "management";
        }
        try {
          await api(`/organizations/${id}/members/${userId}`, { method: "PATCH", body });
          renderOrgDetail(id);
        } catch (err) {
          showBanner(err.message);
        }
      });
    });
    view.querySelectorAll("[data-member-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this person from the organization?")) return;
        try {
          await api(`/organizations/${id}/members/${btn.dataset.memberRemove}`, { method: "DELETE" });
          renderOrgDetail(id);
        } catch (err) {
          showBanner(err.message);
        }
      });
    });

    const retentionForm = document.getElementById("retentionForm");
    if (retentionForm) {
      retentionForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const val = (elId) => {
          const v = document.getElementById(elId).value.trim();
          return v === "" ? null : v;
        };
        try {
          await api(`/organizations/${id}`, {
            method: "PATCH",
            body: {
              photo_retention_messages_days: val("retMessages"),
              photo_retention_checklist_days: val("retChecklist"),
              photo_retention_tasks_days: val("retTasks"),
            },
          });
          showBanner("Retention settings saved", false);
          renderOrgDetail(id);
        } catch (err) {
          showBanner(err.message);
        }
      });
    }

    const newMemberForm = document.getElementById("newMemberForm");
    if (newMemberForm) {
      newMemberForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const nameInput = document.getElementById("memberName");
        const name = nameInput.value.trim();
        if (!name) return;
        const deptIds = Array.from(newMemberForm.querySelectorAll(".dept-checks input:checked")).map((cb) =>
          parseInt(cb.value, 10)
        );
        try {
          await api(`/organizations/${id}/members`, { method: "POST", body: { name, department_ids: deptIds } });
          renderOrgDetail(id);
        } catch (err) {
          showBanner(err.message);
        }
      });
    }
  }

  function departmentRowHtml(dept, isOwner) {
    return `
      <div class="card dept-row">
        <span>${escapeHtml(dept.name)}</span>
        ${isOwner ? `<button class="task-del" data-dept-remove="${dept.id}" aria-label="Remove department">${iconTrash()}</button>` : ""}
      </div>
    `;
  }

  function inviteRowHtml(invite) {
    const scope = invite.department_name ? escapeHtml(invite.department_name) : "Whole organization";
    return `
      <div class="card dept-row">
        <span><strong>${escapeHtml(invite.code)}</strong> · ${scope}</span>
        <button class="task-del" data-invite-revoke="${invite.id}" data-invite-code="${escapeHtml(invite.code)}" aria-label="Revoke invite code">${iconTrash()}</button>
      </div>
    `;
  }

  function ownerRowHtml(owner) {
    return `
      <div class="card dept-row">
        <span>${escapeHtml(owner.name)}</span>
        <button class="task-del" data-owner-remove="${owner.id}" data-owner-name="${escapeHtml(owner.name)}" aria-label="Remove owner status">${iconTrash()}</button>
      </div>
    `;
  }

  function memberRowHtml(member, isAdmin, isOwner, allDepartments, isEditing) {
    const deptNames = member.departments.map((d) => escapeHtml(d.name)).join(", ");

    const roleBadge =
      member.role === "admin"
        ? '<span class="badge done">Admin</span>'
        : member.management
        ? '<span class="badge done">Management</span>'
        : "";

    if (!isEditing) {
      return `
        <div class="card member-row">
          <div class="member-top">
            <div>
              <h4>${escapeHtml(member.name)} ${roleBadge}</h4>
              <p class="meta">${deptNames || "Whole organization only"}</p>
            </div>
            ${isAdmin ? `<button class="btn secondary" data-member-manage="${member.id}">Manage</button>` : ""}
          </div>
        </div>
      `;
    }

    const roleValue = member.role === "admin" ? "admin" : member.management ? "management" : "member";

    return `
      <div class="card member-row" data-member-row="${member.id}">
        <h4>${escapeHtml(member.name)}</h4>
        <div class="field">
          <label>Role</label>
          <select name="role" ${isOwner ? "" : "disabled"}>
            <option value="member" ${roleValue === "member" ? "selected" : ""}>Member</option>
            <option value="management" ${roleValue === "management" ? "selected" : ""}>Management</option>
            <option value="admin" ${roleValue === "admin" ? "selected" : ""}>Admin</option>
          </select>
          ${isOwner ? "" : `<p class="meta" style="margin-top:6px;">Only an owner can change someone's role.</p>`}
        </div>
        ${
          roleValue === "member"
            ? ""
            : `<p class="meta">${
                roleValue === "admin"
                  ? "Admins can add tasks, message any department, see every department's messages, and manage members."
                  : "Management can add tasks, message any department, and see every department's messages — without full admin control."
              }</p>`
        }
        ${
          allDepartments.length
            ? `<div class="field">
                 <label>Departments</label>
                 <div class="dept-checks">
                   ${allDepartments
                     .map(
                       (d) =>
                         `<label class="dept-check"><input type="checkbox" value="${d.id}" ${
                           member.departments.some((md) => md.id === d.id) ? "checked" : ""
                         } /> ${escapeHtml(d.name)}</label>`
                     )
                     .join("")}
                 </div>
               </div>`
            : ""
        }
        <div class="row" style="margin-top:10px;">
          <button class="btn" data-member-save="${member.id}">Save</button>
          <button class="btn secondary" type="button" data-member-cancel="1">Cancel</button>
        </div>
        <button class="btn danger block" style="margin-top:8px;" data-member-remove="${member.id}">Remove from organization</button>
      </div>
    `;
  }

  function newMemberFormHtml(departments) {
    return `
      <form id="newMemberForm" class="card" style="margin-top:14px;">
        <div class="field">
          <label for="memberName">Add someone by name</label>
          <input type="text" id="memberName" maxlength="40" placeholder="Must already have a Notice Board account" required />
        </div>
        ${
          departments.length
            ? `<div class="field">
                 <label>Departments (optional)</label>
                 <div class="dept-checks">
                   ${departments.map((d) => `<label class="dept-check"><input type="checkbox" value="${d.id}" /> ${escapeHtml(d.name)}</label>`).join("")}
                 </div>
               </div>`
            : ""
        }
        <button type="submit" class="btn block">Add member</button>
      </form>
    `;
  }

  // ---------- Router ----------

  function parseHash() {
    const raw = (location.hash || "").replace(/^#\/?/, "");
    return raw.split("/").filter(Boolean);
  }

  async function navigate() {
    const parts = parseHash();

    if (!state.token && parts[0] !== "login") {
      location.hash = "#/login";
      return;
    }
    if (state.token && parts[0] === "login") {
      location.hash = "#/messages";
      return;
    }
    if (parts.length === 0) {
      location.hash = "#/messages";
      return;
    }
    if (parts[0] === "login") return renderLogin();

    // Refresh the signed-in user (mainly for is_owner, which can change on
    // another device without this session's copy noticing otherwise).
    // Best-effort — a failure here shouldn't block navigation.
    try {
      const me = await api("/me");
      if (me && me.user) setAuth(state.token, me.user);
    } catch {
      /* keep the cached user */
    }

    // Every other view depends on knowing which organizations this person
    // is in, and which one is "current" — load that first.
    try {
      const data = await api("/organizations");
      state.orgs = data.organizations;
      if (state.orgId && !state.orgs.some((o) => String(o.id) === String(state.orgId))) {
        setCurrentOrg(null); // no longer a member (e.g. an admin removed them)
      }
      if (!state.orgId && state.orgs.length === 1) {
        setCurrentOrg(state.orgs[0].id); // only one to choose from — just pick it
      }
    } catch (err) {
      showBanner(err.message);
      return;
    }

    if (parts[0] !== "orgs" && !state.orgId) {
      location.hash = "#/orgs";
      return;
    }

    try {
      if (parts[0] === "orgs" && parts.length === 1) return renderOrgs();
      if (parts[0] === "orgs" && parts[1]) return renderOrgDetail(parts[1]);
      if (parts[0] === "checklists" && parts.length === 1) return renderChecklistList();
      if (parts[0] === "checklists" && parts[1] === "new") return renderChecklistForm();
      if (parts[0] === "checklists" && parts.length === 2) return renderChecklistDetail(parts[1]);
      if (parts[0] === "checklists" && parts[2] === "history") return renderChecklistHistory(parts[1]);
      if (parts[0] === "checklists" && parts[2] === "reports" && parts[3]) {
        return renderChecklistReport(parts[1], parts[3]);
      }
      if (parts[0] === "tasks") return renderTasks();
      if (parts[0] === "messages" && parts.length === 1) return renderMessageBoard();
      if (parts[0] === "messages" && parts[1]) return renderMessageDetail(parts[1]);
      location.hash = "#/messages";
    } catch (err) {
      console.error(err);
      showBanner((err && err.message) || "Something went wrong");
    } finally {
      syncBadge();
    }
  }

  window.addEventListener("hashchange", navigate);
  window.addEventListener("DOMContentLoaded", () => {
    navigate();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  });
})();
