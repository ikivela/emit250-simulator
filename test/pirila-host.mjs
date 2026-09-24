// A JavaScript port of the host side of Pirila's SportIdent support
// (feature/sportident-reader branch), for testing the simulator without a
// Windows build of tulospalvelu:
//   - readCard(): Tp/TpLaitteet.cpp lue_SI(), EXT protocol paths - reads the
//     insert notification, sends the same hard-coded request frames, and
//     consumes the station's replies byte by byte with the same header-skip
//     counting and mid-read block switching.
//   - tulkSI(): Tp/SITulkinta.cpp, incl. the C `char` (signed on Pirila's
//     C++Builder build, no unsigned-char option in its .cbproj files) used
//     for the SI5 struct fields.
//   - toEmitRecord(): the SPORTIDENT branch of Juk/VIv.cpp that turns the
//     result into Pirila's EMIT record (61166 remap, times relative to the
//     start, 240 finish / 250 reader codes).

export const TMAALI0 = -24 * 36000 * 10;
const MAXNLEIMA = 50;

const bytes = hex => Uint8Array.from(hex.split(" ").map(h => parseInt(h, 16)));

// Request frames exactly as hard-coded in lue_SI().
export const PIRILA_REQUESTS = {
  si5: bytes("FF 02 B1 00 B1 00 03"),
  ef0: bytes("FF 02 EF 01 00 E2 09 03"),
  ef1: bytes("FF 02 EF 01 01 E3 09 03"),
  ef4: bytes("FF 02 EF 01 04 E6 09 03"),
  ef5: bytes("FF 02 EF 01 05 E7 09 03"),
  ef6: bytes("FF 02 EF 01 06 E4 09 03"),
  ef7: bytes("FF 02 EF 01 07 E5 09 03"),
  e10: bytes("FF 02 E1 01 00 46 0A 03"),
  e11: bytes("FF 02 E1 01 01 47 0A 03"),
  e16: bytes("FF 02 E1 01 06 40 0A 03"),
  e17: bytes("FF 02 E1 01 07 41 0A 03"),
  beep: bytes("FF 02 F9 01 01 17 0A 03")
};

// Reads one card like lue_SI(). `queue` receives station -> host bytes
// (a ByteQueue from si-protocol.js), `send` delivers host -> station bytes.
export async function readCard(queue, send, { timeoutMs = 3000 } = {}) {
  // read_st_x(): up to r_msg_len (10) bytes, need at least 4.
  const deadline = Date.now() + timeoutMs;
  while (queue.buf.length < 4) {
    if (Date.now() > deadline) throw new Error("host: no card notification");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  let msg = Array.from(queue.take(Math.min(10, queue.buf.length)));
  while ((msg[0] !== 0x02 || msg[1] === 0x02) && msg.length > 1) msg.shift();
  const trigger = msg[1];

  let request, type, ext;
  if (msg[0] === 0x02 && msg[1] === 0x46 && msg[2] === 0x49 && msg[3] === 0x03) throw new Error("host: legacy SI5 not ported");
  else if (trigger === 0xe5) { request = PIRILA_REQUESTS.si5; type = 5; ext = true; }
  else if (trigger === 0xe8) { request = PIRILA_REQUESTS.ef0; type = 7; ext = true; }
  else if (trigger === 0xe6) { request = PIRILA_REQUESTS.e10; type = 12; ext = true; }
  else throw new Error(`host: unrecognised notification ${msg.map(b => b.toString(16)).join(" ")}`);

  queue.clear(); // i_flush_x()
  send(request);

  const datalen = [133, 402, 256, 256, 256, 256, 256, 512];
  const buf = new Uint8Array(640);
  let l = 0;
  let skip = type === 7 || type === 12 ? 6 : ext ? 2 : 0;
  let nblock = 0;
  let needed = 1;
  const requestsSent = [request];
  const write = frame => { requestsSent.push(frame); send(frame); };

  for (;;) {
    const [chin] = await queue.read(1, timeoutMs);
    if (skip > 0) skip--;
    else buf[l++] = chin;

    if (type === 7 && l === 128 && nblock === 0) {
      const siid = buf[25] * 65536 + buf[26] * 256 + buf[27];
      nblock = 1;
      skip = 9;
      if (siid >= 7000000) {
        type = 8;
        needed = Math.min(4, Math.max(1, Math.floor((buf[22] + 31) / 32)));
        datalen[3] = 128 + needed * 128;
        write(PIRILA_REQUESTS.ef4);
      } else {
        if (siid >= 6000000) type = 11;
        else if (siid >= 4000000) type = 10;
        else if (siid >= 2000000) type = 9;
        write(PIRILA_REQUESTS.ef1);
      }
    }
    if (type === 8 && nblock > 0 && nblock < needed && l === 128 + nblock * 128) {
      nblock++;
      skip = 9;
      write(nblock === 2 ? PIRILA_REQUESTS.ef5 : nblock === 3 ? PIRILA_REQUESTS.ef6 : PIRILA_REQUESTS.ef7);
    }
    if (type === 12 && l === 128 && nblock === 0) { nblock = 1; skip = 9; write(PIRILA_REQUESTS.e11); }
    else if (type === 12 && l === 256 && nblock === 1) { nblock = 2; skip = 9; write(PIRILA_REQUESTS.e16); }
    else if (type === 12 && l === 384 && nblock === 2) { nblock = 3; skip = 9; write(PIRILA_REQUESTS.e17); }

    if (l === datalen[type - 5]) {
      const sibuf = buf.slice(0, l);
      send(PIRILA_REQUESTS.beep);
      return { type, sibuf, requestsSent };
    }
  }
}

// --- tulkSI() ----------------------------------------------------------

function tulkExtOtsikko(b, r) {
  r.badge = b[25] * 65536 + b[26] * 256 + b[27];
  r.check = b[9] === 0xee ? TMAALI0 : 256 * b[10] + b[11] + (b[8] & 1) * 43200;
  r.finish = b[17] === 0xee ? TMAALI0 : 256 * b[18] + b[19] + (b[16] & 1) * 43200;
  r.start = b[13] === 0xee ? TMAALI0 : 256 * b[14] + b[15] + (b[12] & 1) * 43200;
}

function tulkExtLeimat(b, r, start, step, bound) {
  let n = 0;
  for (let i = start; i + 3 < bound; i += step) {
    const cn = b[i + 1];
    if (cn === 0xee) break;
    let pt = 256 * b[i + 2] + b[i + 3] + (b[i] & 1) * 43200;
    n++;
    if (n < 66) {
      r.cc[n] = cn;
      if (n === 1) {
        if (r.start && pt < r.start) pt += 43200;
      } else if (r.ct[n - 1] && pt < r.ct[n - 1]) pt += 43200;
      r.ct[n] = pt;
    }
  }
}

export function tulkSI(b, type, buflen, { signedChar = true } = {}) {
  const r = { badge: 0, start: 0, check: 0, finish: 0, cc: new Array(66).fill(0), ct: new Array(66).fill(0) };
  const c = signedChar ? v => (v > 127 ? v - 256 : v) : v => v; // C `char`
  switch (type) {
    case 5: {
      // SI5tp struct offsets in SIbuf: CN 7-8, CNS 9, ST 22-23, FT 24-25,
      // CT 28-29, rows from 35 (16 bytes each).
      const cns = c(b[9]);
      r.badge = 256 * c(b[7]) + c(b[8]) + (cns > 1 ? cns * 100000 : 0);
      r.start = 256 * c(b[22]) + c(b[23]);
      r.check = 256 * c(b[28]) + c(b[29]);
      r.finish = 256 * c(b[24]) + c(b[25]);
      for (let row = 0; row < 6; row++) {
        const rowBase = 35 + row * 16;
        r.cc[31 + row] = b[rowBase];
        for (let i = 0; i < 5; i++) {
          const k = 1 + i + 5 * row;
          const p = rowBase + 1 + i * 3;
          r.cc[k] = b[p];
          r.ct[k] = 256 * c(b[p + 1]) + c(b[p + 2]);
          if (row + i === 0) {
            if (r.start !== 61166 && r.ct[1] && r.ct[1] < r.start) r.ct[1] += 43200;
          } else if (r.ct[k] && r.ct[k] < r.ct[k - 1]) r.ct[k] += 43200;
        }
      }
      break;
    }
    case 7: tulkExtOtsikko(b, r); tulkExtLeimat(b, r, 56, 4, 256); break;
    case 8: tulkExtOtsikko(b, r); tulkExtLeimat(b, r, 128, 4, buflen); break;
    case 9: tulkExtOtsikko(b, r); tulkExtLeimat(b, r, 136, 4, 256); break;
    case 10: tulkExtOtsikko(b, r); tulkExtLeimat(b, r, 176, 4, 256); break;
    case 11: tulkExtOtsikko(b, r); tulkExtLeimat(b, r, 56, 8, 256); break;
    case 12:
      r.badge = b[10] * 16777216 + b[11] * 65536 + b[12] * 256 + b[13];
      r.finish = b[21] === 0xee ? TMAALI0 : 256 * b[22] + b[23] + (b[20] & 1) * 43200;
      r.start = b[25] === 0xee ? TMAALI0 : 256 * b[26] + b[27] + (b[24] & 1) * 43200;
      r.check = b[29] === 0xee ? TMAALI0 : 256 * b[30] + b[31] + (b[28] & 1) * 43200;
      tulkExtLeimat(b, r, 256, 4, buflen);
      break;
    default: throw new Error(`tulkSI: type ${type} not ported`);
  }
  return r;
}

// The real punches in a tulkSI result: cc[1..], stopping at the first empty
// slot (CN 0 on SI5; SI6+ lists already stop at CN 0xEE).
export function punchList(result) {
  const punches = [];
  for (let i = 1; i < 31 && result.cc[i]; i++) punches.push({ code: result.cc[i], seconds: result.ct[i] });
  return punches;
}

// --- Juk/VIv.cpp, SPORTIDENT branch --------------------------------------

export function toEmitRecord(result, readAtSeconds) {
  const lukija = readAtSeconds * 10;
  const r = { ...result, cc: [...result.cc], ct: [...result.ct] };
  if (r.start === 61166) r.start = TMAALI0;
  let start = r.start;
  if (r.check === 61166) r.check = TMAALI0;
  if (r.finish === 61166) r.finish = TMAALI0;
  const code = new Array(MAXNLEIMA).fill(0);
  const time = new Array(MAXNLEIMA).fill(0);
  for (let i = 0; i < MAXNLEIMA; i++) {
    code[i] = r.cc[i] & 0xff;
    time[i] = r.ct[i];
    if (start === TMAALI0 && time[i]) start = time[i];
    if (time[i] && start !== TMAALI0) time[i] = (r.ct[i] - start + 86400) % 86400;
  }
  let i;
  for (i = MAXNLEIMA; i > 1; i--) if (code[i - 1]) break;
  if (i < MAXNLEIMA - 1 && i > 1) {
    if (r.finish !== TMAALI0 && start !== TMAALI0) {
      code[i] = 240;
      time[i] = (r.finish - start + 86400) % 86400;
      i++;
    }
    code[i] = 250;
    time[i] = start !== TMAALI0 ? (Math.trunc(lukija / 10) - start + 86400) % 86400 : (Math.trunc(lukija / 10) + 86400) % 86400;
  }
  const splits = [];
  for (let k = 0; k < MAXNLEIMA; k++) if (code[k]) splits.push({ code: code[k], elapsed: time[k] });
  return { badge: r.badge, start, splits };
}
