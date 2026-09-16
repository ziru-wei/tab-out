'use strict';

(() => {
  const { MESSAGES, createRuntimeMessage, matchesRuntimeMessage } = globalThis.TabOutContracts;
  function traceAmbience(stage, detail = {}) {
    chrome.runtime.sendMessage(createRuntimeMessage(MESSAGES.AMBIENCE_OFFSCREEN_TRACE, {
      stage,
      detail,
    })).catch(() => {});
  }
  const FADE_DURATION = 1800;
  const MIX_RAMP_SECONDS = 0.035;
  const TRACKS = globalThis.TabOutAmbienceTracks || [];
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  traceAmbience('script-init', {
    audioContextAvailable: Boolean(AudioContextClass),
    trackCount: TRACKS.length,
  });
  if (!AudioContextClass || TRACKS.length === 0) return;

  let context = null;
  let master = null;
  let convolver = null;
  let active = false;
  let transitionId = 0;
  let stopTimer = 0;
  let sources = [];
  const trackNodes = new Map();
  const trackMix = new Map(TRACKS.map(track => [track.key, {
    volume: track.volume,
    room: track.room,
  }]));
  const decodedTrackPromises = new Map();

  function createRoomImpulse(audioContext) {
    const duration = 1.35;
    const length = Math.floor(audioContext.sampleRate * duration);
    const impulse = audioContext.createBuffer(2, length, audioContext.sampleRate);
    let seed = 0x51f15e;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let index = 0; index < length; index += 1) {
        data[index] = (random() * 2 - 1) * Math.pow(1 - index / length, 2.8);
      }
    }
    return impulse;
  }

  function ensureGraph() {
    if (context) return;
    context = new AudioContextClass();
    traceAmbience('graph-created', { state: context.state, sampleRate: context.sampleRate });
    master = context.createGain();
    master.gain.value = 0;
    convolver = context.createConvolver();
    convolver.buffer = createRoomImpulse(context);
    const roomReturn = context.createGain();
    roomReturn.gain.value = 0.42;
    convolver.connect(roomReturn).connect(master);
    master.connect(context.destination);
  }

  function loadTrack(track) {
    const cached = decodedTrackPromises.get(track.url);
    if (cached) return cached;
    const loading = fetch(track.url)
      .then(response => {
        if (!response.ok) throw new Error(`Could not load ${track.url}`);
        return response.arrayBuffer();
      })
      .then(data => context.decodeAudioData(data))
      .then(buffer => ({ ...track, buffer }))
      .catch(error => {
        // A failed decode must be retryable on the next start/prime request.
        decodedTrackPromises.delete(track.url);
        throw error;
      });
    decodedTrackPromises.set(track.url, loading);
    return loading;
  }

  async function loadAvailableTracks() {
    ensureGraph();
    const results = await Promise.allSettled(TRACKS.map(loadTrack));
    const available = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') available.push(result.value);
      else console.warn(`[tab-out] Could not load ambience layer ${TRACKS[index].url}:`, result.reason);
    });
    if (available.length === 0) throw new Error('No ambience layers could be decoded');
    traceAmbience('tracks-loaded', {
      available: available.map(track => track.key),
      failed: TRACKS.length - available.length,
    });
    return available;
  }

  function stopSources() {
    for (const source of sources) {
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    sources = [];
    trackNodes.clear();
  }

  function clampMixValue(value) {
    return Math.min(1, Math.max(0, Number(value) || 0));
  }

  function rampGain(gain, target) {
    if (!context || !gain) return;
    const now = context.currentTime;
    if (typeof gain.cancelAndHoldAtTime === 'function') gain.cancelAndHoldAtTime(now);
    else {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
    }
    gain.setTargetAtTime(target, now, MIX_RAMP_SECONDS);
  }

  function updateTrackMix(value) {
    const key = typeof value?.key === 'string' ? value.key : '';
    if (!trackMix.has(key)) throw new Error(`Unknown ambience track: ${key}`);
    const next = {
      volume: clampMixValue(value.volume),
      room: clampMixValue(value.room),
    };
    trackMix.set(key, next);
    const nodes = trackNodes.get(key);
    if (nodes) {
      rampGain(nodes.level.gain, next.volume);
      rampGain(nodes.roomSend.gain, next.room);
    }
  }

  function rampMaster(target, duration) {
    if (!context || !master) return;
    const now = context.currentTime;
    const gain = master.gain;
    if (typeof gain.cancelAndHoldAtTime === 'function') gain.cancelAndHoldAtTime(now);
    else {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
    }
    gain.linearRampToValueAtTime(target, now + duration / 1000);
  }

  async function prime() {
    traceAmbience('prime-begin');
    const tracksPromise = loadAvailableTracks();
    if (context.state === 'suspended') await context.resume();
    await tracksPromise;
    traceAmbience('prime-done', { contextState: context.state });
  }

  async function start({ startedAt, instant = false }) {
    traceAmbience('start-begin', { startedAt, instant, active, sources: sources.length });
    if (active && sources.length > 0) {
      traceAmbience('start-already-active');
      return;
    }
    active = true;
    const id = ++transitionId;
    window.clearTimeout(stopTimer);
    stopTimer = 0;
    const tracksPromise = loadAvailableTracks();
    if (context.state === 'suspended') await context.resume();
    const tracks = await tracksPromise;
    if (!active || id !== transitionId) return;

    stopSources();
    const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
    for (const track of tracks) {
      const source = context.createBufferSource();
      const level = context.createGain();
      const roomSend = context.createGain();
      const mix = trackMix.get(track.key) || track;
      source.buffer = track.buffer;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = track.buffer.duration;
      level.gain.value = mix.volume;
      roomSend.gain.value = mix.room;
      source.connect(level);
      level.connect(master);
      level.connect(roomSend).connect(convolver);
      source.start(0, elapsed % track.buffer.duration);
      sources.push(source);
      trackNodes.set(track.key, { level, roomSend });
    }

    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setValueAtTime(instant ? 1 : 0, context.currentTime);
    if (!instant) rampMaster(1, FADE_DURATION);
    traceAmbience('start-done', { sources: sources.length, contextState: context.state });
  }

  function stop() {
    traceAmbience('stop', { active, sources: sources.length });
    if (!active) return;
    active = false;
    ++transitionId;
    rampMaster(0, FADE_DURATION);
    window.clearTimeout(stopTimer);
    stopTimer = window.setTimeout(() => {
      stopTimer = 0;
      stopSources();
    }, FADE_DURATION);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!matchesRuntimeMessage(message, MESSAGES.AMBIENCE_COMMAND, 'offscreen')) return;
    if (message.command === 'ping') {
      sendResponse({ ok: true });
      return;
    }
    if (message.command !== 'mix') traceAmbience('command-received', { command: message.command });
    const operation = message.command === 'prime'
      ? prime()
      : message.command === 'start'
        ? start({ startedAt: Number(message.startedAt) || Date.now(), instant: Boolean(message.instant) })
        : message.command === 'stop'
          ? Promise.resolve(stop())
          : message.command === 'mix'
            ? Promise.resolve(updateTrackMix(message.mix))
          : Promise.reject(new Error(`Unknown ambience command: ${message.command}`));
    operation.then(
      () => {
        if (message.command !== 'mix') traceAmbience('command-success', { command: message.command });
        sendResponse({ ok: true });
      },
      error => {
        traceAmbience('command-error', { command: message.command, message: String(error?.message || error) });
        sendResponse({ ok: false, error: String(error?.message || error) });
      },
    );
    return true;
  });
})();
