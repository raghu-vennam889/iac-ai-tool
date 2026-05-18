require("dotenv").config();
const express   = require("express");
const axios     = require("axios");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
const { SYSTEM_PROMPTS, buildSystemPrompt, buildMigrationPrompt } = require("./prompts");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please wait before trying again." },
});
app.use("/generate", limiter);
app.use("/explain",  limiter);
app.use("/migrate",  limiter);

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("GITHUB_TOKEN is not set in .env"); process.exit(1); }
const API_URL       = "https://models.inference.ai.azure.com/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const ALLOWED_MODELS = new Set([
  "gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini",
  "o3-mini", "o4-mini",
  "meta-llama-3.3-70b-instruct", "meta-llama-3.1-405b-instruct",
  "Mistral-Large-2411", "Codestral-2501",
  "Phi-4",
  "deepseek-v3",
]);


const ALLOWED_FILE_TYPES = new Set(["tf", "yaml", "json", "sh", "arm", "cfn"]);
const MAX_INPUT_LEN = 4000;
const MAX_CODE_LEN = 8000;
const ALLOWED_MIGRATE_TARGETS = new Set(["github-actions", "jenkins"]);

function validateInput(input, fileType) {
  if (!input || typeof input !== "string" || !input.trim())
    return "input is required";
  if (input.length > MAX_INPUT_LEN)
    return `input exceeds ${MAX_INPUT_LEN} characters`;
  if (!ALLOWED_FILE_TYPES.has(fileType))
    return "fileType must be one of: tf, yaml, json, sh";
  return null;
}

function pickModel(requested) {
  return ALLOWED_MODELS.has(requested) ? requested : DEFAULT_MODEL;
}

// Models that do not support streaming on GitHub Models / Azure inference
const NON_STREAMING_MODELS = new Set(["deepseek-v3"]);

function errorMessage(err) {
  if (err.code === "ECONNABORTED") return "Request timed out";
  return err.response?.data?.error?.message || err.message || "Failed";
}


/* ── Non-streaming endpoint (Explain Code from prompt) ── */
app.post("/generate", async (req, res) => {
  const { input, fileType, explain, model } = req.body;
  const err = validateInput(input, fileType);
  if (err) return res.status(400).json({ error: err });

  const systemPrompt = buildSystemPrompt(fileType, explain);

  try {
    const response = await axios.post(
      API_URL,
      {
        model: pickModel(model),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: input }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    const raw = response.data.choices[0].message.content.trim();

    let result, explanation = null;
    if (explain) {
      const cleaned = raw.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
      const parsed  = JSON.parse(cleaned);
      result      = parsed.code.trim();
      explanation = parsed.explanation ? parsed.explanation.trim() : null;
    } else {
      result = raw.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
    }

    res.json({ result, explanation });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: errorMessage(err) });
  }
});

/* ── Streaming endpoint (Generate button) ── */
app.post("/generate/stream", async (req, res) => {
  const { input, fileType, model } = req.body;

  const streamErr = validateInput(input, fileType);
  if (streamErr) return res.status(400).json({ error: streamErr });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const selectedModel = pickModel(model);

  try {
    if (NON_STREAMING_MODELS.has(selectedModel)) {
      // Non-streaming fallback: fetch full response then emit as one SSE event
      const response = await axios.post(
        API_URL,
        {
          model: selectedModel,
          messages: [
            { role: "system", content: SYSTEM_PROMPTS[fileType] },
            { role: "user",   content: input }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json"
          },
          timeout: 60000
        }
      );
      const content = response.data.choices[0].message.content ?? "";
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      const response = await axios.post(
        API_URL,
        {
          model: selectedModel,
          messages: [
            { role: "system", content: SYSTEM_PROMPTS[fileType] },
            { role: "user",   content: input }
          ],
          stream: true
        },
        {
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json"
          },
          responseType: "stream",
          timeout: 30000
        }
      );
      response.data.pipe(res);
    }
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.write(`data: ${JSON.stringify({ error: errorMessage(err) })}\n\n`);
    res.end();
  }
});

/* ── Explain existing code ── */
app.post("/explain", async (req, res) => {
  const { code, fileType, model } = req.body;

  const explainErr = validateInput(code, fileType);
  if (explainErr) return res.status(400).json({ error: explainErr });

  const systemPrompt = buildSystemPrompt(fileType, "explain");

  try {
    const response = await axios.post(
      API_URL,
      {
        model: pickModel(model),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: code }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    const explanation = response.data.choices[0].message.content.trim();
    res.json({ explanation });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: errorMessage(err) });
  }
});

/* ── Migrate pipeline (ADO YAML → GitHub Actions or Jenkins) ── */
app.post("/migrate", async (req, res) => {
  const { code, targetPlatform, model } = req.body;

  if (!code || typeof code !== "string" || !code.trim())
    return res.status(400).json({ error: "code is required" });
  if (code.length > MAX_CODE_LEN)
    return res.status(400).json({ error: `code exceeds ${MAX_CODE_LEN} characters` });
  if (!ALLOWED_MIGRATE_TARGETS.has(targetPlatform))
    return res.status(400).json({ error: "targetPlatform must be github-actions or jenkins" });

  const systemPrompt = buildMigrationPrompt(targetPlatform);

  try {
    const response = await axios.post(
      API_URL,
      {
        model: pickModel(model),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: code }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 60000
      }
    );

    let result = response.data.choices[0].message.content.trim();
    result = result.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/, "").trim();
    res.json({ result, targetPlatform });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: errorMessage(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
