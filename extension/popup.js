import { decodeCode, extractCode, mediaKey } from './lib/protocol.js';

const $ = (id) => document.getElementById(id);
let current;
let working = false;
let initialized = false;
let toastTimer;
let renderedSignature = '';
let clipboardAction = null;
let copiedInvite = null;
const statusLabels = { gathering: 'Preparando codigo', waiting: 'Aguardando troca de codigos',
  connecting: 'Conectando...', connected: 'Conectado', disconnected: 'Tentando recuperar a rede...', failed: 'Desconectado' };

async function request(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'broker', action, payload });
  if (!response?.ok) throw new Error(response?.error || 'A extensao nao respondeu. Feche e abra o popup para tentar novamente.');
  return response.data;
}

function showText(id, text) {
  $(id).textContent = text || '';
  $(id).hidden = !text;
}

function toast(text) {
  showText('toast', text);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2500);
}

function render(state) {
  // `working` is popup-local; without it, finishing an action would not re-enable the buttons.
  const signature = JSON.stringify(state) + working;
  if (initialized && signature === renderedSignature) return;
  renderedSignature = signature;
  current = state;
  $('boot-screen').hidden = true;
  document.body.classList.remove('booting');
  document.body.setAttribute('aria-busy', 'false');
  $('loading').hidden = true;
  $('home').hidden = !!state.party;
  $('party').hidden = !state.party;
  showText('message', state.message);
  const busy = !!state.busy || working;
  document.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  $('name').disabled = busy;
  $('stun').disabled = busy;
  showText('busy', state.busy ?
    (['CREATE', 'JOIN', 'INVITE'].includes(state.busy) ? 'Preparando a conexao direta... Isso pode levar ate 20 segundos. Voce pode fechar este popup.' : 'Atualizando sua party...') : null);
  if (!state.party) return;
  const host = state.party.role === 'host';
  const connected = state.peers.filter((peer) => peer.status === 'connected').length;
  const disconnected = state.peers.some((peer) => ['failed', 'disconnected'].includes(peer.status));
  $('role').textContent = host ? 'HOST' : 'Convidado, em uma sala';
  $('connection').textContent = connected ? 'Conectado' : disconnected ? 'Sem conexao' : 'Aguardando';
  $('connection').className = `badge ${connected ? 'connected' : disconnected ? 'failed' : ''}`;
  $('host-tools').hidden = !host;
  $('invitation').hidden = !state.invitation;
  $('new-invite').hidden = !!state.invitation;
  $('replace-invite').hidden = !state.invitation;
  const invite = state.invitation?.link || state.invitation?.code || '';
  if ($('offer-code').value !== invite) $('offer-code').value = invite;
  $('guest-answer').hidden = host || !state.answer;
  if ($('response-code').value !== (state.answer || '')) $('response-code').value = state.answer || '';
  const media = host ? state.local : state.remoteMedia;
  $('video-title').textContent = media?.title || 'Escolha um video';
  const sameVideo = mediaKey(state.local?.url) && mediaKey(state.local.url) === mediaKey(state.remoteMedia?.url);
  let videoStatus = state.local?.available ? 'Player encontrado. Pronto para assistir.' : 'Abra o video, inicie o player e use esta aba.';
  if (!host && state.remoteMedia && !sameVideo) videoStatus = 'Abrindo o video do host automaticamente...';
  else if (!host && connected && !state.remoteReady) videoStatus = 'Aguardando o player do host ficar disponivel.';
  else if (!host && connected && state.local?.available) videoStatus = 'Seguindo a reproducao do host.';
  else if (!host && !state.remoteMedia) videoStatus = 'Aguardando o video do host.';
  const waitingFor = (state.adHold || []).filter((name) => host || name !== state.party.name);
  if (state.local?.ad) videoStatus = 'Anuncio no seu player. A party esta pausada esperando voce.';
  else if (waitingFor.length) videoStatus = `Pausado para todos: anuncio para ${waitingFor.join(', ')}.`;
  $('video-status').textContent = videoStatus;
  showText('player-notice', state.local?.notice);
  $('open-host').hidden = host || !state.remoteMedia || !!sameVideo;
  // Only the host sets the speed; guests see the party's current speed.
  const canSetRate = host && !!state.local?.available && !busy;
  document.querySelectorAll('#speed button').forEach((button) => {
    const active = state.rate !== null && Math.abs(Number(button.dataset.rate) - state.rate) < 0.01;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = !canSetRate;
  });
  $('speed-hint').textContent = host
    ? (state.local?.available ? 'Todos passam a assistir nesta velocidade.' : 'Disponivel quando o player for encontrado.')
    : state.rate !== null ? 'Definida pelo host.' : 'Aguardando o player do host.';
  $('leave').textContent = host ? 'Encerrar party' : 'Sair da party';
  const count = host ? connected + 1 : connected ? state.party.count || 2 : 1;
  $('people-count').textContent = `${String(count).padStart(2, '0')} ONLINE`;
  const people = [{ name: state.party.name, status: host ? 'Voce / host' : 'Voce', self: true },
    ...state.peers.map((peer) => ({ ...peer, status: `${statusLabels[peer.status] || peer.status}${peer.latency !== null && peer.status === 'connected' ? ` / ~${peer.latency} ms` : ''}` }))];
  $('people').replaceChildren(...people.map((person) => {
    const li = document.createElement('li');
    li.className = 'person';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = person.name.slice(0, 1).toUpperCase();
    avatar.setAttribute('aria-hidden', 'true');
    const info = document.createElement('div');
    info.className = 'person-info';
    const name = document.createElement('span');
    name.className = 'person-name';
    name.textContent = person.name;
    const status = document.createElement('span');
    status.className = 'person-status';
    status.textContent = person.status;
    info.append(name, status);
    li.append(avatar, info);
    if (host && !person.self) {
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.textContent = '\u00d7';
      remove.setAttribute('aria-label', `Remover ${person.name}`);
      remove.disabled = busy;
      remove.addEventListener('click', () => run('REMOVE_PEER', { id: person.id }));
      li.append(remove);
    }
    return li;
  }));
}

async function saveDraft() {
  await chrome.storage.session.set({ drafts: { name: $('name').value, useStun: $('stun').checked,
    joinCode: $('join-code').value, answerCode: $('answer-code').value, joinOpen: !$('join-form').hidden } });
}

async function run(action, payload = {}) {
  if (working || current?.busy) return;
  working = true;
  showText('error', null);
  if (current) render(current);
  try {
    const state = await request(action, payload);
    if (['CREATE', 'JOIN', 'ACCEPT', 'LEAVE', 'INVITE'].includes(action)) {
      $('join-code').value = '';
      $('answer-code').value = '';
      $('clipboard-card').hidden = true;
      await saveDraft();
    }
    render(state);
    if (['CREATE', 'JOIN', 'INVITE'].includes(action)) await autoCopy(state);
  } catch (error) { showText('error', error.message); }
  finally {
    working = false;
    if (current) render(current);
  }
}

// Copies a new invite or answer once, so the next step is just pasting it in the chat.
async function autoCopy(state) {
  const text = state.party?.role === 'host' ? state.invitation?.link || state.invitation?.code : state.answer;
  if (!text || text === copiedInvite) return;
  copiedInvite = text;
  try {
    await navigator.clipboard.writeText(text);
    toast(state.party.role === 'host' ? 'Link copiado! Cole no chat com seu convidado.' : 'Resposta copiada! Cole no chat com o host.');
  } catch { /* The copy button remains available. */ }
}

// Offers the obvious next step for a code the user just copied from the chat.
async function detectClipboard(state) {
  let text;
  try { text = await navigator.clipboard.readText(); } catch { return; }
  const code = extractCode(text);
  if (!code) return;
  let signal;
  try { signal = await decodeCode(code); } catch { return; }
  if (state.party?.role === 'host' && signal.type === 'answer' && signal.inviteId === state.invitation?.id) {
    $('answer-code').value = code;
    showClipboard(`Resposta de ${signal.name} encontrada.`, 'Confirme para concluir a conexao.', `Conectar ${signal.name}`,
      () => run('ACCEPT', { code }));
  } else if (!state.party && signal.type === 'offer') {
    showClipboard(`Convite de ${signal.name} encontrado.`, 'Voce entra na party e recebe uma resposta para devolver.', 'Entrar na party',
      () => run('JOIN', { name: $('name').value, useStun: $('stun').checked, code }));
  }
}

function showClipboard(title, hint, label, action) {
  $('clipboard-title').textContent = title;
  $('clipboard-hint').textContent = hint;
  $('clipboard-action').textContent = label;
  clipboardAction = action;
  $('clipboard-card').hidden = false;
}

async function copy(id) {
  try { await navigator.clipboard.writeText($(id).value); toast('Copiado. Envie pelo seu chat.'); }
  catch {
    $(id).focus();
    $(id).select();
    toast('Use Ctrl+C ou Cmd+C para copiar o codigo selecionado.');
  }
}

$('create').addEventListener('click', () => run('CREATE', { name: $('name').value, useStun: $('stun').checked }));
$('show-join').addEventListener('click', () => {
  $('join-form').hidden = !$('join-form').hidden;
  $('show-join').setAttribute('aria-expanded', String(!$('join-form').hidden));
  if (!$('join-form').hidden) $('join-code').focus();
  saveDraft().catch(() => {});
});
$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run('JOIN', { name: $('name').value, useStun: $('stun').checked, code: $('join-code').value });
});
$('accept-form').addEventListener('submit', (event) => { event.preventDefault(); run('ACCEPT', { code: $('answer-code').value }); });
$('copy-offer').addEventListener('click', () => copy('offer-code'));
$('copy-answer').addEventListener('click', () => copy('response-code'));
$('new-invite').addEventListener('click', () => run('INVITE'));
$('replace-invite').addEventListener('click', () => {
  if (confirm('O codigo anterior deixara de funcionar. Gerar outro convite?')) run('INVITE');
});
$('leave').addEventListener('click', () => {
  if (confirm(current?.party?.role === 'host' ? 'Encerrar a party para todos?' : 'Sair da party? Voce precisara de um novo convite para voltar.')) run('LEAVE');
});
$('select-tab').addEventListener('click', () => run('SELECT_TAB'));
document.querySelectorAll('#speed button').forEach((button) => {
  button.addEventListener('click', () => run('SET_RATE', { rate: Number(button.dataset.rate) }));
});
$('clipboard-action').addEventListener('click', () => {
  if (!$('name').value.trim() && !current?.party) {
    showText('error', 'Informe seu nome antes de entrar.');
    $('name').focus();
    return;
  }
  clipboardAction?.();
});
$('open-host').addEventListener('click', () => run('OPEN_HOST'));
for (const id of ['name', 'stun', 'join-code', 'answer-code']) $(id).addEventListener('input', () => saveDraft().catch(() => {}));
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

chrome.runtime.onMessage.addListener((message, sender) => {
  if (initialized && sender.id === chrome.runtime.id && message?.target === 'popup' && message.action === 'STATE') render(message.payload);
});

try {
  const [state, saved] = await Promise.all([request('GET_STATE'), chrome.storage.session.get('drafts')]);
  const drafts = saved.drafts || {};
  $('name').value = drafts.name ?? state.preferences.name;
  $('stun').checked = drafts.useStun ?? state.preferences.useStun;
  $('join-code').value = drafts.joinCode || '';
  $('answer-code').value = drafts.answerCode || '';
  $('join-form').hidden = !drafts.joinOpen;
  $('show-join').setAttribute('aria-expanded', String(!!drafts.joinOpen));
  initialized = true;
  render(state);
  copiedInvite = state.party?.role === 'host' ? state.invitation?.link || state.invitation?.code : state.answer;
  detectClipboard(state);
} catch (error) {
  $('boot-screen').hidden = true;
  document.body.classList.remove('booting');
  $('loading').hidden = true;
  showText('error', error.message);
}
