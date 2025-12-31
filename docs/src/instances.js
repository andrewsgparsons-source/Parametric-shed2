// FILE: docs/src/instances.js
import { DEFAULTS } from "./params.js";

export function initInstancesUI({ store, ids, dbg }) {
  function $(id) { return document.getElementById(id); }

  var instanceSelectEl = $(ids.instanceSelect);
  var saveInstanceBtnEl = $(ids.saveInstanceBtn);
  var loadInstanceBtnEl = $(ids.loadInstanceBtn);
  var instanceNameInputEl = $(ids.instanceNameInput);
  var saveAsInstanceBtnEl = $(ids.saveAsInstanceBtn);
  var deleteInstanceBtnEl = $(ids.deleteInstanceBtn);
  var instancesHintEl = $(ids.instancesHint);

  // ---- Instances (Save/Load Presets) ----
  var LS_INSTANCES_KEY = "shedInstances_v1";
  var LS_ACTIVE_KEY = "shedInstancesActive_v1";

  var _instProvider = null;
  var _instUsingFallback = false;
  var _instProbe = { canRead: false, canWrite: false, persistentOk: false, errName: "", errMsg: "" };

  function safeJsonParse(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }
  function safeJsonStringify(v) {
    try { return JSON.stringify(v); } catch (e) { return ""; }
  }

  function setInstancesHint(msg) {
    if (!instancesHintEl) return;
    instancesHintEl.textContent = msg;
  }

  function cloneJson(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
  }

  function isPlainObject(x) {
    return !!x && typeof x === "object" && !Array.isArray(x);
  }

  function deepMerge(dst, src) {
    if (!isPlainObject(dst)) dst = {};
    if (!isPlainObject(src)) return dst;
    var keys = Object.keys(src);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var sv = src[k];
      if (Array.isArray(sv)) {
        dst[k] = sv.slice();
      } else if (isPlainObject(sv)) {
        dst[k] = deepMerge(isPlainObject(dst[k]) ? dst[k] : {}, sv);
      } else {
        dst[k] = sv;
      }
    }
    return dst;
  }

  function storageProbe() {
    var res = { canRead: false, canWrite: false, persistentOk: false, errName: "", errMsg: "" };
    var ls = null;

    try { ls = window.localStorage; } catch (e0) { ls = null; }
    if (!ls) {
      res.errName = "NoLocalStorage";
      res.errMsg = "window.localStorage unavailable";
      return res;
    }

    try {
      var tmp = ls.getItem(LS_INSTANCES_KEY);
      res.canRead = true;
      void tmp;
    } catch (e1) {
      res.canRead = false;
      res.errName = e1 && e1.name ? String(e1.name) : "ReadError";
      res.errMsg = e1 && e1.message ? String(e1.message) : String(e1);
      return res;
    }

    try {
      ls.setItem("__shed_probe__", "1");
      var v = ls.getItem("__shed_probe__");
      ls.removeItem("__shed_probe__");
      res.canWrite = (v === "1");
    } catch (e2) {
      // QuotaExceededError: treat read OK, write failed
      res.canWrite = false;
      res.errName = e2 && e2.name ? String(e2.name) : "WriteError";
      res.errMsg = e2 && e2.message ? String(e2.message) : String(e2);
    }

    res.persistentOk = !!(res.canRead && res.canWrite);
    return res;
  }

  function createPersistentProvider() {
    return {
      getItem: function (k) { return window.localStorage.getItem(k); },
      setItem: function (k, v) { window.localStorage.setItem(k, v); },
      removeItem: function (k) { window.localStorage.removeItem(k); }
    };
  }

  function createFallbackProvider() {
    var mem = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? String(mem[k]) : null; },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { try { delete mem[k]; } catch (e) {} }
    };
  }

  function providerGet(key) {
    try { return _instProvider ? _instProvider.getItem(key) : null; } catch (e) { return null; }
  }

  function providerSet(key, val) {
    try { if (_instProvider) _instProvider.setItem(key, val); } catch (e) { throw e; }
  }

  function providerRemove(key) {
    try { if (_instProvider) _instProvider.removeItem(key); } catch (e) { throw e; }
  }

  function hintStorageStatusIfNeeded(prefix) {
    if (_instProbe.persistentOk) return;
    var msg = "";
    if (_instProbe.canRead && !_instProbe.canWrite) {
      msg = "Storage read OK, write blocked: " + String(_instProbe.errName || "") + " " + String(_instProbe.errMsg || "");
    } else {
      msg = "Storage blocked: " + String(_instProbe.errName || "") + " " + String(_instProbe.errMsg || "");
    }
    if (_instUsingFallback) msg += " (session only)";
    if (prefix) msg = prefix + " — " + msg;
    setInstancesHint(msg);
  }

  function readInstances() {
    var raw = providerGet(LS_INSTANCES_KEY);
    if (!raw) return {};
    var parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  }

  function writeInstances(map) {
    var s = safeJsonStringify(map || {});
    if (!s) return;
    providerSet(LS_INSTANCES_KEY, s);
  }

  function readActiveName() {
    var v = providerGet(LS_ACTIVE_KEY);
    return v != null ? String(v) : null;
  }

  function writeActiveName(name) {
    if (name == null) { providerRemove(LS_ACTIVE_KEY); return; }
    providerSet(LS_ACTIVE_KEY, String(name));
  }

  function listInstanceNames(map) {
    var names = Object.keys(map || {});
    names.sort(function (a, b) { return String(a).localeCompare(String(b)); });
    return names;
  }

  function rebuildInstanceSelect(selectedNameMaybe) {
    if (!instanceSelectEl) return { map: {}, names: [], selected: null };

    var map = {};
    try {
      map = readInstances();
    } catch (e) {
      if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
      else hintStorageStatusIfNeeded("Storage unavailable");
      return { map: {}, names: [], selected: null };
    }

    var names = listInstanceNames(map);

    if (!names.length) {
      try {
        map["Default"] = cloneJson(store.getState());
        writeInstances(map);
        writeActiveName("Default");
        map = readInstances();
        names = listInstanceNames(map);
      } catch (e2) {
        if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
        else hintStorageStatusIfNeeded("Storage unavailable");
        return { map: {}, names: [], selected: null };
      }
    }

    var active = readActiveName();
    var want = selectedNameMaybe != null ? String(selectedNameMaybe) : null;
    if (!want && active && map[active] != null) want = active;
    if (!want || names.indexOf(want) === -1) want = names[0];

    instanceSelectEl.innerHTML = "";
    for (var i = 0; i < names.length; i++) {
      var nm = names[i];
      var opt = document.createElement("option");
      opt.value = nm;
      opt.textContent = nm;
      instanceSelectEl.appendChild(opt);
    }

    instanceSelectEl.value = want;
    try { writeActiveName(want); } catch (e3) {}

    if (_instProbe.persistentOk) setInstancesHint("Selected: " + want);
    else setInstancesHint("Selected: " + want + " (session only)");

    return { map: map, names: names, selected: want };
  }

  function getSelectedNameSafe(map) {
    if (!instanceSelectEl) return null;
    var nm = String(instanceSelectEl.value || "");
    if (!nm) return null;
    if (map && typeof map === "object" && map[nm] == null) return null;
    return nm;
  }

  function saveCurrentTo(name, overwriteAllowed) {
    var nm = String(name || "").trim();
    if (!nm) return false;

    try {
      var map = readInstances();
      if (map[nm] != null && !overwriteAllowed) return false;

      map[nm] = cloneJson(store.getState());
      writeInstances(map);
      writeActiveName(nm);
      rebuildInstanceSelect(nm);

      if (_instProbe.persistentOk) setInstancesHint("Saved: " + nm);
      else setInstancesHint("Saved: " + nm + " (session only)");
      return true;
    } catch (e) {
      if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
      else hintStorageStatusIfNeeded("Storage unavailable");
      return false;
    }
  }

  function loadFrom(name) {
    var nm = String(name || "").trim();
    if (!nm) return;

    try {
      var map = readInstances();
      var saved = map[nm];
      if (!saved || typeof saved !== "object") {
        if (_instProbe.persistentOk) setInstancesHint("No saved instances.");
        else setInstancesHint("No saved instances. (session only)");
        rebuildInstanceSelect(null);
        return;
      }

      var baseline = cloneJson(DEFAULTS);
      var merged = deepMerge(baseline, cloneJson(saved));
      store.setState(merged);

      writeActiveName(nm);
      rebuildInstanceSelect(nm);

      if (_instProbe.persistentOk) setInstancesHint("Loaded: " + nm);
      else setInstancesHint("Loaded: " + nm + " (session only)");
    } catch (e) {
      if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
      else hintStorageStatusIfNeeded("Storage unavailable");
    }
  }

  function deleteSelected() {
    try {
      var map = readInstances();
      var names = listInstanceNames(map);
      if (names.length <= 1) {
        if (_instProbe.persistentOk) setInstancesHint("Cannot delete last instance.");
        else setInstancesHint("Cannot delete last instance. (session only)");
        return;
      }

      var name = getSelectedNameSafe(map);
      if (!name) return;

      delete map[name];
      writeInstances(map);

      var remaining = listInstanceNames(map);
      var nextName = remaining.length ? remaining[0] : null;

      if (nextName) {
        writeActiveName(nextName);
        rebuildInstanceSelect(nextName);
        // Optional: auto-load newly selected instance
        loadFrom(nextName);

        if (_instProbe.persistentOk) setInstancesHint("Deleted: " + name + ", Selected: " + nextName);
        else setInstancesHint("Deleted: " + name + ", Selected: " + nextName + " (session only)");
      } else {
        rebuildInstanceSelect(null);
        if (_instProbe.persistentOk) setInstancesHint("Deleted: " + name);
        else setInstancesHint("Deleted: " + name + " (session only)");
      }
    } catch (e) {
      if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
      else hintStorageStatusIfNeeded("Storage unavailable");
    }
  }

  function wireInstancesUiOnce() {
    if (!instanceSelectEl || !saveInstanceBtnEl || !loadInstanceBtnEl || !saveAsInstanceBtnEl || !deleteInstanceBtnEl) return;
    if (saveInstanceBtnEl._wired) return;

    saveInstanceBtnEl._wired = true;
    loadInstanceBtnEl._wired = true;
    saveAsInstanceBtnEl._wired = true;
    deleteInstanceBtnEl._wired = true;
    instanceSelectEl._wired = true;

    saveInstanceBtnEl.addEventListener("click", function () {
      try {
        var map = readInstances();
        var name = getSelectedNameSafe(map);
        if (!name) {
          if (_instProbe.persistentOk) setInstancesHint("No saved instances.");
          else setInstancesHint("No saved instances. (session only)");
          rebuildInstanceSelect(null);
          return;
        }
        saveCurrentTo(name, true);
      } catch (e) {
        if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
        else hintStorageStatusIfNeeded("Storage unavailable");
      }
    });

    loadInstanceBtnEl.addEventListener("click", function () {
      try {
        var map = readInstances();
        var name = getSelectedNameSafe(map);
        if (!name) {
          if (_instProbe.persistentOk) setInstancesHint("No saved instances.");
          else setInstancesHint("No saved instances. (session only)");
          rebuildInstanceSelect(null);
          return;
        }
        loadFrom(name);
      } catch (e) {
        if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
        else hintStorageStatusIfNeeded("Storage unavailable");
      }
    });

    saveAsInstanceBtnEl.addEventListener("click", function () {
      var name = instanceNameInputEl ? String(instanceNameInputEl.value || "").trim() : "";
      if (!name) return;

      try {
        var map = readInstances();
        if (map[name] != null) {
          var ok = false;
          try { ok = window.confirm('Overwrite existing instance "' + name + '"?'); } catch (e0) { ok = false; }
          if (!ok) return;
        }
        saveCurrentTo(name, true);
        if (instanceNameInputEl) instanceNameInputEl.value = "";
      } catch (e) {
        if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
        else hintStorageStatusIfNeeded("Storage unavailable");
      }
    });

    deleteInstanceBtnEl.addEventListener("click", function () {
      deleteSelected();
    });

    instanceSelectEl.addEventListener("change", function () {
      try {
        var map = readInstances();
        var name = getSelectedNameSafe(map);
        if (!name) {
          if (_instProbe.persistentOk) setInstancesHint("No saved instances.");
          else setInstancesHint("No saved instances. (session only)");
          rebuildInstanceSelect(null);
          return;
        }

        try { writeActiveName(name); } catch (e2) {}

        rebuildInstanceSelect(name);
        if (_instProbe.persistentOk) setInstancesHint("Selected: " + name);
        else setInstancesHint("Selected: " + name + " (session only)");
      } catch (e) {
        if (_instProbe.persistentOk) setInstancesHint("Storage unavailable");
        else hintStorageStatusIfNeeded("Storage unavailable");
      }
    });
  }

  function initInstances() {
    // Probe storage and select provider once.
    _instProbe = storageProbe();
    if (_instProbe.persistentOk) {
      _instProvider = createPersistentProvider();
      _instUsingFallback = false;
    } else {
      _instProvider = createFallbackProvider();
      _instUsingFallback = true;
    }

    wireInstancesUiOnce();

    if (!_instProbe.persistentOk) {
      hintStorageStatusIfNeeded(null);
    }

    rebuildInstanceSelect(null);
  }

  // Keep lifecycle identical: init immediately when called.
  try { initInstances(); } catch (e) {
    try {
      if (_instProbe && _instProbe.persistentOk) setInstancesHint("Storage unavailable");
      else setInstancesHint("Storage unavailable");
    } catch (e2) {}
    try { if (dbg) dbg.lastError = "initInstancesUI failed: " + String(e && e.message ? e.message : e); } catch (e3) {}
  }
}