require("dotenv").config();
const express   = require("express");
const axios     = require("axios");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
const { SYSTEM_PROMPTS, buildSystemPrompt, buildCICDGenerationPrompt, buildCICDMigrationPrompt, buildMigrationPrompt } = require("./prompts");

const app = express();
app.use(express.json());
app.use(cors());

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
app.use("/cicd",     limiter);

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

const ALLOWED_FILE_TYPES      = new Set(["tf", "yaml", "json", "sh", "arm", "cfn"]);
const ALLOWED_MIGRATE_TARGETS = new Set(["github-actions", "jenkins"]);
const ALLOWED_CICD_PLATFORMS  = new Set(["github-actions", "azure-devops", "gitlab-ci", "jenkins"]);
const MAX_INPUT_LEN = 4000;
const MAX_CODE_LEN  = 8000;

function validateInput(input, fileType) {
  if (!input || typeof input !== "string" || !input.trim())
    return "input is required";
  if (input.length > MAX_INPUT_LEN)
    return `input exceeds ${MAX_INPUT_LEN} characters`;
  if (!ALLOWED_FILE_TYPES.has(fileType))
    return "fileType must be one of: tf, yaml, json, sh, arm, cfn";
  return null;
}

function pickModel(requested) {
  return ALLOWED_MODELS.has(requested) ? requested : DEFAULT_MODEL;
}

const NON_STREAMING_MODELS = new Set(["deepseek-v3"]);

function errorMessage(err) {
  if (err.code === "ECONNABORTED") return "Request timed out";
  return err.response?.data?.error?.message || err.message || "Failed";
}


/* ── IaC: Non-streaming generate (with optional explanation) ── */
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
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
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


/* ── IaC: Streaming generate ── */
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
      const response = await axios.post(
        API_URL,
        {
          model: selectedModel,
          messages: [
            { role: "system", content: SYSTEM_PROMPTS[fileType] },
            { role: "user",   content: input }
          ]
        },
        { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, timeout: 60000 }
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
        { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, responseType: "stream", timeout: 30000 }
      );
      response.data.pipe(res);
    }
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.write(`data: ${JSON.stringify({ error: errorMessage(err) })}\n\n`);
    res.end();
  }
});


/* ── IaC: Explain existing code ── */
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
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, timeout: 30000 }
    );

    const explanation = response.data.choices[0].message.content.trim();
    res.json({ explanation });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: errorMessage(err) });
  }
});


/* ── IaC: Migrate YAML pipeline (legacy — ADO→GitHub Actions or Jenkins) ── */
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
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, timeout: 60000 }
    );

    let result = response.data.choices[0].message.content.trim();
    result = result.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/, "").trim();
    res.json({ result, targetPlatform });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: errorMessage(err) });
  }
});


/* ── CI/CD: Generate pipeline (streaming) ── */
app.post("/cicd/generate", async (req, res) => {
  const { prompt, platform, model } = req.body;

  if (!prompt || typeof prompt !== "string" || !prompt.trim())
    return res.status(400).json({ error: "prompt is required" });
  if (prompt.length > MAX_INPUT_LEN)
    return res.status(400).json({ error: `prompt exceeds ${MAX_INPUT_LEN} characters` });
  if (!ALLOWED_CICD_PLATFORMS.has(platform))
    return res.status(400).json({ error: "platform must be one of: github-actions, azure-devops, gitlab-ci, jenkins" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const selectedModel  = pickModel(model);
  const systemPrompt   = buildCICDGenerationPrompt(platform);

  try {
    if (NON_STREAMING_MODELS.has(selectedModel)) {
      const response = await axios.post(
        API_URL,
        { model: selectedModel, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }] },
        { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, timeout: 60000 }
      );
      const content = response.data.choices[0].message.content ?? "";
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      const response = await axios.post(
        API_URL,
        { model: selectedModel, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], stream: true },
        { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, responseType: "stream", timeout: 30000 }
      );
      response.data.pipe(res);
    }
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.write(`data: ${JSON.stringify({ error: errorMessage(err) })}\n\n`);
    res.end();
  }
});


/* ── CI/CD: Migrate pipeline between tools ── */
app.post("/cicd/migrate", async (req, res) => {
  const { code, sourcePlatform, targetPlatform, model } = req.body;

  if (!code || typeof code !== "string" || !code.trim())
    return res.status(400).json({ error: "code is required" });
  if (code.length > MAX_CODE_LEN)
    return res.status(400).json({ error: `code exceeds ${MAX_CODE_LEN} characters` });
  if (!ALLOWED_CICD_PLATFORMS.has(targetPlatform))
    return res.status(400).json({ error: "targetPlatform must be one of: github-actions, azure-devops, gitlab-ci, jenkins" });

  const source       = ALLOWED_CICD_PLATFORMS.has(sourcePlatform) ? sourcePlatform : "auto";
  const systemPrompt = buildCICDMigrationPrompt(source, targetPlatform);

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
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, timeout: 60000 }
    );

    let result = response.data.choices[0].message.content.trim();
    result = result.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/, "").trim();
    res.json({ result, targetPlatform });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: errorMessage(err) });
  }
});


app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
