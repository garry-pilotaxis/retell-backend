import express from "express";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const app = express();
app.use(express.json());

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Resend
const resend = new Resend(process.env.RESEND_API_KEY);

app.get("/", (req, res) => {
  res.send("Backend is running.");
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
      return res.status(400).json({ ok: false, error: "Add ?to=youremail@gmail.com" });
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

// ✅ MAIN: Retell webhook → save call → email client
app.post("/retell-webhook", async (req, res) => {
  try {

    // 🔒 Webhook security
    const secret = req.header("x-webhook-secret");
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const client_id = req.query.client_id;
    if (!client_id) {
      return res.status(400).json({ ok: false, error: "Missing client_id in URL" });
    }

    // Fetch client email
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("email,name")
      .eq("id", client_id)
      .single();

    if (cErr) throw cErr;

    // Extract fields
    const retell_call_id = req.body.call_id || req.body.id || null;
    const transcript = req.body.transcript || "";
    const summary = req.body.summary || "";
    const from_number = req.body.from_number || req.body.from || "";

    // Basic action detection
    const text = (summary + " " + transcript).toLowerCase();
    let action = "unknown";
    if (text.includes("cancel")) action = "cancel";
    else if (text.includes("resched")) action = "reschedule";
    else if (text.includes("book") || text.includes("schedule")) action = "book";

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

    // Send email
    const sendResult = await resend.emails.send({
      from: process.env.FROM_EMAIL,
      to: client.email,
      subject: `AI Call: ${action.toUpperCase()}`,
      html: `
        <h2>AI Call Summary</h2>
        <p><b>Client:</b> ${client.name || ""}</p>
        <p><b>Action:</b> ${action}</p>
        <p><b>From:</b> ${from_number}</p>
        <h3>Summary</h3>
        <p>${summary || "(none)"}</p>
        <h3>Transcript</h3>
        <pre style="white-space:pre-wrap;">${transcript || "(none)"}</pre>
      `,
    });

    if (sendResult.error) {
      return res.status(500).json({ ok: false, error: sendResult.error.message });
    }

    return res.json({
      ok: true,
      email_id: sendResult.data?.id,
      version: "v2-webhook",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));