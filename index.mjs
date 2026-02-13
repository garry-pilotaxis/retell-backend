// index.mjs
import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import axios from "axios";
import { google } from "googleapis";
import { DateTime, Interval } from "luxon";

// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------
const VERSION = "FINAL_STABLE_V1";
console.log("BOOT:", VERSION, "CWD:", process.cwd());

const app = express();
app.use(express.json({ limit: "25mb" }));

app.use((req, res, next) => {
  req.request_id = `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  console.log(
    JSON.stringify({
      request_id: req.request_id,
      msg: "INCOMING",
      method: req.method,
      path: req.path,
      query: req.query,
    })
  );
  next();
});
app.get("/debug/routes", (req, res) => {
  const routes = [];
  const stack = app?._router?.stack || [];
  for (const layer of stack) {
    if (layer.route?.path) {
      routes.push({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods || {}).map(m => m.toUpperCase()),
      });
    }
  }
  res.json({ ok: true, routes });
});
app.get("/version", (req, res) => {
  res.json({ ok: true, version: "BOOK_ROUTE_FIX__2026-02-13_23-30" });
});

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Server misconfigured: ${name} missing`);
  return v;
}

function logError(req, err, where, extra = {}) {
  console.error(
    JSON.stringify({
      request_id: req?.request_id,
      level: "error",
      where,
      msg: err?.message || "Unknown error",
      stack: err?.stack,
      ...extra,
    })
  );
}

// ------------------------------------------------------------
// Clients
// ------------------------------------------------------------
const supabase = createClient(mustEnv("SUPABASE_URL"), mustEnv("SUPABASE_SERVICE_ROLE_KEY"));
const resend = new Resend(mustEnv("RESEND_API_KEY"));

// ------------------------------------------------------------
// Public routes (PUT THESE FIRST so they ALWAYS register)
// ------------------------------------------------------------
app.get("/", (req, res) => res.send(`${VERSION}__${new Date().toISOString()}`));

app.get("/ping", (req, res) => res.json({ ok: true, pong: true, time: new Date().toISOString() }));

app.get("/health", (req, res) =>
  res.json({
    ok: true,
    version: VERSION,
    time: new Date().toISOString(),
  })
);
app.get("/version", (req, res) => {
  res.json({
    ok: true,
    version: "FINAL_STABLE_V1",
    render_git_commit: process.env.RENDER_GIT_COMMIT || null,
    railway_git_commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    commit_guess: process.env.GIT_COMMIT || null,
    time: new Date().toISOString(),
  });
});
app.get("/version", (req, res) => res.json({ ok: true, version: VERSION }));

// ------------------------------------------------------------
// Webhook auth (query token)
// ------------------------------------------------------------
function requireWebhookToken(req) {
  const got = String(req.query?.token || "").trim();
  const expected = String(mustEnv("WEBHOOK_TOKEN")).trim();
  if (!got || got !== expected) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
}

// ------------------------------------------------------------
// Tool auth (client-specific token -> client_id)
// ------------------------------------------------------------
async function getClientIdFromToolToken(req) {
  const token = String(req.query?.token || "").trim();
  if (!token) {
    const err = new Error("Missing token");
    err.status = 401;
    throw err;
  }

  const { data, error } = await supabase
    .from("client_tool_tokens")
    .select("client_id,is_active")
    .eq("token", token)
    .single();

  if (error || !data) {
    const err = new Error("Unauthorized (token not found)");
    err.status = 401;
    throw err;
  }
  if (!data.is_active) {
    const err = new Error("Unauthorized (token inactive)");
    err.status = 401;
    throw err;
  }

  // best-effort update
  supabase
    .from("client_tool_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("token", token)
    .then(() => {})
    .catch(() => {});

  return data.client_id;
}

async function toolAuth(req, res, next) {
  try {
    req.client_id = await getClientIdFromToolToken(req);
    next();
  } catch (e) {
    logError(req, e, "toolAuth");
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
}

// If client_id is present in body, enforce match
function enforceClientIdMatch(req, res) {
  if (req.body?.client_id && String(req.body.client_id) !== String(req.client_id)) {
    res.status(403).json({ ok: false, error: "client_id does not match token" });
    return false;
  }
  return true;
}

// ------------------------------------------------------------
// Google OAuth helpers
// ------------------------------------------------------------
function getOAuthClient() {
  return new google.auth.OAuth2(
    mustEnv("GOOGLE_CLIENT_ID"),
    mustEnv("GOOGLE_CLIENT_SECRET"),
    mustEnv("GOOGLE_REDIRECT_URL")
  );
}

async function getClientCalendar(client_id) {
  const { data, error } = await supabase
    .from("client_google")
    .select("refresh_token, calendar_id")
    .eq("client_id", client_id)
    .single();

  if (error) throw new Error("Client Google not connected: " + error.message);
  if (!data?.refresh_token) throw new Error("Missing refresh_token for client");

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ refresh_token: data.refresh_token });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  return { calendar, calendar_id: data.calendar_id || "primary" };
}

// ------------------------------------------------------------
// Business rules (default)
// ------------------------------------------------------------
function getDefaultBusinessRules(timezone) {
  return {
    timezone,
    allow_weekends: false,
    start_hour: 9,
    end_hour: 17,
    lunch_start_hour: 12,
    lunch_end_hour: 13,
    step_minutes: 15,
  };
}

function validateAgainstBusinessRules({ startISO, endISO, rules }) {
  const start = DateTime.fromISO(startISO, { zone: rules.timezone });
  const end = DateTime.fromISO(endISO, { zone: rules.timezone });

  if (!start.isValid || !end.isValid) return { ok: false, error: "Invalid start/end time" };
  if (end <= start) return { ok: false, error: "end_time must be after start_time" };

  if (!rules.allow_weekends && (start.weekday === 6 || start.weekday === 7)) {
    return { ok: false, error: "Closed on weekends" };
  }

  const startHour = start.hour + start.minute / 60;
  const endHour = end.hour + end.minute / 60;

  if (startHour < rules.start_hour || endHour > rules.end_hour) {
    return { ok: false, error: "Outside business hours" };
  }

  if (rules.lunch_start_hour != null && rules.lunch_end_hour != null) {
    const lunchStart = start.set({ hour: rules.lunch_start_hour, minute: 0, second: 0, millisecond: 0 });
    const lunchEnd = start.set({ hour: rules.lunch_end_hour, minute: 0, second: 0, millisecond: 0 });
    const lunchInterval = Interval.fromDateTimes(lunchStart, lunchEnd);
    const slotInterval = Interval.fromDateTimes(start, end);
    if (lunchInterval.overlaps(slotInterval)) {
      return { ok: false, error: "Conflicts with lunch break" };
    }
  }

  return { ok: true };
}

// ------------------------------------------------------------
// Double-booking checks
// ------------------------------------------------------------
async function isFreeInGoogleCalendar(calendar, calendar_id, startISO, endISO) {
  const resp = await calendar.freebusy.query({
    requestBody: { timeMin: startISO, timeMax: endISO, items: [{ id: calendar_id }] },
  });
  const busy = resp.data?.calendars?.[calendar_id]?.busy || [];
  return busy.length === 0;
}

async function hasOverlapInSupabase(client_id, startISO, endISO, ignoreAppointmentId = null) {
  let q = supabase
    .from("appointments")
    .select("id")
    .eq("client_id", client_id)
    .eq("status", "booked")
    .lt("start_time", endISO)
    .gt("end_time", startISO);

  if (ignoreAppointmentId != null) q = q.neq("id", ignoreAppointmentId);

  const { data, error } = await q;
  if (error) throw error;
  return (data || []).length > 0;
}

// ------------------------------------------------------------
// Retell fetch helpers
// ------------------------------------------------------------
function escapeHtml(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function normalizeTranscriptFromRetellCall(call) {
  if (typeof call?.transcript === "string" && call.transcript.trim()) return call.transcript.trim();
  const twtc = call?.transcript_with_tool_calls;
  if (Array.isArray(twtc) && twtc.length) {
    return twtc.map((m) => `${(m.role || "unknown").toUpperCase()}: ${m.content || ""}`).join("\n");
  }
  return "";
}

function detectAction(summary, transcript) {
  const text = `${summary} ${transcript}`.toLowerCase();
  if (text.includes("cancel")) return "cancel";
  if (text.includes("resched")) return "reschedule";
  if (text.includes("book") || text.includes("schedule")) return "book";
  return "unknown";
}

async function fetchRetellCall(call_id) {
  const url = `https://api.retellai.com/v2/get-call/${call_id}`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${mustEnv("RETELL_API_KEY")}` },
    timeout: 20000,
  });
  return resp.data;
}

// ------------------------------------------------------------
// Retell verification pings (GET/HEAD)
// ------------------------------------------------------------
app.all("/retell-webhook", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("ok");
  return next();
});

// ------------------------------------------------------------
// Google OAuth onboarding
// ------------------------------------------------------------
app.get("/onboard/google/start", async (req, res) => {
  try {
    const client_id = req.query.client_id;
    if (!client_id) return res.status(400).send("Missing client_id");

    const oauth2Client = getOAuthClient();
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/calendar.events"],
      state: String(client_id),
    });
    return res.redirect(url);
  } catch (e) {
    logError(req, e, "onboard/google/start");
    return res.status(500).send(e.message);
  }
});

app.get("/onboard/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const client_id = req.query.state;

    if (!code) return res.status(400).send("Missing code");
    if (!client_id) return res.status(400).send("Missing state/client_id");

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(String(code));

    if (!tokens.refresh_token) {
      return res.status(400).send("No refresh_token received. Try again with prompt=consent.");
    }

    const { error } = await supabase.from("client_google").upsert({
      client_id,
      refresh_token: tokens.refresh_token,
      calendar_id: "primary",
    });

    if (error) throw error;
    return res.send("✅ Google Calendar connected! You can close this tab.");
  } catch (e) {
    logError(req, e, "onboard/google/callback");
    return res.status(500).send("OAuth failed: " + e.message);
  }
});

// ------------------------------------------------------------
// TOOLS
// ------------------------------------------------------------
app.post("/tools/check-availability", toolAuth, async (req, res) => {
  try {
    if (!enforceClientIdMatch(req, res)) return;

    const client_id = req.client_id;
    const {
      date, // YYYY-MM-DD
      duration_minutes = 30,
      timezone = "America/Toronto",
      start_hour,
      end_hour,
      lunch_start_hour,
      lunch_end_hour,
      allow_weekends,
    } = req.body || {};

    if (!date) return res.status(400).json({ ok: false, error: "Missing date YYYY-MM-DD" });

    const rules = getDefaultBusinessRules(timezone);
    if (start_hour != null) rules.start_hour = Number(start_hour);
    if (end_hour != null) rules.end_hour = Number(end_hour);
    if (lunch_start_hour != null) rules.lunch_start_hour = Number(lunch_start_hour);
    if (lunch_end_hour != null) rules.lunch_end_hour = Number(lunch_end_hour);
    if (allow_weekends != null) rules.allow_weekends = Boolean(allow_weekends);

    const { calendar, calendar_id } = await getClientCalendar(client_id);

    const dayStart = DateTime.fromISO(date, { zone: rules.timezone }).set({
      hour: rules.start_hour,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    const dayEnd = DateTime.fromISO(date, { zone: rules.timezone }).set({
      hour: rules.end_hour,
      minute: 0,
      second: 0,
      millisecond: 0,
    });

    if (!rules.allow_weekends && (dayStart.weekday === 6 || dayStart.weekday === 7)) {
      return res.json({ ok: true, date, timezone: rules.timezone, slots: [] });
    }

    const eventsResp = await calendar.events.list({
      calendarId: calendar_id,
      timeMin: dayStart.toUTC().toISO(),
      timeMax: dayEnd.toUTC().toISO(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const busy = (eventsResp.data.items || [])
      .filter((e) => e.status !== "cancelled")
      .map((e) => ({
        start: DateTime.fromISO(e.start.dateTime || e.start.date, { zone: "utc" }).toMillis(),
        end: DateTime.fromISO(e.end.dateTime || e.end.date, { zone: "utc" }).toMillis(),
      }));

    const durMs = Number(duration_minutes) * 60 * 1000;
    const stepMs = rules.step_minutes * 60 * 1000;

    const slots = [];
    for (let t = dayStart.toUTC().toMillis(); t + durMs <= dayEnd.toUTC().toMillis(); t += stepMs) {
      const slotStartUTC = DateTime.fromMillis(t, { zone: "utc" });
      const slotEndUTC = DateTime.fromMillis(t + durMs, { zone: "utc" });

      const check = validateAgainstBusinessRules({
        startISO: slotStartUTC.setZone(rules.timezone).toISO(),
        endISO: slotEndUTC.setZone(rules.timezone).toISO(),
        rules,
      });
      if (!check.ok) continue;

      const overlaps = busy.some((b) => t < b.end && (t + durMs) > b.start);
      if (!overlaps) {
        slots.push({
          start_time: slotStartUTC.setZone(rules.timezone).toISO(),
          end_time: slotEndUTC.setZone(rules.timezone).toISO(),
        });
      }
    }

    return res.json({ ok: true, date, timezone: rules.timezone, slots });
  } catch (e) {
    logError(req, e, "tools/check-availability");
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ------------------------------------------------------------
// RETELL WEBHOOK (email summary)
// ------------------------------------------------------------
app.post("/retell-webhook", async (req, res) => {
  try {
    requireWebhookToken(req);

    const client_id = req.query.client_id;
    if (!client_id) return res.status(400).json({ ok: false, error: "Missing client_id" });

    const event = req.body?.event;
    if (event !== "call_analyzed") return res.json({ ok: true, skipped: true, event });

    const call_id = req.body?.call?.call_id || req.body?.call_id || req.body?.id || null;
    if (!call_id) return res.status(400).json({ ok: false, error: "Missing call_id" });

    // respond fast
    res.status(200).json({ ok: true, accepted: true });

    setImmediate(async () => {
      try {
        const { data: client, error: cErr } = await supabase
          .from("clients")
          .select("email,name")
          .eq("id", client_id)
          .single();
        if (cErr) throw cErr;

        const call = await fetchRetellCall(call_id);

        const summary =
          call?.call_analysis?.call_summary ||
          call?.call_analysis?.summary ||
          call?.call_summary ||
          call?.summary ||
          "";

        const transcript = normalizeTranscriptFromRetellCall(call) || "";

        const from_number =
          call?.from_number || call?.from || call?.caller_number || call?.call?.from_number || "(unknown)";

        const recording_url = call?.recording_url || call?.recordingUrl || call?.call?.recording_url || "";

        const action = detectAction(summary, transcript);

        await supabase.from("calls").insert({
          client_id,
          retell_call_id: call_id,
          action,
          summary: summary || "(none)",
          transcript: transcript || "(none)",
          from_number,
        });

        const html = `
          <h2>AI Call Summary</h2>
          <p><b>Client:</b> ${escapeHtml(client?.name || "")}</p>
          <p><b>Action:</b> ${escapeHtml(action)}</p>
          <p><b>From:</b> ${escapeHtml(from_number)}</p>

          <h3>Summary</h3>
          <p>${escapeHtml(summary || "(none)")}</p>

          <h3>Transcript</h3>
          <pre style="white-space:pre-wrap;">${escapeHtml(transcript || "(none)")}</pre>

          <h3>Recording</h3>
          ${
            recording_url
              ? `<a href="${recording_url}">Listen / Download Recording</a>`
              : `<p>(no recording link available)</p>`
          }
        `;

        const sendResult = await resend.emails.send({
          from: mustEnv("FROM_EMAIL"),
          to: client.email,
          subject: `AI Call Summary: ${action.toUpperCase()}`,
          html,
        });

        if (sendResult.error) throw new Error(sendResult.error.message);

        console.log(JSON.stringify({ level: "info", msg: "EMAIL SENT", id: sendResult.data?.id }));
      } catch (e) {
        console.error(JSON.stringify({ level: "error", msg: "WEBHOOK ASYNC ERROR", error: e?.message }));
      }
    });
  } catch (e) {
    logError(req, e, "retell-webhook");
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// ------------------------------------------------------------
// Start
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LISTENING on ${PORT} (${VERSION})`));