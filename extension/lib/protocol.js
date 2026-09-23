const PREFIX = 'WP1.';
const COMPACT_PREFIX = 'WP2.';
const CODE_PATTERN = /WP[12]\.[A-Za-z0-9_-]+/;
const MAX_CODE_LENGTH = 140000;
const MAX_BYTES = 120000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_ID = /^[a-zA-Z0-9_-]+$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateSignal(signal) {
  if (!isObject(signal) || signal.version !== 1) {
    throw new Error('Sinal inv\u00e1lido ou vers\u00e3o n\u00e3o suportada.');
  }
  const { type, partyId, inviteId, name, createdAt, description } = signal;
  if (type !== 'offer' && type !== 'answer') {
    throw new Error('Tipo de sinal inv\u00e1lido.');
  }
  if (typeof partyId !== 'string' || !UUID.test(partyId) ||
      typeof inviteId !== 'string' || !UUID.test(inviteId)) {
    throw new Error('Identificador da sala ou do convite inv\u00e1lido.');
  }
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 40) {
    throw new Error('O nome deve ter entre 1 e 40 caracteres.');
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('Data do convite inv\u00e1lida.');
  }
  const now = Date.now();
  if (createdAt < now - 30 * 60 * 1000) {
    throw new Error('Este convite expirou. Pe\u00e7a um novo convite.');
  }
  if (createdAt > now + 5 * 60 * 1000) {
    throw new Error('A data do convite est\u00e1 no futuro. Verifique o rel\u00f3gio.');
  }
  if (!isObject(description) || description.type !== type ||
      typeof description.sdp !== 'string' || description.sdp.length > 100000 ||
      !description.sdp.includes('v=0') || !description.sdp.includes('a=fingerprint:')) {
    throw new Error('Descri\u00e7\u00e3o de conex\u00e3o inv\u00e1lida.');
  }
  return {
    version: 1, type, partyId, inviteId, name: name.trim(), createdAt,
    description: { type, sdp: description.sdp },
  };
}

async function readLimited(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        throw new RangeError('O c\u00f3digo excede o tamanho permitido.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Compact codes (WP2) keep only what a data-channel-only connection needs: ICE credentials,
// the DTLS fingerprint and UDP candidates. The SDP is rebuilt on decoding.
const SETUPS = ['actpass', 'active', 'passive'];
const ICE_CHARS = /^[A-Za-z0-9+/]+$/;
const MAX_CANDIDATES = 16;
// Candidate kinds: address format and type.
const KINDS = [
  { typ: 'host', family: 4 }, { typ: 'host', family: 6 }, { typ: 'host', family: 'mdns' },
  { typ: 'srflx', family: 4 }, { typ: 'srflx', family: 6 },
];

function uuidBytes(uuid) {
  return Uint8Array.from(uuid.replace(/-/g, '').match(/../g), (hex) => parseInt(hex, 16));
}

function bytesUuid(bytes) {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ipv6Bytes(address) {
  if (!/^[0-9a-f:]+$/i.test(address) || (address.match(/::/g) || []).length > 1) return null;
  const [head, tail] = address.includes('::') ? address.split('::') : [address, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === null ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return Uint8Array.from(groups.flatMap((group) => [parseInt(group, 16) >> 8, parseInt(group, 16) & 255]));
}

function candidateAddress(address) {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (ipv4) {
    const bytes = ipv4.slice(1).map(Number);
    return bytes.every((byte) => byte <= 255) ? { family: 4, bytes: Uint8Array.from(bytes) } : null;
  }
  const mdns = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.local$/i.exec(address);
  if (mdns) return { family: 'mdns', bytes: uuidBytes(mdns[1].toLowerCase()) };
  const bytes = ipv6Bytes(address);
  return bytes ? { family: 6, bytes } : null;
}

function formatAddress(family, bytes) {
  if (family === 4) return [...bytes].join('.');
  if (family === 'mdns') return `${bytesUuid(bytes)}.local`;
  const groups = [];
  for (let index = 0; index < 16; index += 2) groups.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
  return groups.join(':');
}

function compactSignal(signal) {
  const sdp = signal.description.sdp;
  const line = (pattern) => {
    const matches = [...sdp.matchAll(new RegExp(`^a=${pattern}\\r?$`, 'gm'))];
    return matches.length === 1 ? matches[0] : null;
  };
  if ((sdp.match(/^m=/gm) || []).length !== 1 ||
      !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel\r?$/m.test(sdp)) return null;
  const ufrag = line('ice-ufrag:(\\S+)')?.[1];
  const pwd = line('ice-pwd:(\\S+)')?.[1];
  const fingerprint = line('fingerprint:sha-256 ((?:[0-9A-F]{2}:){31}[0-9A-F]{2})')?.[1];
  const setup = SETUPS.indexOf(line('setup:(\\w+)')?.[1]);
  if (!ufrag || !pwd || !fingerprint || setup < 0 || line('mid:0') === null || line('sctp-port:5000') === null ||
      !ICE_CHARS.test(ufrag) || !ICE_CHARS.test(pwd) || ufrag.length < 4 || ufrag.length > 255 ||
      pwd.length < 22 || pwd.length > 255) return null;
  const candidates = [];
  for (const [, component, protocol, address, port, typ] of
    sdp.matchAll(/^a=candidate:\S+ (\d+) (\w+) \d+ (\S+) (\d+) typ (\w+)/gm)) {
    if (component !== '1' || protocol.toLowerCase() !== 'udp' || !['host', 'srflx'].includes(typ)) continue;
    const parsed = candidateAddress(address);
    const kind = KINDS.findIndex((item) => item.typ === typ && item.family === parsed?.family);
    if (kind < 0 || Number(port) < 1 || Number(port) > 65535) continue;
    candidates.push({ kind, bytes: parsed.bytes, port: Number(port) });
  }
  if (!candidates.length || candidates.length > MAX_CANDIDATES) return null;
  const name = new TextEncoder().encode(signal.name);
  const text = (value) => [value.length, ...new TextEncoder().encode(value)];
  const bytes = [
    (signal.type === 'answer' ? 1 : 0) | (setup << 1),
    ...uuidBytes(signal.partyId), ...uuidBytes(signal.inviteId),
    ...Array.from({ length: 6 }, (_, index) => Math.floor(signal.createdAt / 2 ** (8 * (5 - index))) & 255),
    ...fingerprint.split(':').map((hex) => parseInt(hex, 16)),
    ...text(ufrag), ...text(pwd), name.length, ...name, candidates.length,
  ];
  for (const candidate of candidates) bytes.push(candidate.kind, ...candidate.bytes, candidate.port >> 8, candidate.port & 255);
  return Uint8Array.from(bytes);
}

function expandSignal(bytes) {
  let offset = 0;
  const take = (length) => {
    if (offset + length > bytes.length) throw new Error();
    const chunk = bytes.subarray(offset, offset + length);
    offset += length;
    return chunk;
  };
  const text = () => new TextDecoder('utf-8', { fatal: true }).decode(take(take(1)[0]));
  const header = take(1)[0];
  if (header > 5) throw new Error();
  const type = header & 1 ? 'answer' : 'offer';
  const setup = SETUPS[header >> 1];
  const partyId = bytesUuid(take(16));
  const inviteId = bytesUuid(take(16));
  const createdAt = [...take(6)].reduce((value, byte) => value * 256 + byte, 0);
  const fingerprint = [...take(32)].map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(':');
  const ufrag = text();
  const pwd = text();
  const name = text();
  if (!ICE_CHARS.test(ufrag) || !ICE_CHARS.test(pwd) || ufrag.length < 4 || pwd.length < 22) throw new Error();
  const count = take(1)[0];
  if (!count || count > MAX_CANDIDATES) throw new Error();
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const kind = KINDS[take(1)[0]];
    if (!kind) throw new Error();
    const address = formatAddress(kind.family, take(kind.family === 4 ? 4 : 16));
    const [high, low] = take(2);
    const port = (high << 8) | low;
    if (!port) throw new Error();
    const priority = (kind.typ === 'host' ? 126 : 100) * 2 ** 24 + (65535 - index) * 2 ** 8 + 255;
    candidates.push(`a=candidate:${index + 1} 1 udp ${priority} ${address} ${port} typ ${kind.typ}` +
      (kind.typ === 'srflx' ? ' raddr 0.0.0.0 rport 0' : ''));
  }
  if (offset !== bytes.length) throw new Error();
  const sdp = ['v=0', `o=- ${createdAt} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0',
    'a=msid-semantic: WMS', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    ...candidates, `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`, `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${setup}`, 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', ''].join('\r\n');
  return { version: 1, type, partyId, inviteId, name, createdAt, description: { type, sdp } };
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(payload) {
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) {
    throw new Error('O c\u00f3digo cont\u00e9m base64 inv\u00e1lida.');
  }
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    // Reject noncanonical trailing bits as well as invalid characters.
    if (btoa(binary).replace(/=+$/, '') !== base64) throw new Error();
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error('O c\u00f3digo cont\u00e9m base64 inv\u00e1lida.');
  }
}

// Finds a code inside pasted text: a bare code, a chat message or an invite link (#wp=...).
export function extractCode(text) {
  return typeof text === 'string' && text.length <= MAX_CODE_LENGTH ? CODE_PATTERN.exec(text)?.[0] ?? null : null;
}

export async function encodeCode(signal) {
  const valid = validateSignal(signal);
  const compact = compactSignal(valid);
  if (compact) return COMPACT_PREFIX + toBase64Url(compact);
  return encodeFullCode(valid);
}

async function encodeFullCode(signal) {
  const bytes = new TextEncoder().encode(JSON.stringify(validateSignal(signal)));
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error('O sinal excede o tamanho permitido.');
  }
  let compressed;
  try {
    compressed = await readLimited(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
      MAX_CODE_LENGTH,
    );
  } catch {
    throw new Error('N\u00e3o foi poss\u00edvel compactar o convite.');
  }
  let binary = '';
  for (const byte of compressed) binary += String.fromCharCode(byte);
  const code = PREFIX + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (code.length > MAX_CODE_LENGTH) {
    throw new Error('O c\u00f3digo excede o tamanho permitido.');
  }
  return code;
}

export async function decodeCode(text) {
  if (typeof text !== 'string') throw new Error('Cole um c\u00f3digo de convite v\u00e1lido.');
  // Check before trimming so whitespace cannot bypass the raw input limit.
  if (text.length > MAX_CODE_LENGTH) throw new Error('O c\u00f3digo excede o tamanho permitido.');
  const code = text.trim();
  if (code.startsWith(COMPACT_PREFIX)) {
    const bytes = fromBase64Url(code.slice(COMPACT_PREFIX.length));
    let signal;
    try {
      signal = expandSignal(bytes);
    } catch {
      throw new Error('O c\u00f3digo est\u00e1 incompleto ou corrompido. Copie a mensagem inteira.');
    }
    return validateSignal(signal);
  }
  if (!code.startsWith(PREFIX)) throw new Error('Prefixo do convite inv\u00e1lido. Use um c\u00f3digo WP1 ou WP2.');
  const compressed = fromBase64Url(code.slice(PREFIX.length));
  let bytes;
  try {
    bytes = await readLimited(
      new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),
      MAX_BYTES,
    );
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new Error('O convite est\u00e1 corrompido ou n\u00e3o usa gzip v\u00e1lido.');
  }
  let signal;
  try {
    signal = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('O conte\u00fado do convite n\u00e3o \u00e9 um JSON v\u00e1lido.');
  }
  return validateSignal(signal);
}

export function mediaKey(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  const { hostname, pathname, searchParams } = parsed;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(hostname)) {
    const id = pathname === '/watch'
      ? searchParams.get('v')
      : /^\/shorts\/([a-zA-Z0-9_-]+)\/?$/.exec(pathname)?.[1];
    return typeof id === 'string' && MEDIA_ID.test(id) ? `youtube:${id}` : null;
  }
  if (hostname === 'crunchyroll.com' || hostname.endsWith('.crunchyroll.com')) {
    const id = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?watch\/([a-zA-Z0-9_-]+)(?:\/[^/]+)?\/?$/i.exec(pathname)?.[1];
    return id ? `crunchyroll:${id}` : null;
  }
  return null;
}

export function isSupportedUrl(url) {
  return mediaKey(url) !== null;
}

export function normalizePlayback(input) {
  if (!isObject(input)) return null;
  const { time, paused, rate, duration, buffering = false } = input;
  if (!Number.isFinite(time) || time < 0 || typeof paused !== 'boolean' ||
      !Number.isFinite(rate) || rate <= 0 || rate > 16 ||
      !Number.isFinite(duration) || duration < 0 || typeof buffering !== 'boolean') {
    return null;
  }
  return { time, paused, rate, duration, buffering };
}
