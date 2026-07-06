(() => {
  "use strict";

  const SESSION_MS = 1 * 60 * 1000; // 1 minute

  // In-memory only. Never persisted.
  //   masterKey: raw 32-byte Argon2id-derived key. Wiped on lock.
  //   The master password itself is never retained beyond the unlock call.
  let masterKey = null;
  let expiresAt = 0;
  let expireTimer = null;
  let tickTimer = null;
  let sites = [];

  const $ = (id) => document.getElementById(id);

  const els = {
    unlockSection: $("unlock-section"),
    vaultSection:  $("vault-section"),
    master:        $("master"),
    unlockBtn:     $("unlock-btn"),
    unlockError:   $("unlock-error"),
    unlockStatus:  $("unlock-status"),
    countdown:     $("countdown"),
    lockBtn:       $("lock-btn"),
    verifyBanner:  $("verify-banner"),
    categorySelect:$("category-select"),
    siteSelect:    $("site-select"),
    generateBtn:   $("generate-btn"),
    outputBlock:   $("output-block"),
    generated:     $("generated"),
    toggleGen:     $("toggle-generated"),
    copyBtn:       $("copy-btn"),
    copyStatus:    $("copy-status"),
    usernameBlock: $("username-block"),
    usernameVal:   $("username-val"),
    copyUsernameBtn: $("copy-username-btn"),
    copyUsernameStatus: $("copy-username-status"),
    openSiteRow:   $("open-site-row"),
    openSiteBtn:   $("open-site-btn"),
    dataStatus:    $("data-status"),
    siteNote:      $("site-note"),
    uniqueCreated: $("unique-created"),
  };

  // ---- Site list ----------------------------------------------------------

  async function loadSites() {
    try {
      const result = await window.PMStore.load();
      sites = result.sites;
      reportSource(result.source, result.error);
    } catch (err) {
      sites = [];
      reportSource("error", err.message);
    }
  }

  function reportSource(source, errMsg) {
    const el = els.dataStatus;
    if (!el) return;
    if (source === "api") {
      el.textContent = "";
      el.className = "data-status ok";
    } else if (source === "cache") {
      el.textContent = `Offline — showing cached sites (${errMsg || "API unreachable"})`;
      el.className = "data-status warn";
    } else if (source === "empty") {
      el.textContent = `API unreachable and no cache — no sites available (${errMsg || ""})`;
      el.className = "data-status warn";
    } else {
      el.textContent = errMsg || "Failed to load sites.";
      el.className = "data-status error";
    }
  }

  const ALL_CATEGORIES = "__all__";

  function uniqueCategories() {
    const set = new Set();
    for (const s of sites) set.add(s.category || "Uncategorized");
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function populateCategories() {
    const previous = els.categorySelect.value;
    els.categorySelect.innerHTML = "";

    const optAll = document.createElement("option");
    optAll.value = ALL_CATEGORIES;
    optAll.textContent = "All categories";
    els.categorySelect.appendChild(optAll);

    for (const cat of uniqueCategories()) {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      els.categorySelect.appendChild(opt);
    }

    // Preserve prior selection if still valid.
    const values = Array.from(els.categorySelect.options).map((o) => o.value);
    els.categorySelect.value = values.includes(previous) ? previous : ALL_CATEGORIES;
  }

  function filteredSites() {
    const cat = els.categorySelect.value;
    if (!cat || cat === ALL_CATEGORIES) return sites.slice();
    return sites.filter((s) => (s.category || "Uncategorized") === cat);
  }

  function populateSites() {
    const previous = els.siteSelect.value;
    els.siteSelect.innerHTML = "";
    const list = filteredSites().sort((a, b) => a.name.localeCompare(b.name));

    if (list.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = sites.length === 0
        ? "(no sites — add some in Manage)"
        : "(no sites in this category)";
      opt.disabled = true;
      els.siteSelect.appendChild(opt);
      els.generateBtn.disabled = true;
      updateSiteNote();
      return;
    }
    els.generateBtn.disabled = false;
    for (const s of list) {
      const opt = document.createElement("option");
      opt.value = s.name;
      opt.textContent = s.name;
      els.siteSelect.appendChild(opt);
    }
    if (previous && list.some((s) => s.name === previous)) {
      els.siteSelect.value = previous;
    }
    updateSiteNote();
  }

  function updateSiteNote() {
    const name = els.siteSelect.value;
    const site = sites.find((s) => s.name === name);
    const note = site && site.note ? String(site.note).trim() : "";
    if (!note) {
      els.siteNote.hidden = true;
      els.siteNote.textContent = "";
      return;
    }
    els.siteNote.hidden = false;
    els.siteNote.textContent = note;
  }

  function refreshLists() {
    populateCategories();
    populateSites();
  }

  // ---- Session lifecycle --------------------------------------------------

  async function unlock() {
    const pwd = els.master.value;
    if (!pwd) {
      showUnlockError("Master password is required.");
      return;
    }
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

      let bannerKind, bannerMsg;
      let derivedKey;

      if (!meta) {
        // First-ever unlock on this vault: mint a verifier from this password.
        const { masterKey: K, meta: newMeta } =
          await window.PMDerive.createVerifier(pwd);
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

      // Wipe the input immediately.
      els.master.value = "";

      masterKey = derivedKey;
      expiresAt = Date.now() + SESSION_MS;

      setUnlockBusy(false);
      els.unlockSection.hidden = true;
      els.vaultSection.hidden = false;
      showBanner(bannerKind, bannerMsg);

      scheduleExpiry();
      startCountdown();

      // Reload sites now that the API token is set (the init() call happened
      // before unlock, so had no auth token and got 403).
      await loadSites();
      refreshLists();
    } catch (err) {
      setUnlockBusy(false);
      showUnlockError(err.message || "Unlock failed.");
    }
  }

  function lock(reason) {
    // Zero out the master key bytes before dropping the reference.
    if (masterKey && masterKey.fill) {
      try { masterKey.fill(0); } catch (_) {}
    }
    masterKey = null;
    expiresAt = 0;

    if (expireTimer) { clearTimeout(expireTimer); expireTimer = null; }
    if (tickTimer)   { clearInterval(tickTimer);  tickTimer   = null; }

    els.generated.value = "";
    els.generated.type = "password";
    els.outputBlock.hidden = true;
    els.copyStatus.textContent = "";
    if (els.usernameBlock) { els.usernameBlock.hidden = true; els.usernameVal.value = ""; }
    if (els.openSiteRow) els.openSiteRow.hidden = true;
    if (els.uniqueCreated) els.uniqueCreated.textContent = "";
    hideBanner();

    els.vaultSection.hidden = true;
    els.unlockSection.hidden = false;
    els.master.value = "";
    els.master.focus();

    if (reason) {
      showUnlockError(reason);
    }
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

  function scheduleExpiry() {
    if (expireTimer) clearTimeout(expireTimer);
    expireTimer = setTimeout(() => lock("Session expired. Please unlock again."),
      SESSION_MS);
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

  function showUnlockError(msg) {
    els.unlockError.textContent = msg;
    els.unlockError.hidden = false;
  }
  function hideUnlockError() {
    els.unlockError.textContent = "";
    els.unlockError.hidden = true;
  }

  // ---- Generation ---------------------------------------------------------

  async function generate() {
    if (!masterKey) {
      lock("Session is locked.");
      return;
    }
    // Renew the session on activity.
    expiresAt = Date.now() + SESSION_MS;
    scheduleExpiry();

    const name = els.siteSelect.value;
    const site = sites.find((s) => s.name === name);
    if (!site) return;

    try {
      const pwd = await window.PMDerive.derivePassword(masterKey, site);
      els.generated.value = pwd;
      els.generated.type = "password";
      els.outputBlock.hidden = false;
      els.copyStatus.textContent = "";
      els.uniqueCreated.textContent = site.uniqueCreatedAt
        ? `Password created: ${formatFullDate(site.uniqueCreatedAt)}`
        : `Password created: unknown (regenerate to stamp it)`;

      // Username
      if (site.username) {
        els.usernameVal.value = site.username;
        els.usernameBlock.hidden = false;
        els.copyUsernameStatus.textContent = "";
      } else {
        els.usernameVal.value = "";
        els.usernameBlock.hidden = true;
      }

      // Open Site
      if (site.siteUrl) {
        els.openSiteBtn.dataset.url = site.siteUrl;
        els.openSiteRow.hidden = false;
      } else {
        els.openSiteBtn.dataset.url = "";
        els.openSiteRow.hidden = true;
      }
    } catch (err) {
      els.outputBlock.hidden = false;
      els.generated.value = "";
      els.uniqueCreated.textContent = "";
      els.copyStatus.textContent = err.message || "Failed to derive password.";
    }
  }

  function formatFullDate(iso) {
    if (!iso) return "unknown";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "unknown";
    return d.toLocaleString();
  }

  async function copyGenerated() {
    if (!els.generated.value) return;
    try {
      await navigator.clipboard.writeText(els.generated.value);
      els.copyStatus.textContent = "Copied. Clipboard will be cleared in 20s.";
      setTimeout(async () => {
        try {
          const current = await navigator.clipboard.readText();
          if (current === els.generated.value) {
            await navigator.clipboard.writeText("");
            els.copyStatus.textContent = "Clipboard cleared.";
          }
        } catch (_) {
          // readText may be denied; that's fine.
        }
      }, 20000);
    } catch (_) {
      // Fallback: select the input so the user can copy manually.
      els.generated.type = "text";
      els.generated.select();
      els.copyStatus.textContent = "Copy blocked by browser — selected instead.";
    }
  }

  async function copyUsername() {
    const val = els.usernameVal.value;
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      els.copyUsernameStatus.textContent = "Username copied.";
      setTimeout(() => {
        if (els.copyUsernameStatus.textContent === "Username copied.") {
          els.copyUsernameStatus.textContent = "";
        }
      }, 3000);
    } catch (_) {
      els.usernameVal.select();
      els.copyUsernameStatus.textContent = "Copy blocked by browser — selected instead.";
    }
  }

  function openSite() {
    let url = els.openSiteBtn.dataset.url;
    if (!url) return;
    // Ensure an absolute URL — add https:// if the user omitted the protocol.
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function toggleVisibility(input) {
    input.type = input.type === "password" ? "text" : "password";
  }

  // ---- Wire up ------------------------------------------------------------

  async function init() {
    await loadSites();
    refreshLists();

    // Refresh when the manage page updates the cache in another tab.
    window.addEventListener("storage", async (e) => {
      if (e.key === "pmanager.sites.cache.v1") {
        await loadSites();
        refreshLists();
      }
    });
    // Refresh when returning to this tab (e.g. after editing in same window).
    document.addEventListener("visibilitychange", async () => {
      if (!document.hidden) {
        await loadSites();
        refreshLists();
      }
    });

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
    els.generateBtn.addEventListener("click", generate);
    els.categorySelect.addEventListener("change", () => {
      populateSites();
      if (masterKey) generate();
    });
    els.siteSelect.addEventListener("change", () => {
      updateSiteNote();
      // Auto-regenerate when switching sites, if unlocked.
      if (masterKey) generate();
    });
    els.toggleGen.addEventListener("click", () => toggleVisibility(els.generated));
    els.copyBtn.addEventListener("click", copyGenerated);
    els.copyUsernameBtn.addEventListener("click", copyUsername);
    els.openSiteBtn.addEventListener("click", openSite);

    // Lock on tab close / reload for good measure.
    window.addEventListener("beforeunload", () => lock());
  }

  document.addEventListener("DOMContentLoaded", init);
})();
