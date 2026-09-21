'use strict';

// Android-only UI behavior layered on top of renderer.js (loaded after it,
// see index.html) rather than edited into it -- renderer.js is otherwise
// copied verbatim from the desktop app (see services.js's top comment), and
// everything here is either purely mobile (hardware/gesture back, a touch
// slider) or benefits from being one small file that's obviously
// Android-specific rather than scattered edits to a file that isn't.
//
// This relies on renderer.js's top-level `function`s (showView, closeSheet,
// ...) being ordinary global bindings -- classic <script>s (no type=module)
// share one global scope, and top-level function declarations become
// properties of `window` regardless of renderer.js's own 'use strict' --
// so they can be read/wrapped from here without renderer.js knowing this
// file exists at all.

// ---- Home-screen-only titlebar/gear (see android.css's body.no-titlebar) ----
//
// Every other view already renders its own back button + title as the
// first thing inside it; leaving the global titlebar (with the settings
// gear) up above that just pushes it down a redundant row and leaves the
// gear visible somewhere it's meaningless (you're already past it). This
// wraps showView (rather than adding a call at every one of its ~20 call
// sites in renderer.js) so it can't drift out of sync with navigation.
(function () {
  var original = window.showView;
  window.showView = function (name) {
    original(name);
    document.body.classList.toggle('no-titlebar', name !== 'main');
  };
})();

// ---- Hardware/gesture back button ----
//
// Called from native (MainActivity's OnBackPressedCallback) via
// webView.evaluateJavascript() on every system back press or edge-swipe.
// Returning true means this was handled in-app (native does nothing
// further); returning false means the current view has nowhere left to go
// "up" to -- native then finishes the Activity, which is what actually
// returns to the Android home screen/launcher instead of leaving the app
// merely backgrounded.
//
// Deliberately reuses each view's own existing back/close/cancel button
// (via .click()) instead of maintaining a separate navigation stack: those
// buttons already carry view-specific logic (stopping a pairing retry
// loop, the entertainment-area-edit unsaved-changes confirm dialog, ...)
// that a generic "pop the stack" would either have to duplicate or bypass.
function handleAndroidBack() {
  var confirmOverlay = document.getElementById('confirm-overlay');
  if (confirmOverlay && confirmOverlay.classList.contains('active')) {
    document.getElementById('confirm-cancel').click();
    return true;
  }

  var sheetOverlay = document.getElementById('sheet-overlay');
  if (sheetOverlay && sheetOverlay.classList.contains('active')) {
    if (typeof closeSheet === 'function') closeSheet();
    else sheetOverlay.classList.remove('active');
    return true;
  }

  var activeView = document.querySelector('#app .view.active');
  var id = activeView ? activeView.id : null;

  // The entertainment-area editor has its own nested drill-down (Rooms ->
  // a room's Lights) with its own back button, separate from the view's
  // top-level close button -- one "level" of back should surface that
  // first, same as every button-driven path already does.
  if (id === 'view-entarea-edit') {
    var lightsBackBtn = document.getElementById('btn-entarea-lights-back');
    if (lightsBackBtn && lightsBackBtn.style.display !== 'none') {
      lightsBackBtn.click();
      return true;
    }
  }

  var BACK_BUTTON_BY_VIEW = {
    'view-presslink': 'btn-cancel-pair',
    'view-settings': 'btn-settings-back',
    'view-about': 'btn-about-back',
    'view-bridge-pairing': 'btn-bridge-pairing-back',
    'view-bridge-presslink': 'btn-bridge-cancel-pair',
    'view-bridge-detail': 'btn-bridge-detail-back',
    'view-entareas': 'btn-entareas-back',
    'view-entarea-edit': 'btn-entarea-edit-close',
    'view-light-placement': 'btn-placement-done',
  };
  var backBtnId = BACK_BUTTON_BY_VIEW[id];
  if (backBtnId) {
    var btn = document.getElementById(backBtnId);
    if (btn) {
      btn.click();
      return true;
    }
  }

  // view-pairing and view-main are the two root/home screens (before and
  // after pairing) -- nothing left to go "up" to.
  return false;
}
window.handleAndroidBack = handleAndroidBack;

// Brightness pill moved into the shared renderer.js 2026-09-20 -- it turned
// out not to be touch-specific at all (pointer events drive it, which fire
// for mouse too), so it's now a desktop+Android feature kept identical
// across both, not an Android-only override. See renderer.js for the
// actual IIFE (right after its sheetSlider 'input' listener).

// ---- Light placement: touch height control (see .height-control in
// android.css and the comment on it in index.html) ----
//
// The desktop version adjusts a light's height by scrolling the mouse
// wheel while hovering its ball -- there's no touch equivalent of "hover",
// so on Android there was previously no way to change a light's height at
// all. This drives the same underlying state (light.position.y) and
// redraws the same pole/ball elements renderer.js's own wheel handler
// does, using its global includedLights()/lightHeightPx() (both top-level
// `function`s in renderer.js, and therefore plain `window` properties --
// see this file's own top comment) rather than duplicating its light data
// model here.
(function () {
  var control = document.getElementById('height-control');
  var track = document.getElementById('height-track');
  var fill = document.getElementById('height-fill');
  var value = document.getElementById('height-value');
  var legend = document.getElementById('placement-legend');
  var lightsStage = document.getElementById('room3d-lights-stage');
  if (!control || !track || !legend || !lightsStage) return;

  function currentIndex() {
    var el = legend.querySelector('.placement-legend-item.current');
    return el ? Number(el.dataset.index) : null;
  }

  function renderFromLight() {
    var index = currentIndex();
    var light = index === null ? null : includedLights()[index];
    control.hidden = !light;
    if (light) {
      var pct = Math.round(light.position.y * 100);
      fill.style.height = pct + '%';
      value.textContent = pct + '%';
    }
  }

  function setLightHeight(index, yNorm) {
    var light = includedLights()[index];
    if (!light) return;
    light.position.y = Math.min(1, Math.max(0, yNorm));
    var anchor = document.querySelector('.room3d-light[data-index="' + index + '"]');
    if (!anchor) return;
    var pole = anchor.querySelector('.room3d-light-pole');
    var ballOffset = anchor.querySelector('.room3d-light-ball-offset');
    var heightPx = lightHeightPx(light.position.y);
    pole.style.height = heightPx + 'px';
    ballOffset.style.transform = 'translateY(-' + heightPx + 'px)';
  }

  function applyFromClientY(clientY) {
    var index = currentIndex();
    if (index === null) return;
    var rect = track.getBoundingClientRect();
    var frac = 1 - (clientY - rect.top) / rect.height;
    frac = Math.min(1, Math.max(0, frac));
    setLightHeight(index, frac);
    var pct = Math.round(frac * 100);
    fill.style.height = pct + '%';
    value.textContent = pct + '%';
  }

  // The listener lives on the whole control column, not just the visible
  // track -- the fraction math below is still based on the track's own
  // rect (clamped to [0,1], so touches above/below it still resolve to
  // 100%/0%), but starting and holding the drag anywhere in this wider
  // area (including the value badge/label) makes it far easier to grab
  // and to reach the very top or bottom without needing pixel-precise
  // contact with a narrow bar, matching how the brightness slider's much
  // wider hit area already behaves.
  control.addEventListener('pointerdown', (e) => {
    // #height-control is nested inside #room3d-wrap (see index.html), so
    // without this, every touch here also bubbles up to roomWrapEl's own
    // pointerdown handler (room-orbit drag) -- which then calls its own
    // setPointerCapture() for the *same* pointerId, stealing the capture
    // away from `control` entirely. That let the very first tap register
    // but broke every pointermove after it (they went to roomWrapEl
    // instead), which is what made this feel unresponsive/hard to hold.
    e.stopPropagation();
    e.preventDefault();
    control.setPointerCapture(e.pointerId);
    const index = currentIndex();
    const light = index === null ? null : includedLights()[index];
    const before = light ? light.position.y : null;
    applyFromClientY(e.clientY);
    const move = (ev) => applyFromClientY(ev.clientY);
    const up = () => {
      control.removeEventListener('pointermove', move);
      control.removeEventListener('pointerup', up);
      if (light && light.position.y !== before) {
        recordMove(() => {
          setLightHeight(index, before);
          renderFromLight();
        });
      }
    };
    control.addEventListener('pointermove', move);
    control.addEventListener('pointerup', up);
  });

  // renderer.js's setCurrentLight() only ever toggles the 'current' class
  // (on the legend item and the matching ball) -- no event of its own to
  // hook, but that class change is a reliable proxy for "selection
  // changed". renderPlacementRoom() also rebuilds the lights-stage from
  // scratch every time the placement view is (re)entered, which is when
  // this needs to reset to hidden (nothing selected yet).
  new MutationObserver(renderFromLight).observe(legend, { subtree: true, attributes: true, attributeFilter: ['class'] });
  new MutationObserver(renderFromLight).observe(lightsStage, { childList: true });

  // Hides the control the instant focus moves to anything else -- orbiting
  // the room, dragging the TV/couch, or tapping anywhere outside the 3D
  // box entirely (the legend list, the back button, ...). A light tap is
  // the only thing that should *keep* it up (whether it's arming/moving
  // the already-selected light or newly selecting a different one), which
  // this leaves to renderFromLight()'s own observers above -- both react
  // to the exact same 'current' class renderer.js already toggles, so
  // this only ever needs to know when NOT to preempt them. Runs on
  // `document`, not just #room3d-wrap, specifically to also catch taps
  // outside the 3D box; the early `hidden` check makes it a no-op on
  // every other screen where this control doesn't apply.
  document.addEventListener('pointerdown', (e) => {
    if (control.hidden) return;
    if (control.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.room3d-light-ball')) return;
    control.hidden = true;
  });
})();

// ---- Main screen: ambient background from the current bulb colors ----
//
// See .input-tile-ambient in android.css for the visual side (a blurred,
// slowly-rotating gradient) -- this is the polling/data side: while
// syncing, periodically read the actual live color of every Hue light in
// the currently-targeted entertainment area and set it as a CSS custom
// property, so the gradient tracks what the lights (and, by extension, the
// TV/Sync Box) are currently doing.
//
// Reads renderer.js's top-level `let state` directly by name rather than
// through any window.hueSync call -- classic (non-module) <script>s share
// one global lexical environment for top-level let/const the same way they
// do for `function` (see this file's own top comment), so this always sees
// renderer.js's latest fetched state without needing renderer.js to
// expose it deliberately.
(function () {
  var ambient = document.getElementById('input-tile-ambient');
  var mainView = document.getElementById('view-main');
  if (!ambient || !mainView) return;

  // CIE 1931 xy + relative brightness -> sRGB. The Bridge's own conversion
  // is proprietary/undocumented, so this is the standard public xyY -> XYZ
  // -> linear-sRGB -> gamma-corrected-sRGB pipeline (same one reverse-
  // engineered Hue client libraries use) rather than an exact match to
  // what a real bulb's phosphors produce.
  function xyToRgb(x, y, briPct) {
    var Y = Math.max(0.02, (briPct || 50) / 100);
    var X = y > 0 ? (Y / y) * x : 0;
    var Z = y > 0 ? (Y / y) * (1 - x - y) : 0;
    var r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    var g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    var b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
    function gamma(c) {
      c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
      return Math.max(0, Math.min(1, c));
    }
    r = gamma(r);
    g = gamma(g);
    b = gamma(b);
    // xy+brightness alone tends to produce dim, muddy colors (brightness
    // here is the *light's* dimming level, not a saturation/vividness
    // control) -- rescaling so the strongest channel hits full intensity
    // keeps the ambient glow visibly colorful regardless of how bright the
    // room lights happen to be set.
    var max = Math.max(r, g, b, 0.0001);
    return [Math.round((r / max) * 255), Math.round((g / max) * 255), Math.round((b / max) * 255)];
  }

  // The Sync Box's own state only says which group/entertainment area it's
  // targeting (execution.hueTarget, e.g. "groups/<id>") -- resolving that
  // to actual light IDs to poll requires finding which of this app's
  // *separately* paired bridges owns an entertainment configuration with
  // that same ID, since a Sync Box's Hue connection isn't necessarily one
  // of the bridges paired in this app for area-management purposes. Entertainment
  // configuration IDs are bridge-generated UUIDs, so a match is a reliable
  // signal, not a guess -- but this assumes the Sync Box's group ID and the
  // Bridge's entertainment configuration ID are the same resource, which
  // is how the official app's pairing works but isn't verified here
  // end-to-end against real hardware.
  var resolvedForGroupId = null;
  var resolvedLights = null; // [{ ip, lightId }]

  async function resolveLightsForGroup(groupId) {
    var settings = await window.hueSync.getSettings();
    for (const bridge of settings.bridges || []) {
      try {
        const configs = await window.hueSync.getEntertainmentConfigs(bridge.ip);
        const config = configs.find((c) => c.id === groupId);
        if (!config) continue;
        const serviceIds = new Set(config.locations.service_locations.map((sl) => sl.service.rid));
        const lights = await window.hueSync.getBridgeLights(bridge.ip);
        return lights.filter((l) => serviceIds.has(l.serviceId)).map((l) => ({ ip: bridge.ip, lightId: l.lightId }));
      } catch {
        // this bridge doesn't have that config, or is unreachable -- try the next
      }
    }
    return [];
  }

  async function tick() {
    var syncing =
      mainView.classList.contains('active') &&
      typeof state !== 'undefined' &&
      state &&
      state.execution &&
      state.execution.syncActive &&
      state.execution.hueTarget;
    if (!syncing) {
      ambient.style.opacity = '0';
      resolvedForGroupId = null;
      return;
    }

    var groupId = state.execution.hueTarget.replace(/^groups\//, '');
    if (resolvedForGroupId !== groupId) {
      resolvedForGroupId = groupId;
      resolvedLights = await resolveLightsForGroup(groupId);
    }
    if (!resolvedLights || !resolvedLights.length) {
      ambient.style.opacity = '0';
      return;
    }

    try {
      const states = await Promise.all(resolvedLights.map((l) => window.hueSync.getLightColor(l.ip, l.lightId)));
      const rgbs = states
        .filter((s) => s && s.on && s.on.on && s.color && s.color.xy)
        .map((s) => xyToRgb(s.color.xy.x, s.color.xy.y, s.dimming ? s.dimming.brightness : 50));
      if (!rgbs.length) {
        ambient.style.opacity = '0';
        return;
      }
      rgbs.slice(0, 4).forEach((rgb, i) => {
        ambient.style.setProperty('--ambient-c' + i, 'rgb(' + rgb.join(',') + ')');
      });
      ambient.style.opacity = '1';
    } catch {
      // a transient bridge hiccup -- leave whatever colors are already
      // showing rather than flashing the ambient background off and on
    }
  }

  setInterval(tick, 1800);
  tick();
})();
