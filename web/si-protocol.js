"use strict";

// SportIdent (SI) station protocol and card memory encoding, shared by
// web/sportident.js (browser UI) and test/si-simulator.test.mjs (Node).
//
// The simulator plays the station side of the BSM8 EXT protocol (38400 8N1)
// that Pirila's tulospalvelu reads in Tp/TpLaitteet.cpp's lue_SI(), with
// card memory laid out the way a real card stores it - checked byte for byte
// against serial logs from a real station (SI5, SI6, SI8 and SI10/SIAC
// cards) - so Tp/SITulkinta.cpp's tulkSI() decodes it:
// https://github.com/PirilaTP/tulospalvelu/tree/feature/sportident-reader
//
// Frames (every frame is STX CMD LEN DATA[LEN] CRC_H CRC_L ETX; host frames
// are additionally prefixed with an FF wakeup byte):
//  - Station -> host, card inserted: 02 <E5|E6|E8> 06 00 FF <id[4]> crc 03.
//    E5 = SI5, E6 = SI6, E8 = SI8/SI9/SI10/SI11/pCard/tCard (the host picks
//    the subtype from the SIID range once it has block 0).
//  - Host -> station, read request: FF 02 B1 00 ... (SI5, the whole card),
//    FF 02 EF 01 <block> ... (SI8+), FF 02 E1 01 <block> ... (SI6).
//  - Station -> host, card memory: 02 B1 82 00 FF <128 bytes> crc 03 (SI5)
//    or 02 <EF|E1> 83 00 FF <block> <128 bytes> crc 03.
//  - Station -> host, card removed: 02 E7 06 00 FF 00 <id[3]> crc 03.
//  - Host -> station after a successful read: Pirila sends F9 (beep); other
//    readout software sends a bare FF 06 (ACK).
// Pirila itself doesn't check the CRC, ETX or header contents - it discards
// a fixed number of header bytes (2 for B1, 6 for EF/E1) and counts the
// rest - but the CRCs here are real so the frames also work with other
// readout software.

(function (root) {
  const STX = 0x02;
  const ETX = 0x03;
  const WAKEUP = 0xff;
  const NO_PUNCH = 0xee;
  const STATION_CODE = [0x00, 0xff]; // as reported by the logged real station

  const CMD_SI5_INSERTED = 0xe5;
  const CMD_SI6_INSERTED = 0xe6;
  const CMD_SI8_INSERTED = 0xe8;
  const CMD_CARD_REMOVED = 0xe7;
  const CMD_READ_SI5 = 0xb1;
  const CMD_READ_SI6 = 0xe1;
  const CMD_READ_SI8 = 0xef;
  const CMD_BEEP = 0xf9;

  // SPORTident CRC-16 (polynomial 0x8005, processed 16 bits at a time) over
  // CMD, LEN and DATA - verified against every frame in the real logs.
  function siCrc(bytes) {
    const length = bytes.length;
    if (length < 2) return 0;
    let crc = (bytes[0] << 8) | bytes[1];
    if (length === 2) return crc;
    let index = 2;
    for (let words = length >> 1; words > 0; words--) {
      let value;
      if (words > 1) {
        value = (bytes[index] << 8) | bytes[index + 1];
        index += 2;
      } else {
        value = length & 1 ? bytes[index] << 8 : 0;
      }
      for (let bit = 0; bit < 16; bit++) {
        const carry = crc & 0x8000;
        crc = (crc << 1) & 0xffff;
        if (value & 0x8000) crc |= 1;
        if (carry) crc ^= 0x8005;
        value = (value << 1) & 0xffff;
      }
    }
    return crc;
  }

  function concatBytes(...parts) {
    const arrays = parts.map(part => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
    const out = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
    let offset = 0;
    for (const array of arrays) {
      out.set(array, offset);
      offset += array.length;
    }
    return out;
  }

  function extFrame(cmd, data) {
    const body = concatBytes([cmd, data.length], data);
    const crc = siCrc(body);
    return concatBytes([STX], body, [crc >> 8, crc & 0xff, ETX]);
  }

  // ---------------------------------------------------------------------
  // Punch time encoding. SI stores a punch as seconds within a 12-hour half
  // (big-endian 16 bits) plus a PTD byte: bit 0 = afternoon, bits 1-3 = day
  // of week (0 = Sunday, as Date#getDay). Pirila only reads bit 0; the
  // weekday is there because real cards carry it (a Saturday afternoon punch
  // has PTD 0x0D in the logs). SI5 has no PTD byte at all - tulkSI() instead
  // adds 12 h whenever a time is smaller than the previous one.
  // ---------------------------------------------------------------------

  function secondsOfDay(seconds) {
    return ((Math.round(seconds) % 86400) + 86400) % 86400;
  }

  function extPunch(code, seconds, dayOfWeek) {
    const s = secondsOfDay(seconds);
    const half = s >= 43200 ? 1 : 0;
    const raw = s % 43200;
    return [((dayOfWeek & 7) << 1) | half, code & 0xff, raw >> 8, raw & 0xff];
  }

  function writeBytes(target, offset, bytes) {
    target.set(bytes, offset);
  }

  // Card series byte stored next to the SIID (block 0 byte 24, and the top
  // byte of the insert notification's card id). 0x02 (SI8) and 0x0F
  // (SI10/SIAC) are from the logs; the others follow SPORTident's series
  // numbering.
  const SERIES_BYTE = { si9: 0x01, si8: 0x02, pcard: 0x04, tcard: 0x06, si1011: 0x0f };

  // Where each card generation keeps its punch list, in the address space
  // Pirila reads (its SIbuf: block 0, then the next requested blocks
  // concatenated) - see tulkSI() cases 7-11.
  const EXT_FAMILY_LAYOUT = {
    si9: { start: 56, step: 4, readBlocks: [0, 1] },
    si8: { start: 136, step: 4, readBlocks: [0, 1] },
    pcard: { start: 176, step: 4, readBlocks: [0, 1] },
    tcard: { start: 56, step: 8, readBlocks: [0, 1] }
  };

  const MAX_PUNCHES = { si5: 30, si6ext: 64, si9: 50, si8: 30, pcard: 20, tcard: 25, si1011: 128 };

  // Station code written in the start punch slot. tulkSI() only checks that
  // it isn't 0xEE ("no start"), so any other value works.
  const START_CN = 0x01;

  function filledBlock(value) {
    return new Uint8Array(128).fill(value);
  }

  function uidBytes(badge) {
    // Real cards carry a 4-byte chip UID in block 0; any stable value works.
    return [(badge * 7) & 0xff, (badge >>> 5) & 0xff, (badge >>> 13) & 0xff, 0x9a];
  }

  // SI8, SI9, pCard, tCard, SI10/11: block 0 header layout from the logs:
  //   [0:4] UID  [4:8] EA*4  [8:12] clear/check punch (CN 0xFF)
  //   [12:16] start  [16:20] finish  [21] last punched CN  [22] punch count
  //   [24] series  [25:28] SIID  [32:] owner data (';'-separated, EE-padded)
  // Punch records are {PTD, CN, time_H, time_L} (tCard: 8-byte records),
  // unused slots 0xEE.
  function buildExtFamilyBlocks(type, badge, punches, clearSeconds, startSeconds, dayOfWeek) {
    const isSi10 = type === "si1011";
    const layout = isSi10 ? null : EXT_FAMILY_LAYOUT[type];
    const punchBlocks = isSi10 ? Math.min(4, Math.max(1, Math.ceil(punches.length / 32))) : 1;
    const flat = new Uint8Array(128 + 128 * punchBlocks).fill(NO_PUNCH);

    writeBytes(flat, 0, uidBytes(badge));
    writeBytes(flat, 4, [0xea, 0xea, 0xea, 0xea]);
    if (clearSeconds !== null) writeBytes(flat, 8, extPunch(0xff, clearSeconds, dayOfWeek));
    if (startSeconds !== null) writeBytes(flat, 12, extPunch(START_CN, startSeconds, dayOfWeek));
    flat[20] = 0x00;
    flat[21] = punches.length ? punches[punches.length - 1].code & 0xff : 0x00;
    flat[22] = Math.min(255, punches.length);
    flat[23] = 0x00;
    flat[24] = SERIES_BYTE[type];
    writeBytes(flat, 25, [(badge >>> 16) & 0xff, (badge >>> 8) & 0xff, badge & 0xff]);
    writeBytes(flat, 32, [0x3b, 0x3b]); // empty first;last name
    if (type === "si8") flat.fill(0x00, 128, 136); // SI8: block 1 bytes before the punch list

    const start = isSi10 ? 128 : layout.start;
    const step = isSi10 ? 4 : layout.step;
    punches.forEach((punch, index) => {
      const offset = start + index * step;
      writeBytes(flat, offset, extPunch(punch.code, punch.seconds, dayOfWeek));
      if (step === 8) writeBytes(flat, offset + 4, [0x00, 0x00, 0x00, 0x00]); // tCard sub-second fields
    });

    const blocks = new Map([[0, flat.slice(0, 128)]]);
    const hostBlocks = isSi10 ? [4, 5, 6, 7].slice(0, punchBlocks) : [1];
    hostBlocks.forEach((block, index) => blocks.set(block, flat.slice(128 * (index + 1), 128 * (index + 2))));
    return blocks;
  }

  // SI6 block 0 layout from the logs (card 579671):
  //   [0:4] 01*4  [4:8] ED*4  [8:10] 55 AA  [10:14] card number (4 bytes)
  //   [17] last punched CN  [18] punch count  [20:24] finish  [24:28] start
  //   [28:32] check  [32:36] clear  [44:] owner name text (space padded)
  // Blocks 6 and 7 hold 32 punch records each; block 1 is owner data.
  function buildSI6Blocks(badge, punches, clearSeconds, startSeconds, dayOfWeek) {
    const block0 = filledBlock(0x20);
    writeBytes(block0, 0, [0x01, 0x01, 0x01, 0x01, 0xed, 0xed, 0xed, 0xed, 0x55, 0xaa]);
    writeBytes(block0, 10, [(badge >>> 24) & 0xff, (badge >>> 16) & 0xff, (badge >>> 8) & 0xff, badge & 0xff]);
    writeBytes(block0, 14, [0x00, 0x00, 0x00]);
    block0[17] = punches.length ? punches[punches.length - 1].code & 0xff : 0x00;
    block0[18] = Math.min(64, punches.length);
    block0[19] = Math.min(64, punches.length) + 1;
    block0.fill(NO_PUNCH, 20, 32); // finish, start, check
    if (startSeconds !== null) writeBytes(block0, 24, extPunch(START_CN, startSeconds, dayOfWeek));
    if (clearSeconds !== null) writeBytes(block0, 32, extPunch(0xff, clearSeconds, dayOfWeek));
    else block0.fill(NO_PUNCH, 32, 36);
    writeBytes(block0, 36, [0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01]);

    const punchArea = new Uint8Array(256).fill(NO_PUNCH);
    punches.slice(0, 64).forEach((punch, index) => writeBytes(punchArea, index * 4, extPunch(punch.code, punch.seconds, dayOfWeek)));

    return new Map([
      [0, block0],
      [1, filledBlock(0x20)],
      [6, punchArea.slice(0, 128)],
      [7, punchArea.slice(128, 256)]
    ]);
  }

  // SI5 card memory (128 bytes) from the logs (card 229401):
  //   [4:6] CN  [6] CNS (series: badge = CNS*100000 + CN when CNS > 1)
  //   [17:19] CN again  [19:21] start  [21:23] finish  [23] punch count + 1
  //   [25:27] check  [32:128] 6 rows of {extra code, 5 x {CN, time_H, time_L}}
  // Unused start/finish/check and punch slots hold 0xEEEE times (CN 0x00).
  // No PTD byte: times are seconds within the 12-hour half.
  function si5CardNumber(badge) {
    if (badge <= 0xffff) return { cns: 0x01, cn: badge };
    const cns = Math.floor(badge / 100000);
    const cn = badge - cns * 100000;
    if (cns < 2 || cns > 0xff || cn > 0xffff) throw new Error(`SI5-kortin numero ${badge} ei ole esitettävissä (1–65535 tai sarja*100000 + 0–65535).`);
    return { cns, cn };
  }

  function buildSI5Card(badge, punches, startSeconds) {
    const { cns, cn } = si5CardNumber(badge);
    const card = new Uint8Array(128);
    writeBytes(card, 0, [0xaa, 0x2e, 0x00, 0x01, cn >> 8, cn & 0xff, cns]);
    card[16] = 0x65;
    writeBytes(card, 17, [cn >> 8, cn & 0xff]);
    card.fill(NO_PUNCH, 19, 23); // start, finish
    if (startSeconds !== null) {
      const raw = secondsOfDay(startSeconds) % 43200;
      writeBytes(card, 19, [raw >> 8, raw & 0xff]);
    }
    card[23] = Math.min(30, punches.length) + 1;
    card[24] = 0x56;
    card.fill(NO_PUNCH, 25, 27); // check
    writeBytes(card, 27, [0x28, 0x02, 0x4d, 0x00, 0x07]);
    for (let slot = 0; slot < 30; slot++) {
      const offset = 32 + Math.floor(slot / 5) * 16 + 1 + (slot % 5) * 3;
      const punch = punches[slot];
      if (punch) {
        const raw = secondsOfDay(punch.seconds) % 43200;
        writeBytes(card, offset, [punch.code & 0xff, raw >> 8, raw & 0xff]);
      } else {
        writeBytes(card, offset, [0x00, NO_PUNCH, NO_PUNCH]);
      }
    }
    return card;
  }

  function autoCardType(badge) {
    if (badge >= 7000000) return "si1011";
    if (badge >= 6000000) return "tcard";
    if (badge >= 4000000) return "pcard";
    if (badge >= 2000000) return "si8";
    if (badge >= 1000000) return "si9";
    return "si6ext";
  }

  function cardTypeLabel(type) {
    return { si5: "SI5", si6ext: "SI6", si9: "SI9", si8: "SI8", pcard: "pCard", tcard: "tCard", si1011: "SI10/11" }[type] || type;
  }

  // Builds everything the station needs to serve one card read.
  //   card = { type, badge, punches: [{code, seconds}], startSeconds,
  //            clearSeconds, dayOfWeek }
  // seconds are seconds of day; startSeconds / clearSeconds null = no start
  // punch / no clear punch. Without a start punch Pirila takes the zero
  // point from the clear punch (SI6+) or the first control.
  function planForCard(card) {
    const { type, badge, punches } = card;
    const clearSeconds = card.clearSeconds ?? null;
    const startSeconds = card.startSeconds ?? null;
    const dayOfWeek = card.dayOfWeek ?? 0;
    if (!Number.isInteger(badge) || badge < 1 || badge > 0xffffff) throw new Error("Kortin numeron pitää olla välillä 1–16777215.");
    const limit = MAX_PUNCHES[type];
    if (!limit) throw new Error(`Tuntematon korttityyppi: ${type}`);
    if (punches.length > limit) throw new Error(`${cardTypeLabel(type)}-kortille mahtuu enintään ${limit} leimaa (annettu ${punches.length}).`);
    for (const punch of punches) {
      // CN 0xEE ends the punch list on SI6+ cards; CN 0 marks an empty SI5 slot.
      if (!Number.isInteger(punch.code) || punch.code < 1 || punch.code > 255 || punch.code === NO_PUNCH) {
        throw new Error(`Rastikoodin pitää olla välillä 1–255, ei kuitenkaan 238 (0xEE, SI:n "ei leimaa" -merkki). Saatiin ${punch.code}.`);
      }
    }

    if (type === "si5") {
      const { cns, cn } = si5CardNumber(badge);
      return {
        type, badge,
        notifyCmd: CMD_SI5_INSERTED,
        cardId: [0x00, cns, cn >> 8, cn & 0xff],
        requestCmd: CMD_READ_SI5,
        singleShot: buildSI5Card(badge, punches, startSeconds),
        blocks: null,
        requiredBlocks: []
      };
    }
    if (type === "si6ext") {
      return {
        type, badge,
        notifyCmd: CMD_SI6_INSERTED,
        cardId: [0x00, (badge >>> 16) & 0xff, (badge >>> 8) & 0xff, badge & 0xff],
        requestCmd: CMD_READ_SI6,
        singleShot: null,
        blocks: buildSI6Blocks(badge, punches, clearSeconds, startSeconds, dayOfWeek),
        requiredBlocks: [0, 1, 6, 7]
      };
    }
    const blocks = buildExtFamilyBlocks(type, badge, punches, clearSeconds, startSeconds, dayOfWeek);
    return {
      type, badge,
      notifyCmd: CMD_SI8_INSERTED,
      cardId: [SERIES_BYTE[type], (badge >>> 16) & 0xff, (badge >>> 8) & 0xff, badge & 0xff],
      requestCmd: CMD_READ_SI8,
      singleShot: null,
      blocks,
      requiredBlocks: [...blocks.keys()]
    };
  }

  function cardInsertedFrame(plan) {
    return extFrame(plan.notifyCmd, [...STATION_CODE, ...plan.cardId]);
  }

  function cardRemovedFrame(plan) {
    return extFrame(CMD_CARD_REMOVED, [...STATION_CODE, 0x00, ...plan.cardId.slice(1)]);
  }

  function blockResponseFrame(plan, blockNumber) {
    if (plan.singleShot) return extFrame(CMD_READ_SI5, concatBytes(STATION_CODE, plan.singleShot));
    // Blocks the plan doesn't define (e.g. SIAC block 3, which other readout
    // software asks for) read back as unused memory.
    const block = plan.blocks.get(blockNumber) || filledBlock(NO_PUNCH);
    return extFrame(plan.requestCmd, concatBytes([...STATION_CODE, blockNumber], block));
  }

  // ---------------------------------------------------------------------
  // Punch lists.
  // ---------------------------------------------------------------------

  // Evenly spaced punches for a course, ending `readDelaySeconds` before
  // `readAtSeconds` (the moment the card is read, seconds of day) - the same
  // spacing as the Emit 250 simulator, anchored to the clock because SI
  // cards store times of day, not elapsed times. Returns the start time
  // (seconds of day) and the punches.
  function evenPunches(controls, totalSeconds, readAtSeconds, readDelaySeconds = 5) {
    const total = Math.max(60, Math.round(totalSeconds));
    const startSeconds = readAtSeconds - readDelaySeconds - total;
    return {
      startSeconds: secondsOfDay(startSeconds),
      punches: controls.map((code, index) => ({
        code,
        seconds: secondsOfDay(startSeconds + Math.max(1, Math.round((total * (index + 1)) / controls.length)))
      }))
    };
  }

  // Parses "code(split),code(split),..." e.g. "76(239),88(100),92(400)".
  // Each split is the leg time in seconds since the previous punch (since
  // the start for the first one). Returns {code, elapsed} with elapsed =
  // cumulative seconds from the start.
  function parseManualPunches(text) {
    const entries = text.split(",").map(part => part.trim()).filter(Boolean);
    if (!entries.length) throw new Error("Anna vähintään yksi leima muodossa 76(239),88(100),92(400).");
    let elapsed = 0;
    return entries.map(entry => {
      const match = entry.match(/^(\d{1,3})\s*\(\s*(\d+(?:[.,]\d+)?)\s*\)$/);
      if (!match) throw new Error(`Virheellinen leima "${entry}". Käytä muotoa rastikoodi(sekuntia), esim. 76(239).`);
      const code = Number(match[1]);
      if (code < 1 || code > 255) throw new Error(`Rastikoodin pitää olla välillä 1–255 (saatiin ${code}).`);
      elapsed += Number(match[2].replace(",", "."));
      return { code, elapsed };
    });
  }

  // Turns elapsed-from-start punches into clock times so the last punch
  // happens `readDelaySeconds` before the read. Returns the start time
  // (seconds of day) and the punches.
  function anchorPunches(elapsedPunches, readAtSeconds, readDelaySeconds = 5) {
    const last = elapsedPunches.length ? elapsedPunches[elapsedPunches.length - 1].elapsed : 0;
    const startSeconds = readAtSeconds - readDelaySeconds - last;
    return {
      startSeconds: secondsOfDay(startSeconds),
      punches: elapsedPunches.map(punch => ({ code: punch.code, seconds: secondsOfDay(startSeconds + punch.elapsed) }))
    };
  }

  function parseManualBadge(text) {
    const value = Number(String(text).trim());
    if (!Number.isInteger(value) || value < 1) throw new Error("Anna kelvollinen kortin numero (positiivinen kokonaisluku).");
    return value;
  }

  // ---------------------------------------------------------------------
  // Serial I/O.
  // ---------------------------------------------------------------------

  class ByteQueue {
    constructor() {
      this.buf = new Uint8Array(0);
      this.waiters = [];
    }

    push(chunk) {
      this.buf = concatBytes(this.buf, chunk);
      while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
        const waiter = this.waiters.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(this.take(waiter.n));
      }
    }

    // Removes and returns n bytes synchronously; callers check length first.
    take(n) {
      const bytes = this.buf.slice(0, n);
      this.buf = this.buf.slice(n);
      return bytes;
    }

    read(n, timeoutMs) {
      if (this.buf.length >= n) return Promise.resolve(this.take(n));
      return new Promise((resolve, reject) => {
        const waiter = { n, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new TimeoutError());
        }, timeoutMs);
        this.waiters.push(waiter);
      });
    }

    clear() {
      this.buf = new Uint8Array(0);
    }
  }

  class TimeoutError extends Error {
    constructor() {
      super("Aikakatkaisu: lukuohjelma ei lähettänyt lukupyyntöä.");
      this.name = "TimeoutError";
    }
  }

  // Reads one host frame: FF 02 CMD LEN DATA[LEN] CRC_H CRC_L ETX. Skips
  // anything before an FF 02 pair (e.g. a bare FF 06 ACK, or FF FF 02).
  async function readHostFrame(queue, timeoutMs) {
    let previous = -1;
    for (;;) {
      const byte = (await queue.read(1, timeoutMs))[0];
      if (previous === WAKEUP && byte === STX) break;
      previous = byte;
    }
    const [cmd, length] = await queue.read(2, timeoutMs);
    const rest = await queue.read(length + 3, timeoutMs);
    return { cmd, data: rest.slice(0, length) };
  }

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Plays one card insert -> readout -> removal against the host. `write`
  // sends bytes to the port, `queue` holds bytes received from it. Returns
  // { blocksServed, confirmed } where confirmed = the host sent its
  // post-read beep (Pirila only does that once tulkSI() has accepted the
  // card) or ACK.
  async function performCardRead(write, queue, plan, options = {}) {
    const timeoutMs = options.timeoutMs ?? 4000;
    const confirmTimeoutMs = options.confirmTimeoutMs ?? 1500;
    const removeDelayMs = options.removeDelayMs ?? 300;
    const log = options.log ?? (() => {});

    queue.clear(); // drop leftovers such as the previous read's beep
    await write(cardInsertedFrame(plan));
    log(`→ kortti asetettu (${cardTypeLabel(plan.type)} ${plan.badge})`);

    const pending = new Set(plan.singleShot ? ["si5"] : plan.requiredBlocks);
    const blocksServed = [];
    while (pending.size) {
      const request = await readHostFrame(queue, timeoutMs);
      if (request.cmd !== plan.requestCmd) {
        log(`← ohitettu kehys cmd 0x${request.cmd.toString(16).toUpperCase()}`);
        continue;
      }
      const block = plan.singleShot ? "si5" : request.data[0] ?? 0;
      await write(blockResponseFrame(plan, block));
      blocksServed.push(block);
      pending.delete(block);
      log(plan.singleShot ? "← lukupyyntö B1 → kortin muisti lähetetty" : `← lohkopyyntö ${block} → lohko lähetetty`);
    }

    // Pirila (and other readout software) acknowledge a finished read. Wait
    // for that as the success signal instead of assuming it.
    let confirmed = false;
    const deadline = Date.now() + confirmTimeoutMs;
    try {
      while (!confirmed && Date.now() < deadline) {
        const [byte] = await queue.read(1, Math.max(1, deadline - Date.now()));
        if (byte !== WAKEUP) continue;
        const [next] = await queue.read(1, Math.max(1, deadline - Date.now()));
        if (next === 0x06) confirmed = true;
        else if (next === STX) {
          const [cmd, length] = await queue.read(2, Math.max(1, deadline - Date.now()));
          await queue.read(length + 3, Math.max(1, deadline - Date.now()));
          if (cmd === CMD_BEEP) confirmed = true;
          else if (cmd === plan.requestCmd) log("← ylimääräinen lohkopyyntö lukemisen jälkeen (ohitettu)");
        }
      }
    } catch (error) {
      if (!(error instanceof TimeoutError)) throw error;
    }
    log(confirmed ? "← lukuohjelma kuittasi luvun (piippaus)" : "← kuittausta ei tullut");

    await delay(removeDelayMs);
    await write(cardRemovedFrame(plan));
    log("→ kortti poistettu");
    return { blocksServed, confirmed };
  }

  const api = {
    siCrc, extFrame, concatBytes, secondsOfDay, extPunch,
    planForCard, autoCardType, cardTypeLabel, MAX_PUNCHES,
    cardInsertedFrame, cardRemovedFrame, blockResponseFrame,
    evenPunches, parseManualPunches, anchorPunches, parseManualBadge,
    ByteQueue, TimeoutError, readHostFrame, performCardRead
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SI = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
