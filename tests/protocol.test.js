import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCode, decodeCode, extractCode, validateSignal, isSupportedUrl, mediaKey, normalizePlayback } from '../extension/lib/protocol.js';
import { chromeSdp } from './fixtures/sdp.js';

function signal(overrides = {}) {
  return {
    version: 1,
    type: 'offer',
    partyId: '123e4567-e89b-42d3-a456-426614174000',
    inviteId: '123e4567-e89b-42d3-a456-426614174001',
    name: '  Ana  ',
    createdAt: Date.now(),
    description: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n' },
    ...overrides,
  };
}

async function rawCode(content) {
  const stream = new Blob([content]).stream().pipeThrough(new CompressionStream('gzip'));
  return 'WP1.' + Buffer.from(await new Response(stream).arrayBuffer()).toString('base64url');
}

test('offer and answer roundtrip through gzip and unpadded base64url', async () => {
  for (const type of ['offer', 'answer']) {
    const input = signal({ type, name: '  Jo\u00e3o  ', description: { ...signal().description, type } });
    const code = await encodeCode(input);
    assert.match(code, /^WP1\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(await decodeCode(` \n${code}\n `), validateSignal(input));
  }
});

test('validation sanitizes unknown fields without mutating the input', async () => {
  const input = signal({ extra: true });
  input.description.extra = true;
  const validated = validateSignal(input);
  assert.equal(validated.name, 'Ana');
  assert.equal(input.name, '  Ana  ');
  assert.equal('extra' in validated, false);
  assert.equal('extra' in validated.description, false);
  assert.notEqual(validated.description, input.description);
  assert.deepEqual(await decodeCode(await rawCode(JSON.stringify(input))), validated);
});

test('invalid schemas are rejected by validation and encoding', async () => {
  const invalid = [null, [], 'offer', {}, signal({ version: 2 }), signal({ type: 'other' }),
    signal({ partyId: 'not-a-uuid' }), signal({ inviteId: 12 }),
    signal({ partyId: signal().partyId + '-extra' }),
    signal({ name: '' }), signal({ name: ' \n ' }), signal({ name: 42 }), signal({ name: 'a'.repeat(41) }),
    signal({ description: null }), signal({ description: [] }),
    signal({ description: { type: 'answer', sdp: signal().description.sdp } }),
    signal({ description: { type: 'offer', sdp: 12 } }),
    signal({ description: { type: 'offer', sdp: 'v=0' } }),
    signal({ description: { type: 'offer', sdp: 'a=fingerprint:AA' } }),
    signal({ description: { type: 'offer', sdp: 'v=0\na=fingerprint:' + 'x'.repeat(100000) } })];
  for (const value of invalid) {
    assert.throws(() => validateSignal(value), Error);
    await assert.rejects(encodeCode(value), Error);
  }
  assert.equal(validateSignal(signal({ name: 'a'.repeat(40) })).name.length, 40);
  const sdp = 'v=0\na=fingerprint:'.padEnd(100000, 'x');
  assert.equal(validateSignal(signal({ description: { type: 'offer', sdp } })).description.sdp.length, 100000);
});

test('timestamps enforce exact expiry and future tolerance boundaries', (t) => {
  const now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  for (const createdAt of [now, now - 1800000, now + 300000]) {
    assert.equal(validateSignal(signal({ createdAt })).createdAt, createdAt);
  }
  assert.throws(() => validateSignal(signal({ createdAt: now - 1800001 })), /expirou/);
  assert.throws(() => validateSignal(signal({ createdAt: now + 300001 })), /futuro/);
  for (const createdAt of [NaN, Infinity, -Infinity, -1, 1.5, '1800000000000', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateSignal(signal({ createdAt })), /Data/);
  }
});

test('decoding revalidates schema and timestamps', async () => {
  for (const input of [signal({ version: 9 }), signal({ createdAt: Date.now() - 1801000 }), signal({ createdAt: Date.now() + 301000 })]) {
    await assert.rejects(decodeCode(await rawCode(JSON.stringify(input))), /vers\u00e3o|expirou|futuro/);
  }
});

test('rejects wrong prefixes, malformed and noncanonical base64', async () => {
  for (const text of [null, 42, {}, '', 'WP2.AA', 'wp1.AA', 'WP1', 'WP1.', 'WP1.A', 'WP1.AAAAA',
    'WP1.AA==', 'WP1.A+A/', 'WP1.A A', 'WP1.A\nA', 'WP1.\u00e9', 'WP1.AB', 'WP1.AAB']) {
    await assert.rejects(decodeCode(text), /c\u00f3digo|Prefixo|base64/);
  }
});

test('rejects non-gzip, corrupt and truncated gzip', async () => {
  const code = await encodeCode(signal());
  const bytes = Buffer.from(code.slice(4), 'base64url');
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 8] ^= 0xff;
  for (const payload of [Buffer.from('not gzip'), bytes.subarray(0, bytes.length - 1), corrupt]) {
    await assert.rejects(decodeCode('WP1.' + payload.toString('base64url')), /corrompido|gzip/);
  }
});

test('rejects malformed JSON and invalid UTF-8', async () => {
  for (const content of ['{oops', '', Buffer.from([0xff, 0xfe])]) {
    await assert.rejects(decodeCode(await rawCode(content)), /JSON/);
  }
  for (const content of ['null', '[]', '{}']) {
    await assert.rejects(decodeCode(await rawCode(content)), /Sinal/);
  }
});

test('raw input cap applies before trimming and accepts the exact boundary', async () => {
  const code = await encodeCode(signal());
  assert.equal((await decodeCode(code.padEnd(140000, ' '))).name, 'Ana');
  for (const text of [code.padEnd(140001, ' '), 'WP1.' + 'A'.repeat(139997)]) {
    await assert.rejects(decodeCode(text), /tamanho/);
  }
});

test('decompressed byte cap accepts 120000 bytes and rejects larger streams', async () => {
  const input = signal();
  const json = JSON.stringify(input);
  const atLimit = json + ' '.repeat(120000 - Buffer.byteLength(json));
  assert.deepEqual(await decodeCode(await rawCode(atLimit)), validateSignal(input));
  for (const content of [atLimit + ' ', ' '.repeat(2000000)]) {
    await assert.rejects(decodeCode(await rawCode(content)), /tamanho/);
  }
  const unicode = JSON.stringify({ ...input, ignored: '\u00e9'.repeat(60000) });
  assert.ok(unicode.length < 120000);
  await assert.rejects(decodeCode(await rawCode(unicode)), /tamanho/);
});

test('encoding bounds UTF-8 bytes and escaped JSON, not just SDP characters', async () => {
  for (const padding of ['\u00e9'.repeat(60000), '\n'.repeat(60000)]) {
    const input = signal({ description: { type: 'offer', sdp: 'v=0\na=fingerprint:' + padding } });
    validateSignal(input);
    await assert.rejects(encodeCode(input), /tamanho/);
  }
});

test('supported media keys ignore query parameters, fragments, subdomains and locale', () => {
  const groups = [
    ['youtube:Ab_C-123', ['https://youtube.com/watch?v=Ab_C-123',
      'https://www.youtube.com/watch?list=xyz&v=Ab_C-123&t=9#fragment',
      'https://m.youtube.com/shorts/Ab_C-123?feature=share', 'https://youtube.com/shorts/Ab_C-123/']],
    ['crunchyroll:G123', ['https://crunchyroll.com/watch/G123',
      'https://www.crunchyroll.com/pt-br/watch/G123?foo=bar',
      'https://www.crunchyroll.com/pt-br/watch/G123/episode-title',
      'https://www.crunchyroll.com/watch/G123/another-localized-title/',
      'https://beta.crunchyroll.com/en/watch/G123#fragment', 'https://www.crunchyroll.com/watch/G123/']],
  ];
  for (const [key, urls] of groups) {
    for (const url of urls) {
      assert.equal(isSupportedUrl(url), true, url);
      assert.equal(mediaKey(url), key, url);
    }
  }
  assert.notEqual(mediaKey('https://youtube.com/watch?v=one'), mediaKey('https://youtube.com/watch?v=two'));
  assert.notEqual(mediaKey('https://youtube.com/watch?v=G123'), mediaKey('https://crunchyroll.com/watch/G123'));
});

test('rejects domain spoofing, unsupported protocols, routes and missing IDs', () => {
  const urls = [null, {}, '', '/watch?v=x', 'not a url',
    'http://youtube.com/watch?v=x', 'ftp://crunchyroll.com/watch/x',
    'https://youtube.com.evil.test/watch?v=x', 'https://notyoutube.com/watch?v=x',
    'https://www.youtube.com@evil.test/watch?v=x', 'https://evil.test@youtube.com/watch?v=x',
    'https://evil.youtube.com/watch?v=x', 'https://youtu.be/x',
    'https://crunchyroll.com.evil.test/watch/x', 'https://fakecrunchyroll.com/watch/x',
    'https://youtube.com/', 'https://youtube.com/watch', 'https://youtube.com/watch?v=',
    'https://youtube.com/watch?v=x%2Fy', 'https://youtube.com/watch?v=%20',
    'https://youtube.com/shorts/', 'https://youtube.com/shorts/x/extra',
    'https://crunchyroll.com/watch/', 'https://crunchyroll.com/en/watch/',
    'https://crunchyroll.com/series/x', 'https://crunchyroll.com/foo/bar/watch/x',
    'https://crunchyroll.com/watch/x/title/extra'];
  for (const url of urls) {
    assert.equal(isSupportedUrl(url), false, String(url));
    assert.equal(mediaKey(url), null, String(url));
  }
});

test('playback normalization sanitizes and defaults buffering', () => {
  const input = { time: 0, paused: false, rate: 1, duration: 0, extra: true };
  assert.deepEqual(normalizePlayback(input), { time: 0, paused: false, rate: 1, duration: 0, buffering: false });
  assert.equal('buffering' in input, false);
  const full = { time: 10.5, paused: true, rate: 16, duration: 100.5, buffering: true };
  assert.deepEqual(normalizePlayback(full), full);
  assert.notEqual(normalizePlayback(full), full);
  assert.equal(normalizePlayback({ ...full, rate: 0.01 }).rate, 0.01);
});

test('playback rejects missing fields, non-finite values and coercion', () => {
  const valid = { time: 1, paused: true, rate: 1, duration: 100 };
  for (const input of [null, undefined, [], {}, 42, 'playback']) assert.equal(normalizePlayback(input), null);
  for (const field of ['time', 'duration', 'rate']) {
    for (const value of [NaN, Infinity, -Infinity, -1, '1', null, undefined]) {
      assert.equal(normalizePlayback({ ...valid, [field]: value }), null, `${field}: ${value}`);
    }
  }
  for (const rate of [0, 16.01]) assert.equal(normalizePlayback({ ...valid, rate }), null);
  for (const paused of [0, 1, 'false', null, undefined]) assert.equal(normalizePlayback({ ...valid, paused }), null);
  for (const buffering of [0, 1, 'false', null]) assert.equal(normalizePlayback({ ...valid, buffering }), null);
});

test('real data-channel SDPs become short WP2 codes that rebuild an equivalent SDP', async () => {
  for (const type of ['offer', 'answer']) {
    const input = signal({ type, name: 'Jo\u00e3o', description: { type, sdp: chromeSdp(type) } });
    const code = await encodeCode(input);
    assert.match(code, /^WP2\.[A-Za-z0-9_-]+$/);
    assert.ok(code.length < 260, `expected a short code, got ${code.length} characters`);
    const decoded = await decodeCode(code);
    assert.deepEqual({ ...decoded, description: null }, { ...validateSignal(input), description: null });
    const sdp = decoded.description.sdp;
    for (const line of ['a=ice-ufrag:Xk9p', 'a=ice-pwd:0aB1cD2eF3gH4iJ5kL6mN7oP', 'a=mid:0', 'a=sctp-port:5000',
      `a=setup:${type === 'offer' ? 'actpass' : 'active'}`,
      'a=fingerprint:sha-256 6B:8B:5D:EA:59:04:20:23:29:C8:87:1C:CC:87:32:BE:DD:8C:66:A5:8E:50:55:EA:8C:D3:B6:5C:09:5E:D6:BC',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel']) {
      assert.ok(sdp.split('\r\n').includes(line), line);
    }
    const candidates = sdp.split('\r\n').filter((line) => line.startsWith('a=candidate:'));
    assert.equal(candidates.length, 3, 'TCP candidates are dropped');
    assert.match(candidates[0], / 0f5b6a3e-2c1d-4e8f-9a7b-1c2d3e4f5a6b\.local 54321 typ host$/);
    assert.match(candidates[1], / 203\.0\.113\.7 61234 typ srflx raddr 0\.0\.0\.0 rport 0$/);
    assert.match(candidates[2], / 2001:db8:0:0:0:0:0:1 61235 typ srflx/);
  }
});

test('SDPs that cannot be compacted fall back to full WP1 codes', async () => {
  const noCandidates = chromeSdp('offer').split('\r\n').filter((line) => !/ udp /.test(line)).join('\r\n');
  for (const sdp of [signal().description.sdp, noCandidates, chromeSdp('offer').replace('sha-256', 'sha-1'),
    chromeSdp('offer') + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n']) {
    const code = await encodeCode(signal({ description: { type: 'offer', sdp } }));
    assert.match(code, /^WP1\./);
    assert.equal((await decodeCode(code)).description.sdp, sdp);
  }
});

test('truncated, extended or tampered WP2 codes are rejected', async () => {
  const code = await encodeCode(signal({ description: { type: 'offer', sdp: chromeSdp('offer') } }));
  const bytes = Buffer.from(code.slice(4), 'base64url');
  const kind = Buffer.from(bytes);
  kind[0] = 7;
  for (const payload of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from([0])]), kind]) {
    await assert.rejects(decodeCode('WP2.' + payload.toString('base64url')), /incompleto|corrompido/);
  }
  const old = Buffer.from(bytes);
  old.writeUIntBE(Date.now() - 31 * 60 * 1000, 33, 6);
  await assert.rejects(decodeCode('WP2.' + old.toString('base64url')), /expirou/);
});

test('codes are found inside invite links and chat messages', () => {
  assert.equal(extractCode('https://www.youtube.com/watch?v=abc#wp=WP2.AbC_-9'), 'WP2.AbC_-9');
  assert.equal(extractCode('Minha resposta: WP1.xyz obrigado'), 'WP1.xyz');
  for (const text of ['nada aqui', 'WP3.abc', null, 'x'.repeat(140001) + 'WP2.abc']) assert.equal(extractCode(text), null);
});
