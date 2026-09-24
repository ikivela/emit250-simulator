"use strict";

// SportIdent station simulator page: loads the competition files, picks
// competitors or takes a manually typed card, and plays the station side
// of a card readout over Web Serial. The protocol and card memory encoding
// live in si-protocol.js (window.SI), shared with the Node tests.

const {
  planForCard, autoCardType, cardTypeLabel, evenPunches, parseManualPunches,
  anchorPunches, parseManualBadge, secondsOfDay, ByteQueue, performCardRead
} = window.SI;

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

function nowSecondsOfDay() {
  const now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}

function clockText(seconds) {
  const s = secondsOfDay(seconds);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2, "0")).join(":");
}

function logLine(text) {
  const log = el("protocolLog");
  const lines = log.textContent ? log.textContent.split("\n") : [];
  lines.push(`${clockText(nowSecondsOfDay())}  ${text}`);
  log.textContent = lines.slice(-200).join("\n");
  log.scrollTop = log.scrollHeight;
}

// Punches are clock times ending just before now; a real card also carries
// the clear punch from the start box, which Pirila reads as the check time.
function cardPlan(type, badge, punches) {
  const clearSeconds = el("clearPunch").checked && punches.length ? secondsOfDay(punches[0].seconds - 120) : null;
  return planForCard({ type, badge, punches, clearSeconds, dayOfWeek: new Date().getDay() });
}

function planForCompetitor(competitor, finishMinutes) {
  if (!Number.isInteger(competitor.emitCard) || competitor.emitCard < 1) throw new Error("Kortin numero puuttuu tai on virheellinen.");
  if (!competitor.controls.length) throw new Error("Valitulla kilpailijalla ei ole rataleimoja.");
  const type = selectedCardType(competitor);
  return { type, plan: cardPlan(type, competitor.emitCard, evenPunches(competitor.controls, finishMinutes * 60, nowSecondsOfDay())) };
}

async function readOut(plan) {
  logLine(`--- ${cardTypeLabel(plan.type)} ${plan.badge}`);
  return performCardRead(bytes => state.writer.write(bytes), state.queue, plan, { timeoutMs: responseTimeoutMs(), log: logLine });
}

function readOutMessage(plan, outcome) {
  const card = `${cardTypeLabel(plan.type)}-kortti ${plan.badge}`;
  return outcome.confirmed
    ? [`${card} luettu, lukuohjelma kuittasi luvun.`, "success"]
    : [`${card}: lohkot lähetetty, mutta lukuohjelma ei kuitannut lukua - tarkista sen loki.`, "error"];
}

async function sendPacket() {
  try {
    if (!state.writer) throw new Error("Valitse sarjaportti ensin.");
    if (!state.selected) throw new Error("Valitse kilpailija.");
    const minutes = Number(el("finishMinutes").value);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1000) throw new Error("Loppuajan pitää olla 1–1000 minuuttia.");
    const { type, plan } = planForCompetitor(state.selected, minutes);
    setStatus(el("serialStatus"), `${cardTypeLabel(type)}-kortti asetettu, odotetaan lukupyyntöjä...`);
    setStatus(el("serialStatus"), ...readOutMessage(plan, await readOut(plan)));
  } catch (error) {
    setStatus(el("serialStatus"), error.message, "error");
  }
}

async function sendManualCard() {
  try {
    if (!state.writer) throw new Error("Valitse sarjaportti ensin.");
    const badge = parseManualBadge(el("manualBadge").value);
    const punches = anchorPunches(parseManualPunches(el("manualPunches").value), nowSecondsOfDay());
    const chosen = el("manualCardType").value;
    const type = chosen === "auto" ? autoCardType(badge) : chosen;
    const plan = cardPlan(type, badge, punches);
    setStatus(el("manualStatus"), `${cardTypeLabel(type)}-kortti ${badge} asetettu (leimat ${punches.map(p => `${p.code} ${clockText(p.seconds)}`).join(", ")}), odotetaan lukupyyntöjä...`);
    setStatus(el("manualStatus"), ...readOutMessage(plan, await readOut(plan)));
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
  let unconfirmed = 0;
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
      const outcome = await readOut(plan);
      sent++;
      if (!outcome.confirmed) unconfirmed++;
      if (sent + skipped < state.competitors.length && state.simulatingAll) {
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      }
    }
    if (sent + skipped === state.competitors.length) {
      const notes = [skipped ? `${skipped} ohitettu (ei rataleimoja/korttia)` : "", unconfirmed ? `${unconfirmed} ilman lukuohjelman kuittausta` : ""].filter(Boolean);
      setStatus(el("serialStatus"), `Kaikki luettu: ${sent} korttia lähetetty${notes.length ? `, ${notes.join(", ")}` : ""}.`, unconfirmed ? "error" : "success");
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
