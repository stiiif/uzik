// Lets Uzikext find the server on the home network by itself (mDNS / DNS-SD, the way printers are found):
// it answers questions for "_uzikext._tcp.local" with its name, port and identity.
//
// This only reaches the devices when the container shares the machine's network (network_mode: host); in
// Docker's default bridge network the questions never arrive, and Uzikext finds the server by looking at
// the addresses of the home network instead (and by its identity, so a new address is followed).
const dgram = require('dgram');
const os = require('os');

const SERVICE = '_uzikext._tcp.local';
const MDNS_ADDR = '224.0.0.251', MDNS_PORT = 5353;

function encName(name) {
  const parts = name.replace(/\.$/, '').split('.');
  const bufs = [];
  for (const p of parts) { const b = Buffer.from(p, 'utf8').subarray(0, 63); bufs.push(Buffer.from([b.length]), b); }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}
function readName(buf, off) {
  const labels = []; let jumped = false, end = off, guard = 0;
  for (;;) {
    if (off >= buf.length || ++guard > 128) throw new Error('bad name');
    const len = buf[off];
    if (len === 0) { if (!jumped) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = off + 2; off = ((len & 0x3f) << 8) | buf[off + 1]; jumped = true; continue; }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len)); off += 1 + len;
  }
  return { name: labels.join('.'), end };
}
function rr(name, type, ttl, rdata, flush) {
  const n = encName(name), h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0); h.writeUInt16BE(flush ? 0x8001 : 1, 2); h.writeUInt32BE(ttl, 4); h.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([n, h, rdata]);
}
function txt(obj) {
  return Buffer.concat(Object.entries(obj).map(([k, v]) => { const b = Buffer.from(`${k}=${v}`, 'utf8').subarray(0, 255); return Buffer.concat([Buffer.from([b.length]), b]); }));
}
function localV4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

// questions in a DNS message -> [{ name, type }]
function parseQuestions(buf) {
  if (buf.length < 12) return [];
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return [];   // a response, not a query
  const qd = buf.readUInt16BE(4);
  const out = []; let off = 12;
  for (let i = 0; i < qd; i++) {
    const { name, end } = readName(buf, off);
    out.push({ name: name.toLowerCase(), type: buf.readUInt16BE(end) });
    off = end + 4;
  }
  return out;
}

function startDiscovery({ port, getIdentity, log }) {
  let sock;
  const host = (os.hostname().replace(/[^A-Za-z0-9-]/g, '') || 'uzikext').slice(0, 40) + '-uzikext.local';
  function answer(id) {
    const instance = `${id.name.replace(/[.\u0000-\u001f]/g, ' ').slice(0, 50)}.${SERVICE}`;
    const srv = Buffer.alloc(6); srv.writeUInt16BE(0, 0); srv.writeUInt16BE(0, 2); srv.writeUInt16BE(port, 4);
    const recs = [
      rr(SERVICE, 12, 4500, encName(instance)),
      rr(instance, 33, 120, Buffer.concat([srv, encName(host)]), true),
      rr(instance, 16, 4500, txt({ id: id.id, v: id.version, app: 'uzikext', port }), true),
      ...localV4().map(a => rr(host, 1, 120, Buffer.from(a.split('.').map(Number)), true))
    ];
    const h = Buffer.alloc(12);
    h.writeUInt16BE(0x8400, 2); h.writeUInt16BE(recs.length, 6);
    return { msg: Buffer.concat([h, ...recs]), instance: instance.toLowerCase() };
  }
  try {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', e => { log(`Discovery (mDNS) off: ${e.message}`); try { sock.close(); } catch (x) {} });
    sock.on('message', (buf, rinfo) => {
      let qs; try { qs = parseQuestions(buf); } catch (e) { return; }
      if (!qs.length) return;
      const a = answer(getIdentity());
      const wanted = qs.some(q => ((q.type === 12 || q.type === 255) && (q.name === SERVICE || q.name === '_services._dns-sd._udp.local')) || q.name === a.instance);
      if (!wanted) return;
      // a one-shot question (from another port than 5353) is answered to its sender, the others to everyone
      if (rinfo.port !== MDNS_PORT) {
        const id = buf.readUInt16BE(0), m = Buffer.from(a.msg); m.writeUInt16BE(id, 0);
        sock.send(m, rinfo.port, rinfo.address);
      } else sock.send(a.msg, MDNS_PORT, MDNS_ADDR);
    });
    sock.bind(MDNS_PORT, () => {
      try { sock.addMembership(MDNS_ADDR); sock.setMulticastTTL(255); } catch (e) { log(`Discovery (mDNS): ${e.message}`); }
      const announce = () => { try { sock.send(answer(getIdentity()).msg, MDNS_PORT, MDNS_ADDR); } catch (e) {} };
      announce(); setTimeout(announce, 1000).unref();
    });
    sock.unref();
  } catch (e) { log(`Discovery (mDNS) off: ${e.message}`); }
  return { stop: () => { try { sock.close(); } catch (e) {} } };
}

module.exports = { startDiscovery, parseQuestions, readName, encName, SERVICE, localV4 };
