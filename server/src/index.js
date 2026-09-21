import cors from "cors";
import express from "express";
import { getCompetition, getCompetitionEntries, listCompetitions, IrmaError } from "./irma.js";

const port = Number(process.env.PORT || 3000);
const cacheTtlMs = Number(process.env.CACHE_TTL_SECONDS || 300) * 1000;
const allowedOrigins = (process.env.ALLOWED_ORIGIN || "https://ikivela.github.io")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

const app = express();
const cache = new Map();

app.disable("x-powered-by");
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    const error = new Error("Origin is not allowed by CORS.");
    error.status = 403;
    return callback(error);
  },
  methods: ["GET"],
  maxAge: 86400
}));

app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/irma/competitions", async (request, response, next) => {
  try {
    const language = String(request.query.lang || "fi").toLowerCase();
    if (!["fi", "sv", "en"].includes(language)) {
      return response.status(400).json({ error: "Language must be fi, sv or en." });
    }

    const yearValue = request.query.year == null ? null : String(request.query.year);
    if (yearValue !== null && !/^\d{4}$/.test(yearValue)) {
      return response.status(400).json({ error: "Year must be a four-digit number." });
    }

    const upcomingValue = String(request.query.upcoming ?? "true").toLowerCase();
    if (!["true", "false"].includes(upcomingValue)) {
      return response.status(400).json({ error: "Upcoming must be true or false." });
    }

    const year = yearValue === null ? null : Number(yearValue);
    const upcoming = upcomingValue === "true";
    const cacheKey = `list:${language}:${year ?? "current"}:${upcoming}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      response.setHeader("X-Cache", "HIT");
      return response.json(cached.data);
    }

    const data = await listCompetitions({ language, year, upcoming });
    cache.set(cacheKey, { data, expiresAt: Date.now() + cacheTtlMs });
    response.setHeader("X-Cache", "MISS");
    return response.json(data);
  } catch (error) {
    return next(error);
  }
});

app.get("/api/irma/competitions/:competitionDayId", async (request, response, next) => {
  try {
    const rawId = request.params.competitionDayId;
    if (!/^\d{1,10}$/.test(rawId)) {
      return response.status(400).json({ error: "Invalid competition day id." });
    }

    const language = String(request.query.lang || "fi").toLowerCase();
    if (!["fi", "sv", "en"].includes(language)) {
      return response.status(400).json({ error: "Language must be fi, sv or en." });
    }

    const competitionDayId = Number(rawId);
    const cacheKey = `${competitionDayId}:${language}`;
    const cached = cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      response.setHeader("X-Cache", "HIT");
      return response.json(cached.data);
    }

    const data = await getCompetition(competitionDayId, language);
    cache.set(cacheKey, { data, expiresAt: Date.now() + cacheTtlMs });
    response.setHeader("X-Cache", "MISS");
    return response.json(data);
  } catch (error) {
    return next(error);
  }
});

app.get("/api/irma/competitions/:competitionDayId/entries", async (request, response, next) => {
  try {
    const rawId = request.params.competitionDayId;
    if (!/^\d{1,10}$/.test(rawId)) {
      return response.status(400).json({ error: "Invalid competition day id." });
    }
    const language = String(request.query.lang || "fi").toLowerCase();
    if (!["fi", "sv", "en"].includes(language)) {
      return response.status(400).json({ error: "Language must be fi, sv or en." });
    }
    const data = await getCompetitionEntries(Number(rawId), language);
    return response.json(data);
  } catch (error) {
    return next(error);
  }
});

app.use((error, _request, response, _next) => {
  const status = error instanceof IrmaError
    ? error.status
    : Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error);
  response.status(status).json({
    error: status >= 500 ? "IRMA data could not be loaded." : error.message,
    // Upstream endpoint failures are safe to expose: they contain only the
    // IRMA method/status, never the session cookie or CSRF token.
    detail: error instanceof IrmaError || process.env.NODE_ENV === "development"
      ? error.message
      : undefined
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`IRMA API listening on port ${port}`);
});
