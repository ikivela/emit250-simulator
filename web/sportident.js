"use strict";

// SportIdent (SI) station simulator. Speaks the BSM8 EXT protocol
// (38400 8N1) that Pirila's tulospalvelu reads in Tp/TpLaitteet.cpp's
// lue_SI(), and encodes card contents the way Tp/SITulkinta.cpp's tulkSI()
// decodes them, so this page can stand in for a real SI station while
// developing/testing Pirila's SportIdent support:
// https://github.com/PirilaTP/tulospalvelu/tree/feature/sportident-reader
//
// Protocol summary (see lue_SI/tulkSI for the authoritative behaviour):
//  - Station -> host: unsolicited "card inserted" notification, 6 bytes:
//    02 <trigger> 00 <crc_h> <crc_l> 03, trigger = E5 (SI5), E6 (SI6 via
//    EXT), E8 (SI8/SI9/SI10/SI11/pCard/tCard - subtype is inferred by the
//    host from the card's serial number range once block 0 arrives).
//  - Host -> station request: FF 02 <cmd> <len> <data[len]> <crc_h> <crc_l>
//    03. cmd = B1 (SI5, whole 133-byte block in one shot), EF (SI8/9/10/11/
//    pCard/tCard, data[0] = block number 0/1/4/5/6/7), E1 (SI6 via EXT,
//    block number 0/1/6/7).
//  - Station -> host response: 02 <cmd> 83 00 0A <blocknum> + 128 data
//    bytes + <crc_h> <crc_l> 03. Pirila's reader does not validate the CRC
//    or framing bytes around the data - it only counts a fixed number of
//    header bytes to discard (6 for EF/E1, 2 for B1) and then the data
//    bytes themselves, so the exact header/CRC/ETX values here are
//    cosmetic; only their byte counts matter.
//  - After a full card is read, the host sends F9 (beep); we don't need to
//    answer it.

const KILP_HEADER_SIZE = 360;
const KILP_PHASE_SIZE = 248;

const state = {
  classes: new Map(),
  courses: new Map(),
  assignments: new Map(),
  kilpBuffer: null,
  competitors: [],
  visible: [],
  selected: null,
  port: null,
  reader: null,
  writer: null,
  queue: null,
  pumpPromise: null,
  simulatingAll: false
};

const el = id => document.getElementById(id);

// ---------------------------------------------------------------------
// Competition file parsing (KILP.DAT / KilpSrj.xml / radat1.xml), same
// format and logic as web/app.js's Emit 250 simulator - duplicated here
// rather than shared so this page has no dependency on that one.
// ---------------------------------------------------------------------

function directChildren(node, localName) {
  return Array.from(node.children || []).filter(child => child.localName === localName);
}

function firstDirectChild(node, localName) {
  return directChildren(node, localName)[0] || null;
}

function descendantElements(node, localName) {
  return Array.from(node.getElementsByTagNameNS("*", localName));
}

function childText(node, localName) {
  return firstDirectChild(node, localName)?.textContent.trim() || "";
}

function parseXml(text, filename) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  const error = xml.querySelector("parsererror");
  if (error) throw new Error(`${filename} ei ole kelvollinen XML-tiedosto.`);
  return xml;
}

function parseClasses(text) {
  const xml = parseXml(text, "KilpSrj.xml");
  const classes = new Map();
  for (const node of descendantElements(xml, "Class")) {
    const classNo = Number(node.getAttribute("ClassNo"));
    const classId = childText(node, "ClassId");
    if (Number.isInteger(classNo) && classNo > 0 && classId) classes.set(classNo - 1, classId);
  }
  if (!classes.size) throw new Error("KilpSrj.xml: sarjoja ei löytynyt.");
  return classes;
}

function parseCourses(text) {
  const xml = parseXml(text, "radat1.xml");
  const courses = new Map();
  const assignments = new Map();
  const punchMap = new Map();

  for (const control of descendantElements(xml, "Control")) {
    const controlCode = childText(control, "ControlCode");
    const punchingUnit = firstDirectChild(control, "PunchingUnit");
    const unitCode = punchingUnit ? childText(punchingUnit, "UnitCode") : "";
    if (/^\d+$/.test(controlCode) && /^\d+$/.test(unitCode)) punchMap.set(controlCode, Number(unitCode));
  }

  for (const course of descendantElements(xml, "Course")) {
    const courseName = childText(course, "CourseName");
    if (!courseName) continue;
    const controls = [];
    for (const courseControl of descendantElements(course, "CourseControl")) {
      const raw = childText(courseControl, "ControlCode");
      if (/^\d+$/.test(raw)) controls.push(punchMap.get(raw) ?? Number(raw));
    }
    courses.set(courseName, controls);
    for (const classNode of directChildren(course, "ClassShortName")) {
      const className = classNode.textContent.trim();
      if (className) assignments.set(className, courseName);
    }
  }

  for (const assignment of descendantElements(xml, "ClassCourseAssignment")) {
    const className = childText(assignment, "ClassName");
    const courseName = childText(assignment, "CourseName");
    if (className && courseName) assignments.set(className, courseName);
  }

  if (!courses.size) throw new Error("radat1.xml: ratoja ei löytynyt. Tarkista, että valitsit oikean tiedoston.");
  return { courses, assignments };
}

function fixedUtf16(view, offset, characterCount) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, characterCount * 2);
  const value = new TextDecoder("utf-16le").decode(bytes);
  return value.split("\0", 1)[0].trim();
}

function parseKilpDat(buffer, classes, courses, assignments, race) {
  let stageCount = null;
  for (const candidate of [1, 2]) {
    const candidateRecordSize = KILP_HEADER_SIZE + KILP_PHASE_SIZE * candidate;
    if (buffer.byteLength >= candidateRecordSize * 2 && buffer.byteLength % candidateRecordSize === 0) {
      stageCount = candidate;
      break;
    }
  }
  if (stageCount === null) {
    const single = KILP_HEADER_SIZE + KILP_PHASE_SIZE;
    const double = KILP_HEADER_SIZE + KILP_PHASE_SIZE * 2;
    throw new Error(`KILP.DAT: tiedostokoko ${buffer.byteLength} ei koostu ${single} tavun (yksi kilpailu) tai ${double} tavun (kaksi kilpailua) tietueista.`);
  }
  if (race > stageCount) throw new Error("Tämä KILP.DAT sisältää tietoja vain vaiheelle 1.");

  const RECORD_SIZE = KILP_HEADER_SIZE + KILP_PHASE_SIZE * stageCount;
  const view = new DataView(buffer);
  const phaseOffset = KILP_HEADER_SIZE + KILP_PHASE_SIZE * (race - 1);
  const competitors = [];

  for (let recordIndex = 1; recordIndex < buffer.byteLength / RECORD_SIZE; recordIndex++) {
    const base = recordIndex * RECORD_SIZE;
    if (view.getInt16(base, true) !== 0) continue;
    const classIndex = view.getInt16(base + 348, true);
    const className = classes.get(classIndex) ?? `#${classIndex}`;
    const courseName = assignments.get(className) ?? (courses.has(className) ? className : "");
    let emitCard = view.getInt32(base + phaseOffset + 68, true);
    if (emitCard <= 0 && race === 2) emitCard = view.getInt32(base + KILP_HEADER_SIZE + 68, true);
    competitors.push({
      recordIndex,
      number: view.getUint16(base + 2, true),
      leg: 0,
      lastName: fixedUtf16(view, base + 48, 25),
      firstName: fixedUtf16(view, base + 98, 25),
      club: fixedUtf16(view, base + 180, 32),
      className,
      courseName,
      controls: courses.get(courseName) || [],
      emitCard
    });
  }
  return competitors;
}

function parseRelayLegCount(text) {
  const xml = parseXml(text, "KilpSrj.xml");
  const fileFormat = xml.getElementsByTagNameNS("*", "FileFormat")[0];
  const legsText = fileFormat ? childText(fileFormat, "Legs") : "";
  const legs = Number(legsText);
  return Number.isInteger(legs) && legs > 0 ? legs : null;
}

function nulTerminatedUtf8(bytes, offset) {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder("utf-8").decode(bytes.subarray(offset, end)).trim();
}

function parseViestiKilpDat(buffer, courses, className, legCount) {
  const HEADER_SIZE = 138;
  const LEG_SIZE = 202;
  const LEG_NAME_OFFSET = 0;
  const LEG_COURSE_OFFSET = 92;
  const LEG_EMIT_CARD_OFFSET = 105;

  const RECORD_SIZE = HEADER_SIZE + LEG_SIZE * legCount;
  if (buffer.byteLength < RECORD_SIZE * 2 || buffer.byteLength % RECORD_SIZE !== 0) {
    throw new Error(`KILP.DAT (viesti): tiedostokoko ${buffer.byteLength} ei koostu ${RECORD_SIZE} tavun tietueista (${legCount} osuutta).`);
  }

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const runners = [];

  for (let recordIndex = 1; recordIndex < buffer.byteLength / RECORD_SIZE; recordIndex++) {
    const base = recordIndex * RECORD_SIZE;
    if (view.getInt16(base, true) !== 0) continue;

    const teamNumber = view.getInt32(base + 2, true);
    const club = nulTerminatedUtf8(bytes, base + 8);

    for (let leg = 0; leg < legCount; leg++) {
      const legBase = base + HEADER_SIZE + leg * LEG_SIZE;
      const nameField = nulTerminatedUtf8(bytes, legBase + LEG_NAME_OFFSET);
      const emitCard = view.getInt32(legBase + LEG_EMIT_CARD_OFFSET, true);
      if (!nameField || emitCard <= 0) continue;

      const courseName = nulTerminatedUtf8(bytes, legBase + LEG_COURSE_OFFSET);
      const [lastNameRaw, firstNameRaw = ""] = nameField.split("|");
      runners.push({
        recordIndex,
        number: teamNumber,
        leg: leg + 1,
        lastName: lastNameRaw.trim(),
        firstName: firstNameRaw.trim(),
        club,
        className,
        courseName,
        controls: courses.get(courseName) || [],
        emitCard
      });
    }
  }
  return runners;
}

// ---------------------------------------------------------------------
// SI card content encoding.
//
// Punch times are encoded as seconds-of-day (0-86399): PTD bit 0 marks the
// second 12-hour half (see tulkExtOtsikko/tulkExtLeimat in SITulkinta.cpp),
// so a punch at `seconds` becomes raw16 = seconds % 43200 with the half-day
// bit set when seconds >= 43200. SI5's own legacy layout has no half-day
// bit - tulkSI instead compares each punch to the previous one and adds
// 43200 when time appears to go backwards, so storing raw16 = seconds %
// 43200 there decodes correctly too as long as consecutive punches are
// never more than 12h apart (always true here).
// ---------------------------------------------------------------------

const NO_PUNCH_CN = 0xee;

function encodePTDTime(seconds) {
  const s = ((Math.round(seconds) % 86400) + 86400) % 86400;
  const half = s >= 43200 ? 1 : 0;
  const raw = s % 43200;
  return { ptd: half, hi: (raw >> 8) & 0xff, lo: raw & 0xff };
}

function setPunchRecord(buf, offset, code, seconds) {
  const { ptd, hi, lo } = encodePTDTime(seconds);
  buf[offset] = ptd;
  buf[offset + 1] = code & 0xff;
  buf[offset + 2] = hi;
  buf[offset + 3] = lo;
}

function setNoPunch(buf, offset) {
  buf[offset] = 0;
  buf[offset + 1] = NO_PUNCH_CN;
  buf[offset + 2] = 0;
  buf[offset + 3] = 0;
}

// Builds the combined block buffer for SI9/SI8/pCard/tCard/SI10-11 (EXT
// protocol, tulkExtOtsikko header layout, badge = 3-byte SIID at [25:28]).
// `punchStart`/`punchStep`/`totalLen` select the per-type punch-list layout
// documented in SITulkinta.cpp's tulkSI() (case 7/8/9/10/11).
function buildExtFamilyBuffer(badge, punches, punchStart, punchStep, totalLen) {
  const buf = new Uint8Array(totalLen);
  setNoPunch(buf, 8); // check
  setNoPunch(buf, 12); // start
  setNoPunch(buf, 16); // finish
  buf[22] = Math.min(255, punches.length); // RC - only read for SI10/11 (block-count hint), harmless elsewhere
  buf[25] = (badge >>> 16) & 0xff;
  buf[26] = (badge >>> 8) & 0xff;
  buf[27] = badge & 0xff;

  let offset = punchStart;
  for (const punch of punches) {
    if (offset + 3 >= totalLen) break; // no room left in the buffer for this card type
    setPunchRecord(buf, offset, punch.code, punch.seconds);
    offset += punchStep;
  }
  if (offset + 3 < totalLen) buf[offset + 1] = NO_PUNCH_CN; // terminate the punch list
  return buf;
}

// SI6 via the EXT protocol (SItype 12 in tulkSI): distinct header layout
// from the SI9+ family above - 4-byte badge at [10:14], four named punch
// slots (finish/start/check/clear) at [20]/[24]/[28]/[32], punch list
// starting at byte 256 (blocks "6" and "7"), always a fixed 512-byte read.
function buildSI6ExtBuffer(badge, punches) {
  const buf = new Uint8Array(512);
  buf[10] = (badge >>> 24) & 0xff;
  buf[11] = (badge >>> 16) & 0xff;
  buf[12] = (badge >>> 8) & 0xff;
  buf[13] = badge & 0xff;
  setNoPunch(buf, 20); // finish
  setNoPunch(buf, 24); // start
  setNoPunch(buf, 28); // check
  setNoPunch(buf, 32); // clear

  let offset = 256;
  for (const punch of punches) {
    if (offset + 3 >= 512) break;
    setPunchRecord(buf, offset, punch.code, punch.seconds);
    offset += 4;
  }
  if (offset + 3 < 512) buf[offset + 1] = NO_PUNCH_CN;
  return buf;
}

// SI5 (legacy SI5tp struct layout, transported via the EXT E5/B1
// handshake): badge is CN (2 bytes) plus an optional CNS*100000 series
// offset; start/check/finish header punches are left as the "no value"
// sentinel (0xEEEE = 61166, remapped to TMAALI0 by Pirila's Juk/VIv.cpp)
// so the punch row list below is the only source of times.
function buildSI5Buffer(badge, punches) {
  const buf = new Uint8Array(133);
  buf[0] = 0x02; // stx
  let cn = badge;
  let cns = 0;
  if (badge > 0xffff) {
    cns = Math.max(2, Math.floor(badge / 100000));
    cn = badge - cns * 100000;
    if (cn < 0 || cn > 0xffff) {
      cns = 0;
      cn = badge & 0xffff;
    }
  }
  buf[7] = (cn >> 8) & 0xff;
  buf[8] = cn & 0xff;
  buf[9] = cns & 0xff;
  buf[22] = 0xee; buf[23] = 0xee; // ST: no start
  buf[24] = 0xee; buf[25] = 0xee; // FT: no finish
  buf[28] = 0xee; buf[29] = 0xee; // CT: no check

  let idx = 0;
  for (let row = 0; row < 6 && idx < punches.length; row++) {
    const rowBase = 35 + row * 16; // SI5row = 1 (ccx) + 5 * 3 (cc + ct[2]) bytes
    for (let i = 0; i < 5; i++) {
      const cBase = rowBase + 1 + i * 3;
      if (idx < punches.length) {
        const punch = punches[idx++];
        const raw = ((Math.round(punch.seconds) % 43200) + 43200) % 43200;
        buf[cBase] = punch.code & 0xff;
        buf[cBase + 1] = (raw >> 8) & 0xff;
        buf[cBase + 2] = raw & 0xff;
      }
    }
  }
  buf[132] = 0x03; // etx
  return buf;
}

const EXT_FAMILY_LAYOUT = {
  si9: { start: 56, step: 4 },
  si8: { start: 136, step: 4 },
  pcard: { start: 176, step: 4 },
  tcard: { start: 56, step: 8 }
};

// Builds a read "plan" for a card type: the notification trigger byte, the
// request command the host will use, and either a single-shot payload (SI5)
// or a map of host block-number -> 128-byte chunk (everything else).
function planForCard(type, badge, punches) {
  if (type === "si5") {
    return { notifyByte: 0xe5, requestCmd: 0xb1, singleShot: buildSI5Buffer(badge, punches), expectedRequests: 1 };
  }
  if (type === "si6ext") {
    const data = buildSI6ExtBuffer(badge, punches);
    const blocks = new Map([
      [0, data.slice(0, 128)],
      [1, data.slice(128, 256)],
      [6, data.slice(256, 384)],
      [7, data.slice(384, 512)]
    ]);
    return { notifyByte: 0xe6, requestCmd: 0xe1, blocks, expectedRequests: 4 };
  }
  if (type === "si1011") {
    const neededBlocks = Math.min(4, Math.max(1, Math.ceil(punches.length / 32)));
    const totalLen = 128 + neededBlocks * 128;
    const data = buildExtFamilyBuffer(badge, punches, 128, 4, totalLen);
    const blocks = new Map([[0, data.slice(0, 128)]]);
    [4, 5, 6, 7].slice(0, neededBlocks).forEach((hostBlock, index) => {
      blocks.set(hostBlock, data.slice(128 + index * 128, 256 + index * 128));
    });
    return { notifyByte: 0xe8, requestCmd: 0xef, blocks, expectedRequests: 1 + neededBlocks };
  }
  const layout = EXT_FAMILY_LAYOUT[type];
  if (!layout) throw new Error(`Tuntematon korttityyppi: ${type}`);
  const data = buildExtFamilyBuffer(badge, punches, layout.start, layout.step, 256);
  const blocks = new Map([[0, data.slice(0, 128)], [1, data.slice(128, 256)]]);
  return { notifyByte: 0xe8, requestCmd: 0xef, blocks, expectedRequests: 2 };
}

function autoCardType(badge) {
  if (badge >= 7000000) return "si1011";
  if (badge >= 6000000) return "tcard";
  if (badge >= 4000000) return "pcard";
  if (badge >= 2000000) return "si8";
  if (badge >= 1000000) return "si9";
  return "si6ext";
}

function buildPunches(controls, finishMinutes) {
  const finishSeconds = Math.max(60, Math.round(finishMinutes * 60));
  return controls.map((code, index) => ({
    code,
    seconds: Math.max(1, Math.round((finishSeconds * (index + 1)) / controls.length))
  }));
}

// Parses manually entered punches in "code(splitSeconds),code(splitSeconds),..."
// form, e.g. "76(239),88(100),92(400)". Each split is the time since the
// previous punch (or since start, for the first one) - a "rastiväliaika" -
// not a clock time, so this turns them into the cumulative seconds-of-day
// values encodePTDTime()/buildSI5Buffer() expect.
function parseManualPunches(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Anna vähintään yksi leima muodossa 76(239),88(100),92(400).");
  const entries = trimmed.split(",").map(part => part.trim()).filter(Boolean);
  if (!entries.length) throw new Error("Anna vähintään yksi leima muodossa 76(239),88(100),92(400).");

  let cumulative = 0;
  return entries.map(entry => {
    const match = entry.match(/^(\d{1,3})\s*\(\s*(\d+(?:[.,]\d+)?)\s*\)$/);
    if (!match) throw new Error(`Virheellinen leima "${entry}". Käytä muotoa rastikoodi(sekuntia), esim. 76(239).`);
    const code = Number(match[1]);
    const splitSeconds = Number(match[2].replace(",", "."));
    if (!Number.isInteger(code) || code < 1 || code > 255) throw new Error(`Rastikoodin pitää olla välillä 1–255 (sait ${code}).`);
    if (!Number.isFinite(splitSeconds) || splitSeconds < 0) throw new Error(`Rastiväliajan pitää olla nollaa suurempi tai yhtä suuri (sait "${match[2]}").`);
    cumulative += splitSeconds;
    return { code, seconds: cumulative };
  });
}

function parseManualBadge(text) {
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value < 1) throw new Error("Anna kelvollinen kortin numero (positiivinen kokonaisluku).");
  return value;
}

// ---------------------------------------------------------------------
// Serial byte queue: buffers everything the pump reads from the port and
// lets the protocol code await an exact number of bytes, mirroring how
// lue_SI() reads its own request frames one byte at a time.
// ---------------------------------------------------------------------

class ByteQueue {
  constructor() {
    this.buf = new Uint8Array(0);
    this.waiters = [];
  }

  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const waiter = this.waiters.shift();
      waiter.resolve(this.buf.slice(0, waiter.n));
      this.buf = this.buf.slice(waiter.n);
    }
  }

  take(n, timeoutMs) {
    if (this.buf.length >= n) {
      const bytes = this.buf.slice(0, n);
      this.buf = this.buf.slice(n);
      return Promise.resolve(bytes);
    }
    return new Promise((resolve, reject) => {
      const waiter = { n, resolve };
      this.waiters.push(waiter);
      if (timeoutMs) {
        setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
            reject(new Error("Aikakatkaisu: Pirilän ohjelmisto ei vastannut lukupyyntöön."));
          }
        }, timeoutMs);
      }
    });
  }

  reset() {
    this.buf = new Uint8Array(0);
    this.waiters = [];
  }
}

function concatBytes(...parts) {
  const arrays = parts.map(part => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

async function readRequestFrame(queue, timeoutMs) {
  // Sync to the FF 02 wakeup+STX pair, then read cmd/len/data/crc/etx.
  for (;;) {
    const first = (await queue.take(1, timeoutMs))[0];
    if (first !== 0xff) continue;
    const second = (await queue.take(1, timeoutMs))[0];
    if (second !== 0x02) continue;
    const cmd = (await queue.take(1, timeoutMs))[0];
    const len = (await queue.take(1, timeoutMs))[0];
    const rest = await queue.take(len + 3, timeoutMs); // data[len], crc_h, crc_l, etx
    return { cmd, data: rest.slice(0, len) };
  }
}

async function writeFrame(writer, bytes) {
  await writer.write(bytes);
}

async function performCardRead(writer, queue, plan, timeoutMs) {
  await writeFrame(writer, Uint8Array.from([0x02, plan.notifyByte, 0x00, 0x00, 0x00, 0x03]));

  if (plan.singleShot) {
    const request = await readRequestFrame(queue, timeoutMs);
    if (request.cmd !== plan.requestCmd) {
      throw new Error(`Odottamaton pyyntö (cmd 0x${request.cmd.toString(16)}), odotettiin 0x${plan.requestCmd.toString(16)}.`);
    }
    await writeFrame(writer, concatBytes([0x02, plan.requestCmd, 0x83, 0x00, 0x0a, 0x00], plan.singleShot, [0x00, 0x00, 0x03]));
    return;
  }

  let remaining = plan.expectedRequests;
  while (remaining > 0) {
    const request = await readRequestFrame(queue, timeoutMs);
    if (request.cmd !== plan.requestCmd) continue; // ignore stray frames (e.g. a beep ack)
    const blockNum = request.data[0] ?? 0;
    const chunk = plan.blocks.get(blockNum) || new Uint8Array(128);
    await writeFrame(writer, concatBytes([0x02, plan.requestCmd, 0x83, 0x00, 0x0a, blockNum], chunk, [0x00, 0x00, 0x03]));
    remaining--;
  }
}

// ---------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------

function setStatus(target, message, type = "") {
  target.textContent = message;
  target.className = `status ${type}`.trim();
}

function renderCompetitors() {
  const query = el("search").value.trim().toLocaleLowerCase("fi");
  state.visible = state.competitors.filter(c => !query || [c.number, c.leg, c.firstName, c.lastName, c.className, c.courseName, c.emitCard, c.club]
    .join(" ").toLocaleLowerCase("fi").includes(query));
  const body = el("competitors");
  body.replaceChildren();
  for (const competitor of state.visible) {
    const row = document.createElement("tr");
    if (state.selected === competitor) row.classList.add("selected");
    for (const value of [competitor.number, competitor.leg > 0 ? competitor.leg : "", competitor.lastName, competitor.firstName, competitor.className, competitor.courseName, competitor.emitCard, competitor.club]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    row.addEventListener("click", () => selectCompetitor(competitor));
    body.append(row);
  }
  el("countStatus").textContent = `${state.visible.length} / ${state.competitors.length} kilpailijaa`;
}

function cardTypeLabel(type) {
  return { si5: "SI5", si6ext: "SI6", si9: "SI9", si8: "SI8", pcard: "pCard", tcard: "tCard", si1011: "SI10/11" }[type] || type;
}

function selectCompetitor(competitor) {
  state.selected = competitor;
  const legInfo = competitor.leg > 0 ? ` | Osuus ${competitor.leg}` : "";
  const selectedType = el("cardType").value;
  const effectiveType = selectedType === "auto" ? autoCardType(competitor.emitCard) : selectedType;
  el("selectionDetails").textContent = `${competitor.firstName} ${competitor.lastName}${legInfo} | ${competitor.className} | ${competitor.controls.length} rataleimaa | Kortti ${competitor.emitCard} | ${cardTypeLabel(effectiveType)}`;
  el("sendButton").disabled = !state.writer;
  renderCompetitors();
}

async function loadFiles() {
  try {
    const kilp = el("kilpFile").files[0];
    const classes = el("classesFile").files[0];
    const courses = el("coursesFile").files[0];
    if (!kilp || !classes || !courses) throw new Error("Valitse KILP.DAT, KilpSrj.xml ja radat1.xml.");
    const [kilpBuffer, classText, courseText] = await Promise.all([kilp.arrayBuffer(), classes.text(), courses.text()]);
    state.classes = parseClasses(classText);
    const courseData = parseCourses(courseText);
    state.courses = courseData.courses;
    state.assignments = courseData.assignments;
    state.kilpBuffer = kilpBuffer;

    const legCount = parseRelayLegCount(classText);
    if (legCount) {
      const className = state.classes.size === 1 ? [...state.classes.values()][0] : "Viesti";
      state.competitors = parseViestiKilpDat(kilpBuffer, state.courses, className, legCount);
      el("race").disabled = true;
    } else {
      el("race").disabled = false;
      state.competitors = parseKilpDat(kilpBuffer, state.classes, state.courses, state.assignments, Number(el("race").value));
    }

    state.selected = null;
    el("sendButton").disabled = true;
    el("allButton").disabled = !state.writer;
    el("stopAllButton").disabled = true;
    el("selectionDetails").textContent = "Valitse kilpailija.";
    renderCompetitors();
    const relayNote = legCount ? `Viesti, ${legCount} osuutta. ` : "";
    setStatus(el("loadStatus"), `${relayNote}${state.competitors.length} kilpailijaa ladattu. Ratoja ${state.courses.size}, sarjoja ${state.classes.size}.`, "success");
  } catch (error) {
    setStatus(el("loadStatus"), error.message, "error");
  }
}

function setFileInput(inputId, file) {
  const input = el(inputId);
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
}

function identifyDroppedFiles(fileList) {
  const files = Array.from(fileList);
  const byName = new Map(files.map(file => [file.name.toLocaleLowerCase("fi"), file]));
  return {
    kilp: byName.get("kilp.dat") || null,
    classes: byName.get("kilpsrj.xml") || null,
    courses: byName.get("radat1.xml") || byName.get("radat.xml") || null
  };
}

function handleDroppedFiles(fileList) {
  const dropped = identifyDroppedFiles(fileList);
  const missing = [];
  if (dropped.kilp) setFileInput("kilpFile", dropped.kilp); else missing.push("KILP.DAT");
  if (dropped.classes) setFileInput("classesFile", dropped.classes); else missing.push("KilpSrj.xml");
  if (dropped.courses) setFileInput("coursesFile", dropped.courses); else missing.push("radat1.xml");

  if (missing.length) {
    setStatus(el("loadStatus"), `Pudotetuista tiedostoista puuttuu: ${missing.join(", ")}.`, "error");
  } else {
    setStatus(el("loadStatus"), "Kaikki kolme tiedostoa vastaanotettu. Lataa tiedot painamalla painiketta.");
  }
}

async function stopPump() {
  if (state.reader) {
    try { await state.reader.cancel(); } catch { /* already closed */ }
    try { state.reader.releaseLock(); } catch { /* already released */ }
    state.reader = null;
  }
  if (state.pumpPromise) {
    try { await state.pumpPromise; } catch { /* pump loop exit */ }
    state.pumpPromise = null;
  }
}

async function closePort() {
  await stopPump();
  if (state.writer) {
    try { state.writer.releaseLock(); } catch { /* already released */ }
    state.writer = null;
  }
  if (state.port) {
    try { await state.port.close(); } catch { /* already closed */ }
  }
  state.port = null;
  state.queue = null;
}

async function pumpReader(reader, queue) {
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) queue.push(value);
    }
  } catch {
    // Port closed or disconnected under us - the connect/send flows surface this.
  }
}

async function selectPort() {
  try {
    if (!("serial" in navigator)) throw new Error("Selain ei tue Web Serial API:a.");
    await closePort();
    state.port = await navigator.serial.requestPort();
    await state.port.open({ baudRate: 38400, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
    state.queue = new ByteQueue();
    state.reader = state.port.readable.getReader();
    state.pumpPromise = pumpReader(state.reader, state.queue);
    state.writer = state.port.writable.getWriter();
    el("connectButton").textContent = "Vaihda sarjaportti";
    el("sendButton").disabled = !state.selected;
    el("allButton").disabled = !state.competitors.length;
    el("manualSendButton").disabled = false;
    setStatus(el("serialStatus"), "Sarjaportti avattu: 38400 baudia, 8N1 (SI EXT -protokolla).", "success");
  } catch (error) {
    if (error.name !== "NotFoundError") setStatus(el("serialStatus"), error.message, "error");
  }
}

function selectedCardType(competitor) {
  const chosen = el("cardType").value;
  return chosen === "auto" ? autoCardType(competitor.emitCard) : chosen;
}

function responseTimeoutMs() {
  const seconds = Number(el("responseTimeout").value);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 4) * 1000;
}

function planForCompetitor(competitor, finishMinutes) {
  if (!Number.isInteger(competitor.emitCard) || competitor.emitCard < 1 || competitor.emitCard > 0xffffffff) {
    throw new Error("Kortin numero puuttuu tai on virheellinen.");
  }
  if (!competitor.controls.length) throw new Error("Valitulla kilpailijalla ei ole rataleimoja.");
  const type = selectedCardType(competitor);
  const punches = buildPunches(competitor.controls, finishMinutes);
  return { type, plan: planForCard(type, competitor.emitCard, punches) };
}

async function sendPacket() {
  try {
    if (!state.writer) throw new Error("Valitse sarjaportti ensin.");
    if (!state.selected) throw new Error("Valitse kilpailija.");
    const minutes = Number(el("finishMinutes").value);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1000) throw new Error("Loppuajan pitää olla 1–1000 minuuttia.");
    const { type, plan } = planForCompetitor(state.selected, minutes);
    setStatus(el("serialStatus"), `Lähetetään ${cardTypeLabel(type)}-kortti-ilmoitus, odotetaan Pirilän lukupyyntöjä...`);
    await performCardRead(state.writer, state.queue, plan, responseTimeoutMs());
    setStatus(el("serialStatus"), `${cardTypeLabel(type)}-kortti ${state.selected.emitCard} luettu onnistuneesti.`, "success");
  } catch (error) {
    setStatus(el("serialStatus"), error.message, "error");
  }
}

async function sendManualCard() {
  try {
    if (!state.writer) throw new Error("Valitse sarjaportti ensin.");
    const badge = parseManualBadge(el("manualBadge").value);
    const punches = parseManualPunches(el("manualPunches").value);
    const chosen = el("manualCardType").value;
    const type = chosen === "auto" ? autoCardType(badge) : chosen;
    const plan = planForCard(type, badge, punches);
    setStatus(el("manualStatus"), `Lähetetään ${cardTypeLabel(type)}-kortti-ilmoitus (${badge}), odotetaan Pirilän lukupyyntöjä...`);
    await performCardRead(state.writer, state.queue, plan, responseTimeoutMs());
    setStatus(el("manualStatus"), `${cardTypeLabel(type)}-kortti ${badge} luettu onnistuneesti (${punches.length} leimaa).`, "success");
  } catch (error) {
    setStatus(el("manualStatus"), error.message, "error");
  }
}

function setSimulationControls(running) {
  state.simulatingAll = running;
  el("allButton").disabled = running || !state.writer || !state.competitors.length;
  el("stopAllButton").disabled = !running;
  el("sendButton").disabled = running || !state.selected || !state.writer;
  el("manualSendButton").disabled = running || !state.writer;
  el("connectButton").disabled = running;
}

async function simulateAll() {
  if (state.simulatingAll) return;
  if (!state.writer) {
    setStatus(el("serialStatus"), "Valitse sarjaportti ensin.", "error");
    return;
  }
  const seconds = Number(el("allInterval").value);
  if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 3600) {
    setStatus(el("serialStatus"), "Lähetysvälin pitää olla 0,1–3600 sekuntia.", "error");
    return;
  }
  const minutes = Number(el("finishMinutes").value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1000) {
    setStatus(el("serialStatus"), "Loppuajan pitää olla 1–1000 minuuttia.", "error");
    return;
  }

  setSimulationControls(true);
  let sent = 0;
  let skipped = 0;
  try {
    for (let index = 0; index < state.competitors.length; index++) {
      if (!state.simulatingAll) break;
      const competitor = state.competitors[index];
      if (!competitor.controls.length || !competitor.emitCard) {
        skipped++;
        continue;
      }
      const { type, plan } = planForCompetitor(competitor, minutes);
      setStatus(el("serialStatus"), `${sent + 1} / ${state.competitors.length}: ${cardTypeLabel(type)}-kortti ${competitor.emitCard}...`);
      await performCardRead(state.writer, state.queue, plan, responseTimeoutMs());
      sent++;
      if (sent + skipped < state.competitors.length && state.simulatingAll) {
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      }
    }
    if (sent + skipped === state.competitors.length) {
      setStatus(el("serialStatus"), `Kaikki luettu: ${sent} korttia lähetetty${skipped ? `, ${skipped} ohitettu (ei rataleimoja/korttia)` : ""}.`, "success");
    } else {
      setStatus(el("serialStatus"), `Simulointi pysäytetty: ${sent} / ${state.competitors.length} lähetetty.`);
    }
  } catch (error) {
    setStatus(el("serialStatus"), `Simulointi keskeytyi (${sent} / ${state.competitors.length}): ${error.message}`, "error");
  } finally {
    setSimulationControls(false);
  }
}

function stopSimulation() {
  state.simulatingAll = false;
}

el("loadButton").addEventListener("click", loadFiles);
el("race").addEventListener("change", () => { if (state.kilpBuffer) loadFiles(); });
el("search").addEventListener("input", renderCompetitors);
el("cardType").addEventListener("change", () => { if (state.selected) selectCompetitor(state.selected); });
el("connectButton").addEventListener("click", selectPort);
el("sendButton").addEventListener("click", sendPacket);
el("allButton").addEventListener("click", simulateAll);
el("stopAllButton").addEventListener("click", stopSimulation);
el("manualSendButton").addEventListener("click", sendManualCard);

const dropzone = el("dropzone");

function containsFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

document.addEventListener("dragover", event => {
  if (containsFiles(event)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }
}, true);
document.addEventListener("drop", event => {
  if (!containsFiles(event)) return;
  event.preventDefault();
  if (event.target !== dropzone && !dropzone.contains(event.target)) {
    handleDroppedFiles(event.dataTransfer.files);
  }
}, true);

dropzone.addEventListener("dragenter", event => {
  event.preventDefault();
  dropzone.classList.add("is-dragover");
});
dropzone.addEventListener("dragover", event => {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  dropzone.classList.add("is-dragover");
});
dropzone.addEventListener("dragleave", event => {
  if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove("is-dragover");
});
dropzone.addEventListener("drop", event => {
  event.preventDefault();
  dropzone.classList.remove("is-dragover");
  handleDroppedFiles(event.dataTransfer.files);
});

if (!("serial" in navigator) || !window.isSecureContext) el("browserNotice").style.display = "block";

window.addEventListener("beforeunload", () => {
  closePort().catch(() => {});
});
