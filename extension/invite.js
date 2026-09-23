(function () {
  'use strict';

  const match = /(?:^#|&)wp=(WP[12]\.[A-Za-z0-9_-]+)/.exec(location.hash);
  if (!match) return;
  const code = match[1];
  // Runs at document_start, before the site's scripts: drop the invite from the address so the
  // page never reads it. Fragments are not sent to servers, so it only ever existed locally.
  history.replaceState(history.state, '', location.pathname + location.search);

  let root = null;
  let card = null;
  let hostName = 'o host';
  let pollTimer = null;

  function request(action, payload = {}) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ target: 'broker', action, payload }, (response) => {
          const error = chrome.runtime.lastError;
          if (error || !response || !response.ok) {
            reject(new Error((response && response.error) || 'A extensao nao respondeu. Recarregue a pagina.'));
          } else resolve(response.data);
        });
      } catch (error) {
        reject(new Error('A extensao foi atualizada. Recarregue a pagina.'));
      }
    });
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function close() {
    clearInterval(pollTimer);
    if (root) root.remove();
    root = null;
  }

  function mount() {
    root = element('div');
    root.style.cssText = 'all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647;';
    const shadow = root.attachShadow({ mode: 'closed' });
    const style = element('style');
    style.textContent = `
      .card { width: 300px; box-sizing: border-box; padding: 16px; border-radius: 14px;
        background: #222a24; color: #e5e9dd; font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 12px 32px rgba(0, 0, 0, .45); border: 1px solid #3a453b; }
      .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
      .brand { font: italic bold 16px Georgia, serif; }
      .brand span { color: #edaa76; }
      .x { all: unset; cursor: pointer; padding: 2px 6px; color: #9aa597; font-size: 18px; }
      h2 { margin: 0 0 10px; font: 19px/1.2 Georgia, serif; letter-spacing: -0.3px; }
      p { margin: 0 0 10px; color: #c3cbbd; }
      label { display: block; font-size: 12px; color: #9aa597; margin-bottom: 4px; }
      input, textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px;
        border: 1px solid #465344; background: #1a201b; color: inherit; font: inherit; margin-bottom: 10px; }
      textarea { font: 11px/1.3 ui-monospace, monospace; resize: none; height: 54px; }
      button.primary, button.secondary { all: unset; box-sizing: border-box; display: block; width: 100%;
        text-align: center; padding: 9px 12px; border-radius: 8px; cursor: pointer; font-weight: 600; }
      button.primary { background: #edaa76; color: #242a23; }
      button.secondary { margin-top: 6px; color: #e5e9dd; background: #2a342c; border: 1px solid #465344; }
      button:disabled { opacity: .5; cursor: default; }
      .error { color: #f0907a; }
      .ok { color: #9fd89a; }
    `;
    card = element('div', 'card');
    shadow.append(style, card);
    (document.body || document.documentElement).append(root);
  }

  function render(title, body, actions = []) {
    const top = element('div', 'top');
    const brand = element('span', 'brand', 'web party');
    brand.append(element('span', null, '.'));
    const dismiss = element('button', 'x', '×');
    dismiss.setAttribute('aria-label', 'Fechar');
    dismiss.addEventListener('click', close);
    top.append(brand, dismiss);
    card.replaceChildren(top, element('h2', null, title), ...body, ...actions);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // The site's permissions policy may block the async API; the extension may still copy.
      const area = element('textarea');
      area.value = text;
      card.append(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      return copied;
    }
  }

  function showError(message) {
    const retry = element('button', 'secondary', 'Fechar');
    retry.addEventListener('click', close);
    render('Nao foi possivel entrar', [element('p', 'error', message)], [retry]);
  }

  async function showAnswer(answer) {
    const copied = await copy(answer);
    const area = element('textarea');
    area.readOnly = true;
    area.value = answer;
    const button = element('button', copied ? 'secondary' : 'primary', copied ? 'Copiar de novo' : 'Copiar resposta');
    const status = element('p', copied ? 'ok' : null, copied
      ? `Resposta copiada! Cole no chat com ${hostName} e envie.`
      : `Copie a resposta e envie no chat com ${hostName}.`);
    button.addEventListener('click', async () => {
      if (await copy(answer)) {
        status.className = 'ok';
        status.textContent = `Resposta copiada! Cole no chat com ${hostName} e envie.`;
      }
    });
    render('Falta so um passo', [status, area,
      element('p', null, 'Quando o host colar, o video sincroniza sozinho. Voce pode fechar este aviso.')], [button]);
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const status = await request('LINK_STATUS');
        if (status.connected) {
          clearInterval(pollTimer);
          render('Conectado!', [element('p', 'ok', `Voce esta na party de ${hostName}. O video segue o host.`)]);
          setTimeout(close, 4000);
        } else if (status.failed || !status.answer) {
          clearInterval(pollTimer);
          showError('A conexao nao foi concluida. Peca um novo link ao host.');
        }
      } catch (_) {
        clearInterval(pollTimer);
      }
    }, 2000);
  }

  function showInvite(info) {
    const label = element('label', null, 'Como seus amigos te chamam?');
    const input = element('input');
    input.maxLength = 40;
    input.value = info.name;
    input.placeholder = 'Seu nome';
    label.htmlFor = input.id = 'wp-name';
    const join = element('button', 'primary', 'Entrar na party');
    const later = element('button', 'secondary', 'Agora nao');
    later.addEventListener('click', close);
    const submit = async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      join.disabled = later.disabled = input.disabled = true;
      render('Preparando sua resposta...', [element('p', null, 'Isso pode levar ate 20 segundos.')]);
      try {
        const result = await request('LINK_JOIN', { code, name });
        if (!result.answer) throw new Error('A conexao nao gerou uma resposta. Peca um novo link.');
        await showAnswer(result.answer);
      } catch (error) {
        showError(error.message);
      }
    };
    join.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
    const body = [element('p', null, 'Voce vai assistir sincronizado. So os controles viajam; o video e de cada um.'), label, input];
    if (info.inParty) body.push(element('p', 'error', 'Voce ja esta em uma party. Saia dela pelo icone da extensao antes de entrar.'));
    render(`Entrar na party de ${info.host}?`, body, [join, later]);
    if (!info.inParty) setTimeout(() => input.focus(), 0);
    else join.disabled = true;
  }

  async function start() {
    mount();
    try {
      const info = await request('LINK_INVITE', { code });
      hostName = info.host;
      showInvite(info);
    } catch (error) {
      showError(error.message);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
