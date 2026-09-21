import * as cheerio from "cheerio";

const IRMA_ORIGIN = "https://irma.suunnistusliitto.fi";
const DEFAULT_TIMEOUT_MS = 20_000;

export class IrmaError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "IrmaError";
    this.status = status;
  }
}

function extractCookies(headers) {
  const setCookies = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);

  return setCookies
    .map(value => value.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      redirect: "follow",
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new IrmaError("IRMA request timed out.", 504);
    }
    throw new IrmaError(`IRMA request failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function openSession(path) {
  const response = await fetchWithTimeout(
    `${IRMA_ORIGIN}${path}`,
    { headers: { Accept: "text/html" } }
  );

  if (!response.ok) {
    throw new IrmaError(`IRMA competition page returned HTTP ${response.status}.`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const csrfToken = $('meta[name="_csrf"]').attr("content");
  const csrfHeader = $('meta[name="_csrf_header"]').attr("content") || "X-CSRF-TOKEN";
  const cookie = extractCookies(response.headers);

  if (!csrfToken || !cookie) {
    throw new IrmaError("IRMA session or CSRF token was not found.");
  }

  return { cookie, csrfHeader, csrfToken };
}

async function openCalendarSession() {
  return openSession("/public/competitioncalendar/list?tab=competition");
}

async function callEndpoint(session, method, body, endpoint = "CompetitionEndpoint") {
  const response = await fetchWithTimeout(
    `${IRMA_ORIGIN}/connect/${endpoint}/${method}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: session.cookie,
        [session.csrfHeader]: session.csrfToken
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300).trim();
    throw new IrmaError(
      `IRMA endpoint ${method} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}.`
    );
  }

  try {
    return await response.json();
  } catch {
    throw new IrmaError(`IRMA endpoint ${method} returned invalid JSON.`);
  }
}

function collectClasses(competitionDay) {
  const classes = new Map();

  for (const fee of competitionDay.fees || []) {
    const competitionClass = fee.competitionClass;
    if (!competitionClass?.id) continue;

    classes.set(competitionClass.id, {
      id: competitionClass.id,
      name: competitionClass.name,
      orienteeringClassId: competitionClass.orienteeringClass?.id ?? null,
      orienteeringClassName: competitionClass.orienteeringClass?.name ?? null,
      specifier: competitionClass.specifier ?? null,
      firstRegistrationPeriodDayFee: fee.firstRegistrationPeriodDayFee ?? null,
      lateRegistrationPeriodDayFee: fee.lateRegistrationPeriodDayFee ?? null
    });
  }

  return [...classes.values()];
}

export async function getCompetition(competitionDayId, language = "fi") {
  const session = await openSession(`/public/competition/view/${competitionDayId}`);
  const competition = await callEndpoint(session, "viewCompetition", {
    id: competitionDayId
  });

  if (!competition?.id) {
    throw new IrmaError("IRMA response did not contain a competition id.");
  }

  const [competitionDay, entriesResult] = await Promise.all([
    callEndpoint(session, "viewCompetitionDay", {
      id: competitionDayId,
      lang: language
    }),
    getCompetitionEntriesWithSession(session, competition.id)
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    competitionDayId,
    competition,
    competitionDay,
    classes: collectClasses(competitionDay),
    entries: entriesResult.entries,
    entriesAvailable: entriesResult.available,
    entriesError: entriesResult.error
  };
}

async function getCompetitionEntriesWithSession(session, competitionId) {
  try {
    const entries = await callEndpoint(session, "getEntriesForCompetition", {
      competitionId,
      competitionClass: null,
      user: null,
      club: null
    });
    return { entries, available: true };
  } catch (error) {
    // IRMA only exposes this report for competitions whose registration list
    // is public. Keep the competition metadata usable when it is restricted.
    return { entries: [], available: false, error: error.message };
  }
}

export async function getCompetitionEntries(competitionDayId, language = "fi") {
  const session = await openSession(`/public/competition/view/${competitionDayId}`);
  const competition = await callEndpoint(session, "viewCompetition", { id: competitionDayId });
  if (!competition?.id) throw new IrmaError("IRMA response did not contain a competition id.");
  const competitionDay = await callEndpoint(session, "viewCompetitionDay", {
    id: competitionDayId,
    lang: language
  });
  const result = await getCompetitionEntriesWithSession(session, competition.id);
  if (!result.available) throw new IrmaError(result.error || "IRMA competition entries are not public.", 502);
  return { fetchedAt: new Date().toISOString(), competitionDayId, competition, competitionDay, entries: result.entries };
}

function unwrapCompetitionList(value) {
  if (Array.isArray(value)) return value;
  for (const key of ["competitions", "competitionDays", "events", "items", "rows", "data", "content"]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

export async function listCompetitions({ language = "fi", year = null, upcoming = true } = {}) {
  const session = await openCalendarSession();
  const body = {
    // IRMA requires all seven parameters; null selects the rolling upcoming view.
    year: year ?? null,
    month: 1,
    upcoming: upcoming ? "ONE_WEEK" : null,
    disciplines: [],
    areaId: null,
    calendarType: "all",
    competitionOpen: "ALL"
  };

  // IRMA's calendar endpoint is internal and has changed names between
  // releases. Keep the fallback local and read-only so an update in IRMA does
  // not require changing the public proxy contract.
  const methods = [["CompetitionCalendarEndpoint", "view"]];
  let lastError;
  for (const [endpoint, method] of methods) {
    try {
      const response = await callEndpoint(session, method, body, endpoint);
      const competitions = unwrapCompetitionList(response);
      if (competitions.length) {
        return {
          fetchedAt: new Date().toISOString(),
          language,
          year: body.year,
          upcoming,
          competitions
        };
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new IrmaError("IRMA competition list was empty.");
}
