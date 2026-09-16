'use strict';

(() => {
  const root = document.querySelector('[data-ambience-mixer]');
  const tracks = globalThis.TabOutAmbienceTracks || [];
  if (!root || tracks.length === 0) return;

  const { MESSAGES, STORAGE_KEYS, createRuntimeMessage } = globalThis.TabOutContracts;
  const pad = root.querySelector('[data-ambience-pad]');
  const openTabsSection = document.getElementById('openTabsSection');
  const container = root.closest?.('.container') || null;
  const SPACE_TAP_COUNT = 5;
  const SPACE_TAP_WINDOW_MS = 2000;
  const MIX_SAVE_DELAY_MS = 160;
  const state = new Map(tracks.map(track => [track.key, {
    volume: track.volume,
    room: track.room,
  }]));
  const pendingMixes = new Map();
  let sendingMix = false;
  let mixerOpen = false;
  let mixSaveTimer = 0;
  let spaceTapTimes = [];
  let openViewAnimation = null;

  function syncMixerHeight() {
    if (!mixerOpen || !container) return;
    const top = Math.max(0, root.getBoundingClientRect().top);
    const available = Math.max(300, window.innerHeight - top - 24);
    root.style.setProperty('--mixer-available-height', `${available}px`);
  }

  function clamp(value) {
    return Math.min(1, Math.max(0, value));
  }

  function renderTrack(key) {
    const point = root.querySelector(`[data-track="${key}"]`);
    const readout = root.querySelector(`[data-readout="${key}"] span`);
    const values = state.get(key);
    if (!point || !readout || !values) return;

    point.style.left = `${values.room * 100}%`;
    point.style.top = `${(1 - values.volume) * 100}%`;
    const volume = String(Math.round(values.volume * 100)).padStart(2, '0');
    const room = String(Math.round(values.room * 100)).padStart(2, '0');
    readout.textContent = `${volume}% volume _ ${room}% room`;
  }

  function mixSnapshot() {
    return Object.fromEntries([...state].map(([key, values]) => [key, { ...values }]));
  }

  function applyRememberedMix(value) {
    if (!value || typeof value !== 'object') return;
    tracks.forEach(track => {
      const saved = value[track.key];
      if (!saved || !Number.isFinite(Number(saved.volume)) || !Number.isFinite(Number(saved.room))) return;
      state.set(track.key, {
        volume: clamp(Number(saved.volume)),
        room: clamp(Number(saved.room)),
      });
    });
  }

  function persistCurrentMix() {
    window.clearTimeout(mixSaveTimer);
    mixSaveTimer = 0;
    return chrome.storage.local.set({ [STORAGE_KEYS.AMBIENCE_MIX]: mixSnapshot() }).catch(error => {
      console.warn('[tab-out] Could not remember the ambience mix:', error);
    });
  }

  function scheduleMixSave() {
    window.clearTimeout(mixSaveTimer);
    mixSaveTimer = window.setTimeout(() => { void persistCurrentMix(); }, MIX_SAVE_DELAY_MS);
  }

  function setMixerOpen(nextOpen) {
    if (mixerOpen === nextOpen) return;
    mixerOpen = nextOpen;
    root.setAttribute('aria-hidden', String(!nextOpen));
    openViewAnimation?.cancel();
    openViewAnimation = null;

    if (nextOpen) {
      syncMixerHeight();
      if (openTabsSection) {
        openTabsSection.style.visibility = 'visible';
        openTabsSection.inert = true;
        if (typeof openTabsSection.animate === 'function') {
          const animation = openTabsSection.animate(
            [{ opacity: 1 }, { opacity: 0 }],
            { duration: 180, easing: 'ease-in', fill: 'forwards' },
          );
          openViewAnimation = animation;
          animation.finished.then(() => {
            if (mixerOpen) openTabsSection.style.visibility = 'hidden';
            animation.cancel();
            if (openViewAnimation === animation) openViewAnimation = null;
          }).catch(() => {});
        } else {
          openTabsSection.style.visibility = 'hidden';
        }
      }
      document.body.classList.add('ambience-mixer-open');
      return;
    }

    if (openTabsSection) {
      openTabsSection.style.visibility = 'visible';
      openTabsSection.inert = false;
      if (typeof openTabsSection.animate === 'function') {
        const animation = openTabsSection.animate(
          [{ opacity: 0 }, { opacity: 1 }],
          { duration: 240, easing: 'ease-out' },
        );
        openViewAnimation = animation;
        animation.finished.then(() => {
          animation.cancel();
          if (openViewAnimation === animation) openViewAnimation = null;
        }).catch(() => {});
      }
    }
    window.requestAnimationFrame(() => {
      if (!mixerOpen) document.body.classList.remove('ambience-mixer-open');
    });
  }

  async function flushMixUpdates() {
    if (sendingMix) return;
    sendingMix = true;
    try {
      while (pendingMixes.size > 0) {
        const [key, mix] = pendingMixes.entries().next().value;
        pendingMixes.delete(key);
        const response = await chrome.runtime.sendMessage(createRuntimeMessage(
          MESSAGES.AMBIENCE_COMMAND,
          { command: 'mix', mix },
        ));
        if (response?.ok === false) throw new Error(response.error || 'Ambience mix update failed');
      }
    } catch (error) {
      console.warn('[tab-out] Could not update the ambience mix:', error);
    } finally {
      sendingMix = false;
      if (pendingMixes.size > 0) void flushMixUpdates();
    }
  }

  function publishMix(mix) {
    pendingMixes.set(mix.key, mix);
    void flushMixUpdates();
  }

  function publishCurrentMix() {
    state.forEach((values, key) => publishMix({ key, ...values }));
  }

  function setFromPointer(point, event) {
    const rect = pad.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const key = point.dataset.track;
    if (!state.has(key)) return;
    const values = {
      room: clamp((event.clientX - rect.left) / rect.width),
      volume: clamp(1 - ((event.clientY - rect.top) / rect.height)),
    };
    state.set(key, values);
    renderTrack(key);
    root.dispatchEvent(new CustomEvent('ambiencechange', {
      bubbles: true,
      detail: { key, ...values },
    }));
  }

  root.querySelectorAll('[data-track]').forEach(point => {
    point.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      point.setPointerCapture(event.pointerId);
      setFromPointer(point, event);
    });
    point.addEventListener('pointermove', event => {
      if (!point.hasPointerCapture(event.pointerId)) return;
      event.stopPropagation();
      setFromPointer(point, event);
    });
    point.addEventListener('lostpointercapture', () => { void persistCurrentMix(); });
  });

  root.addEventListener('ambiencechange', event => {
    publishMix(event.detail);
    scheduleMixSave();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEYS.AMBIENCE_MIX]) {
      applyRememberedMix(changes[STORAGE_KEYS.AMBIENCE_MIX].newValue);
      state.forEach((_values, key) => renderTrack(key));
      return;
    }
    if (areaName === 'session' && changes[STORAGE_KEYS.POCKET_AMBIENCE]?.newValue?.active) {
      publishCurrentMix();
    }
  });

  document.addEventListener('keydown', event => {
    const target = event.target;
    const isEditing = target instanceof HTMLElement
      && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const isSpace = event.code === 'Space' || event.key === ' ';
    if (!isSpace) {
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) spaceTapTimes = [];
      return;
    }
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isEditing) return;
    event.preventDefault();
    const now = performance.now();
    spaceTapTimes = spaceTapTimes.filter(timestamp => now - timestamp <= SPACE_TAP_WINDOW_MS);
    spaceTapTimes.push(now);
    if (spaceTapTimes.length < SPACE_TAP_COUNT) return;
    spaceTapTimes = [];
    setMixerOpen(!mixerOpen);
  }, true);

  window.addEventListener('blur', () => { spaceTapTimes = []; });
  window.addEventListener('resize', syncMixerHeight);
  window.addEventListener('pagehide', () => { void persistCurrentMix(); });
  state.forEach((_values, key) => renderTrack(key));
  root.classList.add('is-ready');
  root.setAttribute('aria-hidden', 'true');
  Promise.all([
    chrome.storage.local.get(STORAGE_KEYS.AMBIENCE_MIX),
    chrome.storage.session.get(STORAGE_KEYS.POCKET_AMBIENCE),
  ]).then(([local, session]) => {
    applyRememberedMix(local[STORAGE_KEYS.AMBIENCE_MIX]);
    state.forEach((_values, key) => renderTrack(key));
    if (session[STORAGE_KEYS.POCKET_AMBIENCE]?.active) publishCurrentMix();
  }).catch(() => {});
})();
