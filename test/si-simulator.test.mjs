// Checks the SportIdent simulator against serial logs from a real SI
// station (tmp/SI-Card*.txt, not in version control - the tests skip when
// they're missing). Each log holds the raw frames of one card readout plus
// the readout software's decoded summary at the end.
//
// For every logged card:
//  1. the real frames are replayed through a port of Pirila's lue_SI()/
//     tulkSI() (test/pirila-host.mjs), and must decode to the logged summary
//     - this validates the port itself;
//  2. the simulator is given the same card number, punches and clear time,
//     is driven by the same Pirila port over an in-memory "serial line", and
//     must decode to the same summary and produce the same frames as the
//     real station.
//
// Run: node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readCard, tulkSI, punchList, toEmitRecord, TMAALI0 } from "./pirila-host.mjs";

const require = createRequire(import.meta.url);
const SI = require("../web/si-protocol.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logDir = join(root, "tmp");
const logFiles = existsSync(logDir) ? readdirSync(logDir).filter(name => /^SI-Card.*\.txt$/i.test(name)) : [];

const hex = array => Array.from(array, b => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

function clockSeconds(text) {
  const [h, m, s] = text.split(".").map(Number);
  return h * 3600 + m * 60 + s;
}

// Parses a log into { frames: [{dir, bytes}], summary }.
function parseLog(text) {
  const lines = text.split(/\r?\n/);
  const frames = [];
  let current = null;
  for (const line of lines) {
    const frameStart = line.match(/#\s+(IN|OUT)\s+:::\s*(.*)$/);
    if (frameStart) {
      current = { dir: frameStart[1], hex: frameStart[2].trim() ? [frameStart[2].trim()] : [] };
      frames.push(current);
      continue;
    }
    if (current && /^\s+([0-9A-F]{2}-)*[0-9A-F]{2}\s*$/.test(line)) current.hex.push(line.trim());
    else current = null;
  }

  const summary = { records: [] };
  const summaryText = text.slice(text.indexOf("----"));
  for (const line of summaryText.split(/\r?\n/)) {
    const field = line.match(/^\s*(SIID|Clear|Check|Start|Finish):\s*(.*)$/);
    if (field) {
      const value = field[2].trim();
      const punch = value.match(/^(\d+)\s+\S*\s+(\d\d\.\d\d\.\d\d)$/);
      summary[field[1].toLowerCase()] = field[1] === "SIID" ? Number(value) : punch ? { code: Number(punch[1]), seconds: clockSeconds(punch[2]) } : null;
    }
    const record = line.match(/^\s*Record \d+:\s+(\d+)\s+\S*\s*(\d\d\.\d\d\.\d\d)\s*$/);
    if (record) summary.records.push({ code: Number(record[1]), seconds: clockSeconds(record[2]) });
  }

  return {
    frames: frames
      .map(frame => ({ dir: frame.dir, bytes: Uint8Array.from(frame.hex.join("-").split("-").map(h => parseInt(h, 16))) }))
      .filter(frame => frame.bytes.length),
    summary
  };
}

// Reads the (normalised) card type from the insert notification.
function cardTypeOf(log) {
  const notification = log.frames.find(frame => frame.dir === "IN" && frame.bytes[0] === 0x02);
  if (notification.bytes[1] === 0xe5) return "si5";
  return SI.autoCardType(log.summary.siid);
}

// The real station's memory replies, keyed by block number ("si5" for B1).
function loggedBlockFrames(log) {
  const blocks = new Map();
  for (const frame of log.frames) {
    if (frame.dir !== "IN" || frame.bytes[0] !== 0x02) continue;
    const cmd = frame.bytes[1];
    if (cmd === 0xb1) blocks.set("si5", frame.bytes);
    else if (cmd === 0xef || cmd === 0xe1) blocks.set(frame.bytes[5], frame.bytes);
  }
  return blocks;
}

// A station that answers with the logged real frames verbatim. Pirila asks
// for SI6 block 7, which the logging software never read - that one is
// answered as unused memory, same as the simulator does.
function replayStation(log, hostQueue) {
  const blocks = loggedBlockFrames(log);
  const notification = log.frames.find(frame => frame.dir === "IN" && frame.bytes[0] === 0x02);
  const inbox = new SI.ByteQueue();
  let running = true;
  (async () => {
    while (running) {
      let request;
      try { request = await SI.readHostFrame(inbox, 50); } catch { continue; }
      if (request.cmd === 0xb1) hostQueue.push(blocks.get("si5"));
      else if (request.cmd === 0xef || request.cmd === 0xe1) {
        const block = request.data[0];
        hostQueue.push(blocks.get(block) ?? SI.extFrame(request.cmd, SI.concatBytes([0x00, 0xff, block], new Uint8Array(128).fill(0xee))));
      }
    }
  })();
  hostQueue.push(notification.bytes);
  return { send: bytes => inbox.push(bytes), stop: () => { running = false; } };
}

// Wires the simulator's station to the Pirila host port.
async function simulatorRead(plan) {
  const hostQueue = new SI.ByteQueue();
  const stationQueue = new SI.ByteQueue();
  const sent = [];
  const station = SI.performCardRead(
    async bytes => { sent.push(bytes); hostQueue.push(bytes); },
    stationQueue,
    plan,
    { timeoutMs: 2000, confirmTimeoutMs: 500, removeDelayMs: 0 }
  );
  const host = await readCard(hostQueue, bytes => stationQueue.push(bytes));
  const outcome = await station;
  return { host, outcome, sent };
}

function planFromSummary(log, type) {
  return SI.planForCard({
    type,
    badge: log.summary.siid,
    punches: log.summary.records,
    clearSeconds: log.summary.clear?.seconds ?? null,
    dayOfWeek: 6 // the logs were recorded on a Saturday
  });
}

// What the logged summary says Pirila should end up with.
function expectedDecode(log, type) {
  // SI8+ keep the clear/check punch at block 0 [8:12], which tulkSI reads
  // as "check"; SI6 has a separate clear slot that tulkSI uses as the check
  // when there is no check punch. SI5 has no clear punch.
  const check = type === "si5" ? null : log.summary.check ?? log.summary.clear;
  return { badge: log.summary.siid, punches: log.summary.records, check: check ? check.seconds : null };
}

function actualDecode(result) {
  const empty = value => value === TMAALI0 || value === 61166;
  return { badge: result.badge, punches: punchList(result), check: empty(result.check) ? null : result.check };
}

// Manually typed splits ("rastivaliajat") must come out of Pirila's EMIT
// record as the same cumulative times from the start, for every card type.
// A representative card number per type, since the host picks the SI8+
// subtype from the number range.
const TYPE_BADGES = { si5: 12345, si6ext: 12345, si9: 1000123, si8: 2000123, pcard: 4000123, tcard: 6000123, si1011: 7000123 };

async function manualReadOut(type, { withStart, withClear, readAt }) {
  const anchored = SI.anchorPunches(SI.parseManualPunches("76(239),88(100),92(400)"), readAt);
  const plan = SI.planForCard({
    type,
    badge: TYPE_BADGES[type],
    punches: anchored.punches,
    startSeconds: withStart ? anchored.startSeconds : null,
    clearSeconds: withClear ? SI.secondsOfDay(anchored.startSeconds - 120) : null,
    dayOfWeek: 4
  });
  const { host } = await simulatorRead(plan);
  return toEmitRecord(tulkSI(host.sibuf, host.type, host.sibuf.length), readAt).splits.map(s => `${s.code}:${s.elapsed}`);
}

for (const type of Object.keys(TYPE_BADGES)) {
  test(`${SI.cardTypeLabel(type)}: manual splits with a start punch reach Pirila as times from the start`, async () => {
    // 11:21:02 = the read time in the reported HkKisaWin screenshot.
    assert.deepEqual(await manualReadOut(type, { withStart: true, withClear: true, readAt: 11 * 3600 + 21 * 60 + 2 }), ["76:239", "88:339", "92:739", "250:744"]);
  });

  test(`${SI.cardTypeLabel(type)}: without a start punch Pirila's zero is the clear punch or the first control`, async () => {
    const readAt = 11 * 3600 + 21 * 60 + 2;
    const fromFirst = ["76:0", "88:100", "92:500", "250:505"];
    // SI5 has no clear punch, so it always falls back to the first control.
    assert.deepEqual(await manualReadOut(type, { withStart: false, withClear: true, readAt }), type === "si5" ? fromFirst : ["76:359", "88:459", "92:859", "250:864"]);
    assert.deepEqual(await manualReadOut(type, { withStart: false, withClear: false, readAt }), fromFirst);
  });
}

if (!logFiles.length) test("SI station logs", { skip: "tmp/SI-Card*.txt not found" }, () => {});

test("CRC matches every frame in the logs", { skip: !logFiles.length }, () => {
  let checked = 0;
  for (const name of logFiles) {
    for (const frame of parseLog(readFileSync(join(logDir, name), "utf8")).frames) {
      const bytes = frame.bytes[0] === 0xff ? frame.bytes.slice(1) : frame.bytes;
      if (bytes[0] !== 0x02 || bytes.length < 6) continue; // e.g. a bare FF 06 ACK
      const crc = SI.siCrc(bytes.slice(1, bytes.length - 3));
      assert.equal(crc, (bytes[bytes.length - 3] << 8) | bytes[bytes.length - 2], `${name}: ${hex(bytes.slice(0, 8))}...`);
      checked++;
    }
  }
  assert.ok(checked > 20);
});

for (const name of logFiles) {
  const log = parseLog(readFileSync(join(logDir, name), "utf8"));
  const type = cardTypeOf(log);
  const label = `${name} (${SI.cardTypeLabel(type)} ${log.summary.siid})`;

  test(`${label}: real frames decode to the logged summary through the Pirila port`, async () => {
    const hostQueue = new SI.ByteQueue();
    const station = replayStation(log, hostQueue);
    try {
      const { type: sitype, sibuf } = await readCard(hostQueue, station.send);
      assert.deepEqual(actualDecode(tulkSI(sibuf, sitype, sibuf.length)), expectedDecode(log, type));
    } finally {
      station.stop();
    }
  });

  test(`${label}: simulator frames decode to the same summary`, async () => {
    const { host, outcome } = await simulatorRead(planFromSummary(log, type));
    assert.deepEqual(actualDecode(tulkSI(host.sibuf, host.type, host.sibuf.length)), expectedDecode(log, type));
    assert.equal(outcome.confirmed, true, "Pirila's beep after the read");
  });

  test(`${label}: simulator notifications match the real station byte for byte`, () => {
    const plan = planFromSummary(log, type);
    const real = log.frames.filter(frame => frame.dir === "IN" && frame.bytes[0] === 0x02);
    assert.equal(hex(SI.cardInsertedFrame(plan)), hex(real[0].bytes));
    assert.equal(hex(SI.cardRemovedFrame(plan)), hex(real[real.length - 1].bytes));
  });

  test(`${label}: simulator card memory matches the real card where Pirila reads it`, () => {
    const plan = planFromSummary(log, type);
    for (const [block, realFrame] of loggedBlockFrames(log)) {
      const simFrame = SI.blockResponseFrame(plan, block);
      const headerLength = block === "si5" ? 5 : 6;
      assert.equal(hex(simFrame.slice(0, headerLength)), hex(realFrame.slice(0, headerLength)), `block ${block} header`);
      const sim = simFrame.slice(headerLength, headerLength + 128);
      const real = realFrame.slice(headerLength, headerLength + 128);
      for (const offset of fieldsPirilaReads(type, block)) {
        // PTD bits 4-5 are SPORTident's week counter, which the simulator
        // doesn't track; Pirila only uses bit 0.
        const mask = isPtdByte(type, block, offset) ? 0x0f : 0xff;
        assert.equal(sim[offset] & mask, real[offset] & mask, `block ${block} byte ${offset}: sim ${hex([sim[offset]])} real ${hex([real[offset]])}`);
      }
    }
  });

  test(`${label}: Pirila's EMIT record is the same for the real card and the simulator`, async () => {
    const readAt = log.summary.records.at(-1).seconds + 60;
    const hostQueue = new SI.ByteQueue();
    const station = replayStation(log, hostQueue);
    let real;
    try {
      real = await readCard(hostQueue, station.send);
    } finally {
      station.stop();
    }
    const { host: sim } = await simulatorRead(planFromSummary(log, type));
    assert.deepEqual(
      toEmitRecord(tulkSI(sim.sibuf, sim.type, sim.sibuf.length), readAt),
      toEmitRecord(tulkSI(real.sibuf, real.type, real.sibuf.length), readAt)
    );
  });
}

// Card memory offsets tulkSI() (and lue_SI()'s block switching) read, per
// logged block.
function fieldsPirilaReads(type, block) {
  const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);
  if (type === "si5") {
    // SI5 card offsets = SI5tp struct offsets - 3.
    return [...range(4, 7), ...range(19, 23), ...range(25, 27), ...range(32, 128)];
  }
  if (type === "si6ext") {
    if (block === 0) return [...range(10, 14), ...range(20, 32)];
    if (block === 6 || block === 7) return range(0, 128);
    return [];
  }
  if (block === 0) {
    const header = [...range(8, 20), 22, ...range(25, 28)];
    return type === "si9" || type === "tcard" ? [...header, ...range(56, 128)] : header;
  }
  if (type === "si8" && block === 1) return range(8, 128);
  if (type === "pcard" && block === 1) return range(48, 128);
  if (block === 1 || (type === "si1011" && block >= 4)) return range(0, 128);
  return []; // blocks Pirila never asks for (e.g. SIAC block 3)
}

function isPtdByte(type, block, offset) {
  if (type === "si5") return false;
  if (block === 0 && (offset === 8 || offset === 12 || offset === 16)) return true;
  if (type === "si6ext" && block === 0) return offset === 20 || offset === 24 || offset === 28;
  const step = type === "tcard" ? 8 : 4;
  const punchStart = { si9: 56, si8: 136, pcard: 176, tcard: 56 }[type] ?? 0;
  const flat = (type === "si1011" || type === "si6ext") ? offset : block * 128 + offset;
  return flat >= punchStart && (flat - punchStart) % step === 0;
}
