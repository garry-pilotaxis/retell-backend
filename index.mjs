// index.mjs
import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import axios from "axios";
import { google } from "googleapis";

console.log("CWD:", process.cwd());
console.log("TOOL_TOKEN ENV:", process.env.TOOL_TOKEN ? "SET" : "MISSING");
console.log("RUNNING CODE VERSION: PERFECT_V2_MULTI_CLIENT");

// -------------------- App --------------------
const app = express();

// Retell can send big payloads (transcripts/tool calls)
app.use(express.json({ limit: "25mb" }));

// Simple request logger (no body spam)
app.use((req, res, next) => {
  console.log("INCOMING", req.method, req.path, req.query);
  next();
});

// -------------------- Clients --------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

// -------------------- Env sanity --------------------
function mustEnv(name) {
  if (!process.env[name]) throw new Error(`Server misconfigured: ${name} missing`);
  return process.env[name];
}

// Token auth via query param (?token=...)
// - WEBHOOK_TOKEN: for Retell webhook (Retell can’t add custom headers)
// - TOOL_TOKEN: for Retell tool/function calls
function requireQueryToken(req, tokenName) {
  const got = String(req.query?.token || "").trim();
  const expected = String(process.env[tokenName] || "").trim();

  if (!expected) {
    const err = new Error(`Server misconfigured: ${tokenName} missing`);
    err.status = 500;
    throw err;
  }

  if (!got || got !== expected) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
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

// -------------------- Small helpers --------------------
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function detectAction(summary, transcript) {
  const text = `${summary} ${transcript}`.toLowerCase();
  if (text.includes("cancel")) return "cancel";
  if (text.includes("resched")) return "reschedule";
  if (text.includes("book") || text.includes("schedule")) return "book";
  return "unknown";
}

function normalizeTranscriptFromRetellCall(call) {
  if (typeof call?.transcript === "string" && call.transcript.trim()) return call.transcript.trim();

  const twtc = call?.transcript_with_tool_calls;
  if (Array.isArray(twtc) && twtc.length) {
    return twtc
      .map((m) => {
        const role = (m.role || "unknown").toUpperCase();
        const content = m.content || "";
        return `${role}: ${content}`;
      })
      .join("\n");
  }

  return "";
}
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

  return data.client_id;
}

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

  return data.client_id;
}

async function fetchRetellCall(call_id) {
  mustEnv("RETELL_API_KEY");
  const url = `https://api.retellai.com/v2/get-call/${call_id}`;

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}` },
    timeout: 20000,
  });

  return resp.data;
}

// -------------------- Routes --------------------
app.get("/", (req, res) => res.send("Backend is running."));

// Retell verification pings (GET/HEAD)
app.all("/retell-webhook", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("ok");
  return next();
});

// -------------------- TESTS --------------------
app.get("/test-email", async (req, res) => {
  try {
    const to = req.query.to;
    if (!to) return res.status(400).json({ ok: false, error: "Add ?to=youremail@gmail.com" });

    const result = await resend.emails.send({
      from: mustEnv("FROM_EMAIL"),
      to,
      subject: "Backend Email Test",
      html: "<h2>It works</h2><p>Your backend can now send emails.</p>",
    });

    if (result.error) return res.status(500).json({ ok: false, error: result.error.message });
    return res.json({ ok: true, id: result.data?.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------- GOOGLE OAUTH ONBOARDING --------------------
// 1) Client starts OAuth
app.get("/onboard/google/start", async (req, res) => {
  try {
    const client_id = req.query.client_id;

    const oauth2Client = getOAuthClient();

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/calendar.events"],
      state: String(client_id),
    });

    return res.redirect(url);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

// 2) Callback
app.get("/onboard/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const client_id = req.query.state;

    if (!code) return res.status(400).send("Missing code");
    if (!client_id) return res.status(400).send("Missing state/client_id");

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(String(code));

    const refresh_token = tokens.refresh_token;
    if (!refresh_token) {
      return res
        .status(400)
        .send("No refresh_token received. Try again and make sure prompt=consent.");
    }

    const { error } = await supabase.from("client_google").upsert({
      client_id,
      refresh_token,
      calendar_id: "primary",
    });

    if (error) throw error;

    return res.send("✅ Google Calendar connected! You can close this tab.");
  } catch (e) {
    return res.status(500).send("OAuth failed: " + e.message);
  }
});

// -------------------- TOOL ENDPOINTS (Retell functions) --------------------
// Retell tool URL format:
// https://YOUR-RENDER.onrender.com/tools/book-appointment?token=TOOL_TOKEN
// and send JSON body with client_id + params

// Helper: list busy blocks and return slots (simple)
app.post("/tools/check-availability", async (req, res) => {
  try {
    const client_id = await getClientIdFromToolToken(req);

    const {
      client_id,
      date, // YYYY-MM-DD
      duration_minutes = 30,
      timezone = "America/Toronto",
      start_hour = 9,
      end_hour = 17,
    } = req.body || {};

    if (!client_id) return res.status(400).json({ ok: false, error: "Missing client_id" });
    if (!date) return res.status(400).json({ ok: false, error: "Missing date YYYY-MM-DD" });

    const { calendar, calendar_id } = await getClientCalendar(client_id);

    // NOTE: This uses -05:00; Toronto switches with DST.
    // It’s fine for now. If you want DST-correct, we’ll add luxon.
    const dayStart = new Date(
      `${date}T${String(start_hour).padStart(2, "0")}:00:00-05:00`
    );
    const dayEnd = new Date(`${date}T${String(end_hour).padStart(2, "0")}:00:00-05:00`);

    const eventsResp = await calendar.events.list({
      calendarId: calendar_id,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const busy = (eventsResp.data.items || [])
      .filter((e) => e.status !== "cancelled")
      .map((e) => ({
        start: new Date(e.start.dateTime || e.start.date).getTime(),
        end: new Date(e.end.dateTime || e.end.date).getTime(),
      }));

    const durMs = Number(duration_minutes) * 60 * 1000;
    const slots = [];

    // step by 15 minutes (better than stepping by full duration)
    const stepMs = 15 * 60 * 1000;

    for (let t = dayStart.getTime(); t + durMs <= dayEnd.getTime(); t += stepMs) {
      const slotStart = t;
      const slotEnd = t + durMs;
      const overlaps = busy.some((b) => slotStart < b.end && slotEnd > b.start);
      if (!overlaps) {
        slots.push({
          start_time: new Date(slotStart).toISOString(),
          end_time: new Date(slotEnd).toISOString(),
        });
      }
    }

    return res.json({ ok: true, date, timezone, slots });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
});

app.post("/tools/book-appointment", async (req, res) => {
  try {
const client_id = await getClientIdFromToolToken(req);

const {
  start_time,
  end_time,
  timezone = "America/Toronto",
  title = "Appointment",
  customer_name,
  customer_email,
  customer_phone,
  notes,
} = req.body || {};

   
    if (!start_time || !end_time)
      return res.status(400).json({ ok: false, error: "Missing start_time/end_time" });

    const { calendar, calendar_id } = await getClientCalendar(client_id);

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
        ]
          .filter(Boolean)
          .join("\n"),
        start: { dateTime: start_time, timeZone: timezone },
        end: { dateTime: end_time, timeZone: timezone },
      },
    });

    const google_event_id = eventResp.data.id;

    // IMPORTANT: Your appointments table MUST have these columns.
    // If your table is different, change here (don’t guess).
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

    return res.json({
      ok: true,
      appointment_id: data.id,
      google_event_id,
      start_time,
      end_time,
    });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
});

app.post("/tools/cancel-appointment", async (req, res) => {
  try {
    const client_id = await getClientIdFromToolToken(req);

    const { client_id, appointment_id } = req.body || {};
    
    if (!appointment_id)
      return res.status(400).json({ ok: false, error: "Missing appointment_id" });

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

    return res.json({ ok: true, cancelled_appointment_id: appt.id });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
});

app.post("/tools/reschedule-appointment", async (req, res) => {
  try {
    const client_id = await getClientIdFromToolToken(req);

    const {
      client_id,
      appointment_id,
      new_start_time,
      new_end_time,
      timezone = "America/Toronto",
      new_title,
      notes,
    } = req.body || {};

    
    if (!appointment_id)
      return res.status(400).json({ ok: false, error: "Missing appointment_id" });
    if (!new_start_time || !new_end_time)
      return res.status(400).json({ ok: false, error: "Missing new_start_time/new_end_time" });

    const { data: oldAppt, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("id", appointment_id)
      .eq("client_id", client_id)
      .single();

    if (error) throw error;

    const { calendar, calendar_id } = await getClientCalendar(client_id);

    // 1) delete old event immediately (your requirement)
    if (oldAppt.google_event_id) {
      await calendar.events.delete({ calendarId: calendar_id, eventId: oldAppt.google_event_id });
    }

    // 2) create new event
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
        ]
          .filter(Boolean)
          .join("\n"),
        start: { dateTime: new_start_time, timeZone: timezone },
        end: { dateTime: new_end_time, timeZone: timezone },
      },
    });

    const newGoogleEventId = eventResp.data.id;

    // 3) mark old row
    await supabase.from("appointments").update({ status: "rescheduled" }).eq("id", oldAppt.id);

    // 4) insert new row linked to old
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
        google_event_id: newGoogleEventId,
        previous_appointment_id: oldAppt.id,
        title: new_title || oldAppt.title || "Appointment (Rescheduled)",
        notes: notes || null,
      })
      .select()
      .single();

    if (insErr) throw insErr;

    return res.json({
      ok: true,
      old_appointment_id: oldAppt.id,
      new_appointment_id: newAppt.id,
      new_google_event_id: newGoogleEventId,
    });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
});
app.post("/tools/find-appointment", async (req, res) => {
  try {
    const client_id = await getClientIdFromToolToken(req);

    const {
      client_id,
      customer_phone,
      customer_email,
      from_date, // "2026-02-15"
      to_date,   // "2026-02-20"
      limit = 5
    } = req.body || {};

    
    if (!customer_phone && !customer_email)
      return res.status(400).json({ ok: false, error: "Need customer_phone or customer_email" });

    // default: next 30 days if not provided
    const now = new Date();
    const defaultFrom = now.toISOString();
    const defaultTo = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const fromISO = from_date ? new Date(`${from_date}T00:00:00-05:00`).toISOString() : defaultFrom;
    const toISO = to_date ? new Date(`${to_date}T23:59:59-05:00`).toISOString() : defaultTo;

    let q = supabase
      .from("appointments")
      .select("id,start_time,end_time,status,customer_name,customer_email,customer_phone,title")
      .eq("client_id", client_id)
      .in("status", ["booked"]) // only active appointments
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
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
});

// -------------------- RETELL WEBHOOK (Final email + recording + transcript) --------------------
app.post("/retell-webhook", async (req, res) => {
  try {
    requireQueryToken(req, "WEBHOOK_TOKEN");

    const client_id = req.query.client_id;

    const event = req.body?.event;
    console.log("RETELL EVENT:", event);

    // Only process once at the end
    if (event !== "call_analyzed") {
      return res.json({ ok: true, skipped: true, event });
    }

    const call_id = req.body?.call?.call_id || req.body?.call_id || req.body?.id || null;
    if (!call_id) return res.status(400).json({ ok: false, error: "Missing call_id" });

    // Respond fast
    res.status(200).json({ ok: true, accepted: true });

    setImmediate(async () => {
      try {
        const { data: client, error: cErr } = await supabase
          .from("clients")
          .select("email,name")
          .eq("id", client_id)
          .single();

        if (cErr) throw cErr;

        console.log("SENDING TO:", client?.email);
        console.log("FETCHING RETELL CALL:", call_id);

        const call = await fetchRetellCall(call_id);

        const summary =
          call?.call_analysis?.call_summary ||
          call?.call_analysis?.summary ||
          call?.call_summary ||
          call?.summary ||
          "";

        const transcript = normalizeTranscriptFromRetellCall(call) || "";

        const from_number =
          call?.from_number ||
          call?.from ||
          call?.caller_number ||
          call?.call?.from_number ||
          "(unknown)";

        const recording_url =
          call?.recording_url ||
          call?.recordingUrl ||
          call?.call?.recording_url ||
          "";

        const action = detectAction(summary, transcript);

        // Save call log
        // NOTE: this assumes your calls table has: client_id, retell_call_id, action, summary, transcript, from_number
        // If you add recording_url column later, then add it here.
        const { error: insertErr } = await supabase.from("calls").insert({
          client_id,
          retell_call_id: call_id,
          action,
          summary: summary || "(none)",
          transcript: transcript || "(none)",
          from_number,
        });

        if (insertErr) throw insertErr;

        // Email (final only)
        const html = `
          <h2>AI Call Summary</h2>
          <p><b>Client:</b> ${escapeHtml(client.name || "")}</p>
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
        console.log("EMAIL SENT:", sendResult.data?.id);
      } catch (e) {
        console.error("ASYNC WEBHOOK ERROR:", e?.message || e);
      }
    });
  } catch (e) {
    const status = e.status || 500;
    console.error("WEBHOOK ERROR:", e?.message || e);
    return res.status(status).json({ ok: false, error: e.message });
  }
});

// -------------------- Start --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));