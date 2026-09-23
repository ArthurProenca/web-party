import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const AUTOPLAY_NOTICE = 'Clique em reproduzir no player para liberar o áudio e a sincronização.';

function setup(options = {}) {
  let now = 0;
  let nextTimer = 0;
  let scans = 0;
  let invalidated = false;
  const timers = new Map();
  const listeners = new Map();
  const messages = [];
  const runtimeListeners = new Set();
  const observers = [];
  const userActivation = { isActive: false };
  class Video {
    constructor(properties = {}) {
      Object.assign(this, {
        duration: 120, readyState: 4, paused: true, seeking: false,
        playbackRate: 1, time: 0, seeks: [], playCalls: 0, pauseCalls: 0,
        style: { display: 'block', visibility: 'visible', opacity: '1' },
        rect: { left: 0, top: 0, right: 800, bottom: 450 },
      }, properties);
    }
    get currentTime() { return this.time; }
    set currentTime(value) { this.seeks.push(value); this.time = value; }
    getBoundingClientRect() { return this.rect; }
    pause() { this.pauseCalls += 1; this.paused = true; }
    play() {
      this.playCalls += 1;
      if (this.playResult) return this.playResult();
      this.paused = false;
      return Promise.resolve();
    }
  }
  const videos = options.empty ? [] : [new Video(options.video)];
  function timer(callback, delay, repeat) {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay, repeat });
    return id;
  }
  const runtime = {
    id: 'test-extension',
    onMessage: {
      addListener: (fn) => runtimeListeners.add(fn),
      removeListener: (fn) => runtimeListeners.delete(fn),
    },
    sendMessage(message, callback) {
      if (invalidated) throw new Error('Extension context invalidated.');
      messages.push(JSON.parse(JSON.stringify(message)));
      callback();
    },
  };
  vm.runInNewContext(source, {
    chrome: { runtime },
    HTMLVideoElement: Video,
    document: {
      querySelectorAll(selector) { assert.equal(selector, 'video'); scans += 1; return videos; },
      addEventListener(type, fn, capture) { assert.equal(capture, true); listeners.set(type, fn); },
      removeEventListener(type) { listeners.delete(type); },
    },
    window: { innerWidth: 1280, innerHeight: 720 },
    navigator: { userActivation },
    getComputedStyle: (video) => video.style,
    performance: { now: () => now },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    setTimeout: (fn, delay) => timer(fn, delay, 0),
    setInterval: (fn, delay) => timer(fn, delay, delay),
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
  });
  return {
    videos, Video, messages, timers, userActivation, listeners, runtimeListeners, observers, runtime,
    get scans() { return scans; },
    get report() { return messages.at(-1).payload; },
    invalidate() { invalidated = true; },
    send(action, payload) {
      runtimeListeners.forEach((fn) => fn({ target: 'player', action, payload }));
    },
    emit(type, target = videos[0]) { listeners.get(type)?.({ type, target }); },
    mutate() { observers.forEach((observer) => { if (!observer.disconnected) observer.callback([]); }); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, value]) => value.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, value] = next;
        now = value.at;
        if (value.repeat) value.at += value.repeat;
        else timers.delete(id);
        value.callback();
      }
      now = end;
    },
  };
}

function apply(env, overrides = {}, delayMs = 0) {
  env.send('APPLY_STATE', {
    state: { time: 20, paused: true, rate: 1, duration: 120, buffering: false, ...overrides },
    delayMs,
  });
}

test('guest seeks, pauses, sets rate, and respects paused drift tolerance', () => {
  const env = setup({ video: { paused: false } });
  env.send('SET_ROLE', { role: 'guest' });
  apply(env, { rate: 1.5 });
  assert.equal(env.videos[0].paused, true);
  assert.equal(env.videos[0].currentTime, 20);
  assert.equal(env.videos[0].playbackRate, 1.5);
  apply(env, { time: 20.3 });
  assert.equal(env.videos[0].seeks.length, 1);
  apply(env, { time: 21 });
  assert.equal(env.videos[0].currentTime, 21);
});

test('playing state extrapolates elapsed time and caps network delay at two seconds', () => {
  const env = setup({ video: { paused: false } });
  env.send('SET_ROLE', { role: 'guest' });
  apply(env, { paused: false, rate: 2 }, 9000);
  assert.equal(env.videos[0].currentTime, 24);
  env.advance(500);
  assert.equal(env.videos[0].seeks.length, 1);
  env.advance(500);
  assert.equal(env.videos[0].currentTime, 26);
});

test('host buffering pauses guest and does not extrapolate', () => {
  const env = setup({ video: { paused: false } });
  env.send('SET_ROLE', { role: 'guest' });
  apply(env, { paused: false, buffering: true }, 2000);
  env.advance(3000);
  assert.equal(env.videos[0].paused, true);
  assert.equal(env.videos[0].currentTime, 20);
  assert.equal(env.videos[0].playCalls, 0);
});

test('host role never applies remote state; null role and reset leave playback alone', () => {
  const env = setup({ video: { paused: false, time: 8 } });
  env.send('SET_ROLE', { role: 'host' });
  apply(env);
  env.advance(2000);
  assert.equal(env.videos[0].currentTime, 8);
  assert.equal(env.videos[0].paused, false);
  env.send('SET_ROLE', { role: 'guest' });
  apply(env);
  env.send('SET_ROLE', { role: null });
  env.videos[0].time = 7;
  env.videos[0].paused = false;
  env.advance(2000);
  assert.equal(env.videos[0].currentTime, 7);
  assert.equal(env.videos[0].paused, false);
  env.send('SET_ROLE', { role: 'guest' });
  apply(env);
  env.send('RESET');
  env.videos[0].time = 9;
  env.advance(2000);
  assert.equal(env.videos[0].currentTime, 9);
});

test('autoplay rejection reports a friendly notice and playing clears it', async () => {
  const env = setup({ video: { playResult: () => Promise.reject(new Error('NotAllowedError')) } });
  env.send('SET_ROLE', { role: 'guest' });
  apply(env, { paused: false });
  await Promise.resolve();
  assert.equal(env.report.notice, AUTOPLAY_NOTICE);
  assert.equal(env.videos[0].paused, true);
  env.videos[0].paused = false;
  env.emit('playing');
  assert.equal(env.report.notice, null);
});

test('overlapping play promises are guarded and stale rejections do not restore notices', async () => {
  let reject;
  const env = setup({ video: { playResult: () => new Promise((_, fail) => { reject = fail; }) } });
  env.send('SET_ROLE', { role: 'guest' });
  apply(env, { paused: false });
  env.advance(2500);
  apply(env, { paused: false });
  assert.equal(env.videos[0].playCalls, 1);
  env.send('SET_ROLE', { role: null });
  reject(new Error('NotAllowedError'));
  await Promise.resolve();
  assert.equal(env.report.notice, null);
});

test('does not seek during local seeking or missing metadata and clamps near the end', () => {
  const env = setup({ video: { seeking: true } });
  env.send('SET_ROLE', { role: 'guest' });
  apply(env);
  assert.equal(env.videos[0].seeks.length, 0);
  env.videos[0].seeking = false;
  env.videos[0].readyState = 0;
  env.advance(500);
  assert.equal(env.videos[0].seeks.length, 0);
  env.videos[0].readyState = 4;
  apply(env, { time: 200 });
  assert.equal(env.videos[0].currentTime, 119.9);
});

test('largest visible viable video wins and replacement inherits the last state', () => {
  const env = setup();
  const small = env.videos[0];
  const large = new env.Video({ rect: { left: 0, top: 0, right: 1000, bottom: 600 } });
  env.videos.push(large, new env.Video({ duration: Infinity }),
    new env.Video({ rect: { left: 2000, right: 3000, top: 0, bottom: 700 } }));
  env.send('REPORT_REQUEST');
  assert.equal(env.report.area, 600000);
  env.send('SET_ROLE', { role: 'guest' });
  apply(env);
  assert.equal(large.currentTime, 20);
  assert.equal(small.currentTime, 0);
  const replacement = new env.Video();
  env.videos.splice(0, env.videos.length, replacement);
  env.mutate();
  env.advance(250);
  assert.equal(replacement.currentTime, 20);
  assert.equal(replacement.paused, true);
});

test('mutation storms are throttled and unavailable reports continue every 1500ms', () => {
  const env = setup({ empty: true });
  assert.equal(env.report.available, false);
  assert.equal(env.report.area, 0);
  for (let i = 0; i < 100; i += 1) env.mutate();
  assert.equal(env.scans, 1);
  env.advance(250);
  assert.equal(env.scans, 2);
  const count = env.messages.length;
  env.advance(4250);
  assert.equal(env.messages.length, count + 3);
  assert.equal(env.report.available, false);
  const video = new env.Video({ duration: NaN, readyState: 0 });
  env.videos.push(video);
  env.mutate();
  env.advance(250);
  assert.equal(env.report.available, false);
  video.duration = 120;
  video.readyState = 4;
  env.emit('loadedmetadata', video);
  env.advance(250);
  assert.equal(env.report.available, true);
  env.videos.length = 0;
  env.mutate();
  env.advance(1500);
  assert.equal(env.report.available, false);
});

test('video events report state without URLs or window message listeners', () => {
  const env = setup();
  for (const event of ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'waiting', 'playing', 'loadedmetadata']) {
    const count = env.messages.length;
    env.emit(event);
    assert.ok(env.messages.length > count);
    assert.equal(env.report.state.buffering, event === 'waiting');
  }
  assert.deepEqual(Object.keys(env.messages.at(-1)), ['target', 'action', 'payload']);
  assert.equal(env.messages.at(-1).target, 'broker');
  assert.equal(env.messages.at(-1).action, 'PLAYER_REPORT');
  assert.deepEqual(Object.keys(env.report), ['available', 'area', 'state', 'notice', 'ad']);
  assert.equal(env.listeners.has('message'), false);
});

test('malformed messages are ignored and playback rate errors are caught', () => {
  const env = setup();
  env.send('SET_ROLE', { role: 'guest' });
  for (const state of [{ time: NaN }, { paused: 'false' }, { rate: -1 }, { duration: Infinity }, { buffering: 1 }]) {
    apply(env, state);
  }
  apply(env, {}, NaN);
  env.runtimeListeners.forEach((fn) => {
    fn(null);
    fn({ target: 'other', action: 'RESET' });
    fn({ target: 'player', action: 'APPLY_STATE' });
  });
  assert.equal(env.videos[0].seeks.length, 0);
  Object.defineProperty(env.videos[0], 'playbackRate', {
    get: () => 1,
    set: () => { throw new Error('Unsupported rate'); },
  });
  assert.doesNotThrow(() => apply(env, { rate: 3 }));
  assert.equal(env.videos[0].currentTime, 20);
});

test('extension invalidation stops timers, observer, and listeners', () => {
  const env = setup();
  env.mutate();
  env.invalidate();
  env.send('REPORT_REQUEST');
  assert.equal(env.timers.size, 0);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.runtimeListeners.size, 0);
  assert.equal(env.observers[0].disconnected, true);
  const count = env.messages.length;
  env.advance(6000);
  assert.equal(env.messages.length, count);
});

test('states expire at eight seconds, leave local controls alone, and resume on a fresh snapshot', () => {
  const env = setup();
  env.send('SET_ROLE', { role: 'guest' });
  apply(env);
  env.advance(7500);
  const player = env.videos[0];
  player.time = 5;
  player.paused = false;
  player.playbackRate = 2;
  env.advance(500);
  assert.equal(player.currentTime, 5);
  assert.equal(player.paused, false);
  assert.equal(player.playbackRate, 2);
  env.advance(5000);
  assert.equal(player.currentTime, 5);
  assert.equal(player.paused, false);
  const replacement = new env.Video({ time: 10, paused: false });
  env.videos.splice(0, 1, replacement);
  env.send('REPORT_REQUEST');
  assert.equal(replacement.currentTime, 10);
  assert.equal(replacement.paused, false);
  apply(env, { time: 40 });
  assert.equal(replacement.currentTime, 40);
  assert.equal(replacement.paused, true);
});

test('expired playing states do not restart playback', () => {
  const env = setup({ video: { paused: false } });
  env.send('SET_ROLE', { role: 'guest' });
  apply(env, { paused: false });
  env.advance(8000);
  env.videos[0].paused = true;
  const time = env.videos[0].currentTime;
  env.advance(3000);
  assert.equal(env.videos[0].playCalls, 0);
  assert.equal(env.videos[0].currentTime, time);
});

test('rate must be finite, positive, and at most sixteen', () => {
  const env = setup();
  env.send('SET_ROLE', { role: 'guest' });
  for (const rate of [0, -1, 16.01, Infinity, NaN, '1']) apply(env, { rate });
  assert.equal(env.videos[0].seeks.length, 0);
  assert.equal(env.videos[0].playbackRate, 1);
  apply(env, { rate: 16 });
  assert.equal(env.videos[0].playbackRate, 16);
  apply(env, { rate: 0.25 });
  assert.equal(env.videos[0].playbackRate, 0.25);
});

test('guest clicks on play/pause become intents; extension-driven and site-driven toggles do not', async () => {
  const env = setup();
  const [video] = env.videos;
  env.send('SET_ROLE', { role: 'guest' });
  apply(env, { paused: false });
  env.emit('play');
  await Promise.resolve();
  const intents = () => env.messages.filter((message) => message.action === 'PLAYER_INTENT').map((message) => message.payload);
  assert.deepEqual(intents(), []);
  // The site pausing by itself (no user activation) is reverted by the sync loop.
  video.paused = true;
  env.emit('pause');
  assert.deepEqual(intents(), []);
  env.advance(500);
  assert.equal(video.paused, false);
  env.emit('play');
  await Promise.resolve();
  env.userActivation.isActive = true;
  video.paused = true;
  env.emit('pause');
  assert.deepEqual(intents(), [{ paused: true }]);
  // The local pause is kept while the host catches up, even against stale host packets.
  apply(env, { paused: false, time: 21 });
  env.advance(1000);
  assert.equal(video.paused, true);
  // Once the host confirms, normal sync resumes.
  apply(env, { paused: true, time: 22 });
  assert.equal(video.time, 22);
  video.paused = false;
  env.emit('play');
  assert.deepEqual(intents(), [{ paused: true }, { paused: false }]);
});

test('host applies CONTROL from guests, and guests or unbound frames ignore it', () => {
  const env = setup();
  const [video] = env.videos;
  env.send('SET_ROLE', { role: 'guest' });
  env.send('CONTROL', { paused: false });
  assert.equal(video.playCalls, 0);
  env.send('SET_ROLE', { role: 'host' });
  env.send('CONTROL', { paused: false });
  assert.equal(video.playCalls, 1);
  env.send('CONTROL', { paused: true });
  assert.equal(video.pauseCalls, 1);
  env.send('CONTROL', { paused: 'no' });
  assert.equal(video.playCalls + video.pauseCalls, 2);
});

function adPlayer(env) {
  const flags = new Set();
  env.videos[0].closest = (selector) => (selector === '.html5-video-player' ? { classList: { contains: (name) => flags.has(name) } } : null);
  return {
    start() { flags.add('ad-showing'); env.mutate(); env.advance(300); },
    end() { flags.delete('ad-showing'); env.mutate(); env.advance(300); },
  };
}

test('a guest watching an ad reports it and is left alone until it ends', () => {
  const env = setup();
  const [video] = env.videos;
  const ads = adPlayer(env);
  env.send('SET_ROLE', { role: 'guest' });
  ads.start();
  assert.equal(env.report.ad, true);
  video.time = 3;
  apply(env, { time: 50, paused: true });
  env.advance(1000);
  assert.deepEqual(video.seeks, []);
  assert.equal(video.pauseCalls, 0);
  env.userActivation.isActive = true;
  video.paused = true;
  env.emit('pause');
  assert.equal(env.messages.some((message) => message.action === 'PLAYER_INTENT'), false);
  ads.end();
  assert.equal(env.report.ad, false);
  apply(env, { time: 50, paused: true });
  assert.equal(video.time, 50);
});

test('host HOLD pauses for a guest ad, defers guest play requests and resumes afterwards', () => {
  const env = setup({ video: { paused: false } });
  const [video] = env.videos;
  env.send('SET_ROLE', { role: 'host' });
  env.send('HOLD', { active: true });
  assert.equal(video.paused, true);
  env.send('HOLD', { active: true });
  assert.equal(video.pauseCalls, 1);
  env.send('CONTROL', { paused: false });
  assert.equal(video.playCalls, 0);
  env.send('HOLD', { active: false });
  assert.equal(video.playCalls, 1);
  // A host already paused stays paused when the hold ends.
  video.paused = true;
  env.send('HOLD', { active: true });
  env.send('HOLD', { active: false });
  assert.equal(video.playCalls, 1);
  // The host's own ad is never paused by a hold.
  const ads = adPlayer(env);
  video.paused = false;
  ads.start();
  env.send('HOLD', { active: true });
  assert.equal(video.paused, false);
});

test('RATE changes the host player speed only', () => {
  const env = setup();
  const [video] = env.videos;
  env.send('SET_ROLE', { role: 'guest' });
  env.send('RATE', { rate: 2 });
  assert.equal(video.playbackRate, 1);
  env.send('SET_ROLE', { role: 'host' });
  env.send('RATE', { rate: 1.5 });
  assert.equal(video.playbackRate, 1.5);
  assert.equal(env.report.state.rate, 1.5);
  for (const rate of [0, -1, 17, NaN, '2']) env.send('RATE', { rate });
  assert.equal(video.playbackRate, 1.5);
});
