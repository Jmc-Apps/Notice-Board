(function () {
  "use strict";

  // Same-origin "/api" by default (Cloudflare Pages); config.js can point
  // this at a standalone Worker's URL instead, for when the site is hosted
  // somewhere that can't run the API itself (e.g. GitHub Pages).
  const API = (window.NOTICE_BOARD_API_BASE || "").trim() || "/api";
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

  // ---------- Shell (header + bottom tab bar) ----------

  const app = document.getElementById("app");

  function shell(activeTab, innerHtml) {
    const org = currentOrgMeta();
    const orgTabHref = state.orgId ? `#/orgs/${state.orgId}` : "#/orgs";

    app.innerHTML = `
      <header class="topbar">
        <a class="brand" href="#/checklists" aria-label="Notice Board home">
          <img src="brand/banner.png" alt="Notice Board" />
        </a>
        <div class="who">
          <span>${escapeHtml(state.user && state.user.name)}</span>
          <button class="icon-btn" id="logoutBtn" title="Switch user" aria-label="Switch user">${iconLogout()}</button>
        </div>
      </header>
      ${org ? `<a class="org-strip" href="#/orgs">${iconOrg()}<span>${escapeHtml(org.name)}</span><span class="switch">Switch</span></a>` : ""}
      <main id="view">${innerHtml}</main>
      <nav class="tabbar">
        <a href="#/checklists" class="${activeTab === "checklists" ? "active" : ""}">
          ${iconChecklist()}<span>Checklists</span>
        </a>
        <a href="#/tasks" class="${activeTab === "tasks" ? "active" : ""}">
          ${iconTasks()}<span>Tasks</span>
        </a>
        <a href="#/messages" class="${activeTab === "messages" ? "active" : ""}">
          ${iconMessage()}<span>Messages</span>
        </a>
        <a href="${orgTabHref}" class="${activeTab === "org" ? "active" : ""}">
          ${iconOrg()}<span>Org</span>
        </a>
      </nav>
    `;
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);
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
          <div class="error-text" id="authError" hidden></div>
          <button type="submit" class="btn block" id="authSubmit">Log in</button>
        </form>
      </div>
    `;

    let mode = "login";
    const toggleBtns = app.querySelectorAll(".tabs-toggle button");
    toggleBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        mode = btn.dataset.mode;
        toggleBtns.forEach((b) => b.classList.toggle("active", b === btn));
        document.getElementById("authSubmit").textContent = mode === "login" ? "Log in" : "Create account";
      });
    });

    document.getElementById("authForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("authName").value.trim();
      const pin = document.getElementById("authPin").value.trim();
      const errorEl = document.getElementById("authError");
      errorEl.hidden = true;
      if (!name || !pin) return;

      const submitBtn = document.getElementById("authSubmit");
      submitBtn.disabled = true;
      try {
        const data = await api(mode === "login" ? "/login" : "/register", {
          method: "POST",
          body: { name, pin },
        });
        setAuth(data.token, data.user);
        location.hash = "#/checklists";
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // ---------- Checklist list ----------

  async function renderChecklistList() {
    shell("checklists", `<div class="empty">Loading…</div>`);
    let data;
    try {
      data = await api(`/checklists?org_id=${state.orgId}`);
    } catch (err) {
      showBanner(err.message);
      return;
    }

    const view = document.getElementById("view");
    view.innerHTML = data.checklists.length
      ? `<div class="section-title">Checklists</div>${data.checklists.map(checklistCardHtml).join("")}`
      : `<div class="empty">No checklists yet.<br />Tap + to create your first repeatable checklist.</div>`;

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

    let pickableDepartments = [];
    try {
      const orgData = await api(`/organizations/${state.orgId}`);
      pickableDepartments = pickableDepartmentsFor(orgData);
    } catch (err) {
      showBanner(err.message);
    }

    const view = document.getElementById("view");
    view.innerHTML = `
      <a class="back-link" href="#/checklists">${iconChevronLeft()} Checklists</a>
      <h2>New checklist</h2>
      <form id="newChecklistForm">
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
            ? `<div class="field">
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

    const itemRows = document.getElementById("itemRows");
    function addItemRow(value, requiresPhoto) {
      const row = document.createElement("div");
      row.className = "item-input-row";
      row.innerHTML = `
        <input type="text" maxlength="120" placeholder="Item" value="${escapeHtml(value || "")}" />
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

      const department_ids = Array.from(view.querySelectorAll('input[name="clDept"]:checked')).map((cb) =>
        parseInt(cb.value, 10)
      );

      try {
        const data = await api("/checklists", {
          method: "POST",
          body: { title, description, recurrence, recurrence_n, items, org_id: state.orgId, department_ids },
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

    view.querySelectorAll("[data-note]").forEach((input) => {
      input.addEventListener("change", async () => {
        const itemId = input.dataset.note;
        const cb = view.querySelector(`[data-item="${itemId}"]`);
        try {
          await api(`/runs/${run.id}/items/${itemId}`, {
            method: "PATCH",
            body: { checked: cb ? cb.checked : false, note: input.value },
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
        const cb = view.querySelector(`[data-item="${itemId}"]`);
        const noteEl = view.querySelector(`[data-note="${itemId}"]`);
        try {
          await api(`/runs/${run.id}/items/${itemId}`, {
            method: "PATCH",
            body: { checked: cb ? cb.checked : false, note: noteEl ? noteEl.value : undefined, images: existing.concat(newOnes) },
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
        const cb = view.querySelector(`[data-item="${itemId}"]`);
        const noteEl = view.querySelector(`[data-note="${itemId}"]`);
        try {
          await api(`/runs/${run.id}/items/${itemId}`, {
            method: "PATCH",
            body: { checked: cb ? cb.checked : false, note: noteEl ? noteEl.value : undefined, images },
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
    return `
      <li class="item ${item.checked ? "done" : ""}">
        <label class="item-main">
          <input type="checkbox" data-item="${item.item_id}" ${item.checked ? "checked" : ""} ${readonly ? "disabled" : ""} />
          <span>${escapeHtml(item.label)}</span>
          ${item.requires_photo ? '<span class="badge photo-req">📷 Photo required</span>' : ""}
        </label>
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

    const canCreate = isManagerFlag(orgData);
    const pickableDepartments = pickableDepartmentsFor(orgData);

    const view = document.getElementById("view");
    const open = data.tasks.filter((t) => !t.done);
    const done = data.tasks.filter((t) => t.done);

    let pendingCreateImages = [];

    view.innerHTML = `
      ${
        canCreate
          ? `<form id="newTaskForm" class="card">
               <div class="field" style="margin-bottom:10px;">
                 <input type="text" id="taskTitle" maxlength="120" placeholder="Add a task…" required />
               </div>
               ${
                 pickableDepartments.length
                   ? `<div class="field" style="margin-bottom:10px;">
                        <select id="taskDept">
                          <option value="">Whole organization</option>
                          ${pickableDepartments.map((d) => `<option value="${d.id}">${escapeHtml(d.name)} only</option>`).join("")}
                        </select>
                      </div>`
                   : ""
               }
               <div class="field" id="newTaskPhotoField" style="margin-bottom:10px;">
                 ${photoStripHtml([], { addAttr: 'id="newTaskPhotoAdd"' })}
               </div>
               <button type="submit" class="btn block">Add task</button>
             </form>`
          : `<div class="empty">Only managers can add tasks. You can still check tasks off, add notes and photos.</div>`
      }
      <div class="section-title">To do (${open.length})</div>
      <ul class="item-list" id="openTasks">
        ${open.length ? open.map(taskRowHtml).join("") : `<div class="empty">Nothing to do — nice.</div>`}
      </ul>
      ${
        done.length
          ? `<div class="section-title">Done (${done.length})</div><ul class="item-list" id="doneTasks">${done.map(taskRowHtml).join("")}</ul>`
          : ""
      }
    `;

    function renderPendingCreatePhotos() {
      const field = document.getElementById("newTaskPhotoField");
      if (!field) return;
      field.innerHTML = photoStripHtml(pendingCreateImages, {
        addAttr: 'id="newTaskPhotoAdd"',
        removeAttr: (i) => `data-new-task-photo-remove="${i}"`,
      });
      wireNewTaskPhotoAdd();
      field.querySelectorAll("[data-new-task-photo-remove]").forEach((btn) => {
        btn.addEventListener("click", () => {
          pendingCreateImages.splice(parseInt(btn.dataset.newTaskPhotoRemove, 10), 1);
          renderPendingCreatePhotos();
        });
      });
    }

    function wireNewTaskPhotoAdd() {
      const addLabel = document.getElementById("newTaskPhotoAdd");
      if (!addLabel) return;
      const input = addLabel.querySelector("input[type=file]");
      input.addEventListener("change", async () => {
        const room = 3 - pendingCreateImages.length;
        if (room <= 0) return;
        const newOnes = await resizeImageFiles(input.files, room);
        pendingCreateImages = pendingCreateImages.concat(newOnes);
        renderPendingCreatePhotos();
      });
    }

    const newTaskForm = document.getElementById("newTaskForm");
    if (newTaskForm) {
      wireNewTaskPhotoAdd();

      newTaskForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("taskTitle");
        const title = input.value.trim();
        if (!title) return;
        const deptSelect = document.getElementById("taskDept");
        const department_ids = deptSelect && deptSelect.value ? [parseInt(deptSelect.value, 10)] : [];
        try {
          await api("/tasks", { method: "POST", body: { title, org_id: state.orgId, department_ids, images: pendingCreateImages } });
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
          }${scopeSuffix(task.scopes)}
        </div>
      </li>
    `;
  }

  // ---------- Message board ----------

  async function renderMessageBoard() {
    shell("messages", `<div class="empty">Loading…</div>`);
    let data, orgData;
    try {
      data = await api(`/messages?org_id=${state.orgId}`);
      orgData = await api(`/organizations/${state.orgId}`);
    } catch (err) {
      showBanner(err.message);
      return;
    }

    const pickableDepartments = pickableDepartmentsFor(orgData);
    const view = document.getElementById("view");

    view.innerHTML = `
      <form id="newMessageForm" class="card">
        <div class="field" style="margin-bottom:10px;">
          <textarea id="msgBody" maxlength="4000" placeholder="Write a message…" required></textarea>
        </div>
        <div class="field" style="margin-bottom:10px;">
          <select id="msgDept">
            <option value="">Whole organization</option>
            ${pickableDepartments.map((d) => `<option value="${d.id}">${escapeHtml(d.name)} only</option>`).join("")}
          </select>
        </div>
        <button type="submit" class="btn block">Post</button>
      </form>
      <div class="section-title">Messages</div>
      ${data.messages.length ? data.messages.map(messageCardHtml).join("") : `<div class="empty">No messages yet.</div>`}
    `;

    document.getElementById("newMessageForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const bodyEl = document.getElementById("msgBody");
      const text = bodyEl.value.trim();
      if (!text) return;
      const deptSelect = document.getElementById("msgDept");
      const department_id = deptSelect.value ? parseInt(deptSelect.value, 10) : null;
      try {
        await api("/messages", { method: "POST", body: { body: text, org_id: state.orgId, department_id } });
        renderMessageBoard();
      } catch (err) {
        showBanner(err.message);
      }
    });
  }

  function messageCardHtml(m) {
    return `
      <a class="card report-row" href="#/messages/${m.id}">
        <div class="left">
          <h4>${escapeHtml(m.author_name || "Someone")}${m.department_name ? ` <span class="badge">${escapeHtml(m.department_name)}</span>` : ""}</h4>
          <p>${escapeHtml(truncate(m.body, 140))}</p>
          <p class="meta">${formatDateTime(m.created_at)} · ${m.reply_count} repl${m.reply_count === 1 ? "y" : "ies"}</p>
        </div>
        <div class="chev">${iconChevron()}</div>
      </a>
    `;
  }

  async function renderMessageDetail(id) {
    shell("messages", `<div class="empty">Loading…</div>`);
    let data;
    try {
      data = await api(`/messages/${id}`);
    } catch (err) {
      showBanner(err.message);
      location.hash = "#/messages";
      return;
    }

    const { message, replies } = data;
    const isMine = message.author_id === state.user.id;
    const view = document.getElementById("view");
    view.innerHTML = `
      <a class="back-link" href="#/messages">${iconChevronLeft()} Message board</a>
      <div class="card">
        <div class="member-top">
          <div>
            <h4>${escapeHtml(message.author_name || "Someone")}${message.department_name ? ` <span class="badge">${escapeHtml(message.department_name)}</span>` : ""}</h4>
            <p class="meta">${formatDateTime(message.created_at)}</p>
          </div>
          <button class="task-del" id="deleteMsgBtn" aria-label="Delete message">${iconTrash()}</button>
        </div>
        <p style="white-space:pre-wrap;margin:10px 0 0;">${escapeHtml(message.body)}</p>
      </div>
      <div class="section-title">Replies (${replies.length})</div>
      ${replies.map(replyHtml).join("") || `<div class="empty">No replies yet.</div>`}
      <form id="replyForm" class="card" style="margin-top:10px;">
        <div class="field" style="margin-bottom:10px;">
          <textarea id="replyBody" maxlength="2000" placeholder="Reply…" required></textarea>
        </div>
        <button type="submit" class="btn block">Reply</button>
      </form>
    `;

    document.getElementById("replyForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const el = document.getElementById("replyBody");
      const text = el.value.trim();
      if (!text) return;
      try {
        await api(`/messages/${id}/replies`, { method: "POST", body: { body: text } });
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
    return `
      <div class="card">
        <h4 style="margin:0 0 3px;font-size:14px;">${escapeHtml(r.author_name || "Someone")}</h4>
        <p class="meta" style="margin:0 0 6px;">${formatDateTime(r.created_at)}</p>
        <p style="white-space:pre-wrap;margin:0;">${escapeHtml(r.body)}</p>
      </div>
    `;
  }

  // ---------- Organizations ----------

  async function renderOrgs() {
    shell("org", `<div class="empty">Loading…</div>`);
    const view = document.getElementById("view");

    view.innerHTML = `
      ${
        state.orgs.length
          ? `<div class="section-title">Your organizations</div>${state.orgs.map(orgRowHtml).join("")}`
          : `<div class="empty">You're not part of an organization yet.<br />Create one below, or ask an admin to add you by your name.</div>`
      }
      <div class="section-title">Create an organization</div>
      <form id="newOrgForm" class="card">
        <div class="field" style="margin-bottom:10px;">
          <input type="text" id="orgName" maxlength="80" placeholder="Organization name" required />
        </div>
        <button type="submit" class="btn block">Create organization</button>
      </form>
    `;

    view.querySelectorAll("[data-org-switch]").forEach((row) => {
      row.addEventListener("click", () => {
        setCurrentOrg(row.dataset.orgSwitch);
        location.hash = `#/orgs/${row.dataset.orgSwitch}`;
      });
    });

    document.getElementById("newOrgForm").addEventListener("submit", async (e) => {
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

    const { organization, my_role, departments, members } = data;
    const isAdmin = my_role === "admin";
    const isCurrent = String(id) === String(state.orgId);
    const editingMemberId = opts.editingMemberId || null;

    const view = document.getElementById("view");
    view.innerHTML = `
      <a class="back-link" href="#/orgs">${iconChevronLeft()} Organizations</a>
      <h2>${escapeHtml(organization.name)}</h2>
      ${
        isCurrent
          ? `<p class="meta" style="margin-bottom:16px;">This is your current organization.</p>`
          : `<button class="btn secondary block" id="makeCurrentBtn" style="margin-bottom:16px;">Make this my current organization</button>`
      }

      <div class="section-title">Departments</div>
      ${departments.length ? departments.map((d) => departmentRowHtml(d, isAdmin)).join("") : `<div class="empty">No departments yet.</div>`}
      ${
        isAdmin
          ? `<form id="newDeptForm" class="row" style="margin-top:10px;">
               <input type="text" id="deptName" maxlength="60" placeholder="New department name" required />
               <button type="submit" class="btn">Add</button>
             </form>`
          : ""
      }

      <div class="section-title">Members</div>
      ${members.map((m) => memberRowHtml(m, isAdmin, departments, editingMemberId === m.id)).join("")}
      ${isAdmin ? newMemberFormHtml(departments) : ""}
    `;

    const makeCurrentBtn = document.getElementById("makeCurrentBtn");
    if (makeCurrentBtn) {
      makeCurrentBtn.addEventListener("click", () => {
        setCurrentOrg(id);
        renderOrgDetail(id);
      });
    }

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
        const role = row.querySelector('[name="role"]').value;
        const managementInput = row.querySelector('[name="management"]');
        const management = managementInput ? managementInput.checked : undefined;
        const deptIds = Array.from(row.querySelectorAll('.dept-checks input[type="checkbox"]:checked')).map((cb) =>
          parseInt(cb.value, 10)
        );
        try {
          await api(`/organizations/${id}/members/${userId}`, { method: "PATCH", body: { role, management, department_ids: deptIds } });
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

  function departmentRowHtml(dept, isAdmin) {
    return `
      <div class="card dept-row">
        <span>${escapeHtml(dept.name)}</span>
        ${isAdmin ? `<button class="task-del" data-dept-remove="${dept.id}" aria-label="Remove department">${iconTrash()}</button>` : ""}
      </div>
    `;
  }

  function memberRowHtml(member, isAdmin, allDepartments, isEditing) {
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

    return `
      <div class="card member-row" data-member-row="${member.id}">
        <h4>${escapeHtml(member.name)}</h4>
        <div class="field">
          <label>Role</label>
          <select name="role">
            <option value="member" ${member.role === "member" ? "selected" : ""}>Member</option>
            <option value="admin" ${member.role === "admin" ? "selected" : ""}>Admin</option>
          </select>
        </div>
        ${
          member.role === "admin"
            ? `<p class="meta">Admins are automatically management — they can add tasks, message any department and see every department's messages.</p>`
            : `<div class="field">
                 <label class="dept-check"><input type="checkbox" name="management" ${member.management ? "checked" : ""} /> Management — can add tasks, message any department, and see every department's messages</label>
               </div>`
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
      location.hash = "#/checklists";
      return;
    }
    if (parts.length === 0) {
      location.hash = "#/checklists";
      return;
    }
    if (parts[0] === "login") return renderLogin();

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
      location.hash = "#/checklists";
    } catch (err) {
      console.error(err);
      showBanner((err && err.message) || "Something went wrong");
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
