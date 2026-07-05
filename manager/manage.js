(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const SESSION_MS = 5 * 60 * 1000; // 5 minutes
  let masterKey = null;
  let expiresAt = 0;
  let expireTimer = null;
  let tickTimer = null;

  const els = {
    unlockSection: $("unlock-section"),
    manageSection: $("manage-section"),
    master:        $("master"),
    unlockBtn:     $("unlock-btn"),
    unlockError:   $("unlock-error"),
    unlockStatus:  $("unlock-status"),
    verifyBanner:  $("verify-banner"),
    countdown:     $("countdown"),
    sessionBar:    $("session-bar"),
    lockBtn:       $("lock-btn"),
    addForm:       $("add-form"),
    addName:       $("add-name"),
    addCategory:   $("add-category"),
    addUnique:     $("add-unique"),
    addLength:     $("add-length"),
    addUsername:   $("add-username"),
    addSiteUrl:    $("add-siteurl"),
    addNote:       $("add-note"),
    addError:      $("add-error"),
    addHeading:    $("add-heading"),
    listHeading:   $("list-heading"),
    siteList:      $("site-list"),
    siteCount:     $("site-count"),
    emptyHint:     $("empty-hint"),
    rowTpl:        $("site-row-template"),
    dataStatus:    $("data-status"),
    categoryList:  $("categories-list"),
    tabs:          $("category-tabs"),
    newCatBtn:     $("new-cat-btn"),
    newCatForm:    $("new-cat-form"),
    newCatInput:   $("new-cat-input"),
    newCatCancel:  $("new-cat-cancel"),
    addCard:       $("add-card"),
    addSiteBtn:    $("add-site-btn"),
    addCancel:     $("add-cancel"),
    sectionTpl:    $("category-section-template"),
    // Edit modal
    editModal:     $("edit-modal"),
    editTitle:     $("editor-title"),
    editName:      $("edit-name"),
    editCategory:  $("edit-category"),
    editUnique:    $("edit-unique"),
    editLength:    $("edit-length"),
    editUsername:  $("edit-username"),
    editSiteUrl:   $("edit-siteurl"),
    editNote:      $("edit-note"),
    editError:     $("edit-error"),
    editHistMenu:  $("edit-history-menu"),
    editFooterMain:    $("edit-footer-main"),
    editFooterConfirm: $("edit-footer-confirm"),
    editConfirmMsg:    $("edit-confirm-msg"),
    editConfirmYes:    $("edit-confirm-yes"),
  };

  let editingIndex = null; // index in `sites` currently being edited, or null
  let pendingConfirm = null; // 'save' | 'delete' | null

  const ALL_TAB = "__all__";
  let sites = [];
  let activeTab = ALL_TAB;
  const pendingCategories = new Set(); // categories added via UI but no sites yet

  // ---- Rendering ----------------------------------------------------------

  function categoriesFromSites() {
    const set = new Set();
    for (const s of sites) set.add(s.category || "Uncategorized");
    return set;
  }

  function uniqueCategories() {
    const set = categoriesFromSites();
    for (const c of pendingCategories) set.add(c);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function refreshCategoryList() {
    if (!els.categoryList) return;
    els.categoryList.innerHTML = "";
    for (const c of uniqueCategories()) {
      const opt = document.createElement("option");
      opt.value = c;
      els.categoryList.appendChild(opt);
    }
  }

  function currentCategory() {
    return activeTab === ALL_TAB ? "" : activeTab;
  }

  function renderTabs() {
    els.tabs.innerHTML = "";

    const makeTab = (label, value, count, options = {}) => {
      const wrap = document.createElement("span");
      wrap.className = "tab-wrap" + (activeTab === value ? " active" : "");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tab" + (activeTab === value ? " active" : "");
      btn.dataset.cat = value;
      btn.innerHTML = count == null
        ? label
        : `${label} <span class="tab-count">${count}</span>`;
      btn.addEventListener("click", () => setActiveTab(value));
      wrap.appendChild(btn);

      if (options.deletable) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "tab-del";
        del.title = `Delete category "${label}"`;
        del.setAttribute("aria-label", `Delete category ${label}`);
        del.textContent = "×";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          onDeleteCategory(value);
        });
        wrap.appendChild(del);
      }

      return wrap;
    };

    els.tabs.appendChild(makeTab("All", ALL_TAB, sites.length));

    // Count sites per category (from sites only; pending is 0 by definition).
    const counts = new Map();
    for (const s of sites) {
      const c = s.category || "Uncategorized";
      counts.set(c, (counts.get(c) || 0) + 1);
    }

    for (const cat of uniqueCategories()) {
      // Uncategorized is always deletable in UI too, but treated as a no-op fallback.
      const deletable = cat !== "Uncategorized";
      els.tabs.appendChild(makeTab(cat, cat, counts.get(cat) || 0, { deletable }));
    }
  }

  async function onDeleteCategory(cat) {
    if (cat === ALL_TAB || cat === "Uncategorized") return;

    const affected = sites.filter((s) => (s.category || "Uncategorized") === cat);
    const isPending = pendingCategories.has(cat);

    if (affected.length === 0) {
      // Empty category (pending or otherwise) — just drop it.
      if (isPending) pendingCategories.delete(cat);
      if (activeTab === cat) activeTab = ALL_TAB;
      syncAddForm();
      render();
      return;
  }

    const msg =
      `Delete category "${cat}"?\n\n` +
      `${affected.length} site(s) will be moved to "Uncategorized". ` +
      `The site entries themselves are kept.`;
    if (!confirm(msg)) return;

    const nowIso = new Date().toISOString();
    const next = sites.map((s) =>
      (s.category || "Uncategorized") === cat
        ? { ...s, category: "Uncategorized", lastModifiedAt: nowIso }
        : s
    );
    const ok = await persist(next);
    if (!ok) {
      reportStatus("Failed to delete category — API save failed.", "error");
      return;
    }
    pendingCategories.delete(cat);
    if (activeTab === cat) activeTab = ALL_TAB;
    syncAddForm();
    render();
    reportStatus(`Category "${cat}" deleted. ${affected.length} site(s) moved to "Uncategorized".`, "ok");
  }

  function setActiveTab(cat) {
    // Discard a pending category if the user leaves it without adding a site.
    if (activeTab !== ALL_TAB && activeTab !== cat) {
      const hasSites = sites.some((s) => (s.category || "Uncategorized") === activeTab);
      if (!hasSites) pendingCategories.delete(activeTab);
    }
    activeTab = cat;
    syncAddForm();
    render();
  }

  function syncAddForm() {
    const heading = activeTab === ALL_TAB
      ? "Add a new site"
      : `Add a new site to “${activeTab}”`;
    els.addHeading.textContent = heading;
    // Pre-fill category to the active tab (empty on "All").
    els.addCategory.value = currentCategory();
  }

  function populateCategorySelect(select, currentValue) {
    select.innerHTML = "";
    const cats = new Set(uniqueCategories());
    cats.add("Uncategorized");
    if (currentValue) cats.add(currentValue);

    for (const cat of Array.from(cats).sort((a, b) => a.localeCompare(b))) {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      select.appendChild(opt);
    }

    const sep = document.createElement("option");
    sep.disabled = true;
    sep.textContent = "────────";
    select.appendChild(sep);

    const newOpt = document.createElement("option");
    newOpt.value = "__NEW__";
    newOpt.textContent = "+ New category…";
    select.appendChild(newOpt);

    select.value = currentValue || "Uncategorized";
  }

  function buildSiteRow(site, index) {
    const tr = els.rowTpl.content.firstElementChild.cloneNode(true);
    tr.querySelector(".site-name-cell").textContent = site.name;
    if (site.note) {
      tr.querySelector(".site-name-cell").title = site.note; // hover to preview note
    }
    const urlCell = tr.querySelector(".site-url-cell");
    if (site.siteUrl) {
      const a = document.createElement("a");
      a.href = site.siteUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "↗";
      a.title = site.siteUrl;
      a.className = "site-url-link";
      urlCell.appendChild(a);
    }
    const modCell = tr.querySelector(".site-modified");
    if (site.lastModifiedAt) {
      modCell.textContent = formatHistoryTime(site.lastModifiedAt);
      modCell.title = new Date(site.lastModifiedAt).toLocaleString();
    } else {
      modCell.textContent = "—";
      modCell.title = "Never modified since this record was created";
    }
    tr.querySelector('[data-action="edit"]').addEventListener("click", () =>
      openEditor(index)
    );
    return tr;
  }

  function render() {
    renderTabs();
    refreshCategoryList();
    els.siteList.innerHTML = "";

    // Filter sites for the active tab, preserving original index for edit lookup.
    const filtered = sites
      .map((s, i) => ({ site: s, index: i }))
      .filter(({ site }) => {
        if (activeTab === ALL_TAB) return true;
        return (site.category || "Uncategorized") === activeTab;
      });

    els.siteCount.textContent = String(filtered.length);
    els.listHeading.firstChild.textContent =
      activeTab === ALL_TAB
        ? `All sites (`
        : `“${activeTab}” sites (`;

    els.emptyHint.hidden = filtered.length > 0;
    if (filtered.length === 0) return;

    // Group by category. When a specific tab is active, there's just one group.
    const groups = new Map();
    for (const entry of filtered) {
      const cat = entry.site.category || "Uncategorized";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(entry);
    }

    const orderedCats = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
    for (const cat of orderedCats) {
      const section = els.sectionTpl.content.firstElementChild.cloneNode(true);
      section.querySelector(".category-section-title").textContent = cat;
      const rowsForCat = groups.get(cat).slice().sort((a, b) =>
        a.site.name.localeCompare(b.site.name)
      );
      section.querySelector(".category-section-count").textContent =
        `${rowsForCat.length} site${rowsForCat.length === 1 ? "" : "s"}`;
      const tbody = section.querySelector("tbody");
      for (const { site, index } of rowsForCat) {
        tbody.appendChild(buildSiteRow(site, index));
      }
      els.siteList.appendChild(section);
    }
  }

  // ---- Editor modal -------------------------------------------------------

  function openEditor(index) {
    const site = sites[index];
    if (!site) return;
    editingIndex = index;
    hideEditError();
    els.editHistMenu.hidden = true;

    els.editTitle.textContent = `Edit “${site.name}”`;
    els.editName.value = site.name;
    els.editUnique.value = site.unique;
    els.editLength.value = site.length;
    els.editUsername.value = site.username || "";
    els.editSiteUrl.value = site.siteUrl || "";
    els.editNote.value = site.note || "";
    for (const k of window.PMStore.CLASS_KEYS) {
      els.editModal.querySelector(`[data-edit-cls="${k}"]`).checked = Boolean(site.classes[k]);
    }
    populateCategorySelect(els.editCategory, site.category || "Uncategorized");
    els.editCategory.dataset.prev = els.editCategory.value;

    renderHistoryMenu(els.editHistMenu, site, index);

    els.editModal.hidden = false;
    document.body.classList.add("modal-open");
    setTimeout(() => els.editName.focus(), 40);
  }

  function closeEditor() {
    hideConfirmFooter();
    els.editModal.hidden = true;
    els.editHistMenu.hidden = true;
    document.body.classList.remove("modal-open");
    editingIndex = null;
    hideEditError();
  }

  function readEditor() {
    const classes = {};
    for (const k of window.PMStore.CLASS_KEYS) {
      classes[k] = els.editModal.querySelector(`[data-edit-cls="${k}"]`).checked;
    }
    return {
      name:     els.editName.value,
      category: els.editCategory.value,
      unique:   els.editUnique.value,
      length:   els.editLength.value,
      username: els.editUsername.value,
      siteUrl:  els.editSiteUrl.value,
      note:     els.editNote.value,
      classes,
    };
  }

  function showEditError(msg) {
    els.editError.textContent = msg;
    els.editError.hidden = false;
  }
  function hideEditError() {
    els.editError.textContent = "";
    els.editError.hidden = true;
  }

  function onEditorCategoryChange() {
    if (els.editCategory.value !== "__NEW__") {
      els.editCategory.dataset.prev = els.editCategory.value;
      return;
    }
    const name = (prompt("New category name:") || "").trim();
    if (!name) {
      els.editCategory.value = els.editCategory.dataset.prev || "Uncategorized";
      return;
    }
    const existing = uniqueCategories().find(
      (c) => c.toLowerCase() === name.toLowerCase()
    );
    const finalName = existing || name;
    if (!existing) pendingCategories.add(finalName);
    populateCategorySelect(els.editCategory, finalName);
    els.editCategory.dataset.prev = finalName;
    refreshCategoryList();
  }

  function readRow_UNUSED() { /* replaced by readEditor */ }

  function setRowStatus_UNUSED() { /* row inline status removed — modal shows errors, top status shows successes */ }

  // ---- Actions ------------------------------------------------------------

  async function persist(newSites) {
    try {
      const saved = await window.PMStore.save(newSites);
      sites = saved;
      reportStatus("Saved to API.", "ok");
      return true;
    } catch (err) {
      reportStatus(`Save failed: ${err.message}`, "error");
      return false;
    }
  }

  function reportStatus(msg, kind) {
    const el = els.dataStatus;
    if (!el) return;
    el.textContent = msg || "";
    el.className = `data-status ${kind || ""}`;
    if (kind === "ok") {
      setTimeout(() => {
        if (el.textContent === msg) {
          el.textContent = "";
          el.className = "data-status";
        }
      }, 2000);
    }
  }

  function showConfirmFooter(msg, yesLabel, yesKind) {
    els.editConfirmMsg.textContent = msg;
    els.editConfirmYes.textContent = yesLabel;
    els.editConfirmYes.className = yesKind; // "primary" or "danger"
    els.editFooterMain.hidden = true;
    els.editFooterConfirm.hidden = false;
    els.editConfirmYes.focus();
  }

  function hideConfirmFooter() {
    els.editFooterConfirm.hidden = true;
    els.editFooterMain.hidden = false;
    pendingConfirm = null;
  }

  // Read + normalize + validate the editor. Returns the normalized payload,
  // or null after showing an inline error.
  function validateEditorPayload() {
    if (editingIndex == null) return null;
    hideEditError();
    const raw = readEditor();
    const current = sites[editingIndex];
    if (current && Array.isArray(current.history)) raw.history = current.history;
    if (current && current.uniqueCreatedAt) raw.uniqueCreatedAt = current.uniqueCreatedAt;

    const normalized = window.PMStore.normalize(raw);
    if (!normalized) {
      showEditError("Name and unique string are required.");
      return null;
    }
    if (!normalized.username) {
      showEditError("Username is required.");
      return null;
    }
    if (!normalized.siteUrl) {
      showEditError("Site URL is required.");
      return null;
    }
    if (Object.values(normalized.classes).every((v) => !v)) {
      showEditError("Enable at least one character class.");
      return null;
    }
    if (normalized.length < 8 || normalized.length > 32) {
      showEditError("Password length must be between 8 and 32.");
      return null;
    }
    if (isDuplicateName(normalized.name, editingIndex)) {
      showEditError("Another site already has this name.");
      return null;
    }
    return normalized;
  }

  function onEditorSaveRequest() {
    const validated = validateEditorPayload();
    if (!validated) return;
    pendingConfirm = "save";
    showConfirmFooter(`Save changes to “${validated.name}”?`, "Save", "primary");
  }

  function onEditorDeleteRequest() {
    if (editingIndex == null) return;
    const site = sites[editingIndex];
    if (!site) return;
    pendingConfirm = "delete";
    showConfirmFooter(
      `Delete “${site.name}”? This only affects site config, not any real account.`,
      "Delete",
      "danger"
    );
  }

  async function onEditorConfirmYes() {
    if (pendingConfirm === "save")   { hideConfirmFooter(); await doEditorSave();   return; }
    if (pendingConfirm === "delete") { hideConfirmFooter(); await doEditorDelete(); return; }
  }

  async function doEditorSave() {
    const normalized = validateEditorPayload();
    if (!normalized) return; // fields changed during confirm and are now invalid
    normalized.lastModifiedAt = new Date().toISOString();
    const prev = sites[editingIndex];
    const next = sites.slice();
    next[editingIndex] = normalized;
    const ok = await persist(next);
    if (!ok) {
      showEditError("API save failed — try again.");
      return;
    }
    if ((prev && prev.category) !== normalized.category) {
      pendingCategories.delete(normalized.category);
      reportStatus(`Moved “${normalized.name}” to “${normalized.category}”.`, "ok");
    } else {
      reportStatus(`Saved “${normalized.name}”.`, "ok");
    }
    closeEditor();
    render();
  }

  async function doEditorDelete() {
    if (editingIndex == null) return;
    const site = sites[editingIndex];
    if (!site) return;
    const next = sites.slice();
    next.splice(editingIndex, 1);
    const ok = await persist(next);
    if (!ok) {
      showEditError("Delete failed — API error.");
      return;
    }
    reportStatus(`Deleted “${site.name}”.`, "ok");
    closeEditor();
    render();
  }

  // ---- Unique-string regenerate + history ---------------------------------

  // 16 chars from an unambiguous alphanumeric set (~82 bits entropy).
  function generateUnique() {
    const CHARSET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/O/1/l/i for readability
    const LEN = 16;
    const buf = new Uint32Array(LEN);
    crypto.getRandomValues(buf);
    let out = "";
    for (let i = 0; i < LEN; i++) out += CHARSET[buf[i] % CHARSET.length];
    return out;
  }

  // Push a snapshot of the previous key into history.
  // `oldEntry` is { value, createdAt } representing the previous key's birthday.
  function pushHistory(currentHistory, oldEntry, newUnique) {
    const HIST_MAX = 5;
    const list = Array.isArray(currentHistory) ? currentHistory.slice() : [];
    // Remove any entry matching the new current value (it shouldn't live in history).
    const cleaned = list.filter((h) => (h && h.value) !== newUnique);
    if (oldEntry && oldEntry.value && oldEntry.value !== newUnique) {
      // Drop older duplicates of oldEntry.value, then push it to the head.
      const deduped = cleaned.filter((h) => (h && h.value) !== oldEntry.value);
      deduped.unshift({
        value: oldEntry.value,
        createdAt: oldEntry.createdAt || null,
      });
      return deduped.slice(0, HIST_MAX);
    }
    return cleaned.slice(0, HIST_MAX);
  }

  async function onRegenUnique(index) {
    const site = sites[index];
    if (!site) return;
    const newUnique = generateUnique();
    const nowIso = new Date().toISOString();
    const oldEntry = { value: site.unique, createdAt: site.uniqueCreatedAt || null };
    const updated = {
      ...site,
      unique: newUnique,
      uniqueCreatedAt: nowIso,
      lastModifiedAt: nowIso,
      history: pushHistory(site.history, oldEntry, newUnique),
    };
    const next = sites.slice();
    next[index] = updated;
    const ok = await persist(next);
    if (!ok) {
      showEditError("Regenerate failed — API error.");
      return;
    }
    reportStatus(`New unique key generated for “${site.name}”.`, "ok");
    // If the editor is showing this site, refresh its unique field and history menu.
    if (editingIndex === index) {
      els.editUnique.value = newUnique;
      renderHistoryMenu(els.editHistMenu, sites[index], index);
    }
  }

  // entry = { value, createdAt } picked from site.history
  async function onRestoreUnique(index, entry) {
    const site = sites[index];
    if (!site || !entry) return;
    if (!confirm(
      `Restore previous unique key for "${site.name}"?\n\n` +
      `Current key will be pushed into history. All passwords derived with the current key will change.`
    )) return;
    const oldEntry = { value: site.unique, createdAt: site.uniqueCreatedAt || null };
    const updated = {
      ...site,
      unique: entry.value,
      uniqueCreatedAt: entry.createdAt || null,
      lastModifiedAt: new Date().toISOString(),
      history: pushHistory(site.history, oldEntry, entry.value).filter(
        (h) => (h && h.value) !== entry.value
      ),
    };
    const next = sites.slice();
    next[index] = updated;
    const ok = await persist(next);
    if (!ok) {
      reportStatus("Restore failed — API save error.", "error");
      return;
    }
    render();
    reportStatus(`Restored a previous unique key for “${site.name}”.`, "ok");
    // Refresh editor UI if it's showing this site.
    if (editingIndex === index) {
      els.editUnique.value = entry.value;
      renderHistoryMenu(els.editHistMenu, sites[index], index);
    }
  }

  function formatHistoryTime(iso) {
    if (!iso) return "unknown time";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "unknown time";
    const now = new Date();
    const diffSec = Math.max(0, Math.round((now - d) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
    return d.toLocaleString();
  }

  function renderHistoryMenu(container, site, index) {
    container.innerHTML = "";
    const hist = Array.isArray(site.history) ? site.history : [];

    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = `Previous unique keys (${hist.length}/5)`;
    container.appendChild(title);

    if (hist.length === 0) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "No history yet. Click ↻ to generate a new key — the current one will be saved here.";
      container.appendChild(empty);
      return;
    }

    for (const entry of hist) {
      const item = document.createElement("div");
      item.className = "history-item";

      const info = document.createElement("div");
      info.className = "history-info";

      const code = document.createElement("code");
      code.textContent = entry.value;
      info.appendChild(code);

      const when = document.createElement("span");
      when.className = "history-time";
      when.textContent = formatHistoryTime(entry.createdAt);
      if (entry.createdAt) when.title = new Date(entry.createdAt).toLocaleString();
      info.appendChild(when);

      item.appendChild(info);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-restore";
      btn.textContent = "Restore";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        container.hidden = true;
        onRestoreUnique(index, entry);
      });
      item.appendChild(btn);
      container.appendChild(item);
    }
  }

  async function onAdd(e) {
    e.preventDefault();
    hideAddError();

    const classes = {};
    for (const k of window.PMStore.CLASS_KEYS) {
      classes[k] = els.addForm.querySelector(`[data-cls="${k}"]`).checked;
    }

    const raw = {
      name:     els.addName.value,
      category: els.addCategory.value,
      unique:   els.addUnique.value,
      length:   els.addLength.value,
      username: els.addUsername.value,
      siteUrl:  els.addSiteUrl.value,
      note:     els.addNote.value,
      classes,
    };
    const normalized = window.PMStore.normalize(raw);
    if (!normalized) {
      showAddError("Name and unique string are required.");
      return;
    }
    if (!normalized.username) {
      showAddError("Username is required.");
      return;
    }
    if (!normalized.siteUrl) {
      showAddError("Site URL is required.");
      return;
    }
    if (Object.values(normalized.classes).every((v) => !v)) {
      showAddError("Enable at least one character class.");
      return;
    }
    if (normalized.length < 8 || normalized.length > 32) {
      showAddError("Password length must be between 8 and 32.");
      return;
    }
    if (isDuplicateName(normalized.name, -1)) {
      showAddError("A site with this name already exists.");
      return;
    }
    const nowIso = new Date().toISOString();
    normalized.lastModifiedAt = nowIso;
    if (!normalized.uniqueCreatedAt) normalized.uniqueCreatedAt = nowIso;

    const next = sites.concat(normalized);
    const ok = await persist(next);
    if (ok) {
      // If the new site's category was a pending one, promote it (drop from pending).
      pendingCategories.delete(normalized.category);
      // Switch to that category's tab so the user sees the new site.
      activeTab = normalized.category;
      syncAddForm();
      render();
      resetAddForm();
      hideAddCard();
    } else {
      showAddError("API save failed — try again.");
    }
  }

  // ---- Helpers ------------------------------------------------------------

  function isDuplicateName(name, excludeIndex) {
    const target = name.toLowerCase();
    return sites.some((s, i) => i !== excludeIndex && s.name.toLowerCase() === target);
  }

  function showAddError(msg) {
    els.addError.textContent = msg;
    els.addError.hidden = false;
  }
  function hideAddError() {
    els.addError.textContent = "";
    els.addError.hidden = true;
  }
  function resetAddForm() {
    els.addName.value = "";
    els.addUnique.value = generateUnique();
    els.addLength.value = "20";
    els.addUsername.value = "";
    els.addSiteUrl.value = "";
    els.addNote.value = "";
    els.addCategory.value = currentCategory(); // keep sync with active tab
    for (const k of window.PMStore.CLASS_KEYS) {
      els.addForm.querySelector(`[data-cls="${k}"]`).checked = true;
    }
    els.addName.focus();
  }

  // ---- Add-site card visibility -------------------------------------------

  function showAddCard() {
    els.addCard.hidden = false;
    els.addSiteBtn.textContent = "− Close Add Form";
    els.addSiteBtn.classList.remove("primary");
    syncAddForm();
    // Pre-fill unique if empty (first open or after a reset).
    if (!els.addUnique.value) els.addUnique.value = generateUnique();
    // Always reset length to default on open.
    els.addLength.value = "20";
    // Focus name for quick entry; scroll into view for narrow windows.
    els.addCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => els.addName.focus(), 60);
  }

  function hideAddCard() {
    els.addCard.hidden = true;
    els.addSiteBtn.textContent = "+ Add Site";
    els.addSiteBtn.classList.add("primary");
    hideAddError();
  }

  function toggleAddCard() {
    if (els.addCard.hidden) showAddCard();
    else hideAddCard();
  }

  // ---- New category flow --------------------------------------------------

  function showNewCatForm() {
    els.newCatBtn.hidden = true;
    els.newCatForm.hidden = false;
    els.newCatInput.value = "";
    els.newCatInput.focus();
  }

  function hideNewCatForm() {
    els.newCatForm.hidden = true;
    els.newCatBtn.hidden = false;
    els.newCatInput.value = "";
  }

  function onNewCatSubmit(e) {
    e.preventDefault();
    const name = els.newCatInput.value.trim();
    if (!name) {
      els.newCatInput.focus();
      return;
    }
    // Case-insensitive de-dup against existing categories.
    const existing = uniqueCategories().find(
      (c) => c.toLowerCase() === name.toLowerCase()
    );
    const finalName = existing || name;
    if (!existing) pendingCategories.add(finalName);
    hideNewCatForm();
    activeTab = finalName;
    syncAddForm();
    render();
    // Open the add-site form pre-filled with the new category.
    showAddCard();
  }

  // ---- Session lifecycle --------------------------------------------------

  async function unlock() {
    const pwd = els.master.value;
    if (!pwd) { showUnlockError("Master password is required."); return; }
    hideUnlockError();
    setUnlockBusy(true, "Deriving key (Argon2id, this takes a moment)…");
    try {
      // Derive the API Bearer token from the master password (fast, PBKDF2)
      // and register it so all subsequent API calls are authenticated.
      const apiToken = await window.PMDerive.deriveApiToken(pwd);
      window.PMStore.setApiToken(apiToken);

      let meta;
      try {
        meta = await window.PMStore.loadMeta();
      } catch (err) {
        setUnlockBusy(false);
        const msg = /403/.test(err.message)
          ? "Wrong master password."
          : `Cannot reach API: ${err.message}`;
        showUnlockError(msg);
        return;
      }
      let bannerKind, bannerMsg, derivedKey;
      if (!meta) {
        const { masterKey: K, meta: newMeta } = await window.PMDerive.createVerifier(pwd);
        try {
          await window.PMStore.saveMeta(newMeta);
        } catch (err) {
          setUnlockBusy(false);
          showUnlockError(`Could not save vault meta: ${err.message}`);
          return;
        }
        derivedKey = K;
        bannerKind = "first";
        bannerMsg  = "Master password set. This becomes your permanent master — remember it.";
      } else {
        const result = await window.PMDerive.verifyMaster(pwd, meta);
        if (!result.ok) {
          setUnlockBusy(false);
          showUnlockError("Wrong master password.");
          return;
        }
        derivedKey = result.masterKey;
        bannerKind = "ok";
        bannerMsg  = "Master password verified.";
      }
      els.master.value = "";
      masterKey = derivedKey;
      expiresAt = Date.now() + SESSION_MS;
      setUnlockBusy(false);
      els.unlockSection.hidden = true;
      els.manageSection.hidden = false;
      els.sessionBar.hidden = false;
      showBanner(bannerKind, bannerMsg);
      attachActivityListeners();
      scheduleExpiry();
      startCountdown();
      await loadAndRender();
    } catch (err) {
      setUnlockBusy(false);
      showUnlockError(err.message || "Unlock failed.");
    }
  }

  function lock(reason) {
    detachActivityListeners();
    if (masterKey && masterKey.fill) { try { masterKey.fill(0); } catch (_) {} }
    masterKey = null;
    expiresAt = 0;
    if (expireTimer) { clearTimeout(expireTimer); expireTimer = null; }
    if (tickTimer)   { clearInterval(tickTimer);  tickTimer   = null; }
    hideBanner();
    els.manageSection.hidden = true;
    els.sessionBar.hidden = true;
    els.unlockSection.hidden = false;
    els.master.value = "";
    els.master.focus();
    if (reason) showUnlockError(reason);
  }

  const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"];

  function onActivity() {
    if (!masterKey) return;
    expiresAt = Date.now() + SESSION_MS;
    scheduleExpiry();
  }

  function attachActivityListeners() {
    for (const evt of ACTIVITY_EVENTS) {
      document.addEventListener(evt, onActivity, { passive: true });
    }
  }

  function detachActivityListeners() {
    for (const evt of ACTIVITY_EVENTS) {
      document.removeEventListener(evt, onActivity);
    }
  }

  function scheduleExpiry() {
    if (expireTimer) clearTimeout(expireTimer);
    expireTimer = setTimeout(() => lock("Session expired due to inactivity."), SESSION_MS);
  }

  function startCountdown() {
    if (tickTimer) clearInterval(tickTimer);
    renderCountdown();
    tickTimer = setInterval(renderCountdown, 500);
  }

  function renderCountdown() {
    const remaining = Math.max(0, expiresAt - Date.now());
    const total = Math.ceil(remaining / 1000);
    const mm = String(Math.floor(total / 60)).padStart(2, "0");
    const ss = String(total % 60).padStart(2, "0");
    els.countdown.textContent = `${mm}:${ss}`;
  }

  function setUnlockBusy(busy, msg) {
    els.unlockBtn.disabled = busy;
    els.master.disabled    = busy;
    if (els.unlockStatus) {
      els.unlockStatus.textContent = busy ? (msg || "Working…") : "";
      els.unlockStatus.hidden      = !busy;
    }
  }

  function showBanner(kind, msg) {
    if (!els.verifyBanner) return;
    els.verifyBanner.textContent = msg;
    els.verifyBanner.className = `verify-banner ${kind}`;
    els.verifyBanner.hidden = false;
  }
  function hideBanner() {
    if (!els.verifyBanner) return;
    els.verifyBanner.hidden = true;
    els.verifyBanner.textContent = "";
    els.verifyBanner.className = "verify-banner";
  }

  function showUnlockError(msg) {
    els.unlockError.textContent = msg;
    els.unlockError.hidden = false;
  }
  function hideUnlockError() {
    els.unlockError.textContent = "";
    els.unlockError.hidden = true;
  }

  // ---- Init ---------------------------------------------------------------

  async function loadAndRender() {
    try {
      const result = await window.PMStore.load();
      sites = result.sites;
      if (result.source === "cache") {
        reportStatus(`Offline — showing cached list (${result.error || "API unreachable"})`, "warn");
      } else if (result.source === "empty") {
        reportStatus(`API unreachable and no cache — list is empty. Start the mock API.`, "warn");
      }
    } catch (err) {
      sites = [];
      reportStatus(err.message || "Failed to load.", "error");
    }
    syncAddForm();
    render();
  }

  async function init() {
    els.unlockBtn.addEventListener("click", unlock);
    els.master.addEventListener("keydown", (e) => {
      if (e.key === "Enter") unlock();
    });

    const clearMasterBtn = document.getElementById("clear-master-btn");
    if (clearMasterBtn) {
      clearMasterBtn.addEventListener("click", () => {
        els.master.value = "";
        hideUnlockError();
        els.master.focus();
      });
    }

    els.lockBtn.addEventListener("click", () => lock());
    els.addForm.addEventListener("submit", onAdd);
    els.addSiteBtn.addEventListener("click", toggleAddCard);
    els.addCancel.addEventListener("click", hideAddCard);
    els.newCatBtn.addEventListener("click", showNewCatForm);
    els.newCatForm.addEventListener("submit", onNewCatSubmit);
    els.newCatCancel.addEventListener("click", hideNewCatForm);
    els.newCatInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideNewCatForm();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!els.editModal.hidden) {
        if (!els.editFooterConfirm.hidden) { hideConfirmFooter(); return; }
        closeEditor();
        return;
      }
      if (!els.addCard.hidden) { hideAddCard(); return; }
    });

    // ---- Edit modal wiring ----
    els.editModal.addEventListener("click", (e) => {
      const action = e.target.closest("[data-action]")?.dataset.action;
      if (!action) return;
      if (action === "close" || action === "cancel") { closeEditor(); return; }
      if (action === "save")   { onEditorSaveRequest();   return; }
      if (action === "delete") { onEditorDeleteRequest(); return; }
      if (action === "confirm-yes") { onEditorConfirmYes(); return; }
      if (action === "confirm-no")  { hideConfirmFooter();  return; }
      if (action === "edit-regen") {
        if (editingIndex != null) onRegenUnique(editingIndex);
        return;
      }
      if (action === "edit-history") {
        e.stopPropagation();
        els.editHistMenu.hidden = !els.editHistMenu.hidden;
        return;
      }
    });
    els.editCategory.addEventListener("change", onEditorCategoryChange);

    // Close any open history menu when clicking outside a .unique-cell.
    document.addEventListener("click", (e) => {
      const inCell = e.target.closest(".unique-cell");
      document.querySelectorAll(".history-menu:not([hidden])").forEach((menu) => {
        if (!inCell || !inCell.contains(menu)) menu.hidden = true;
      });
    });

    // Keep this tab in sync if another tab edits storage (only while unlocked).
    window.addEventListener("storage", async (e) => {
      if (!masterKey) return;
      if (e.key === "pmanager.sites.cache.v1") {
        const result = await window.PMStore.load();
        sites = result.sites;
        render();
      }
    });

    window.addEventListener("beforeunload", () => lock());
  }

  document.addEventListener("DOMContentLoaded", init);
})();
