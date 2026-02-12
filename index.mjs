import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import axios from "axios";

console.log("RUNNING CODE VERSION: CLEAN_V4_RETELL_FETCH");

const app = express();

// ✅ Increase payload limit (Retell can send big objects)
app.use(express.json({ limit: "25mb" }));

// ✅ Simple request logger
app.use((req, res, next) => {
  console.log("INCOMING", req.method, req.path, req.query);
  next();
});

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// --- routes ---
app.get("/", (req, res) => {
  return res.send("Backend is running.");
});

// ✅ Test: Supabase insert
app.get("/test-supabase", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("calls")
      .insert({
        client_id: null,
        retell_call_id: "test_call_123",
        action: "test",
        summary: "Backend test insert",
        transcript: "Hello world",
        from_number: "+10000000000",
      })
      .select();

    if (error) throw error;
    return res.json({ ok: true, inserted: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ✅ Test: Send email (manual)
app.get("/test-email", async (req, res) => {
  try {
    const to = req.query.to;
    if (!to) {
      return res
        .status(400)
        .json({ ok: false, error: "Add ?to=youremail@gmail.com" });
    }

    const result = await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to,
      subject: "Backend Email Test",
      html: "<h2>It works</h2><p>Your backend can now send emails.</p>",
    });

    if (result.error) {
      return res.status(500).json({ ok: false, error: result.error.message });
    }

    return res.json({ ok: true, id: result.data?.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ✅ Allow Retell verification pings (GET/HEAD)
app.all("/retell-webhook", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    return res.status(200).send("ok");
  }
  return next();
});

// -------- helpers --------
function detectAction(summary, transcript) {
  const text = `${summary} ${transcript}`.toLowerCase();
  if (text.includes("cancel")) return "cancel";
  if (text.includes("resched")) return "reschedule";
  if (text.includes("book") || text.includes("schedule")) return "book";
  return "unknown";
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeTranscript(call) {
  // Prefer final transcript if present
  if (typeof call?.transcript === "string" && call.transcript.trim()) {
    return call.transcript.trim();
  }

  // Some accounts expose transcript_with_tool_calls
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

  // fallback
  return "";
}

async function fetchRetellCall(call_id) {
  if (!process.env.RETELL_API_KEY) {
    throw new Error("Server misconfigured: RETELL_API_KEY missing");
  }

  // Retell endpoint (v2)
  const url = `https://api.retellai.com/v2/get-call/${call_id}`;

  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
    },
    timeout: 20000,
  });

  return resp.data;
}

// ✅ MAIN: Retell webhook → fetch final call → save → email client
app.post("/retell-webhook", async (req, res) => {
  try {
    // 🔐 Token auth (Retell can't send headers in your setup)
    const token = req.query.token;
    if (!token || token !== process.env.WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const client_id = req.query.client_id;
    if (!client_id) {
      return res.status(400).json({ ok: false, error: "Missing client_id" });
    }

    const event = req.body?.event;
    console.log("RETELL EVENT:", event);
    console.log("RETELL BODY KEYS:", Object.keys(req.body || {}));

    // ✅ Only act when call is finished
    if (event !== "call_analyzed") {
      return res.json({ ok: true, skipped: true, event });
    }

    // ✅ Extract call_id from webhook payload
    const call_id =
      req.body?.call?.call_id ||
      req.body?.call_id ||
      req.body?.id ||
      null;

    if (!call_id) {
      return res.status(400).json({ ok: false, error: "Missing call_id" });
    }

    // ✅ Respond immediately
    res.status(200).json({ ok: true, accepted: true });

    // ✅ Heavy work after response
    setImmediate(async () => {
      try {
        // 1) Fetch client row
        const { data: client, error: cErr } = await supabase
          .from("clients")
          .select("email,name")
          .eq("id", client_id)
          .single();

        if (cErr) throw cErr;

        console.log("CLIENT ROW:", client);
        console.log("SENDING TO:", client?.email);
        console.log("FROM_EMAIL:", process.env.FROM_EMAIL);
        console.log("FETCHING RETELL CALL:", call_id);

        // 2) Fetch final call from Retell
        const call = await fetchRetellCall(call_id);

        // 3) Pull the real summary/transcript/recording
        const summary =
          call?.call_analysis?.call_summary ||
          call?.call_analysis?.summary ||
          call?.call_summary ||
          "(none)";

        const transcript = normalizeTranscript(call) || "(none)";

        const from_number =
          call?.from_number ||
          call?.from ||
          call?.caller_number ||
          "(unknown)";

        const recording_url =
          call?.recording_url ||
          call?.recordingUrl ||
          "";

        const action = detectAction(summary, transcript);

        console.log("SUMMARY LENGTH:", summary?.length || 0);
        console.log("TRANSCRIPT LENGTH:", transcript?.length || 0);
        console.log("RECORDING URL:", recording_url ? "YES" : "NO");

        // 4) Save to DB
        const { error: insertErr } = await supabase.from("calls").insert({
          client_id,
          retell_call_id: call_id,
          action,
          summary,
          transcript,
          from_number,
        });

        if (insertErr) throw insertErr;

        // 5) Send ONE final email
        const html = `
          <h2>AI Call Summary</h2>
          <p><b>Client:</b> ${escapeHtml(client.name || "")}</p>
          <p><b>Action:</b> ${escapeHtml(action)}</p>
          <p><b>From:</b> ${escapeHtml(from_number)}</p>

          <h3>Summary</h3>
          <p>${escapeHtml(summary)}</p>

          <h3>Transcript</h3>
          <pre style="white-space:pre-wrap;">${escapeHtml(transcript)}</pre>

          <h3>Recording</h3>
          ${
            recording_url
              ? `<a href="${recording_url}">Listen / Download Recording</a>`
              : `<p>(no recording link available)</p>`
          }
        `;

        const sendResult = await resend.emails.send({
          from: process.env.FROM_EMAIL,
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
    console.error("WEBHOOK ERROR:", e?.message || e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));