'use strict';

(() => {
  const {
    DOM_EVENTS,
    MESSAGES,
    STORAGE_KEYS,
    createRuntimeMessage,
    matchesRuntimeMessage,
  } = globalThis.TabOutContracts;
  const trace = () => {};
  // The persistent audio owner lives in offscreen.html; this page owns only
  // its local Sparkle visual and forwards user intent to the service worker.
  const AMBIENCE_ENABLED = true;
  const AMBIENCE_STATE_KEY = STORAGE_KEYS.POCKET_AMBIENCE;
  const FADE_DURATION = 1800;
  if (!AMBIENCE_ENABLED) return;

  const layer = document.getElementById('ambientRainLayer');
  const canvas = document.getElementById('ambientRainCanvas');
  const createRain = globalThis.TabOutSparkleRain?.createRain;
  const visualAvailable = Boolean(layer && canvas && typeof createRain === 'function');
  trace('page:init', {
    layer: Boolean(layer),
    canvas: Boolean(canvas),
    sparkle: typeof createRain === 'function',
  });
  if (!visualAvailable) {
    console.warn('[tab-out] Rain renderer is unavailable; ambience audio controls remain active.');
  }

  let rain = null;
  let rainStarted = false;
  let visualActive = false;
  let pauseTimer = 0;

  function ensureRain() {
    if (!visualAvailable) return null;
    if (rain) return rain;
    rain = createRain({
      variant: 'drizzle',
      drops: 480,
      speed: 0.52,
      wind: 0.045,
      splashes: false,
      groundLevel: 1.04,
      color: 'rgba(132, 148, 168, 0.44)',
      scale: 0.86,
    }).mount(canvas, undefined, 30);
    return rain;
  }

  function setVisualActive(nextActive, { instant = false } = {}) {
    trace('visual:set-request', { nextActive, previousActive: visualActive, instant });
    if (nextActive === visualActive) return;
    visualActive = nextActive;
    if (!visualAvailable) return;
    window.clearTimeout(pauseTimer);
    pauseTimer = 0;

    if (nextActive) {
      const effect = ensureRain();
      if (!effect) return;
      if (rainStarted) effect.resume();
      else {
        effect.start();
        rainStarted = true;
      }
      if (instant) layer.classList.add('is-instant');
      layer.classList.add('is-active');
      if (instant) requestAnimationFrame(() => layer.classList.remove('is-instant'));
      return;
    }

    layer.classList.remove('is-active');
    pauseTimer = window.setTimeout(() => {
      pauseTimer = 0;
      rain?.pause();
    }, FADE_DURATION);
  }

  function sendCommand(command) {
    trace('page:send-command', { command });
    return chrome.runtime.sendMessage(createRuntimeMessage(MESSAGES.AMBIENCE_COMMAND, {
      command,
    }));
  }

  document.addEventListener(DOM_EVENTS.AMBIENCE_PRIME, () => {
    trace('page:prime-event');
    sendCommand('prime').catch(error => {
      console.warn('[tab-out] Could not prime ambience:', error);
    });
  });

  document.addEventListener(DOM_EVENTS.AMBIENCE_TOGGLE, event => {
    const source = event.detail?.source;
    if (source !== 'coin' && source !== 'space') return;
    trace('page:toggle-event', { source, visualActive });
    const previousActive = visualActive;
    // Respond to the completed long press locally instead of making the
    // visual wait for a service-worker/offscreen round trip.
    setVisualActive(!previousActive);
    sendCommand('toggle').then(response => {
      trace('page:toggle-response', response);
      if (response?.state) setVisualActive(Boolean(response.state.active));
    }).catch(error => {
      trace('page:toggle-error', { message: String(error?.message || error) });
      setVisualActive(previousActive);
      console.warn('[tab-out] Could not toggle ambience:', error);
    });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session' || !changes[AMBIENCE_STATE_KEY]) return;
    trace('page:session-state', changes[AMBIENCE_STATE_KEY]);
    setVisualActive(Boolean(changes[AMBIENCE_STATE_KEY].newValue?.active));
  });

  // The worker migrates legacy state and makes sure the singleton offscreen
  // audio owner exists before returning the authoritative current state.
  sendCommand('ensure').then(response => {
    trace('page:ensure-response', response);
    setVisualActive(Boolean(response?.state?.active), { instant: true });
  }).catch(error => {
    trace('page:ensure-error', { message: String(error?.message || error) });
    console.warn('[tab-out] Could not restore ambience:', error);
  });

  chrome.runtime.onMessage.addListener(message => {
    if (!matchesRuntimeMessage(message, MESSAGES.AMBIENCE_TRACE)) return;
    trace(message.stage, message.detail || {});
  });
})();
