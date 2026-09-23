import { decodeCode, extractCode, isSupportedUrl } from './lib/protocol.js';

const offscreenUrl = chrome.runtime.getURL('offscreen.html');
const popupUrl = chrome.runtime.getURL('popup.html');
let creating;

async function hasOffscreen() {
  return (await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl],
  })).length > 0;
}

async function ensureOffscreen() {
  if (creating) return creating;
  creating = (async () => {
    if (!await hasOffscreen()) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['WEB_RTC'],
        justification: 'Manter as conexoes P2P da party quando o popup estiver fechado.',
      });
    }
  })();
  try { await creating; } finally { creating = null; }
}

async function forward(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', action, payload });
  if (!response?.ok) throw new Error(response?.error || 'A conexao da extensao foi interrompida. Tente novamente.');
  return response.data;
}

function tabInfo(tab) {
  return { tabId: tab.id, url: tab.url || tab.pendingUrl || '', title: tab.title || 'Video' };
}

// Invite links (#wp=...) are opened by the guest on the video page. The page card only gets
// what it shows: the host name, the guest's own answer and whether the party connected.
async function handleLink(action, payload, tab) {
  if (action === 'LINK_INVITE') {
    const signal = await decodeCode(extractCode(payload.code) ?? '');
    if (signal.type !== 'offer') throw new Error('Este link nao e um convite.');
    const saved = (await chrome.storage.session.get('session')).session;
    return { host: signal.name, name: saved?.preferences?.name || '', inParty: !!saved?.party };
  }
  await ensureOffscreen();
  if (action === 'LINK_STATUS') {
    const state = await forward('GET_STATE');
    const guest = state.party?.role === 'guest' && state.local?.tabId === tab.id;
    return { answer: guest ? state.answer : null,
      connected: guest && state.peers.some((peer) => peer.status === 'connected'),
      failed: guest && state.peers.some((peer) => peer.status === 'failed') };
  }
  const { preferences } = await forward('GET_STATE');
  const state = await forward('JOIN', { name: payload.name, code: extractCode(payload.code) ?? '',
    useStun: preferences.useStun, tab: isSupportedUrl(tab.url) ? tabInfo(tab) : null });
  return { answer: state.answer };
}

async function handle(message, sender) {
  const { action, payload = {} } = message;
  if (sender.url === offscreenUrl && !sender.tab) {
    // Offscreen documents only have access to chrome.runtime, not storage or tabs.
    if (action === 'SESSION_GET') return (await chrome.storage.session.get('session')).session || null;
    if (action === 'SESSION_SET') {
      await chrome.storage.session.set({ session: payload });
      return null;
    }
    if (action === 'PLAYER_COMMAND') {
      try {
        await chrome.tabs.sendMessage(payload.tabId, {
          target: 'player', action: payload.action, payload: payload.payload,
        }, Number.isInteger(payload.frameId) ? { frameId: payload.frameId } : {});
        return true;
      } catch { return false; }
    }
    if (action === 'NAVIGATE') {
      // Guests follow the host: reuse the party tab, or open one if it was never bound.
      if (!isSupportedUrl(payload.url)) throw new Error('Endereco de video invalido.');
      if (Number.isInteger(payload.tabId)) {
        try {
          await chrome.tabs.update(payload.tabId, { url: payload.url, active: true });
          return null;
        } catch { /* The tab is gone; open a new one below. */ }
      }
      return tabInfo(await chrome.tabs.create({ url: payload.url }));
    }
    throw new Error('Operacao interna desconhecida.');
  }

  if (['PLAYER_REPORT', 'PLAYER_INTENT'].includes(action) && sender.tab) {
    if (!await hasOffscreen()) return null;
    return forward(action, { ...payload, ...tabInfo(sender.tab), frameId: sender.frameId });
  }
  if (['LINK_INVITE', 'LINK_JOIN', 'LINK_STATUS'].includes(action) && sender.tab && sender.frameId === 0) {
    return handleLink(action, payload, sender.tab);
  }
  if (sender.url !== popupUrl) throw new Error('Origem nao autorizada.');
  await ensureOffscreen();
  if (['CREATE', 'JOIN', 'SELECT_TAB'].includes(action)) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const supported = tab && isSupportedUrl(tab.url);
    if (!supported && action !== 'JOIN') {
      throw new Error('Abra um video do YouTube ou um episodio do Crunchyroll nesta aba primeiro.');
    }
    return forward(action, { ...payload, tab: supported ? tabInfo(tab) : null });
  }
  if (action === 'OPEN_HOST') {
    const state = await forward('GET_STATE');
    const url = state.remoteMedia?.url;
    if (state.party?.role !== 'guest' || !isSupportedUrl(url)) throw new Error('O host ainda nao compartilhou um video.');
    const tab = await chrome.tabs.create({ url });
    return forward('SELECT_TAB', { tab: tabInfo(tab) });
  }
  if (!['GET_STATE', 'INVITE', 'ACCEPT', 'LEAVE', 'REMOVE_PEER', 'SET_RATE'].includes(action)) {
    throw new Error('Operacao desconhecida.');
  }
  return forward(action, payload);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'broker' || sender.id !== chrome.runtime.id) return;
  handle(message, sender).then(
    (data) => respond({ ok: true, data }),
    (error) => respond({ ok: false, error: error.message }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  hasOffscreen().then((exists) => exists && forward('TAB_CLOSED', { tabId })).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  const action = change.url || change.status === 'loading' ? 'TAB_UPDATED' : change.title ? 'TAB_TITLE' : null;
  if (!action) return;
  hasOffscreen().then((exists) => exists && forward(action, tabInfo(tab))).catch(() => {});
});
