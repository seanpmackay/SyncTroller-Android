'use strict';

// Android port of the Electron app's main.js + preload.js + store.js +
// huesyncbox.js + huebridge.js, all collapsed into one in-WebView module.
// There's no separate main/renderer process here, so this just builds the
// same `window.hueSync` object the desktop preload.js exposed -- renderer.js
// itself is untouched, copied verbatim from the desktop app, and has no
// idea it's not talking to Electron IPC anymore.
//
// Two real platform differences from the desktop version, both handled by
// small native plugins (see android/.../MainActivity.java and friends)
// rather than in this file directly:
//  - No Node `https`/`child_process`, and no CORS headers on either
//    device's embedded API -- HTTP(S) goes through LocalHttpPlugin
//    (native Java) instead of fetch(), which also handles the self-signed
//    certs both devices use (same trust model as the desktop app's
//    rejectUnauthorized:false).
//  - No avahi-browse -- mDNS discovery goes through DiscoveryPlugin
//    (Android's native NsdManager API), the same underlying protocol
//    avahi-browse uses on desktop, just a different API to reach it.

// ---- Status notification (plain ongoing notification, no service) ----
//
// Lets the app be reopened from the notification shade the way a
// media-player app can, without hunting through the app drawer/recents.
// Shown once a box is paired (including on every subsequent app launch
// while still paired), kept up to date with "Standby" vs "Syncing"
// via notifySyncStateChanged below (called by renderer.js only when
// syncActive actually changes), and torn down when the box is forgotten.
// Not a foreground service: Play rejects FGS declarations whose only job
// is keeping a notification up, so on Android 14+ it can be swiped away
// (it returns on the next launch).
async function showStatusNotification(text) {
  try {
    await window.Capacitor.Plugins.SyncNotification.show({ title: 'SyncTroller', text });
  } catch {
    // Notifications plugin/permission unavailable -- non-fatal, app still works.
  }
}
async function hideStatusNotification() {
  try {
    await window.Capacitor.Plugins.SyncNotification.hide();
  } catch {
    // ignore
  }
}

async function nsdDiscover(serviceType, timeoutMs = 4000) {
  try {
    const res = await window.Capacitor.Plugins.Discovery.discover({ serviceType, timeoutMs });
    return res.services || [];
  } catch {
    return [];
  }
}

// ---- localStorage-backed store (electron-store equivalent) ----

const STORE_DEFAULTS = {
  box: null,
  bridges: [],
  trayBehavior: null,
  launchOnLogin: false,
  groupOverrides: {},
};

function storeGet(key) {
  const raw = localStorage.getItem(`synctroller.${key}`);
  if (raw === null) return STORE_DEFAULTS[key];
  try {
    return JSON.parse(raw);
  } catch {
    return STORE_DEFAULTS[key];
  }
}

function storeSet(key, value) {
  localStorage.setItem(`synctroller.${key}`, JSON.stringify(value));
}

// ---- Native HTTP bridge ----
//
// Not fetch() -- neither device's embedded REST API sends CORS headers (they
// were never built to be called from browser JS), so the WebView would
// block reading the response even though the network request itself would
// succeed. Both also use self-signed certs a stock fetch() would reject
// outright. LocalHttpPlugin (native Java, see MainActivity/that file) makes
// the actual request outside the WebView's networking stack entirely,
// sidestepping both problems at once.
async function localHttpRequest(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await window.Capacitor.Plugins.LocalHttp.request({
    url,
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  if (res.body) {
    try {
      json = JSON.parse(res.body);
    } catch {
      // non-JSON body, leave json null
    }
  }
  return { status: res.status, json };
}

// ---- Sync Box client (huesyncbox.js equivalent) ----

class HueSyncBoxError extends Error {}

async function syncboxRequest(host, path, { method = 'GET', body, accessToken } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let res;
  try {
    res = await localHttpRequest(`https://${host}:443/api/v1${path}`, { method, headers, body });
  } catch (err) {
    throw new HueSyncBoxError(err.message);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new HueSyncBoxError((res.json && res.json.message) || `HTTP ${res.status}`);
  }
  return res.json;
}

const huesyncbox = {
  async register(host, appName, instanceName) {
    const res = await syncboxRequest(host, '/registrations', {
      method: 'POST',
      body: { appName, instanceName },
    });
    return { registrationId: res.registrationId, accessToken: res.accessToken };
  },
  unregister(host, accessToken, registrationId) {
    return syncboxRequest(host, `/registrations/${registrationId}`, { method: 'DELETE', accessToken });
  },
  getState(host, accessToken) {
    return syncboxRequest(host, '', { accessToken });
  },
  setExecution(host, accessToken, update) {
    return syncboxRequest(host, '/execution', { method: 'PUT', accessToken, body: update });
  },
  setHueGroupActive(host, accessToken, groupId, active) {
    return syncboxRequest(host, `/hue/groups/${groupId}`, { method: 'PUT', accessToken, body: { active } });
  },
  renameHdmiInput(host, accessToken, inputKey, { name, type } = {}) {
    const body = {};
    if (name !== undefined) body.name = name;
    if (type !== undefined) body.type = type;
    return syncboxRequest(host, `/hdmi/${inputKey}`, { method: 'PUT', accessToken, body });
  },
};

// ---- Hue Bridge client (huebridge.js equivalent, fetch-based) ----

class HueBridgeError extends Error {}

async function bridgeRawRequest(host, path, { method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await localHttpRequest(`https://${host}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  } catch (err) {
    throw new HueBridgeError(err.message);
  }
  if (res.status < 200 || res.status >= 300) throw new HueBridgeError(`HTTP ${res.status}`);
  return res.json;
}

async function bridgeV2Request(host, appKey, path, opts = {}) {
  const json = await bridgeRawRequest(host, `/clip/v2/resource${path}`, {
    ...opts,
    headers: { 'hue-application-key': appKey },
  });
  if (json && Array.isArray(json.errors) && json.errors.length) {
    throw new HueBridgeError(json.errors.map((e) => e.description).join('; '));
  }
  return (json && json.data) || [];
}

async function bridgeGetName(host) {
  try {
    const config = await bridgeRawRequest(host, '/api/config');
    return (config && config.name) || 'Hue Bridge';
  } catch {
    return 'Hue Bridge';
  }
}

const huebridge = {
  getBridgeName: bridgeGetName,
  async register(host, appName, instanceName) {
    const res = await bridgeRawRequest(host, '/api', {
      method: 'POST',
      body: { devicetype: `${appName}#${instanceName}`, generateclientkey: true },
    });
    const entry = Array.isArray(res) ? res[0] : null;
    if (!entry || !entry.success) {
      const desc = entry && entry.error ? entry.error.description : 'link button not pressed';
      throw new HueBridgeError(desc);
    }
    const name = await bridgeGetName(host);
    return { username: entry.success.username, clientkey: entry.success.clientkey, name };
  },
  async getEntertainmentLights(host, appKey) {
    const [lights, services] = await Promise.all([
      bridgeV2Request(host, appKey, '/light'),
      bridgeV2Request(host, appKey, '/entertainment'),
    ]);
    const serviceByDevice = new Map(services.map((s) => [s.owner.rid, s]));
    return lights
      .filter((l) => serviceByDevice.has(l.owner.rid))
      .map((l) => ({
        serviceId: serviceByDevice.get(l.owner.rid).id,
        lightId: l.id,
        deviceId: l.owner.rid,
        name: l.metadata.name,
      }));
  },
  // Briefly makes the physical bulb blink/breathe via the Bridge's own
  // identify effect (a single call only does one short breathe cycle, so
  // this fires it 5 times with a gap between each) -- lets renderer.js
  // give a real-world answer to "which bulb is that" instead of just an
  // on-screen pulse. The gap needs to clear the *whole* breathe cycle
  // (confirmed live it's close to 2s, not under 1.5s as first assumed) --
  // firing the next call before the previous one finishes doesn't queue a
  // second pulse, it just restarts/extends the current one in place, which
  // is what made 5 calls read as a single blip instead of 5 distinct
  // pulses. Best-effort: a bridge hiccup here shouldn't interrupt the
  // identify UX, so failures are swallowed rather than surfaced.
  async identifyLight(host, appKey, lightId) {
    try {
      for (let i = 0; i < 5; i++) {
        await bridgeV2Request(host, appKey, `/light/${lightId}`, {
          method: 'PUT',
          body: { identify: { action: 'identify' } },
        });
        if (i < 4) await new Promise((resolve) => setTimeout(resolve, 2500));
      }
    } catch {
      // best-effort only, see above
    }
  },
  async getEntertainmentRooms(host, appKey) {
    const [rooms, lights] = await Promise.all([
      bridgeV2Request(host, appKey, '/room'),
      huebridge.getEntertainmentLights(host, appKey),
    ]);
    return rooms
      .map((room) => {
        const deviceIds = new Set(room.children.filter((c) => c.rtype === 'device').map((c) => c.rid));
        return { id: room.id, name: room.metadata.name, lights: lights.filter((l) => deviceIds.has(l.deviceId)) };
      })
      .filter((room) => room.lights.length > 0);
  },
  getEntertainmentConfigurations(host, appKey) {
    return bridgeV2Request(host, appKey, '/entertainment_configuration');
  },
  createEntertainmentConfiguration(host, appKey, { name, lights, configurationType = 'screen' }) {
    return bridgeV2Request(host, appKey, '/entertainment_configuration', {
      method: 'POST',
      body: {
        type: 'entertainment_configuration',
        metadata: { name },
        configuration_type: configurationType,
        locations: {
          service_locations: lights.map((l) => ({
            service: { rid: l.serviceId, rtype: 'entertainment' },
            positions: [l.position],
          })),
        },
      },
    });
  },
  updateEntertainmentConfiguration(host, appKey, id, { name, lights }) {
    const body = {};
    if (name !== undefined) body.metadata = { name };
    if (lights !== undefined) {
      body.locations = {
        service_locations: lights.map((l) => ({
          service: { rid: l.serviceId, rtype: 'entertainment' },
          positions: [l.position],
        })),
      };
    }
    return bridgeV2Request(host, appKey, `/entertainment_configuration/${id}`, { method: 'PUT', body });
  },
  deleteEntertainmentConfiguration(host, appKey, id) {
    return bridgeV2Request(host, appKey, `/entertainment_configuration/${id}`, { method: 'DELETE' });
  },
};

// ---- window.hueSync -- same shape as the desktop preload.js ----

function currentBox() {
  const box = storeGet('box');
  if (!box) throw new Error('No Sync Box paired yet.');
  return box;
}

function findBridge(ip) {
  const bridge = storeGet('bridges').find((b) => b.ip === ip);
  if (!bridge) throw new Error('That Hue Bridge is no longer paired.');
  return bridge;
}

let trayToggleCallback = null;

window.hueSync = {
  // Settings
  getSettings: async () => ({
    trayBehavior: storeGet('trayBehavior'),
    launchOnLogin: storeGet('launchOnLogin'),
    box: storeGet('box'),
    bridges: storeGet('bridges'),
    groupOverrides: storeGet('groupOverrides'),
  }),
  setTrayBehavior: async (value) => {
    storeSet('trayBehavior', value);
    return true;
  },
  // No system tray / autostart concept on Android -- kept as a harmless
  // store write so nothing throws if this is ever called.
  setLaunchOnLogin: async (enabled) => {
    storeSet('launchOnLogin', enabled);
    return true;
  },
  getGroupOverrides: async () => storeGet('groupOverrides'),
  setGroupOverride: async (groupId, name, icon) => {
    const overrides = storeGet('groupOverrides');
    overrides[groupId] = { name, icon };
    storeSet('groupOverrides', overrides);
    return overrides;
  },

  // Window chrome -- no-ops (no frameless-window concept on Android;
  // the corresponding titlebar buttons are hidden in index.html)
  minimizeWindow: () => {},
  closeWindow: () => {},

  // Pairing
  discoverBoxes: async () => {
    const services = await nsdDiscover('_huesync._tcp.');
    const seen = new Set();
    const boxes = [];
    for (const s of services) {
      if (seen.has(s.host)) continue;
      seen.add(s.host);
      boxes.push({ ip: s.host, uniqueId: s.txt.uniqueid || null, name: s.txt.name || 'Hue Sync Box' });
    }
    return boxes;
  },
  pairBox: async ({ ip, uniqueId, name }) => {
    const { registrationId, accessToken } = await huesyncbox.register(ip, 'SyncTroller', 'Android');
    const box = { ip, uniqueId, name, accessToken, registrationId };
    storeSet('box', box);
    showStatusNotification('Standby');
    return box;
  },
  forgetBox: async () => {
    const box = storeGet('box');
    if (box) {
      try {
        await huesyncbox.unregister(box.ip, box.accessToken, box.registrationId);
      } catch {
        // device may be offline/already forgotten the registration
      }
    }
    storeSet('box', null);
    hideStatusNotification();
    return true;
  },

  // State + control
  getState: async () => {
    const box = currentBox();
    return huesyncbox.getState(box.ip, box.accessToken);
  },
  setExecution: async (update) => {
    const box = currentBox();
    return huesyncbox.setExecution(box.ip, box.accessToken, update);
  },
  setHueGroupActive: async (groupId, active) => {
    const box = currentBox();
    return huesyncbox.setHueGroupActive(box.ip, box.accessToken, groupId, active);
  },
  renameInput: async (inputKey, name, type) => {
    const box = currentBox();
    return huesyncbox.renameHdmiInput(box.ip, box.accessToken, inputKey, { name, type });
  },

  // A plain navigation to a foreign host is intercepted by Capacitor's
  // BridgeWebViewClient.shouldOverrideUrlLoading -> Bridge.launchIntent,
  // which fires an ACTION_VIEW intent (system browser) and keeps the
  // WebView on the app page. window.open() is not reliably routed that way.
  openExternal: async (url) => {
    window.location.href = url;
  },

  onTrayToggleSync: (callback) => {
    trayToggleCallback = callback;
  },
  // renderer.js calls this only when execution.syncActive actually changes
  // (see refreshState() there) -- used here to keep the status
  // notification's text current instead of just its existence.
  notifySyncStateChanged: (active) => {
    showStatusNotification(active ? 'Syncing' : 'Standby');
  },

  // Hue Bridge
  discoverBridges: async () => {
    const services = await nsdDiscover('_hue._tcp.');
    const seen = new Set();
    const bridges = [];
    for (const s of services) {
      if (seen.has(s.host)) continue;
      seen.add(s.host);
      bridges.push({ ip: s.host, id: s.txt.bridgeid || null });
    }
    return Promise.all(bridges.map(async (b) => ({ ...b, name: await huebridge.getBridgeName(b.ip) })));
  },
  pairBridge: async ({ ip, id }) => {
    const { username, clientkey, name } = await huebridge.register(ip, 'SyncTroller', 'Android');
    const bridge = { ip, id, name, username, clientkey };
    storeSet('bridges', [...storeGet('bridges').filter((b) => b.ip !== ip), bridge]);
    return bridge;
  },
  forgetBridge: async (ip) => {
    storeSet('bridges', storeGet('bridges').filter((b) => b.ip !== ip));
    return true;
  },
  refreshBridgeName: async (ip) => {
    const bridge = findBridge(ip);
    const name = await huebridge.getBridgeName(bridge.ip);
    const updated = { ...bridge, name };
    storeSet('bridges', storeGet('bridges').map((b) => (b.ip === ip ? updated : b)));
    return updated;
  },
  getBridgeLights: async (ip) => {
    const bridge = findBridge(ip);
    return huebridge.getEntertainmentLights(bridge.ip, bridge.username);
  },
  identifyLight: async (ip, lightId) => {
    const bridge = findBridge(ip);
    return huebridge.identifyLight(bridge.ip, bridge.username, lightId);
  },
  getBridgeRooms: async (ip) => {
    const bridge = findBridge(ip);
    return huebridge.getEntertainmentRooms(bridge.ip, bridge.username);
  },
  getEntertainmentConfigs: async (ip) => {
    const bridge = findBridge(ip);
    return huebridge.getEntertainmentConfigurations(bridge.ip, bridge.username);
  },
  createEntertainmentConfig: async (ip, name, lights) => {
    const bridge = findBridge(ip);
    return huebridge.createEntertainmentConfiguration(bridge.ip, bridge.username, { name, lights });
  },
  updateEntertainmentConfig: async (ip, id, name, lights) => {
    const bridge = findBridge(ip);
    return huebridge.updateEntertainmentConfiguration(bridge.ip, bridge.username, id, { name, lights });
  },
  deleteEntertainmentConfig: async (ip, id) => {
    const bridge = findBridge(ip);
    return huebridge.deleteEntertainmentConfiguration(bridge.ip, bridge.username, id);
  },
};

// Re-show the status notification on every launch where a box is already
// paired (pairBox() only covers the moment pairing first happens).
if (storeGet('box')) {
  showStatusNotification('Standby');
}
