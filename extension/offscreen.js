import { decodeCode, encodeCode, extractCode, isSupportedUrl, mediaKey, normalizePlayback } from './lib/protocol.js';

const peers = new Map();
const frames = new Map();
const MAX_PEERS = 8;
const INVITE_TTL = 30 * 60 * 1000;
const FOLLOW_RETRY = 10000;
const ICE_RETRY = 10000;
const RATES = [1, 1.25, 1.5, 2];
// Guests refresh their ad status every 2s; a silent guest or a stuck ad cannot hold the party forever.
const AD_FRESH = 6000;
const AD_MAX = 3 * 60 * 1000;
let selectedFrame = null;
let selectedRole = null;
let localSample = null;
let remoteSample = null;
let lastRemoteAt = 0;
let followedKey = null;
let followAt = -Infinity;
let playerHeld = false;
let sentAd = false;
let persistQueue = Promise.resolve();
let state = {
  party: null, peers: [], invitation: null, answer: null, busy: null,
  local: null, remoteMedia: null, message: null, adHold: [],
  preferences: { name: '', useStun: true },
};

async function broker(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'broker', action, payload });
  if (!response?.ok) throw new Error(response?.error || 'Falha ao comunicar com a extensao.');
  return response.data;
}

function snapshot() {
  return structuredClone({ ...state,
    remoteReady: !!remoteSample && performance.now() - lastRemoteAt < 8000,
    rate: (state.party?.role === 'host' ? localSample?.state.rate : remoteSample?.rate) ?? null,
    peers: [...peers.values()].map((peer) => ({
    id: peer.id, name: peer.name, status: peer.status,
    latency: peer.rtt === null ? null : Math.round(peer.rtt / 2),
  })) });
}

function publish() {
  const value = snapshot();
  // Serialize writes so an older report cannot overwrite a more recent session.
  persistQueue = persistQueue.catch(() => {}).then(() => broker('SESSION_SET', value));
  persistQueue.catch(() => {});
  chrome.runtime.sendMessage({ target: 'popup', action: 'STATE', payload: value }).catch(() => {});
}

const ready = (async () => {
  const saved = await broker('SESSION_GET');
  if (saved?.preferences) state.preferences = saved.preferences;
  if (saved?.party) {
    state.message = 'A conexao foi interrompida. Crie uma nova party ou peca um novo convite. Conexoes P2P nao podem ser restauradas de um codigo salvo.';
    if (saved.local?.tabId) await playerCommand('RESET', {}, saved.local.tabId);
  }
  publish();
})();

function playerCommand(action, payload = {}, tabId = state.local?.tabId, frameId) {
  if (!Number.isInteger(tabId)) return Promise.resolve(false);
  return broker('PLAYER_COMMAND', { tabId, frameId, action, payload }).catch(() => false);
}

function send(peer, message) {
  if (peer.channel?.readyState !== 'open' || peer.channel.bufferedAmount > 65536) return;
  try { peer.channel.send(JSON.stringify(message)); } catch { /* Connection state follows asynchronously. */ }
}

function broadcast(message) {
  for (const peer of peers.values()) send(peer, message);
}

function roster() {
  if (state.party?.role !== 'host') return;
  broadcast({ type: 'roster', count: [...peers.values()].filter((p) => p.status === 'connected').length + 1 });
}

function closePeer(peer) {
  clearTimeout(peer.disconnectTimer);
  clearTimeout(peer.connectTimer);
  peer.pc.onconnectionstatechange = null;
  peer.pc.ondatachannel = null;
  if (peer.channel) {
    peer.channel.onclose = null;
    peer.channel.onmessage = null;
    peer.channel.onopen = null;
    peer.channel.close();
  }
  peer.pc.close();
}

function failPeer(peer, message) {
  if (peers.get(peer.id) !== peer || peer.status === 'failed') return;
  peer.status = 'failed';
  closePeer(peer);
  if (state.party?.role === 'guest') {
    remoteSample = null;
    playerCommand('RESET');
    selectedFrame = null;
    state.answer = null;
    state.adHold = [];
    sentAd = false;
  }
  if (state.invitation?.id === peer.id) state.invitation = null;
  state.message = message;
  updateHold();
  publish();
  roster();
}

function syncGuest() {
  if (!remoteSample || !state.local || selectedFrame === null) return;
  if (mediaKey(state.local.url) !== mediaKey(state.remoteMedia?.url)) return;
  const peer = peers.values().next().value;
  if (peer?.status !== 'connected') return;
  const age = performance.now() - lastRemoteAt;
  if (age > 8000) return;
  const adjusted = { ...remoteSample };
  if (!adjusted.paused && !adjusted.buffering) adjusted.time += age / 1000 * adjusted.rate;
  playerCommand('APPLY_STATE', { state: adjusted, delayMs: Math.min((peer.rtt || 0) / 2, 2000) }, state.local.tabId, selectedFrame);
}

async function followHost() {
  if (state.party?.role !== 'guest' || peers.values().next().value?.status !== 'connected') return;
  const key = mediaKey(state.remoteMedia?.url);
  if (!key || mediaKey(state.local?.url) === key) { followedKey = key; return; }
  // Only the host changes videos: a party tab on another video is sent back. A closed or
  // abandoned tab is reopened only when the host moves to a different video.
  if (followedKey === key && (!state.local || performance.now() - followAt < FOLLOW_RETRY)) return;
  followedKey = key;
  followAt = performance.now();
  const tab = await broker('NAVIGATE', { tabId: state.local?.tabId ?? null, url: state.remoteMedia.url }).catch(() => null);
  if (tab && state.party?.role === 'guest' && mediaKey(state.remoteMedia?.url) === key) {
    await bindTab(tab);
    publish();
  }
}

function playerIntent(payload) {
  if (state.party?.role !== 'guest' || state.local?.tabId !== payload.tabId ||
    payload.frameId !== selectedFrame || selectedRole !== 'guest' || typeof payload.paused !== 'boolean') return;
  send(peers.values().next().value, { type: 'control', paused: payload.paused, media: mediaKey(state.local.url) });
}

function guestsInAd() {
  const now = performance.now();
  return [...peers.values()].filter((peer) => peer.status === 'connected' && peer.adSince !== null &&
    now - peer.adAt < AD_FRESH && now - peer.adSince < AD_MAX);
}

// Host: pause its own player while any guest is in an ad. Its own ads already stop the content.
function updateHold() {
  if (state.party?.role !== 'host') return;
  const guests = guestsInAd();
  state.adHold = guests.map((peer) => peer.name);
  const hold = guests.length > 0 && !state.local?.ad && selectedFrame !== null;
  // Resent while active: HOLD is idempotent in the player and survives a missed message.
  if (hold || playerHeld) playerCommand('HOLD', { active: hold }, state.local?.tabId, selectedFrame);
  playerHeld = hold;
}

// Guest: tell the host whether this player is showing an ad for the party video.
function reportAd(force = false) {
  if (state.party?.role !== 'guest') return;
  const key = mediaKey(state.local?.url);
  const active = !!state.local?.ad && !!key && key === mediaKey(state.remoteMedia?.url);
  if (active === sentAd && !(force && active)) return;
  sentAd = active;
  send(peers.values().next().value, { type: 'ad', active });
}

function sendPlayback(peer) {
  if (state.party?.role !== 'host') return;
  const fresh = localSample && performance.now() - localSample.at < 5000 && state.local?.available;
  let playback = null;
  if (fresh) {
    playback = { ...localSample.state };
    if (!playback.paused && !playback.buffering) playback.time += (performance.now() - localSample.at) / 1000 * playback.rate;
  }
  const message = { type: 'playback', state: playback,
    media: isSupportedUrl(state.local?.url) ? { url: state.local.url, title: state.local.title } : null,
    hold: [...(state.local?.ad ? [state.party.name] : []), ...state.adHold] };
  if (peer) send(peer, message); else broadcast(message);
}

function receive(peer, data) {
  if (typeof data !== 'string' || data.length > 16000) return;
  let message;
  try { message = JSON.parse(data); } catch { return; }
  if (!message || typeof message !== 'object') return;
  // Control packets are bounded and rate-limited even for an invited peer.
  const now = performance.now();
  if (now - peer.windowAt > 1000) { peer.windowAt = now; peer.packets = 0; }
  if (++peer.packets > 80) return;
  if (message.type === 'ping' && Number.isFinite(message.id)) {
    send(peer, { type: 'pong', id: message.id });
  } else if (message.type === 'pong' && message.id === peer.pingAt) {
    peer.rtt = Math.min(now - peer.pingAt, 4000);
    peer.pingAt = null;
  } else if (state.party?.role === 'guest' && message.type === 'playback') {
    const media = message.media;
    if (media !== null && (!media || !isSupportedUrl(media.url) || media.url.length > 4000 ||
      typeof media.title !== 'string' || media.title.length > 500)) return;
    const playback = message.state === null ? null : normalizePlayback(message.state);
    if (message.state !== null && !playback) return;
    const changed = mediaKey(state.remoteMedia?.url) !== mediaKey(media?.url);
    if (changed || !playback) {
      playerCommand('RESET');
      selectedFrame = null;
    }
    const hold = message.hold;
    state.adHold = Array.isArray(hold) && hold.length <= MAX_PEERS + 1 &&
      hold.every((name) => typeof name === 'string' && name.length <= 40) ? hold : [];
    state.remoteMedia = media;
    remoteSample = playback;
    lastRemoteAt = now;
    if (playback) chooseFrame();
    syncGuest();
    followHost();
    reportAd();
    publish();
  } else if (state.party?.role === 'host' && message.type === 'ad' && typeof message.active === 'boolean') {
    if (peer.status !== 'connected') return;
    if (!message.active) peer.adSince = null;
    else {
      if (peer.adSince === null) peer.adSince = now;
      peer.adAt = now;
    }
    updateHold();
    sendPlayback();
    publish();
  } else if (state.party?.role === 'host' && message.type === 'control' && typeof message.paused === 'boolean') {
    // Guests may play or pause the shared video; the host's player then broadcasts the result.
    if (peer.status !== 'connected' || now - peer.controlAt < 300 || selectedFrame === null ||
      !state.local?.available || message.media !== mediaKey(state.local.url)) return;
    peer.controlAt = now;
    playerCommand('CONTROL', { paused: message.paused }, state.local.tabId, selectedFrame);
  } else if (state.party?.role === 'guest' && message.type === 'roster' &&
    Number.isInteger(message.count) && message.count >= 1 && message.count <= MAX_PEERS + 1) {
    state.party.count = message.count;
    publish();
  } else if (state.party?.role === 'guest' && message.type === 'end') {
    leave('O host encerrou a party. Voce pode criar ou entrar em outra.');
  }
}

function attachChannel(peer, channel) {
  if (channel.label !== 'web-party' || peer.channel) { channel.close(); return; }
  peer.channel = channel;
  channel.onmessage = (event) => receive(peer, event.data);
  channel.onopen = () => {
    if (peers.get(peer.id) !== peer) return;
    clearTimeout(peer.connectTimer);
    peer.connectedOnce = true;
    peer.status = 'connected';
    if (state.invitation?.id === peer.id) state.invitation = null;
    if (state.party.role === 'guest') state.answer = null;
    state.message = null;
    sendPlayback(peer);
    roster();
    publish();
  };
  channel.onclose = () => failPeer(peer, 'Conexao encerrada. Para reconectar, troquem um novo convite e uma nova resposta.');
}

function createPeer(id, name) {
  const pc = new RTCPeerConnection({
    iceServers: state.preferences.useStun ? [{ urls: 'stun:stun.l.google.com:19302' }] : [],
    iceTransportPolicy: 'all',
  });
  const peer = { id, name, pc, channel: null, status: 'gathering', createdAt: Date.now(),
    rtt: null, pingAt: null, connectedOnce: false, iceRound: 0, iceRetryAt: 0, windowAt: 0, packets: 0, controlAt: -Infinity, adSince: null, adAt: 0, disconnectTimer: null, connectTimer: null };
  peers.set(id, peer);
  pc.ondatachannel = (event) => attachChannel(peer, event.channel);
  pc.onconnectionstatechange = () => {
    if (peer.status === 'failed') return;
    clearTimeout(peer.disconnectTimer);
    // Until the first connection, the other side may simply not have pasted its code yet:
    // keep the transport and let retryIce() resume the checks. Invite and accept timeouts still apply.
    if (!peer.connectedOnce && ['failed', 'disconnected'].includes(pc.connectionState)) return;
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      failPeer(peer, 'Nao foi possivel manter a conexao direta. Tente outro convite ou outra rede; nao usamos relay TURN.');
    } else if (pc.connectionState === 'disconnected') {
      peer.status = 'disconnected';
      if (state.party?.role === 'guest') { playerCommand('RESET'); selectedFrame = null; remoteSample = null; }
      peer.disconnectTimer = setTimeout(() => failPeer(peer, 'A rede desconectou. Troquem um novo convite para reconectar.'), 15000);
      publish();
    } else if (pc.connectionState === 'connected' && peer.channel?.readyState === 'open') {
      peer.status = 'connected';
      sendPlayback(peer);
      publish();
    }
  };
  return peer;
}

// Chrome stops sending connectivity checks ~15s after a peer goes unanswered, which is usually
// before the other person pastes the code; the NAT mapping then expires and the late side cannot
// get through. Re-adding the remote candidates restarts the checks; identical candidates are
// ignored, so each round gets fresh foundations.
function retryIce(peer) {
  const now = performance.now();
  if (peer.connectedOnce || !peer.pc.remoteDescription || peer.pc.connectionState !== 'failed' ||
    now - peer.iceRetryAt < ICE_RETRY) return;
  peer.iceRetryAt = now;
  peer.iceRound += 1;
  const lines = peer.pc.remoteDescription.sdp.split(/\r?\n/).filter((line) => line.startsWith('a=candidate:'));
  for (const [index, line] of lines.entries()) {
    const candidate = line.slice(2).replace(/^candidate:\S+/, `candidate:r${peer.iceRound}x${index}`);
    peer.pc.addIceCandidate({ candidate, sdpMLineIndex: 0 }).catch(() => {});
  }
}

function waitForIce(peer) {
  return new Promise((resolve, reject) => {
    const pc = peer.pc;
    const timer = setTimeout(() => finish(new Error('A descoberta de rede demorou demais. Tente novamente ou desative STUN para uma rede local.')), 20000);
    function finish(error) {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('connectionstatechange', check);
      if (error) reject(error); else resolve();
    }
    function check() {
      if (pc.connectionState === 'closed') finish(new Error('Convite cancelado.'));
      else if (pc.iceGatheringState === 'complete') finish();
    }
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('connectionstatechange', check);
    check();
  });
}

function connectionTimeout(peer) {
  if (peer.status === 'connected') return;
  peer.status = 'connecting';
  peer.connectTimer = setTimeout(() => failPeer(peer,
    'A conexao direta nao respondeu. Confira a troca dos codigos ou tente outra rede. Algumas redes exigem TURN, que esta extensao nao usa.'), 90000);
}

// The invite rides in the fragment of the host's video URL: clicking it opens the video, and the
// fragment never reaches the site's servers (the extension strips it before the page loads).
function inviteLink(code) {
  if (!isSupportedUrl(state.local?.url)) return null;
  const url = new URL(state.local.url);
  url.hash = `wp=${code}`;
  return url.href;
}

async function makeInvite() {
  if (state.party?.role !== 'host') throw new Error('Apenas o host pode convidar.');
  if (state.invitation) {
    const previous = peers.get(state.invitation.id);
    if (previous && previous.status !== 'connected') { closePeer(previous); peers.delete(previous.id); }
    state.invitation = null;
  }
  for (const [id, peer] of peers) if (peer.status === 'failed') { closePeer(peer); peers.delete(id); }
  if (peers.size >= MAX_PEERS) throw new Error('Limite de 8 convidados atingido.');
  const peer = createPeer(crypto.randomUUID(), 'Novo convidado');
  try {
    attachChannel(peer, peer.pc.createDataChannel('web-party', { ordered: true }));
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    await waitForIce(peer);
    const code = await encodeCode({ version: 1, type: 'offer', partyId: state.party.id,
      inviteId: peer.id, name: state.party.name, createdAt: peer.createdAt,
      description: peer.pc.localDescription.toJSON() });
    peer.status = 'waiting';
    state.invitation = { id: peer.id, code, link: inviteLink(code), expiresAt: peer.createdAt + INVITE_TTL };
  } catch (error) {
    closePeer(peer);
    peers.delete(peer.id);
    throw error;
  }
}

async function bindTab(tab) {
  await playerCommand('RESET');
  frames.clear();
  selectedFrame = null;
  localSample = null;
  state.local = tab ? { ...tab, title: tab.title.slice(0, 500), available: false, notice: null } : null;
  await playerCommand('REPORT_REQUEST');
}

function chooseFrame() {
  let best = null;
  for (const [id, frame] of frames) {
    if (!frame.available || performance.now() - frame.at > 5000) continue;
    if (!best || frame.area > best[1].area) best = [id, frame];
  }
  const id = best?.[0] ?? null;
  const role = id === null ? null : state.party.role === 'guest' &&
    (!remoteSample || performance.now() - lastRemoteAt > 8000 ||
      peers.values().next().value?.status !== 'connected' ||
      mediaKey(state.local.url) !== mediaKey(state.remoteMedia?.url)) ? null : state.party.role;
  if (id !== selectedFrame || role !== selectedRole) {
    // RESET/SET_ROLE clear the player's hold; the next update reapplies it.
    playerHeld = false;
    if (selectedFrame !== null) playerCommand('RESET', {}, state.local?.tabId, selectedFrame);
    selectedFrame = id;
    selectedRole = role;
    if (id !== null) {
      playerCommand('SET_ROLE', { role }, state.local.tabId, id);
      if (role === 'guest') syncGuest();
    }
  }
  if (state.local) {
    state.local.available = !!best;
    state.local.notice = best?.[1].notice || null;
    state.local.ad = !!best?.[1].ad;
  }
  return best;
}

// The host's ad plays in place of the content: guests hold at the last content position.
function frozenSample(adPlayback, now) {
  if (localSample?.ad) return localSample.state;
  if (!localSample) return { time: 0, paused: true, rate: 1, duration: adPlayback.duration, buffering: false };
  const frozen = { ...localSample.state, paused: true, buffering: false };
  if (!localSample.state.paused && !localSample.state.buffering) {
    frozen.time += Math.min(now - localSample.at, 5000) / 1000 * frozen.rate;
  }
  return frozen;
}

function reportPlayer(payload) {
  if (!state.party || state.local?.tabId !== payload.tabId) return;
  const playback = normalizePlayback(payload.state);
  if (!Number.isInteger(payload.frameId) || !Number.isFinite(payload.area) || payload.area < 0 ||
    typeof payload.available !== 'boolean' || !playback) return;
  frames.set(payload.frameId, { available: payload.available && playback.duration > 0,
    area: payload.area, state: playback, at: performance.now(),
    notice: typeof payload.notice === 'string' ? payload.notice.slice(0, 300) : null,
    ad: payload.ad === true });
  const best = chooseFrame();
  if (state.party.role === 'host' && best?.[0] === payload.frameId) {
    const now = performance.now();
    if (payload.ad === true) localSample = { state: frozenSample(playback, now), at: now, ad: true };
    else localSample = { state: playback, at: now };
    updateHold();
    sendPlayback();
  }
  reportAd();
  publish();
}

async function leave(message = null) {
  if (state.party?.role === 'host') broadcast({ type: 'end' });
  for (const peer of peers.values()) closePeer(peer);
  peers.clear();
  await playerCommand('RESET');
  frames.clear();
  localSample = remoteSample = null;
  selectedFrame = null;
  followedKey = null;
  followAt = -Infinity;
  playerHeld = sentAd = false;
  state = { ...state, party: null, peers: [], invitation: null, answer: null, local: null,
    remoteMedia: null, message, busy: null, adHold: [] };
  publish();
}

async function command(action, payload) {
  await ready;
  if (action === 'GET_STATE') return snapshot();
  if (action === 'PLAYER_REPORT') { reportPlayer(payload); return null; }
  if (action === 'PLAYER_INTENT') { playerIntent(payload); return null; }
  if (action === 'TAB_TITLE') {
    if (state.local?.tabId === payload.tabId) {
      state.local.title = payload.title.slice(0, 500);
      sendPlayback();
      publish();
    }
    return null;
  }
  if (action === 'TAB_CLOSED' || action === 'TAB_UPDATED') {
    if (state.local?.tabId === payload.tabId) {
      await bindTab(action === 'TAB_UPDATED' && isSupportedUrl(payload.url) ? payload : null);
      if (!state.local) state.message = 'A aba da party foi fechada ou saiu do video. Abra um video e use "Usar esta aba".';
      sendPlayback();
      publish();
    }
    return null;
  }
  if (action === 'SET_RATE') {
    if (state.party?.role !== 'host') throw new Error('Apenas o host muda a velocidade.');
    if (!RATES.includes(payload.rate)) throw new Error('Velocidade invalida.');
    if (selectedFrame === null || !state.local?.available) throw new Error('Abra o video e inicie o player primeiro.');
    // The player reports the new rate, which then reaches every guest with the playback state.
    await playerCommand('RATE', { rate: payload.rate }, state.local.tabId, selectedFrame);
    return null;
  }
  if (state.busy) throw new Error('Uma operacao esta em andamento. Aguarde alguns segundos.');
  state.busy = action;
  state.message = null;
  publish();
  try {
    if (action === 'CREATE' || action === 'JOIN') {
      if (state.party) throw new Error('Saia da party atual antes de entrar em outra.');
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      if (!name || name.length > 40) throw new Error('Informe seu nome (ate 40 caracteres).');
      const signal = action === 'JOIN' ? await decodeCode(extractCode(payload.code) ?? payload.code) : null;
      if (signal && signal.type !== 'offer') throw new Error('Este e um codigo de resposta. Peca o convite do host.');
      state.preferences = { name, useStun: payload.useStun !== false };
      state.party = { id: signal?.partyId || crypto.randomUUID(), role: action === 'CREATE' ? 'host' : 'guest', name, count: 1 };
      await bindTab(payload.tab);
      if (action === 'CREATE') await makeInvite();
      else {
        const peer = createPeer(signal.inviteId, signal.name);
        try {
          await peer.pc.setRemoteDescription(signal.description);
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          await waitForIce(peer);
          const answer = await encodeCode({ version: 1, type: 'answer', partyId: signal.partyId,
            inviteId: signal.inviteId, name, createdAt: Date.now(), description: peer.pc.localDescription.toJSON() });
          if (peer.status !== 'connected') {
            state.answer = answer;
            peer.status = 'waiting';
          }
        } catch (error) { await leave(); throw error; }
      }
    } else if (action === 'INVITE') await makeInvite();
    else if (action === 'ACCEPT') {
      if (state.party?.role !== 'host') throw new Error('Apenas o host pode confirmar respostas.');
      const signal = await decodeCode(extractCode(payload.code) ?? payload.code);
      if (signal.type !== 'answer' || signal.partyId !== state.party.id) throw new Error('A resposta nao pertence a esta party.');
      const peer = peers.get(signal.inviteId);
      if (!peer || peer.status !== 'waiting' || Date.now() - peer.createdAt > INVITE_TTL) {
        throw new Error('Este convite ja foi usado, cancelado ou expirou. Gere outro.');
      }
      await peer.pc.setRemoteDescription(signal.description);
      peer.name = signal.name;
      connectionTimeout(peer);
      state.invitation = null;
    } else if (action === 'SELECT_TAB') {
      if (!state.party) throw new Error('Crie ou entre em uma party primeiro.');
      await bindTab(payload.tab);
    } else if (action === 'REMOVE_PEER') {
      if (state.party?.role !== 'host') throw new Error('Apenas o host pode remover convidados.');
      const peer = peers.get(payload.id);
      if (peer) { send(peer, { type: 'end' }); closePeer(peer); peers.delete(peer.id); }
      if (state.invitation?.id === payload.id) state.invitation = null;
      updateHold();
      roster();
    } else if (action === 'LEAVE') await leave();
    else throw new Error('Operacao desconhecida.');
    return snapshot();
  } catch (error) {
    state.message = error.message;
    throw error;
  } finally {
    state.busy = null;
    publish();
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab) return;
  command(message.action, message.payload || {}).then(
    () => respond({ ok: true, data: snapshot() }),
    (error) => respond({ ok: false, error: error.message }),
  );
  return true;
});

setInterval(() => {
  if (!state.party) return;
  for (const peer of peers.values()) {
    if (['gathering', 'waiting'].includes(peer.status) && Date.now() - peer.createdAt > INVITE_TTL) {
      failPeer(peer, 'O convite expirou. Gere um novo codigo para conectar.');
    }
    if (['waiting', 'connecting'].includes(peer.status)) retryIce(peer);
    if (peer.channel?.readyState === 'open') {
      peer.pingAt = performance.now();
      send(peer, { type: 'ping', id: peer.pingAt });
    }
  }
  chooseFrame();
  updateHold();
  reportAd(true);
  sendPlayback();
  publish();
}, 2000);
