// index.mjs
import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import axios from "axios";
import { google } from "googleapis";
import { DateTime, Interval } from "luxon";

console.log("RUNNING CODE VERSION: FINAL_STABLE_V1");

// -------------------- App --------------------
const app = express();
app.use(express.json({ limit: "25mb" }));

// -------------------- Request id + logs --------------------
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

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Server misconfigured: ${name} missing`);
  return v;
}

function logError(req, err, extra = {}) {
  console.error(
    JSON.stringify({
      request_id: req?.request_id,
      level: "error",
      msg: err?.message || "Unknown error",
      stack: err?.stack,
      ...extra,
    })
  );
}

// -------------------- Clients --------------------
const supabase = createClient(mustEnv("SUPABASE_URL"), mustEnv("SUPABASE_SERVICE_ROLE_KEY"));
const resend = new Resend(mustEnv("RESEND_API_KEY"));

// -------------------- Simple HTML escape (emails) --------------------
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// -------------------- Webhook token auth (?token=...) --------------------
function requireWebhookToken(req) {
  const got = String(req.query?.token || "").trim();
  const expected = String(process.env.WEBHOOK_TOKEN || "").trim();
  if (!expected) {
    const err = new Error("Server misconfigured: WEBHOOK_TOKEN missing");
    err.status = 500;
    throw err;
  }
  if (!got || got !== expected) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
}

// -------------------- Tool token auth (client-specific) --------------------
// token is stored in Supabase: client_tool_tokens(token -> client_id)
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
    const err2 = new Error("Unauthorized (token not found)");
    err2.status = 401;
    throw err2;
  }

  if (!data.is_active) {
    const err3 = new Error("Unauthorized (token inactive)");
    err3.status = 401;
    throw err3;
  }

  // best-effort last_used_at update (ignore failures)
  supabase
    .from("client_tool_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("token", token)
    .then(() => {})
    .catch(() => {});

  return data.client_id;
}

// middleware: attaches locked client_id to req
async function toolAuth(req, res, next) {
  try {
    req.client_id = await getClientIdFromToolToken(req);
    return next();
  } catch (e) {
    logError(req, e, { where: "toolAuth" });
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
}

// if caller sends client_id anyway, it MUST match token-locked client_id
function enforceClientIdMatch(req, res) {
  if (req.body?.client_id && String(req.body.client_id) !== String(req.client_id)) {
    res.status(403).json({ ok: false, error: "client_id does not match token" });
    return false;
  }
  return true;
}

// -------------------- Google OAuth helpers --------------------
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

// -------------------- Business rules (default) --------------------
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

  if (!rules.allow_weekends) {
    if (start.weekday === 6 || start.weekday === 7) return { ok: false, error: "Closed on weekends" };
  }

  const startHour = start.hour + start.minute / 60;
  const endHour = end.hour + end.minute / 60;

  if (startHour < rules.start_hour || endHour > rules.end_hour) {
    return { ok: false, error: "Outside business hours" };
  }

  if (
    rules.lunch_start_hour != null &&
    rules.lunch_end_hour != null &&
    rules.lunch_end_hour > rules.lunch_start_hour
  ) {
    const lunchStart = start.set({ hour: rules.lunch_start_hour, minute: 0, second: 0, millisecond: 0 });
    const lunchEnd = start.set({ hour: rules.lunch_end_hour, minute: 0, second: 0, millisecond: 0 });
    const lunch = Interval.fromDateTimes(lunchStart, lunchEnd);
    const slot = Interval.fromDateTimes(start, end);
    if (lunch.overlaps(slot)) return { ok: false, error: "Conflicts with lunch break" };
  }

  return { ok: true };
}

// -------------------- Double booking checks --------------------
async function isFreeInGoogleCalendar(calendar, calendar_id, startISO, endISO) {
  const resp = await calendar.freebusy.query({
    requestBody: {
      timeMin: DateTime.fromISO(startISO).toUTC().toISO(),
      timeMax: DateTime.fromISO(endISO).toUTC().toISO(),
      items: [{ id: calendar_id }],
    },
  });

  const busy = resp.data?.calendars?.[calendar_id]?.busy || [];
  return busy.length === 0;
}

async function hasOverlapInSupabase(client_id, startISO, endISO, ignoreAppointmentId = null) {
  // overlap: existing.start < new_end AND existing.end > new_start
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

// -------------------- Idempotency --------------------
// Requires table: tool_idempotency(client_id, tool_name, idempotency_key, response)
async function getIdempotentResponse(client_id, tool_name, idempotency_key) {
  if (!idempotency_key) return null;

  const { data, error } = await supabase
    .from("tool_idempotency")
    .select("response")
    .eq("client_id", client_id)
    .eq("tool_name", tool_name)
    .eq("idempotency_key", idempotency_key)
    .single();

  if (error || !data) return null;
  return data.response || null;
}

async function saveIdempotentResponse(client_id, tool_name, idempotency_key, response) {
  if (!idempotency_key) return;
  await supabase.from("tool_idempotency").upsert(
    { client_id, tool_name, idempotency_key, response },
    { onConflict: "client_id,tool_name,idempotency_key" }
  );
}

// -------------------- Retell call fetch + transcript --------------------
async function fetchRetellCall(call_id) {
  mustEnv("RETELL_API_KEY");
  const url = `https://api.retellai.com/v2/get-call/${call_id}`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}` },
    timeout: 20000,
  });
  return resp.data;
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

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.send("FINAL_STABLE_V1__" + new Date().toISOString());
});
app.get("/ping", (req, res) => res.json({ ok: true, pong: true }));
app.get("/health", (req, res) =>
  res.json({ ok: true, time: new Date().toISOString(), version: "FINAL_STABLE_V1" })
);
app.get("/version", (req, res) => res.json({ ok: true, version: "FINAL_STABLE_V1" }));

// Retell verification pings (GET/HEAD)
app.all("/retell-webhook", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("ok");
  return next();
});

// -------------------- Google OAuth onboarding --------------------
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
    logError(req, e, { where: "onboard/google/start" });
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

    const refresh_token = tokens.refresh_token;
    if (!refresh_token) return res.status(400).send("No refresh_token received. Try again.");

    const { error } = await supabase.from("client_google").upsert({
      client_id,
      refresh_token,
      calendar_id: "primary",
    });
    if (error) throw error;

    return res.send("✅ Google Calendar connected! You can close this tab.");
  } catch (e) {
    logError(req, e, { where: "onboard/google/callback" });
    return res.status(500).send("OAuth failed: " + e.message);
  }
});

// -------------------- TOOLS --------------------

// Check availability
app.post("/tools/check-availability", toolAuth, async (req, res) => {
  try {
    if (!enforceClientIdMatch(req, res)) return;
    const client_id = req.client_id;

    const {
      date, // YYYY-MM-DD
      duration_minutes = 30,
      timezone = "America/Toronto",
    } = req.body || {};

    if (!date) return res.status(400).json({ ok: false, error: "Missing date YYYY-MM-DD" });

    const rules = getDefaultBusinessRules(timezone);
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
        start: DateTime.fromISO(e.start.dateTime || e.start.date).toUTC().toMillis(),
        end: DateTime.fromISO(e.end.dateTime || e.end.date).toUTC().toMillis(),
      }));

    const durMs = Number(duration_minutes) * 60 * 1000;
    const stepMs = rules.step_minutes * 60 * 1000;

    const slots = [];
    for (let t = dayStart.toUTC().toMillis(); t + durMs <= dayEnd.toUTC().toMillis(); t += stepMs) {
      const startUTC = DateTime.fromMillis(t, { zone: "utc" });
      const endUTC = DateTime.fromMillis(t + durMs, { zone: "utc" });

      const startLocal = startUTC.setZone(rules.timezone).toISO();
      const endLocal = endUTC.setZone(rules.timezone).toISO();

      const ruleCheck = validateAgainstBusinessRules({ startISO: startLocal, endISO: endLocal, rules });
      if (!ruleCheck.ok) continue;

      const overlaps = busy.some((b) => t < b.end && t + durMs > b.start);
      if (!overlaps) slots.push({ start_time: startLocal, end_time: endLocal });
    }

    return res.json({ ok: true, date, timezone: rules.timezone, slots });
  } catch (e) {
    logError(req, e, { where: "tools/check-availability" });
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// Book appointment
app.post("/tools/book-appointment", toolAuth, async (req, res) => {
  try {
    if (!enforceClientIdMatch(req, res)) return;
    const client_id = req.client_id;

    const {
      start_time,
      end_time,
      timezone = "America/Toronto",
      title = "Appointment",
      customer_name,
      customer_email,
      customer_phone,
      notes,
      idempotency_key, // pass Retell call_id here
    } = req.body || {};

    if (!start_time || !end_time)
      return res.status(400).json({ ok: false, error: "Missing start_time/end_time" });
    if (!idempotency_key)
      return res.status(400).json({ ok: false, error: "Missing idempotency_key" });

    const prev = await getIdempotentResponse(client_id, "book-appointment", idempotency_key);
    if (prev) return res.json(prev);

    const rules = getDefaultBusinessRules(timezone);
    const ruleCheck = validateAgainstBusinessRules({ startISO: start_time, endISO: end_time, rules });
    if (!ruleCheck.ok) return res.status(400).json({ ok: false, error: ruleCheck.error });

    const overlapDb = await hasOverlapInSupabase(client_id, start_time, end_time);
    if (overlapDb) return res.status(409).json({ ok: false, error: "Time slot already booked" });

    const { calendar, calendar_id } = await getClientCalendar(client_id);

    const free = await isFreeInGoogleCalendar(calendar, calendar_id, start_time, end_time);
    if (!free) return res.status(409).json({ ok: false, error: "Time slot is busy in calendar" });

    const eventResp = await calendar.events.insert({
      calendarId: calendar_id,
      requestBody: {
        summary: title,
        description: [
          `Booked by AI`,
          customer_name ? `Name: ${customer_name}` : null,
          customer_email ? `Email: ${customer_email}` : null,
          customer_phone ? `Phone: ${customer_phone}` : null,
          notes ? `Notes: ${notes}` : null,
        ].filter(Boolean).join("\n"),
        start: { dateTime: start_time, timeZone: timezone },
        end: { dateTime: end_time, timeZone: timezone },
      },
    });

    const google_event_id = eventResp.data.id;

    const { data, error } = await supabase
      .from("appointments")
      .insert({
        client_id,
        customer_name: customer_name || null,
        customer_email: customer_email || null,
        customer_phone: customer_phone || null,
        start_time,
        end_time,
        timezone,
        status: "booked",
        google_calendar_id: calendar_id,
        google_event_id,
        title,
        notes: notes || null,
      })
      .select()
      .single();

    if (error) throw error;

    const response = { ok: true, appointment_id: data.id, google_event_id, start_time, end_time };
    await saveIdempotentResponse(client_id, "book-appointment", idempotency_key, response);
    return res.json(response);
  } catch (e) {
    logError(req, e, { where: "tools/book-appointment" });
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// Cancel appointment
app.post("/tools/cancel-appointment", toolAuth, async (req, res) => {
  try {
    if (!enforceClientIdMatch(req, res)) return;
    const client_id = req.client_id;

    const { appointment_id, idempotency_key } = req.body || {};
    if (!appointment_id) return res.status(400).json({ ok: false, error: "Missing appointment_id" });
    if (!idempotency_key) return res.status(400).json({ ok: false, error: "Missing idempotency_key" });

    const prev = await getIdempotentResponse(client_id, "cancel-appointment", idempotency_key);
    if (prev) return res.json(prev);

    const { data: appt, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("id", appointment_id)
      .eq("client_id", client_id)
      .single();
    if (error) throw error;

    const { calendar, calendar_id } = await getClientCalendar(client_id);

    if (appt.google_event_id) {
      await calendar.events.delete({ calendarId: calendar_id, eventId: appt.google_event_id });
    }

    await supabase.from("appointments").update({ status: "cancelled" }).eq("id", appt.id);

    const response = { ok: true, cancelled_appointment_id: appt.id };
    await saveIdempotentResponse(client_id, "cancel-appointment", idempotency_key, response);
    return res.json(response);
  } catch (e) {
    logError(req, e, { where: "tools/cancel-appointment" });
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// Reschedule appointment
app.post("/tools/reschedule-appointment", toolAuth, async (req, res) => {
  try {
    if (!enforceClientIdMatch(req, res)) return;
    const client_id = req.client_id;

    const {
      appointment_id,
      new_start_time,
      new_end_time,
      timezone = "America/Toronto",
      new_title,
      notes,
      idempotency_key,
    } = req.body || {};

    if (!appointment_id) return res.status(400).json({ ok: false, error: "Missing appointment_id" });
    if (!new_start_time || !new_end_time)
      return res.status(400).json({ ok: false, error: "Missing new_start_time/new_end_time" });
    if (!idempotency_key) return res.status(400).json({ ok: false, error: "Missing idempotency_key" });

    const prev = await getIdempotentResponse(client_id, "reschedule-appointment", idempotency_key);
    if (prev) return res.json(prev);

    const rules = getDefaultBusinessRules(timezone);
    const ruleCheck = validateAgainstBusinessRules({
      startISO: new_start_time,
      endISO: new_end_time,
      rules,
    });
    if (!ruleCheck.ok) return res.status(400).json({ ok: false, error: ruleCheck.error });

    const { data: oldAppt, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("id", appointment_id)
      .eq("client_id", client_id)
      .single();
    if (error) throw error;

    // guard BEFORE deleting old
    const overlapDb = await hasOverlapInSupabase(client_id, new_start_time, new_end_time, oldAppt.id);
    if (overlapDb) return res.status(409).json({ ok: false, error: "New time slot already booked" });

    const { calendar, calendar_id } = await getClientCalendar(client_id);
    const free = await isFreeInGoogleCalendar(calendar, calendar_id, new_start_time, new_end_time);
    if (!free) return res.status(409).json({ ok: false, error: "New time slot is busy in calendar" });

    // now delete old
    if (oldAppt.google_event_id) {
      await calendar.events.delete({ calendarId: calendar_id, eventId: oldAppt.google_event_id });
    }

    // create new
    const eventResp = await calendar.events.insert({
      calendarId: calendar_id,
      requestBody: {
        summary: new_title || oldAppt.title || "Appointment (Rescheduled)",
        description: [
          `Rescheduled by AI`,
          oldAppt.customer_name ? `Name: ${oldAppt.customer_name}` : null,
          oldAppt.customer_email ? `Email: ${oldAppt.customer_email}` : null,
          oldAppt.customer_phone ? `Phone: ${oldAppt.customer_phone}` : null,
          notes ? `Notes: ${notes}` : null,
        ].filter(Boolean).join("\n"),
        start: { dateTime: new_start_time, timeZone: timezone },
        end: { dateTime: new_end_time, timeZone: timezone },
      },
    });

    const new_google_event_id = eventResp.data.id;

    await supabase.from("appointments").update({ status: "rescheduled" }).eq("id", oldAppt.id);

    const { data: newAppt, error: insErr } = await supabase
      .from("appointments")
      .insert({
        client_id,
        customer_name: oldAppt.customer_name || null,
        customer_email: oldAppt.customer_email || null,
        customer_phone: oldAppt.customer_phone || null,
        start_time: new_start_time,
        end_time: new_end_time,
        timezone,
        status: "booked",
        google_calendar_id: calendar_id,
        google_event_id: new_google_event_id,
        previous_appointment_id: oldAppt.id,
        title: new_title || oldAppt.title || "Appointment (Rescheduled)",
        notes: notes || null,
      })
      .select()
      .single();
    if (insErr) throw insErr;

    const response = {
      ok: true,
      old_appointment_id: oldAppt.id,
      new_appointment_id: newAppt.id,
      new_google_event_id,
    };
    await saveIdempotentResponse(client_id, "reschedule-appointment", idempotency_key, response);
    return res.json(response);
  } catch (e) {
    logError(req, e, { where: "tools/reschedule-appointment" });
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// Find appointment
app.post("/tools/find-appointment", toolAuth, async (req, res) => {
  try {
    if (!enforceClientIdMatch(req, res)) return;
    const client_id = req.client_id;

    const {
      customer_phone,
      customer_email,
      from_date,
      to_date,
      timezone = "America/Toronto",
      limit = 5,
    } = req.body || {};

    if (!customer_phone && !customer_email)
      return res.status(400).json({ ok: false, error: "Need customer_phone or customer_email" });

    const rules = getDefaultBusinessRules(timezone);
    const now = DateTime.now().setZone(rules.timezone);

    const fromISO = from_date
      ? DateTime.fromISO(from_date, { zone: rules.timezone }).startOf("day").toUTC().toISO()
      : now.toUTC().toISO();

    const toISO = to_date
      ? DateTime.fromISO(to_date, { zone: rules.timezone }).endOf("day").toUTC().toISO()
      : now.plus({ days: 30 }).toUTC().toISO();

    let q = supabase
      .from("appointments")
      .select("id,start_time,end_time,status,customer_name,customer_email,customer_phone,title")
      .eq("client_id", client_id)
      .in("status", ["booked"])
      .gte("start_time", fromISO)
      .lte("start_time", toISO)
      .order("start_time", { ascending: true })
      .limit(limit);

    if (customer_phone) q = q.eq("customer_phone", customer_phone);
    if (customer_email) q = q.eq("customer_email", customer_email);

    const { data, error } = await q;
    if (error) throw error;

    return res.json({ ok: true, matches: data || [] });
  } catch (e) {
    logError(req, e, { where: "tools/find-appointment" });
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// -------------------- RETELL WEBHOOK (email transcript/summary) --------------------
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

        // save log (optional table)
        await supabase.from("calls").insert({
          client_id,
          retell_call_id: call_id,
          action,
          summary: summary || "(none)",
          transcript: transcript || "(none)",
          from_number,
          recording_url: recording_url || null,
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
    logError(req, e, { where: "retell-webhook" });
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// -------------------- Start --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));