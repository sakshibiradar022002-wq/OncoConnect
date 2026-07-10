// ChemoCure sync client — mirrors the cc_* localStorage keys to the server.
//
// The apps read/write localStorage synchronously; this layer makes that data
// durable and cross-device without touching the app code:
//   1. login pulls the account's keyspace from the server into localStorage
//   2. every localStorage write to a cc_* key is queued and pushed (debounced)
// If the server is unreachable, the apps keep working local-only, exactly as
// before — pushes retry on the next write.
(function () {
  'use strict';

  var API = '/api/sync';
  var META_KEY = 'cc__sync_meta'; // per-key server timestamps, excluded from sync

  var state = {
    mode: null,        // 'doctor' | 'patient' | 'lab' | null (local-only)
    online: false,
    dirty: new Set(),
    timer: null,
    pushing: false,
  };

  function pushUrl() {
    if (state.mode === 'patient') return API + '/patient';
    if (state.mode === 'lab') return API + '/lab';
    return API;
  }

  function meta() {
    try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveMeta(m) {
    try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) {}
  }

  async function req(method, url, body) {
    var res = await fetch(url, {
      method: method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var err = new Error(data.error || res.statusText);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Server wins only where its copy is newer than what we last synced.
  function mergeKeys(keys) {
    var m = meta();
    var applied = 0;
    for (var k in (keys || {})) {
      var entry = keys[k];
      if (!m[k] || entry.ts > m[k]) {
        try { localStorage.setItem('cc_' + k, JSON.stringify(entry.v)); applied++; } catch (e) {}
        m[k] = entry.ts;
      }
    }
    saveMeta(m);
    return applied;
  }

  function collectAllLocal() {
    var out = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf('cc_') !== 0 || k === META_KEY) continue;
      try { out[k.slice(3)] = JSON.parse(localStorage.getItem(k)); } catch (e) {}
    }
    return out;
  }

  function schedulePush() {
    if (!state.online) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(pushDirty, 1500);
  }

  async function pushDirty() {
    if (!state.online || state.pushing || state.dirty.size === 0) return;
    var keys = Array.from(state.dirty);
    state.dirty.clear();
    var changes = {};
    keys.forEach(function (k) {
      var raw = localStorage.getItem('cc_' + k);
      try { changes[k] = raw === null ? null : JSON.parse(raw); } catch (e) { changes[k] = null; }
    });
    state.pushing = true;
    try {
      await req('PUT', pushUrl(), { changes: changes });
      var m = meta();
      var now = new Date().toISOString();
      keys.forEach(function (k) { if (changes[k] === null) delete m[k]; else m[k] = now; });
      saveMeta(m);
    } catch (e) {
      keys.forEach(function (k) { state.dirty.add(k); }); // retry on next write
      if (e.status === 401) state.online = false;         // session expired → local-only
    } finally {
      state.pushing = false;
    }
    if (state.dirty.size) schedulePush();
  }

  // Intercept every localStorage write so app code needs no changes.
  var origSet = Storage.prototype.setItem;
  var origDel = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) {
    origSet.call(this, k, v);
    if (this === window.localStorage && typeof k === 'string' && k.indexOf('cc_') === 0 && k !== META_KEY) {
      state.dirty.add(k.slice(3));
      schedulePush();
    }
  };
  Storage.prototype.removeItem = function (k) {
    origDel.call(this, k);
    if (this === window.localStorage && typeof k === 'string' && k.indexOf('cc_') === 0 && k !== META_KEY) {
      state.dirty.add(k.slice(3));
      schedulePush();
    }
  };

  // Patient/lab portals: poll for new server data (e.g. a task assigned by
  // the doctor after login) and refresh the task list when something changed.
  setInterval(function () {
    if (!state.online || (state.mode !== 'patient' && state.mode !== 'lab')) return;
    req('GET', state.mode === 'patient' ? API + '/patient' : API + '/lab').then(function (d) {
      var applied = mergeKeys(d.keys);
      if (applied && state.mode === 'lab' && typeof window.refreshLabTasks === 'function') {
        try { window.refreshLabTasks(); } catch (e) {}
      }
    }).catch(function () {});
  }, 45000);

  // Flush pending changes when the tab closes.
  window.addEventListener('pagehide', function () {
    if (!state.online || state.dirty.size === 0) return;
    var changes = {};
    state.dirty.forEach(function (k) {
      var raw = localStorage.getItem('cc_' + k);
      try { changes[k] = raw === null ? null : JSON.parse(raw); } catch (e) { changes[k] = null; }
    });
    try {
      fetch(pushUrl(), {
        method: 'PUT',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: changes }),
      });
    } catch (e) {}
  });

  window.CCSync = {
    get online() { return state.online; },
    get mode() { return state.mode; },

    // Doctor: authenticate on the server, pull the account keyspace, then
    // upload any local-only keys (first device migrating its prototype data).
    doctorLogin: async function (email, password) {
      await req('POST', '/api/auth/login', { email: email, password: password });
      state.mode = 'doctor';
      state.online = true;
      var pulled = await req('GET', API);
      mergeKeys(pulled.keys);
      var local = collectAllLocal();
      var missing = {};
      var n = 0;
      for (var k in local) if (!(k in pulled.keys)) { missing[k] = local[k]; n++; }
      if (n) { try { await req('PUT', API, { changes: missing }); } catch (e) {} }
      return true;
    },

    doctorRegister: async function (info) {
      try {
        await req('POST', '/api/auth/register', {
          name: info.name, email: info.email, password: info.password,
          specialty: info.specialty || undefined, institution: info.institution || undefined,
        });
      } catch (e) {
        if (e.status !== 409) throw e; // already registered on another device is fine
      }
    },

    // Patient: authenticate against the synced records and pull own keys.
    patientLogin: async function (mrn, password) {
      var data = await req('POST', API + '/patient-login', { mrn: mrn, password: password });
      state.mode = 'patient';
      state.online = true;
      mergeKeys(data.keys);
      return true;
    },

    // Lab technician: authenticate against the synced lab account and pull
    // the lab's tasks, submissions, and sanitized patient list.
    labLogin: async function (username, password) {
      var data = await req('POST', API + '/lab-login', { username: username, password: password });
      state.mode = 'lab';
      state.online = true;
      mergeKeys(data.keys);
      return true;
    },

    // Revoke the server session (fire-and-forget; local logout proceeds regardless).
    logout: function () {
      var wasOnline = state.online;
      state.mode = null;
      state.online = false;
      state.dirty.clear();
      if (wasOnline) { try { req('POST', '/api/auth/logout').catch(function () {}); } catch (e) {} }
    },
  };
})();
