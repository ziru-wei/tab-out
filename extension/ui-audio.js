'use strict';

(() => {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;

  let context = null;
  const buffers = new Map();
  const loading = new Map();

  function ensureContext() {
    if (!context) context = new AudioContextClass();
    return context;
  }

  function prepareBuffer(url) {
    if (buffers.has(url)) return Promise.resolve(buffers.get(url));
    if (loading.has(url)) return loading.get(url);
    const audioContext = ensureContext();
    const promise = fetch(url)
      .then(response => {
        if (!response.ok) throw new Error(`Could not load ${url}`);
        return response.arrayBuffer();
      })
      .then(data => audioContext.decodeAudioData(data))
      .then(buffer => {
        buffers.set(url, buffer);
        loading.delete(url);
        return buffer;
      })
      .catch(error => {
        loading.delete(url);
        throw error;
      });
    loading.set(url, promise);
    return promise;
  }

  function prime() {
    const audioContext = ensureContext();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  }

  function playBuffer(url, { playbackRate = 1, volume = 1, delay = 0 } = {}) {
    prime();
    const buffer = buffers.get(url);
    if (!buffer) {
      prepareBuffer(url).catch(() => {});
      const fallback = new Audio(url);
      fallback.volume = volume;
      fallback.playbackRate = playbackRate;
      if ('preservesPitch' in fallback) fallback.preservesPitch = false;
      if ('webkitPreservesPitch' in fallback) fallback.webkitPreservesPitch = false;
      const play = () => fallback.play().catch(() => {});
      if (delay > 0) window.setTimeout(play, delay * 1000);
      else play();
      return;
    }

    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    gain.gain.value = volume;
    source.connect(gain).connect(context.destination);
    source.start(context.currentTime + Math.max(0, delay));
  }

  function playCloseSwoosh() {
    prime();
    const duration = 0.25;
    const now = context.currentTime;
    const buffer = context.createBuffer(1, context.sampleRate * duration, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) {
      const position = index / data.length;
      const envelope = position < 0.1
        ? position / 0.1
        : Math.pow(1 - (position - 0.1) / 0.9, 1.5);
      data[index] = (Math.random() * 2 - 1) * envelope;
    }

    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = buffer;
    filter.type = 'bandpass';
    filter.Q.value = 2;
    filter.frequency.setValueAtTime(4000, now);
    filter.frequency.exponentialRampToValueAtTime(400, now + duration);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    source.connect(filter).connect(gain).connect(context.destination);
    source.start(now);
  }

  globalThis.TabOutAudio = Object.freeze({ prepareBuffer, prime, playBuffer, playCloseSwoosh });
})();
