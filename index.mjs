console.log("RUNNING CODE VERSION: CLEAN_V3");
import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const app = express();

// ✅ Increase payload limit (Retell transcripts can be big)
app.use(express.json({ limit: "10mb" }));

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

// ✅ Allow Retell verification pings (GET)
app.all("/retell-webhook", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    return res.status(200).send("ok");
  }
  return next();
});

// -------- helpers --------
function buildTranscriptFromToolCalls(transcript_with_tool_calls) {
  // Retell can send transcript as an array of turns/messages.
  // We’ll try to convert it into readable text.
  if (!Array.isArray(transcript_with_tool_calls)) return "";

  const lines = [];
  for (const t of transcript_with_tool_calls) {
    // common shapes: { role, content } or { speaker, text } etc.
    const role = t.role || t.speaker || t.from || "unknown";
    const text =
      t.content ||
      t.text ||
      t.message ||
      (typeof t === "string" ? t : "") ||
      "";

    if (text) lines.push(`${role}: ${text}`);
  }
  return lines.join("\n");
}

function detectAction(summary, transcript) {
  const text = `${summary} ${transcript}`.toLowerCase();
  if (text.includes("cancel")) return "cancel";
  if (text.includes("resched")) return "reschedule";
  if (text.includes("book") || text.includes("schedule")) return "book";
  return "unknown";
}

// ✅ MAIN: Retell webhook → save call → email client
app.post("/retell-webhook", async (req, res) => {
  try {
    // 🔐 Token auth (Retell can’t send headers in your setup)
    const token = req.query.token;
    if (!token || token !== process.env.WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const client_id = req.query.client_id;
    if (!client_id) {
      return res.status(400).json({ ok: false, error: "Missing client_id" });
    }

    // ✅ Only process final event
    const event = req.body?.event;
    console.log("RETELL EVENT:", event);
    console.log("RETELL BODY KEYS:", Object.keys(req.body || {}));

    if (event !== "call_analyzed") {
      return res.json({ ok: true, skipped: true, event });
    }

    // ✅ respond immediately (Retell expects fast response)
    res.status(200).json({ ok: true, accepted: true });

    // ✅ heavy work after response
    setImmediate(async () => {
      try {
        // Fetch client row
        const { data: client, error: cErr } = await supabase
          .from("clients")
          .select("email,name")
          .eq("id", client_id)
          .single();

        if (cErr) throw cErr;

        console.log("CLIENT ROW:", client);
        console.log("SENDING TO:", client?.email);
        console.log("FROM_EMAIL:", process.env.FROM_EMAIL);

        // ✅ Extract from real Retell payload
const call = req.body?.call || {};
const retell_call_id = call.call_id || req.body?.call_id || req.body?.id || null;

const from_number =
  call.from_number ||
  call.from ||
  req.body?.from_number ||
  req.body?.from ||
  "";

// summary can be in different names depending on Retell event
const summary =
  call.call_summary ||
  call.summary ||
  req.body?.summary ||
  "";

// transcript array (Retell) -> convert to readable text
const twtc = req.body?.transcript_with_tool_calls || [];
const transcript = Array.isArray(twtc)
  ? twtc
      .map((m) => {
        const role = m.role || "unknown";
        const content = m.content || "";
        return `${role.toUpperCase()}: ${content}`;
      })
      .join("\n")
  : (req.body?.transcript || "");

        console.log("FINAL CALL_ID:", retell_call_id);
        console.log("SUMMARY LENGTH:", summary?.length || 0);
        console.log("TRANSCRIPT LENGTH:", transcript?.length || 0);

        const action = detectAction(summary, transcript);

        // Save to DB
        const { error: insertErr } = await supabase.from("calls").insert({
          client_id,
          retell_call_id,
          action,
          summary,
          transcript,
          from_number,
        });

        if (insertErr) throw insertErr;

        // Send email (only one email now — final)
        const sendResult = await resend.emails.send({
          from: process.env.FROM_EMAIL,
          to: client.email,
          subject: `AI Call Summary: ${action.toUpperCase()}`,
          html: `
            <h2>AI Call Summary</h2>
            <p><b>Client:</b> ${client.name || ""}</p>
            <p><b>Action:</b> ${action}</p>
            <p><b>From:</b> ${from_number || "(unknown)"}</p>

            <h3>Summary</h3>
            <p>${summary || "(none)"}</p>

            <h3>Transcript</h3>
            <pre style="white-space:pre-wrap;">${transcript || "(none)"}</pre>
          `,
        });

        if (sendResult.error) throw new Error(sendResult.error.message);
        console.log("EMAIL SENT:", sendResult.data?.id);
      } catch (e) {
        console.error("ASYNC WEBHOOK ERROR:", e);
      }
    });
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));