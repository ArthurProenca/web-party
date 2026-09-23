import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as protocol from '../extension/lib/protocol.js';
import { chromeSdp } from './fixtures/sdp.js';

const sources = Object.fromEntries(['background', 'offscreen'].map((name) => [name,
  readFileSync(new URL(`../extension/${name}.js`, import.meta.url), 'utf8'),
]));
const tab = { id: 7, url: 'https://www.youtube.com/watch?v=video-one', title: 'First video' };
const playback = { time: 20, paused: true, rate: 1, duration: 120, buffering: false };
const description = (type) => ({ type, sdp: `v=0\r\na=fingerprint:sha-256 AA:BB\r\na=setup:${type === 'offer' ? 'actpass' : 'active'}\r\n` });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const FOLLOW_WAIT = 10001;

async function setup(t, { saved = null, activeTab = tab, iceComplete = true } = {}) {
  const id = 'test-extension';
  const url = (path) => `chrome-extension://${id}/${path}`;
  const listeners = new Map();
  const timers = new Map();
  const connections = [];
  const playerCalls = [];
  const writes = [];
  const notifications = [];
  const navigations = [];
  const tabEvents = {};
  let session = structuredClone(saved);
  let now = 0;
  let timerId = 0;
  const epoch = Date.now();

  function timer(callback, delay, repeat = 0) {
    const key = ++timerId;
    timers.set(key, { callback, at: now + delay, repeat });
    return key;
  }

  class Channel {
    constructor(label = 'web-party') {
      this.label = label;
      this.readyState = 'connecting';
      this.bufferedAmount = 0;
      this.sent = [];
    }
    send(data) {
      assert.equal(this.readyState, 'open');
      this.sent.push(JSON.parse(data));
    }
    open() { this.readyState = 'open'; this.onopen?.(); }
    receive(message) { this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) }); }
    close() { this.readyState = 'closed'; this.onclose?.(); }
  }

  class PeerConnection {
    constructor(config) {
      this.config = structuredClone(config);
      this.connectionState = 'new';
      this.signalingState = 'stable';
      this.iceGatheringState = iceComplete ? 'complete' : 'gathering';
      this.events = new Map();
      this.remoteDescriptions = [];
      connections.push(this);
    }
    createDataChannel(label, options) {
      this.channelOptions = structuredClone(options);
      this.channel = new Channel(label);
      return this.channel;
    }
    async createOffer() { return description('offer'); }
    async createAnswer() {
      assert.equal(this.signalingState, 'have-remote-offer');
      return description('answer');
    }
    async setLocalDescription(value) {
      assert.equal(this.signalingState, value.type === 'offer' ? 'stable' : 'have-remote-offer');
      const copy = structuredClone(value);
      this.localDescription = { ...copy, toJSON: () => structuredClone(copy) };
      this.signalingState = value.type === 'offer' ? 'have-local-offer' : 'stable';
    }
    async setRemoteDescription(value) {
      assert.equal(this.signalingState, value.type === 'offer' ? 'stable' : 'have-local-offer');
      this.remoteDescription = structuredClone(value);
      this.remoteDescriptions.push(this.remoteDescription);
      this.signalingState = value.type === 'offer' ? 'have-remote-offer' : 'stable';
    }
    addEventListener(type, listener) {
      if (!this.events.has(type)) this.events.set(type, new Set());
      this.events.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.events.get(type)?.delete(listener); }
    emit(type) {
      this[`on${type}`]?.();
      for (const listener of this.events.get(type) || []) listener();
    }
    connect() {
      if (!this.channel) {
        this.channel = new Channel();
        this.ondatachannel?.({ channel: this.channel });
      }
      this.connectionState = 'connected';
      this.emit('connectionstatechange');
      this.channel.open();
      return this.channel;
    }
    async addIceCandidate(candidate) { (this.addedCandidates ||= []).push(structuredClone(candidate)); }
    changeState(value) { this.connectionState = value; this.emit('connectionstatechange'); }
    close() { this.changeState('closed'); this.signalingState = 'closed'; }
  }

  function dispatch(target, message, sender) {
    return new Promise((resolve, reject) => {
      try {
        const listening = listeners.get(target)?.(structuredClone(message), sender,
          (response) => resolve(structuredClone(response)));
        if (listening !== true) resolve(undefined);
      } catch (error) { reject(error); }
    });
  }

  function runtime(name) {
    return {
      id, getURL: url,
      getContexts: async () => [{ documentUrl: url('offscreen.html') }],
      onMessage: { addListener: (listener) => listeners.set(name, listener) },
      async sendMessage(message) {
        if (message.target === 'popup') {
          notifications.push(structuredClone(message.payload));
          return;
        }
        assert.ok(['broker', 'offscreen'].includes(message.target));
        return dispatch(message.target === 'broker' ? 'background' : 'offscreen', message,
          { id, url: url(`${name}.html`) });
      },
    };
  }

  // Only replace the static import; production logic runs unchanged, with no VM module flags.
  for (const name of ['background', 'offscreen']) {
    const source = sources[name].replace(
      /^import \{([^}]+)\} from '\.\/lib\/protocol\.js';/,
      'const {$1} = protocol;',
    );
    assert.notEqual(source, sources[name], 'expected a single protocol import');
    vm.runInNewContext(source, {
      protocol, structuredClone, URL, crypto: { randomUUID }, RTCPeerConnection: PeerConnection,
      Date: class extends Date { static now() { return epoch + now; } },
      performance: { now: () => now },
      setTimeout: (callback, delay) => timer(callback, delay),
      clearTimeout: (key) => timers.delete(key),
      setInterval: (callback, delay) => timer(callback, delay, delay),
      clearInterval: (key) => timers.delete(key),
      chrome: {
        runtime: runtime(name),
        storage: { session: {
          async get(key) { assert.equal(key, 'session'); return { session: structuredClone(session) }; },
          async set(value) { session = structuredClone(value.session); writes.push(session); },
        } },
        tabs: {
          query: async () => activeTab ? [structuredClone(activeTab)] : [],
          create: async ({ url: target }) => {
            navigations.push({ created: true, url: target });
            return { id: 8, url: target, title: 'Host video' };
          },
          async update(tabId, properties) {
            navigations.push(structuredClone({ tabId, ...properties }));
            return { id: tabId, url: properties.url, title: 'Loading' };
          },
          async sendMessage(tabId, message, options) {
            playerCalls.push(structuredClone({ tabId, ...message, ...options }));
          },
          onRemoved: { addListener: (listener) => { tabEvents.removed = listener; } },
          onUpdated: { addListener: (listener) => { tabEvents.updated = listener; } },
        },
      },
    }, { filename: `extension/${name}.js` });
  }
  t.after(() => { timers.clear(); listeners.clear(); });
  const env = {
    connections, playerCalls, writes, notifications, timers, navigations,
    get session() { return structuredClone(session); },
    raw(action, payload = {}, sender = { id, url: url('popup.html') }) {
      return dispatch('background', { target: 'broker', action, payload }, sender);
    },
    async command(action, payload = {}) {
      const response = await env.raw(action, payload);
      assert.equal(response?.ok, true, response?.error);
      await flush();
      return response.data;
    },
    async report(overrides = {}, senderTab = tab, frameId = 0) {
      const response = await env.raw('PLAYER_REPORT', {
        available: true, area: 360000, state: playback, ...overrides,
      }, { id, tab: senderTab, frameId });
      assert.equal(response.ok, true, response.error);
      await flush();
    },
    async update(nextTab, change = { url: nextTab.url }) {
      tabEvents.updated(nextTab.id, change, nextTab);
      await flush();
    },
    async remove(tabId) { tabEvents.removed(tabId); await flush(); },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, value]) => value.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [key, value] = next;
        now = value.at;
        if (value.repeat) value.at += value.repeat;
        else timers.delete(key);
        value.callback();
        await flush();
      }
      now = end;
      await flush();
    },
  };
  await env.command('GET_STATE');
  return env;
}

async function join(t, options = {}) {
  const env = await setup(t, options);
  const offer = {
    version: 1, type: 'offer', partyId: randomUUID(), inviteId: randomUUID(),
    name: 'Host', createdAt: Date.now(), description: description('offer'),
  };
  const state = await env.command('JOIN', { name: 'Guest', code: await protocol.encodeCode(offer) });
  return { env, offer, state, pc: env.connections[0] };
}

function sendPlayback(channel, url = tab.url, state = playback) {
  channel.receive({ type: 'playback', media: url === null ? null : { url, title: 'Host video' }, state });
}

test('CREATE produces a real offer that survives popup GET_STATE and serialized storage writes', async (t) => {
  const env = await setup(t);
  const created = await env.command('CREATE', { name: '  Host  ', useStun: false });
  const offer = await protocol.decodeCode(created.invitation.code);
  assert.equal(offer.type, 'offer');
  assert.equal(offer.partyId, created.party.id);
  assert.equal(offer.inviteId, created.invitation.id);
  assert.equal(offer.name, 'Host');
  assert.deepEqual(offer.description, description('offer'));
  assert.equal(created.party.role, 'host');
  assert.equal(created.busy, null);
  assert.equal(created.peers[0].status, 'waiting');
  assert.deepEqual(env.connections[0].config.iceServers, []);
  assert.deepEqual(env.connections[0].channelOptions, { ordered: true });
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await env.command('GET_STATE'), created);
  assert.deepEqual(env.session, created);
  assert.deepEqual(env.notifications.at(-1), created);
  assert.ok(env.playerCalls.some((call) => call.action === 'REPORT_REQUEST' && call.tabId === tab.id));
  created.invitation.code = 'mutated popup copy';
  assert.equal((await env.command('GET_STATE')).invitation.code, env.session.invitation.code);
});

test('JOIN applies the offer and returns an answer with matching invitation and guest identity', async (t) => {
  const { env, offer, state, pc } = await join(t, { activeTab: null });
  const answer = await protocol.decodeCode(state.answer);
  assert.deepEqual(pc.remoteDescription, offer.description);
  assert.equal(answer.type, 'answer');
  assert.equal(answer.partyId, offer.partyId);
  assert.equal(answer.inviteId, offer.inviteId);
  assert.equal(answer.name, 'Guest');
  assert.deepEqual(answer.description, description('answer'));
  assert.equal(state.party.role, 'guest');
  assert.equal(state.local, null);
  assert.equal(state.peers[0].status, 'waiting');
  assert.deepEqual((await env.command('GET_STATE')).answer, state.answer);
  pc.connect();
  const connected = await env.command('GET_STATE');
  assert.equal(connected.peers[0].status, 'connected');
  assert.equal(connected.answer, null);
});

test('ACCEPT rejects wrong type, party, invitation and reused answers without consuming the valid offer', async (t) => {
  const host = await setup(t);
  const created = await host.command('CREATE', { name: 'Host' });
  const guest = await setup(t);
  const joined = await guest.command('JOIN', { name: 'Guest', code: created.invitation.code });
  const answer = await protocol.decodeCode(joined.answer);
  const invalid = [created.invitation.code,
    await protocol.encodeCode({ ...answer, partyId: randomUUID() }),
    await protocol.encodeCode({ ...answer, inviteId: randomUUID() })];
  for (const code of invalid) {
    const response = await host.raw('ACCEPT', { code });
    assert.equal(response.ok, false);
    assert.match(response.error, /party|convite/i);
    assert.equal((await host.command('GET_STATE')).invitation.code, created.invitation.code);
    assert.equal(host.connections[0].remoteDescriptions.length, 0);
  }
  const accepted = await host.command('ACCEPT', { code: joined.answer });
  assert.equal(accepted.invitation, null);
  assert.equal(accepted.peers[0].status, 'connecting');
  assert.equal(accepted.peers[0].name, 'Guest');
  assert.deepEqual(host.connections[0].remoteDescription, answer.description);
  const reused = await host.raw('ACCEPT', { code: joined.answer });
  assert.equal(reused.ok, false);
  assert.match(reused.error, /usado|cancelado|expirou/);
  assert.equal(host.connections[0].remoteDescriptions.length, 1);
  host.connections[0].connect();
  assert.equal((await host.command('GET_STATE')).peers[0].status, 'connected');
  assert.equal((await host.raw('ACCEPT', { code: joined.answer })).ok, false);
});

test('replacing an invitation closes its peer and rejects its obsolete answer', async (t) => {
  const host = await setup(t);
  const first = await host.command('CREATE', { name: 'Host' });
  const guest = await setup(t);
  const joined = await guest.command('JOIN', { name: 'Guest', code: first.invitation.code });
  const next = await host.command('INVITE');
  assert.notEqual(next.invitation.id, first.invitation.id);
  assert.equal(next.peers.length, 1);
  assert.equal(host.connections[0].connectionState, 'closed');
  assert.equal(host.connections[0].channel.readyState, 'closed');
  assert.equal((await host.raw('ACCEPT', { code: joined.answer })).ok, false);
  assert.equal((await host.command('GET_STATE')).invitation.id, next.invitation.id);
});

test('interrupted storage restores preferences, not a fake connected party or saved signaling codes', async (t) => {
  const live = await setup(t);
  await live.command('CREATE', { name: 'Remember me', useStun: false });
  live.connections[0].connect();
  const saved = await live.command('GET_STATE');
  const restored = await setup(t, { saved });
  const state = await restored.command('GET_STATE');
  assert.equal(state.party, null);
  assert.deepEqual(state.peers, []);
  assert.equal(state.invitation, null);
  assert.equal(state.answer, null);
  assert.equal(state.local, null);
  assert.equal(state.remoteMedia, null);
  assert.deepEqual(state.preferences, saved.preferences);
  assert.match(state.message, /interrompida/);
  assert.equal(restored.connections.length, 0);
  assert.ok(restored.playerCalls.some((call) => call.action === 'RESET' && call.tabId === tab.id));
  assert.deepEqual(restored.session, state);
  const fresh = await restored.command('CREATE', { name: 'Remember me' });
  assert.notEqual(fresh.party.id, saved.party.id);
});

test('host ignores guest playback, roster and end packets while broadcasting its own player state', async (t) => {
  const env = await setup(t);
  await env.command('CREATE', { name: 'Host' });
  const channel = env.connections[0].connect();
  await env.report();
  const before = await env.command('GET_STATE');
  env.playerCalls.length = 0;
  sendPlayback(channel, 'https://www.youtube.com/watch?v=other', { ...playback, time: 90 });
  channel.receive({ type: 'roster', count: 9 });
  channel.receive({ type: 'end' });
  assert.deepEqual(await env.command('GET_STATE'), before);
  assert.deepEqual(env.playerCalls, []);
  assert.ok(channel.sent.some((message) => message.type === 'playback' && message.state?.time === 20));
});

test('guest starts uncontrolled and becomes guest only when a connected host shares the same video', async (t) => {
  const { env, pc } = await join(t);
  await env.report();
  assert.equal(env.playerCalls.filter((call) => call.action === 'SET_ROLE').at(-1).payload.role, null);
  assert.equal(env.playerCalls.some((call) => call.action === 'APPLY_STATE'), false);
  const channel = pc.connect();
  sendPlayback(channel);
  await flush();
  const role = env.playerCalls.findIndex((call) => call.action === 'SET_ROLE' && call.payload.role === 'guest');
  const apply = env.playerCalls.findIndex((call) => call.action === 'APPLY_STATE');
  assert.ok(role >= 0 && apply > role);
  assert.equal(env.playerCalls[apply].frameId, 0);
  assert.deepEqual(env.playerCalls[apply].payload.state, playback);
});

test('same-video guard blocks unrelated media but accepts alternate URLs for the same video', async (t) => {
  const { env, pc } = await join(t);
  await env.report();
  const channel = pc.connect();
  env.playerCalls.length = 0;
  sendPlayback(channel, 'https://www.youtube.com/watch?v=video-two');
  await flush();
  assert.equal(env.playerCalls.some((call) => call.action === 'APPLY_STATE'), false);
  assert.equal(env.playerCalls.some((call) => call.action === 'SET_ROLE' && call.payload.role === 'guest'), false);
  sendPlayback(channel, 'https://m.youtube.com/shorts/video-one?t=5');
  await flush();
  assert.ok(env.playerCalls.some((call) => call.action === 'APPLY_STATE'));
  env.playerCalls.length = 0;
  sendPlayback(channel, 'https://www.crunchyroll.com/watch/video-one');
  await flush();
  assert.ok(env.playerCalls.some((call) => call.action === 'RESET'));
  assert.equal(env.playerCalls.some((call) => call.action === 'APPLY_STATE'), false);
});

test('playback resumption on unchanged media promotes an initially uncontrolled frame to guest', async (t) => {
  const { env, pc } = await join(t);
  const channel = pc.connect();
  sendPlayback(channel, tab.url, null);
  await env.report();
  assert.equal(env.playerCalls.filter((call) => call.action === 'SET_ROLE').at(-1).payload.role, null);
  env.playerCalls.length = 0;
  sendPlayback(channel);
  await flush();
  const role = env.playerCalls.findIndex((call) => call.action === 'SET_ROLE' && call.payload.role === 'guest');
  const apply = env.playerCalls.findIndex((call) => call.action === 'APPLY_STATE');
  assert.ok(role >= 0 && apply > role, 'resumed playback must set guest role before APPLY_STATE');
});

test('disconnect resets guest playback and reconnect requires a fresh sample and guest role', async (t) => {
  const { env, pc } = await join(t);
  const channel = pc.connect();
  await env.report();
  sendPlayback(channel);
  await flush();
  env.playerCalls.length = 0;
  pc.changeState('disconnected');
  assert.equal((await env.command('GET_STATE')).peers[0].status, 'disconnected');
  assert.ok(env.playerCalls.some((call) => call.action === 'RESET'));
  await env.report();
  env.playerCalls.length = 0;
  pc.changeState('connected');
  await flush();
  assert.equal(env.playerCalls.some((call) => call.action === 'APPLY_STATE'), false);
  sendPlayback(channel);
  await flush();
  assert.ok(env.playerCalls.some((call) => call.action === 'SET_ROLE' && call.payload.role === 'guest'),
    'reconnected frame must regain guest role even when its frame ID and media are unchanged');
  assert.ok(env.playerCalls.some((call) => call.action === 'APPLY_STATE'));
  await env.advance(15000);
  assert.equal((await env.command('GET_STATE')).peers[0].status, 'connected');
});

test('disconnect timeout closes guest transport, clears the answer and leaves player reset', async (t) => {
  const { env, pc } = await join(t);
  pc.connect();
  pc.changeState('disconnected');
  await env.advance(15000);
  const state = await env.command('GET_STATE');
  assert.equal(state.peers[0].status, 'failed');
  assert.equal(state.answer, null);
  assert.equal(pc.connectionState, 'closed');
  assert.equal(pc.channel.readyState, 'closed');
  assert.match(state.message, /convite|reconectar/);
  assert.ok(env.playerCalls.some((call) => call.action === 'RESET'));
  assert.equal(env.playerCalls.some((call) => call.action === 'APPLY_STATE'), false);
});

test('host URL updates discard old samples and publish new media; unsupported navigation unbinds', async (t) => {
  const env = await setup(t);
  await env.command('CREATE', { name: 'Host' });
  const channel = env.connections[0].connect();
  await env.report();
  env.playerCalls.length = 0;
  const next = { ...tab, url: 'https://www.youtube.com/watch?v=video-two', title: 'Second video' };
  await env.update(next);
  let state = await env.command('GET_STATE');
  assert.equal(state.local.url, next.url);
  assert.equal(state.local.available, false);
  assert.deepEqual(channel.sent.filter((message) => message.type === 'playback').at(-1),
    { type: 'playback', state: null, media: { url: next.url, title: next.title }, hold: [] });
  assert.deepEqual(env.playerCalls.map((call) => call.action), ['RESET', 'REPORT_REQUEST']);
  await env.report({ state: { ...playback, time: 3 } }, next);
  assert.equal(channel.sent.filter((message) => message.type === 'playback').at(-1).state.time, 3);
  env.playerCalls.length = 0;
  await env.update({ ...next, title: 'Updated title after SPA navigation' }, { title: 'Updated title after SPA navigation' });
  assert.equal((await env.command('GET_STATE')).local.title, 'Updated title after SPA navigation');
  assert.deepEqual(env.playerCalls, []);
  assert.equal(channel.sent.filter((message) => message.type === 'playback').at(-1).state.time, 3);
  await env.update({ ...next, url: 'https://example.com/' });
  state = await env.command('GET_STATE');
  assert.equal(state.local, null);
  assert.match(state.message, /aba/);
  assert.deepEqual(channel.sent.filter((message) => message.type === 'playback').at(-1),
    { type: 'playback', state: null, media: null, hold: [] });
});

test('guest navigation resets the old frame and only applies playback after matching-video reports', async (t) => {
  const { env, pc } = await join(t);
  const channel = pc.connect();
  await env.report();
  sendPlayback(channel);
  await flush();
  env.playerCalls.length = 0;
  const other = { ...tab, url: 'https://www.youtube.com/watch?v=video-two' };
  await env.update(other);
  await env.report({}, other);
  sendPlayback(channel);
  await flush();
  assert.ok(env.playerCalls.some((call) => call.action === 'RESET'));
  assert.equal(env.playerCalls.some((call) => call.action === 'APPLY_STATE'), false);
  env.playerCalls.length = 0;
  await env.update(tab);
  assert.equal(env.playerCalls.some((call) => call.action === 'APPLY_STATE'), false);
  await env.report();
  assert.ok(env.playerCalls.some((call) => call.action === 'SET_ROLE' && call.payload.role === 'guest'));
  assert.ok(env.playerCalls.some((call) => call.action === 'APPLY_STATE'));
  await env.remove(tab.id);
  assert.equal((await env.command('GET_STATE')).local, null);
});

test('broker uses sender tab/frame identities, rejects privileged player messages and ignores unrelated tabs', async (t) => {
  const env = await setup(t);
  await env.command('CREATE', { name: 'Host' });
  const before = await env.command('GET_STATE');
  await env.report({ tabId: tab.id, frameId: 0 }, { ...tab, id: 99 }, 4);
  await env.update({ ...tab, id: 99, url: 'https://example.com/' });
  await env.remove(99);
  assert.deepEqual(await env.command('GET_STATE'), before);
  const response = await env.raw('SESSION_SET', { party: null }, { id: 'test-extension', tab, frameId: 0 });
  assert.equal(response.ok, false);
  assert.match(response.error, /autorizada/);
  await env.report({ tabId: 99, frameId: 99 }, tab, 4);
  assert.ok(env.playerCalls.some((call) => call.action === 'SET_ROLE' && call.tabId === tab.id && call.frameId === 4));
});

test('LEAVE closes transports, resets player and permits a fresh party without stale callbacks', async (t) => {
  const env = await setup(t);
  const first = await env.command('CREATE', { name: 'Host' });
  const pc = env.connections[0];
  const channel = pc.connect();
  await env.report();
  const staleOpen = channel.onopen;
  const left = await env.command('LEAVE');
  assert.equal(left.party, null);
  assert.equal(left.local, null);
  assert.equal(left.invitation, null);
  assert.equal(left.answer, null);
  assert.deepEqual(left.peers, []);
  assert.equal(channel.sent.at(-1).type, 'end');
  assert.equal(channel.readyState, 'closed');
  assert.equal(pc.connectionState, 'closed');
  assert.equal(channel.onmessage, null);
  assert.equal(pc.onconnectionstatechange, null);
  const fresh = await env.command('CREATE', { name: 'New host' });
  staleOpen();
  assert.notEqual(fresh.party.id, first.party.id);
  assert.deepEqual(await env.command('GET_STATE'), fresh);
  assert.equal([...env.timers.values()].filter((timer) => !timer.repeat).length, 0);
});

test('ICE gathering keeps CREATE busy but GET_STATE available until the offer is complete', async (t) => {
  const env = await setup(t, { iceComplete: false });
  const pending = env.raw('CREATE', { name: 'Host' });
  await flush();
  const gathering = await env.command('GET_STATE');
  assert.equal(gathering.busy, 'CREATE');
  assert.equal(gathering.invitation, null);
  assert.equal(gathering.peers[0].status, 'gathering');
  assert.equal((await env.raw('INVITE')).ok, false);
  const pc = env.connections[0];
  pc.iceGatheringState = 'complete';
  pc.emit('icegatheringstatechange');
  const result = await pending;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.busy, null);
  assert.equal((await protocol.decodeCode(result.data.invitation.code)).type, 'offer');
  assert.equal([...env.timers.values()].filter((timer) => !timer.repeat).length, 0);
  assert.ok([...pc.events.values()].every((listeners) => listeners.size === 0));
});

test('ICE timeout frees the failed connection and allows another invitation', async (t) => {
  const env = await setup(t, { iceComplete: false });
  const pending = env.raw('CREATE', { name: 'Host' });
  await flush();
  await env.advance(20000);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /demorou/);
  const state = await env.command('GET_STATE');
  assert.equal(state.busy, null);
  assert.equal(state.invitation, null);
  assert.deepEqual(state.peers, []);
  assert.equal(env.connections[0].connectionState, 'closed');
  const retry = env.raw('INVITE');
  await flush();
  env.connections[1].iceGatheringState = 'complete';
  env.connections[1].emit('icegatheringstatechange');
  assert.equal((await retry).ok, true);
});

test('accepted answers time out rather than leaving a permanent connecting state', async (t) => {
  const host = await setup(t);
  const created = await host.command('CREATE', { name: 'Host' });
  const guest = await setup(t);
  const joined = await guest.command('JOIN', { name: 'Guest', code: created.invitation.code });
  await host.command('ACCEPT', { code: joined.answer });
  await host.advance(90000);
  const state = await host.command('GET_STATE');
  assert.equal(state.peers[0].status, 'failed');
  assert.match(state.message, /nao respondeu/);
  assert.equal(host.connections[0].connectionState, 'closed');
  assert.equal((await host.command('INVITE')).peers.length, 1);
});

test('guest ignores malformed or unsafe remote playback without changing its player', async (t) => {
  const { env, pc } = await join(t);
  const channel = pc.connect();
  await env.report();
  sendPlayback(channel);
  await flush();
  const before = await env.command('GET_STATE');
  env.playerCalls.length = 0;
  channel.receive('{not-json');
  channel.receive('x'.repeat(16001));
  channel.receive(null);
  sendPlayback(channel, 'https://youtube.com.evil.test/watch?v=video-one');
  sendPlayback(channel, tab.url, { ...playback, rate: 100 });
  sendPlayback(channel, tab.url, { ...playback, time: -1 });
  assert.deepEqual(await env.command('GET_STATE'), before);
  assert.deepEqual(env.playerCalls, []);
});

test('eight-guest limit and individual removal preserve other connected guests', async (t) => {
  const env = await setup(t);
  await env.command('CREATE', { name: 'Host' });
  for (let i = 0; i < 8; i++) {
    if (i > 0) await env.command('INVITE');
    env.connections[i].connect();
  }
  const full = await env.command('GET_STATE');
  assert.equal(full.peers.length, 8);
  assert.equal((await env.raw('INVITE')).ok, false);
  await env.command('REMOVE_PEER', { id: full.peers[0].id });
  assert.equal(env.connections[0].connectionState, 'closed');
  assert.ok(env.connections.slice(1).every((pc) => pc.channel.readyState === 'open'));
  const next = await env.command('INVITE');
  assert.equal(next.peers.length, 8);
  assert.ok(next.invitation);
});

test('guest party tab automatically follows the host video without popup interaction', async (t) => {
  const { env, pc } = await join(t);
  await env.report();
  const channel = pc.connect();
  const next = 'https://www.youtube.com/watch?v=video-two';
  sendPlayback(channel, next);
  await flush();
  assert.deepEqual(env.navigations, [{ tabId: tab.id, url: next, active: true }]);
  // Repeated host packets while the tab loads do not renavigate.
  sendPlayback(channel, next);
  await env.advance(3000);
  assert.equal(env.navigations.length, 1);
  const loaded = { ...tab, url: next, title: 'Second video' };
  await env.update(loaded);
  await env.report({}, loaded);
  env.playerCalls.length = 0;
  sendPlayback(channel, next);
  await flush();
  assert.ok(env.playerCalls.some((call) => call.action === 'APPLY_STATE'));
  // Only the host changes videos: a guest who wanders to another video is sent back.
  const wandered = { ...tab, url: 'https://www.youtube.com/watch?v=elsewhere' };
  await env.update(wandered);
  await env.advance(FOLLOW_WAIT);
  sendPlayback(channel, next);
  await flush();
  assert.deepEqual(env.navigations.at(-1), { tabId: tab.id, url: next, active: true });
});

test('guest without a party tab gets one opened, and a closed tab reopens only on a new host video', async (t) => {
  const { env, pc } = await join(t, { activeTab: null });
  const channel = pc.connect();
  sendPlayback(channel);
  await flush();
  assert.deepEqual(env.navigations, [{ created: true, url: tab.url }]);
  assert.equal((await env.command('GET_STATE')).local.tabId, 8);
  await env.remove(8);
  await env.advance(FOLLOW_WAIT);
  sendPlayback(channel);
  await flush();
  assert.equal(env.navigations.length, 1);
  sendPlayback(channel, 'https://www.youtube.com/watch?v=video-two');
  await flush();
  assert.deepEqual(env.navigations.at(-1), { created: true, url: 'https://www.youtube.com/watch?v=video-two' });
});

test('guest play/pause intents reach the host player; foreign or stale intents are ignored', async (t) => {
  const { env: guest, pc } = await join(t);
  await guest.report();
  const guestChannel = pc.connect();
  sendPlayback(guestChannel);
  await flush();
  const intent = (paused, frameId = 0, senderTab = tab) => guest.raw('PLAYER_INTENT', { paused },
    { id: 'test-extension', tab: senderTab, frameId });
  await intent(true, 3);
  await intent(true, 0, { ...tab, id: 99 });
  assert.equal(guestChannel.sent.some((message) => message.type === 'control'), false);
  await intent(true);
  assert.deepEqual(guestChannel.sent.filter((message) => message.type === 'control'),
    [{ type: 'control', paused: true, media: 'youtube:video-one' }]);

  const host = await setup(t);
  await host.command('CREATE', { name: 'Host' });
  const hostChannel = host.connections[0].connect();
  await host.report({ state: { ...playback, paused: false } });
  host.playerCalls.length = 0;
  hostChannel.receive({ type: 'control', paused: true, media: 'youtube:video-one' });
  hostChannel.receive({ type: 'control', paused: false, media: 'youtube:video-one' });
  await host.advance(500);
  hostChannel.receive({ type: 'control', paused: false, media: 'youtube:other' });
  hostChannel.receive({ type: 'control', paused: 'yes', media: 'youtube:video-one' });
  await flush();
  assert.deepEqual(host.playerCalls.filter((call) => call.action === 'CONTROL'),
    [{ tabId: tab.id, target: 'player', action: 'CONTROL', payload: { paused: true }, frameId: 0 }]);
});

test('a guest ad pauses the host player for everyone until the ad ends or goes silent', async (t) => {
  const { env: guest, pc } = await join(t);
  await guest.report();
  const guestChannel = pc.connect();
  sendPlayback(guestChannel);
  await flush();
  await guest.report({ ad: true });
  assert.deepEqual(guestChannel.sent.filter((message) => message.type === 'ad'), [{ type: 'ad', active: true }]);
  assert.equal((await guest.command('GET_STATE')).local.ad, true);
  await guest.report({ ad: false });
  assert.deepEqual(guestChannel.sent.filter((message) => message.type === 'ad').at(-1), { type: 'ad', active: false });

  const host = await setup(t);
  await host.command('CREATE', { name: 'Host' });
  const channel = host.connections[0].connect();
  await host.report({ state: { ...playback, paused: false } });
  const holds = () => host.playerCalls.filter((call) => call.action === 'HOLD').map((call) => call.payload.active);
  channel.receive({ type: 'ad', active: true });
  await flush();
  assert.deepEqual(holds(), [true]);
  assert.deepEqual(channel.sent.filter((message) => message.type === 'playback').at(-1).hold, ['Novo convidado']);
  assert.deepEqual((await host.command('GET_STATE')).adHold, ['Novo convidado']);
  channel.receive({ type: 'ad', active: false });
  await flush();
  assert.deepEqual(holds(), [true, false]);
  assert.deepEqual(channel.sent.filter((message) => message.type === 'playback').at(-1).hold, []);
  // A guest that stops refreshing its ad status releases the party.
  channel.receive({ type: 'ad', active: true });
  await flush();
  assert.equal(holds().at(-1), true);
  for (let i = 0; i < 5; i += 1) {
    await host.advance(1500);
    await host.report({ state: { ...playback, paused: true } });
  }
  assert.equal(holds().at(-1), false);
});

test('host ad freezes the shared position paused and names the host', async (t) => {
  const env = await setup(t);
  await env.command('CREATE', { name: 'Host' });
  const channel = env.connections[0].connect();
  await env.report({ state: { ...playback, time: 40, paused: false } });
  env.playerCalls.length = 0;
  await env.report({ ad: true, state: { ...playback, time: 2, duration: 15, paused: false } });
  await env.advance(4000);
  await env.report({ ad: true, state: { ...playback, time: 6, duration: 15, paused: false } });
  const last = channel.sent.filter((message) => message.type === 'playback').at(-1);
  assert.equal(last.state.paused, true);
  assert.equal(last.state.time, 40);
  assert.deepEqual(last.hold, ['Host']);
  assert.equal(env.playerCalls.some((call) => call.action === 'HOLD'), false);
  await env.report({ state: { ...playback, time: 40.5, paused: false } });
  const resumed = channel.sent.filter((message) => message.type === 'playback').at(-1);
  assert.equal(resumed.state.paused, false);
  assert.deepEqual(resumed.hold, []);
});

test('invitations carry a link to the host video, and pasted links or messages are accepted', async (t) => {
  const env = await setup(t);
  const created = await env.command('CREATE', { name: 'Host' });
  const link = new URL(created.invitation.link);
  assert.equal(link.origin + link.pathname + link.search, tab.url);
  assert.equal(link.hash, `#wp=${created.invitation.code}`);

  const offer = await protocol.decodeCode(created.invitation.code);
  const reply = await protocol.encodeCode({ version: 1, type: 'answer', partyId: offer.partyId, inviteId: offer.inviteId,
    name: 'Bia', createdAt: Date.now(), description: description('answer') });
  await env.command('ACCEPT', { code: `oi! aqui a resposta: ${reply} :)` });
  assert.equal((await env.command('GET_STATE')).peers[0].name, 'Bia');
});

test('video pages join through invite links from the top frame only and see only their own status', async (t) => {
  const env = await setup(t);
  const offer = {
    version: 1, type: 'offer', partyId: randomUUID(), inviteId: randomUUID(),
    name: 'Host', createdAt: Date.now(), description: description('offer'),
  };
  const code = await protocol.encodeCode(offer);
  const page = (action, payload, frameId = 0) => env.raw(action, payload, { id: 'test-extension', tab, frameId });
  assert.equal((await page('LINK_INVITE', { code }, 3)).ok, false);
  const info = await page('LINK_INVITE', { code });
  assert.deepEqual(info.data, { host: 'Host', name: '', inParty: false });
  const answerAsInvite = await protocol.encodeCode({ ...offer, type: 'answer', description: description('answer') });
  assert.match((await page('LINK_INVITE', { code: answerAsInvite })).error, /convite/);
  assert.equal((await page('LINK_JOIN', { code, name: 'Bia' }, 2)).ok, false);
  const joined = await page('LINK_JOIN', { code, name: 'Bia' });
  assert.equal(joined.ok, true, joined.error);
  assert.match(joined.data.answer, /^WP[12]\./);
  assert.deepEqual(Object.keys(joined.data), ['answer']);
  const state = await env.command('GET_STATE');
  assert.equal(state.party.role, 'guest');
  assert.equal(state.local.tabId, tab.id);
  assert.deepEqual((await page('LINK_STATUS')).data, { answer: joined.data.answer, connected: false, failed: false });
  const other = await env.raw('LINK_STATUS', {}, { id: 'test-extension', tab: { ...tab, id: 99 }, frameId: 0 });
  assert.deepEqual(other.data, { answer: null, connected: false, failed: false });
  env.connections[0].connect();
  await flush();
  assert.equal((await page('LINK_STATUS')).data.connected, true);
  assert.match((await page('LINK_JOIN', { code, name: 'Bia' })).error, /Saia da party/);
});

test('an unanswered peer survives ICE failure and keeps retrying until the other side pastes its code', async (t) => {
  const env = await setup(t);
  const offer = {
    version: 1, type: 'offer', partyId: randomUUID(), inviteId: randomUUID(),
    name: 'Host', createdAt: Date.now(), description: { type: 'offer', sdp: chromeSdp('offer') },
  };
  await env.command('JOIN', { name: 'Guest', code: await protocol.encodeCode(offer) });
  const pc = env.connections[0];
  pc.changeState('failed');
  await flush();
  let state = await env.command('GET_STATE');
  assert.equal(state.peers[0].status, 'waiting');
  assert.equal(state.message, null);
  await env.advance(10000);
  const rounds = (pc.addedCandidates || []).map((added) => added.candidate);
  assert.equal(rounds.length, 3);
  assert.ok(rounds.every((candidate) => /^candidate:r1x\d /.test(candidate)));
  await env.advance(10000);
  assert.ok(pc.addedCandidates.some((added) => added.candidate.startsWith('candidate:r2x0 ')));
  // The host finally answers: the same transport connects.
  pc.connect();
  await flush();
  state = await env.command('GET_STATE');
  assert.equal(state.peers[0].status, 'connected');
  const count = pc.addedCandidates.length;
  await env.advance(20000);
  assert.equal(pc.addedCandidates.length, count);
  // After a real connection, failure is final as before.
  pc.changeState('failed');
  await flush();
  assert.match((await env.command('GET_STATE')).message, /manter a conexao/);
});

test('only the host sets the speed, through its player, and everyone sees the resulting rate', async (t) => {
  const env = await setup(t);
  await env.command('CREATE', { name: 'Host' });
  const channel = env.connections[0].connect();
  let response = await env.raw('SET_RATE', { rate: 1.5 });
  assert.match(response.error, /player/);
  await env.report();
  for (const rate of [3, 0, '1.5', 1.1]) {
    response = await env.raw('SET_RATE', { rate });
    assert.match(response.error, /invalida/);
  }
  env.playerCalls.length = 0;
  await env.command('SET_RATE', { rate: 1.5 });
  assert.deepEqual(env.playerCalls, [{ tabId: tab.id, target: 'player', action: 'RATE', payload: { rate: 1.5 }, frameId: 0 }]);
  await env.report({ state: { ...playback, rate: 1.5 } });
  assert.equal((await env.command('GET_STATE')).rate, 1.5);
  assert.equal(channel.sent.filter((message) => message.type === 'playback').at(-1).state.rate, 1.5);

  const { env: guest, pc } = await join(t);
  await guest.report();
  assert.equal((await guest.command('GET_STATE')).rate, null);
  assert.match((await guest.raw('SET_RATE', { rate: 2 })).error, /host/);
  sendPlayback(pc.connect(), tab.url, { ...playback, rate: 2 });
  await flush();
  assert.equal((await guest.command('GET_STATE')).rate, 2);
});
