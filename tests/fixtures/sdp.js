// Captured from Chrome after ICE gathering completes (public address replaced by a documentation IP).
// Note the m= and c= lines carry the default candidate, not the pre-gathering port 9.
export function chromeSdp(type) {
  return [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 61234 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 203.0.113.7',
    'a=candidate:3016924133 1 udp 2113937151 0f5b6a3e-2c1d-4e8f-9a7b-1c2d3e4f5a6b.local 54321 typ host generation 0 network-cost 999',
    'a=candidate:842163049 1 udp 1677729535 203.0.113.7 61234 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
    'a=candidate:1234567 1 udp 1677729535 2001:db8::1 61235 typ srflx raddr :: rport 0 generation 0',
    'a=candidate:99 1 tcp 1518280447 192.0.2.4 9 typ host tcptype active generation 0',
    'a=ice-ufrag:Xk9p',
    'a=ice-pwd:0aB1cD2eF3gH4iJ5kL6mN7oP',
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 6B:8B:5D:EA:59:04:20:23:29:C8:87:1C:CC:87:32:BE:DD:8C:66:A5:8E:50:55:EA:8C:D3:B6:5C:09:5E:D6:BC',
    `a=setup:${type === 'offer' ? 'actpass' : 'active'}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
}
