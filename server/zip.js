// A small .zip writer and reader, so the server keeps its zero-dependency rule (archive.js uses it).
// Writer: entries are compressed (deflate) one after another straight into the file, then the central
// directory. Reader: from a Buffer (an uploaded archive) or a file, through the central directory, so zips
// written by other tools (JSZip in Uzikext, Windows Explorer, 7-Zip) read the same. Plain zip only (no
// zip64): an archive stays under 4 GB and 65,535 entries, which Uzikext's archives are far below.
const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');
const deflateRaw = promisify(zlib.deflateRaw);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

const LIMIT = 0xFFFFFFFF;

// -> { add(name, data, { store }), finish() }. data: Buffer / Uint8Array / string.
async function createZip(file) {
  const fh = await fs.promises.open(file, 'w');
  let offset = 0;
  const entries = [];
  const { time, date } = dosTime(new Date());
  const write = async buf => { await fh.write(buf, 0, buf.length, null); offset += buf.length; };
  async function add(name, data, opts = {}) {
    const raw = Buffer.isBuffer(data) ? data : typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const crc = crc32(raw);
    let method = 0, body = raw;
    if (!opts.store && raw.length > 64) {
      const z = await deflateRaw(raw, { level: 6 });
      if (z.length < raw.length) { method = 8; body = z; }
    }
    if (raw.length >= LIMIT || offset + body.length + 100 >= LIMIT) throw new Error('archive too large for a plain zip (over 4 GB)');
    const nameBuf = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    entries.push({ nameBuf, method, crc, csize: body.length, usize: raw.length, offset });
    await write(h); await write(nameBuf); await write(body);
  }
  async function finish() {
    if (entries.length >= 0xFFFF) throw new Error('too many entries for a plain zip');
    const cdStart = offset;
    for (const e of entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.usize, 24); c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38);
      c.writeUInt32LE(e.offset, 42);
      await write(c); await write(e.nameBuf);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16); end.writeUInt16LE(0, 20);
    await write(end);
    await fh.sync().catch(() => {});
    await fh.close();
    return offset;
  }
  async function abort() { try { await fh.close(); } catch (e) {} }
  return { add, finish, abort };
}

// A zip in memory -> { names, has(name), get(name) -> Buffer, text(name), json(name) }
function readZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xFFFF || cdOff === LIMIT) throw new Error('zip64 archives are not supported');
  const map = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip (central directory)');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, p + 46 + nl);
    if (!name.endsWith('/')) map.set(name, { method, crc, csize, usize, off });
    p += 46 + nl + xl + cl;
  }
  function get(name) {
    const e = map.get(name);
    if (!e) return null;
    if (buf.readUInt32LE(e.off) !== 0x04034b50) throw new Error('damaged zip (' + name + ')');
    const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
    const body = buf.subarray(start, start + e.csize);
    const out = e.method === 0 ? Buffer.from(body) : e.method === 8 ? zlib.inflateRawSync(body) : null;
    if (!out) throw new Error(`unsupported compression in ${name}`);
    if (out.length !== e.usize || crc32(out) !== e.crc) throw new Error(`damaged zip: ${name} doesn't match its checksum`);
    return out;
  }
  return {
    names: [...map.keys()],
    has: n => map.has(n),
    get,
    text: n => { const b = get(n); return b == null ? null : b.toString('utf8'); },
    json: n => { const b = get(n); return b == null ? null : JSON.parse(b.toString('utf8')); }
  };
}

module.exports = { createZip, readZip, crc32 };
