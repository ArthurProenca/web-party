import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/invite.js', import.meta.url), 'utf8');

function load(hash) {
  const replaced = [];
  const messages = [];
  vm.runInNewContext(source, {
    location: { hash, pathname: '/watch', search: '?v=video-one' },
    history: { state: { page: 1 }, replaceState: (...args) => replaced.push(args) },
    document: { readyState: 'loading', addEventListener() {} },
    chrome: { runtime: { sendMessage: (message) => messages.push(message) } },
  });
  return { replaced, messages };
}

test('invite links are removed from the address before the page scripts run', () => {
  const { replaced } = load('#wp=WP2.AbC_-9');
  assert.deepEqual(replaced, [[{ page: 1 }, '', '/watch?v=video-one']]);
});

test('pages without an invite are left untouched', () => {
  for (const hash of ['', '#t=30', '#wp=nope']) {
    const { replaced, messages } = load(hash);
    assert.deepEqual(replaced, []);
    assert.deepEqual(messages, []);
  }
});
