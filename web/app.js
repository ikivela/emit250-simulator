"use strict";

const RECORD_SIZE = 856;
const PACKET_SIZE = 217;
const XOR_MASK = 0xdf;

const state = {
  classes: new Map(),
  courses: new Map(),
  assignments: new Map(),
  kilpBuffer: null,
  competitors: [],
  visible: [],
  selected: null,
  port: null,
  simulatingAll: false
};

const el = id => document.getElementById(id);

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
  if (buffer.byteLength < RECORD_SIZE * 2 || buffer.byteLength % RECORD_SIZE !== 0) {
    throw new Error(`KILP.DAT: tiedostokoko ${buffer.byteLength} ei koostu 856 tavun tietueista.`);
  }
  const view = new DataView(buffer);
  const phaseOffset = race === 1 ? 360 : 608;
  const competitors = [];

  for (let recordIndex = 1; recordIndex < buffer.byteLength / RECORD_SIZE; recordIndex++) {
    const base = recordIndex * RECORD_SIZE;
    if (view.getInt16(base, true) !== 0) continue;
    const classIndex = view.getInt16(base + 348, true);
    const className = classes.get(classIndex) ?? `#${classIndex}`;
    const courseName = assignments.get(className) ?? (courses.has(className) ? className : "");
    let emitCard = view.getInt32(base + phaseOffset + 68, true);
    if (emitCard <= 0 && race === 2) emitCard = view.getInt32(base + 360 + 68, true);
    competitors.push({
      recordIndex,
      number: view.getUint16(base + 2, true),
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

function setUInt16LE(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
}

function setAscii(buffer, offset, length, value) {
  const text = value.padEnd(length).slice(0, length);
  for (let i = 0; i < length; i++) buffer[offset + i] = text.charCodeAt(i) & 0x7f;
}

function setZeroSumByte(buffer, start, checksumOffset) {
  let sum = 0;
  for (let i = start; i < checksumOffset; i++) sum = (sum + buffer[i]) & 0xff;
  buffer[checksumOffset] = (-sum) & 0xff;
}

function makeEmit250Packet(emitCard, controls, finishMinutes, wrongPunch = false) {
  if (!Number.isInteger(emitCard) || emitCard < 1 || emitCard > 999999) throw new Error("Emit-numeron pitää olla välillä 1–999999.");
  const route = controls.filter(code => Number.isInteger(code) && code >= 1 && code <= 250);
  if (!route.length) throw new Error("Valitulla kilpailijalla ei ole rataleimoja.");
  if (route.length > 49) throw new Error("Radalla on yli 49 rastia; yksi paikka tarvitaan lukijakoodille 250.");

  if (wrongPunch) {
    const existing = new Set(route);
    let incorrect = 1;
    while (incorrect <= 249 && existing.has(incorrect)) incorrect++;
    if (incorrect > 249) incorrect = 249;
    // Replace one punch so the packet remains within the Emit 250 format,
    // while the result service sees a control that is not on the course.
    route[Math.max(0, route.length - 1)] = incorrect;
  }

  const decoded = new Uint8Array(PACKET_SIZE);
  decoded[0] = 0xff;
  decoded[1] = 0xff;
  decoded[2] = emitCard & 0xff;
  decoded[3] = (emitCard >>> 8) & 0xff;
  decoded[4] = (emitCard >>> 16) & 0xff;
  decoded[6] = 1;
  decoded[7] = new Date().getFullYear() % 100;
  setZeroSumByte(decoded, 2, 9);

  const finishSeconds = Math.max(60, Math.round(finishMinutes * 60));
  route.forEach((code, index) => {
    const offset = 10 + index * 3;
    decoded[offset] = code;
    const seconds = Math.min(65534, Math.max(1, Math.round(finishSeconds * (index + 1) / route.length)));
    setUInt16LE(decoded, offset + 1, seconds);
  });

  const readerOffset = 10 + route.length * 3;
  decoded[readerOffset] = 250;
  setUInt16LE(decoded, readerOffset + 1, Math.min(65534, finishSeconds + 5));
  decoded.fill(0x20, 160, 216);
  setAscii(decoded, 160, 40, "Emit 250 simulator");
  decoded[200] = "S".charCodeAt(0);
  setAscii(decoded, 201, 4, "0000");
  decoded[205] = "P".charCodeAt(0);
  setAscii(decoded, 206, 4, "0000");
  decoded[210] = "L".charCodeAt(0);
  setAscii(decoded, 211, 4, "0001");
  decoded[215] = 0;
  setZeroSumByte(decoded, 0, 216);

  const encoded = Uint8Array.from(decoded, value => value ^ XOR_MASK);
  validatePacket(encoded);
  return encoded;
}

function validatePacket(encoded) {
  if (encoded.length !== PACKET_SIZE) throw new Error("Paketin pituus ei ole 217 tavua.");
  const decoded = Uint8Array.from(encoded, value => value ^ XOR_MASK);
  if (decoded[0] !== 0xff || decoded[1] !== 0xff) throw new Error("Paketin otsake on virheellinen.");
  const sum = (start, end) => decoded.slice(start, end).reduce((total, value) => (total + value) & 0xff, 0);
  if (sum(2, 10) !== 0) throw new Error("Emit-numeron tarkistussumma on virheellinen.");
  if (sum(0, PACKET_SIZE) !== 0) throw new Error("Paketin tarkistussumma on virheellinen.");
}

function setStatus(target, message, type = "") {
  target.textContent = message;
  target.className = `status ${type}`.trim();
}

function renderCompetitors() {
  const query = el("search").value.trim().toLocaleLowerCase("fi");
  state.visible = state.competitors.filter(c => !query || [c.number, c.firstName, c.lastName, c.className, c.courseName, c.emitCard, c.club]
    .join(" ").toLocaleLowerCase("fi").includes(query));
  const body = el("competitors");
  body.replaceChildren();
  for (const competitor of state.visible) {
    const row = document.createElement("tr");
    if (state.selected === competitor) row.classList.add("selected");
    for (const value of [competitor.number, competitor.lastName, competitor.firstName, competitor.className, competitor.courseName, competitor.emitCard, competitor.club]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    row.addEventListener("click", () => selectCompetitor(competitor));
    body.append(row);
  }
  el("countStatus").textContent = `${state.visible.length} / ${state.competitors.length} kilpailijaa`;
}

function selectCompetitor(competitor) {
  state.selected = competitor;
  el("selectionDetails").textContent = `${competitor.firstName} ${competitor.lastName} | ${competitor.className} | ${competitor.controls.length} rataleimaa | Emit ${competitor.emitCard}`;
  el("sendButton").disabled = !state.port;
  el("saveButton").disabled = false;
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
    state.competitors = parseKilpDat(kilpBuffer, state.classes, state.courses, state.assignments, Number(el("race").value));
    state.selected = null;
    el("sendButton").disabled = true;
    el("saveButton").disabled = true;
    el("allButton").disabled = !state.port;
    el("stopAllButton").disabled = true;
    el("selectionDetails").textContent = "Valitse kilpailija.";
    renderCompetitors();
    setStatus(el("loadStatus"), `${state.competitors.length} kilpailijaa ladattu. Ratoja ${state.courses.size}, sarjoja ${state.classes.size}.`, "success");
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
    courses: byName.get("radat1.xml") || null
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
    return;
  }
  setStatus(el("loadStatus"), "Kaikki kolme tiedostoa vastaanotettu. Lataa tiedot painamalla painiketta.");
}

async function selectPort() {
  try {
    if (!("serial" in navigator)) throw new Error("Selain ei tue Web Serial API:a.");
    if (state.port?.readable || state.port?.writable) await state.port.close();
    state.port = await navigator.serial.requestPort();
    await state.port.open({ baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none", flowControl: "none" });
    el("connectButton").textContent = "Vaihda sarjaportti";
    el("sendButton").disabled = !state.selected;
    el("allButton").disabled = !state.competitors.length;
    setStatus(el("serialStatus"), "Sarjaportti avattu: 9600 baudia, 8N2.", "success");
  } catch (error) {
    if (error.name !== "NotFoundError") setStatus(el("serialStatus"), error.message, "error");
  }
}

function selectedPacket() {
  if (!state.selected) throw new Error("Valitse kilpailija.");
  const minutes = Number(el("finishMinutes").value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1000) throw new Error("Loppuajan pitää olla 1–1000 minuuttia.");
  return makeEmit250Packet(state.selected.emitCard, state.selected.controls, minutes);
}

async function writePacket(packet) {
  const writer = state.port.writable.getWriter();
  try {
    await writer.write(packet);
    if (el("sendTwice").checked) {
      await new Promise(resolve => setTimeout(resolve, 100));
      await writer.write(packet);
    }
  } finally {
    writer.releaseLock();
  }
}

async function sendPacket() {
  try {
    if (!state.port?.writable) throw new Error("Valitse sarjaportti ensin.");
    const packet = selectedPacket();
    await writePacket(packet);
    setStatus(el("serialStatus"), `217 tavun paketti lähetetty Emit-kortille ${state.selected.emitCard}${el("sendTwice").checked ? " kahdesti" : ""}.`, "success");
  } catch (error) {
    setStatus(el("serialStatus"), error.message, "error");
  }
}

function setSimulationControls(running) {
  state.simulatingAll = running;
  el("allButton").disabled = running || !state.port || !state.competitors.length;
  el("stopAllButton").disabled = !running;
  el("sendButton").disabled = running || !state.selected || !state.port;
  el("saveButton").disabled = running || !state.selected;
  el("connectButton").disabled = running;
}

async function simulateAll() {
  if (state.simulatingAll) return;
  if (!state.port?.writable) {
    setStatus(el("serialStatus"), "Valitse sarjaportti ensin.", "error");
    return;
  }
  const seconds = Number(el("allInterval").value);
  if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 3600) {
    setStatus(el("serialStatus"), "Lähetysvälin pitää olla 0,1–3600 sekuntia.", "error");
    return;
  }

  setSimulationControls(true);
  let sent = 0;
  let disqualified = 0;
  try {
    for (let index = 0; index < state.competitors.length; index++) {
      if (!state.simulatingAll) break;
      const competitor = state.competitors[index];
      // Every twentieth competitor is marked disqualified (approximately 5%).
      const wrongPunch = (index + 1) % 20 === 0;
      if (wrongPunch) disqualified++;
      const minutes = Number(el("finishMinutes").value);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1000) throw new Error("Loppuajan pitää olla 1–1000 minuuttia.");
      await writePacket(makeEmit250Packet(competitor.emitCard, competitor.controls, minutes, wrongPunch));
      sent++;
      setStatus(el("serialStatus"), `${sent} / ${state.competitors.length} kilpailijaa lähetetty${wrongPunch ? " (väärä leima / hylätty)" : ""}. Hylättyjä ${disqualified}.`);
      if (sent < state.competitors.length && state.simulatingAll) {
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      }
    }
    if (sent === state.competitors.length) {
      setStatus(el("serialStatus"), `Kaikki ${sent} kilpailijaa lähetetty. Hylättyjä väärän leiman vuoksi ${disqualified} (noin 5 %).`, "success");
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

function savePacket() {
  try {
    const packet = selectedPacket();
    const url = URL.createObjectURL(new Blob([packet], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `emit250-${state.selected.emitCard}.bin`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(el("serialStatus"), `Paketti emit250-${state.selected.emitCard}.bin tallennettu.`, "success");
  } catch (error) {
    setStatus(el("serialStatus"), error.message, "error");
  }
}

el("loadButton").addEventListener("click", loadFiles);
el("race").addEventListener("change", () => { if (state.kilpBuffer) loadFiles(); });
el("search").addEventListener("input", renderCompetitors);
el("connectButton").addEventListener("click", selectPort);
el("sendButton").addEventListener("click", sendPacket);
el("saveButton").addEventListener("click", savePacket);
el("allButton").addEventListener("click", simulateAll);
el("stopAllButton").addEventListener("click", stopSimulation);

const dropzone = el("dropzone");

// Prevent the browser from opening dropped files as new documents. The drop
// target can be missed by a few pixels, so accept file drops anywhere on the
// page and route them through the same handler.
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
  if (state.port?.readable || state.port?.writable) state.port.close().catch(() => {});
});
