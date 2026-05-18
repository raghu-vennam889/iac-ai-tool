# IaC AI Tool — High Level Design (HLD)

---

## 1. Overview

**IaC AI Tool** is a browser-based, single-page application that uses large language models (LLMs) to generate, explain, and migrate Infrastructure-as-Code (IaC) files. A user describes what infrastructure they need in plain English; the tool returns production-ready Terraform, YAML, JSON, or Shell Script output in real time.

---

## 2. Goals

| Goal | Description |
|------|-------------|
| Code generation | Produce production-ready IaC from a natural-language prompt |
| Code explanation | Explain any generated code in structured, readable prose |
| Pipeline migration | Convert Azure DevOps YAML pipelines to GitHub Actions or Jenkins |
| Multi-model support | Allow the user to pick from 12 models across 5 AI providers |
| Multi-format support | Generate Terraform, YAML, JSON, Shell Script, ARM Templates, and CloudFormation |
| Zero build tooling | Run with a single `node server.js` — no webpack, no bundler |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (Client)                     │
│                                                          │
│   index.html  ──  Vanilla JS  ──  Inline CSS             │
│       │                                                  │
│   Fetch API (SSE streaming + JSON requests)              │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTP  (localhost:3000)
┌───────────────────────▼─────────────────────────────────┐
│               Node.js / Express  (server.js)             │
│                                                          │
│   POST /generate/stream  ── streaming proxy (SSE)        │
│   POST /generate         ── non-streaming (code+explain) │
│   POST /explain          ── explain existing code        │
│   POST /migrate          ── pipeline migration           │
│                                                          │
│   Rate limiter: 30 req / 15 min per IP                   │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTPS (Bearer: GITHUB_TOKEN)
┌───────────────────────▼─────────────────────────────────┐
│     GitHub Models / Azure AI Inference Endpoint          │
│   https://models.inference.ai.azure.com/chat/completions │
│                                                          │
│   OpenAI, Meta Llama, Mistral, Microsoft Phi, DeepSeek  │
└─────────────────────────────────────────────────────────┘
```

**Communication pattern:**
- Generate → streaming (Server-Sent Events via `ReadableStream`)
- Explain Code (fresh) → single HTTP POST, JSON response with two keys
- Explain Code (existing) → single HTTP POST, JSON response
- Migrate → single HTTP POST, JSON response

---

## 4. Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | LTS |
| Web framework | Express | 5.2.1 |
| HTTP client (server) | Axios | 1.16.0 |
| CORS middleware | cors | 2.8.6 |
| Rate limiting | express-rate-limit | 8.5.1 |
| Env config | dotenv | 17.4.2 |
| Frontend | Vanilla HTML/CSS/JS | — |
| Syntax highlighting | highlight.js (CDN) | 11.9.0 |
| Line numbers | highlightjs-line-numbers (CDN) | 2.8.0 |
| Markdown rendering | marked (CDN) | 9.x |
| AI backend | GitHub Models / Azure AI Inference | — |

---

## 5. Key Features

### 5.1 Code Generation (Streaming)
The primary flow. The user writes a prompt, selects a file type and model, and clicks **Generate** (or presses `Ctrl+Enter`). Tokens stream to the browser in real time via Server-Sent Events, appearing character-by-character in the output panel. On completion, the code is syntax-highlighted with line numbers.

Six file types are supported:

| File Type | Value | Output | Description |
|-----------|-------|--------|-------------|
| Terraform | `tf` | `.tf` | HCL-syntax Terraform modules |
| YAML | `yaml` | `.yaml` | Pipeline configs, Kubernetes manifests, Ansible playbooks |
| JSON | `json` | `.json` | Generic JSON configuration |
| Shell Script | `sh` | `.sh` | Bash scripts with `#!/bin/bash` |
| ARM Template | `arm` | `.json` | Azure Resource Manager JSON templates |
| CloudFormation | `cfn` | `.yaml` | AWS CloudFormation YAML templates |

### 5.2 Explain Code
Two sub-modes:
- **No existing code** — a single API call returns both code and a Markdown explanation simultaneously.
- **Existing code** — the current code in the output panel is sent to a dedicated `/explain` endpoint and the explanation is rendered in the Explanation tab.

### 5.3 Pipeline Migration
Available only when the current file type is YAML. A second select allows the user to choose the target platform (GitHub Actions or Jenkins). The migration runs as a separate API call and renders in the Migration tab.

### 5.4 Multi-Model Selection
13 models from 5 providers are available via a grouped `<select>`. All route through the same Azure AI Inference endpoint using the `GITHUB_TOKEN` credential. DeepSeek-V3 uses the non-streaming path because it does not support SSE on this endpoint.

### 5.5 Session History
Up to 10 recent generations are stored in `localStorage` under the key `iac-gen-history`. Each entry stores the prompt, file type, code, explanation (if generated), and timestamp. The history panel is collapsible, supports click-to-restore, and timestamps refresh every 30 seconds.

### 5.6 In-Place Code Editing
The output code can be edited directly in the browser. An **Edit** button swaps the syntax-highlighted `<pre>` for a raw `<textarea>`. **Done** re-highlights the edited content and persists it back to the history entry.

### 5.7 Auto File-Type Detection
As the user types in the prompt textarea, a debounced (300 ms) regex engine scans the text and automatically switches the file type selector to the best match. A glow animation and "auto" badge confirm the switch visually.

Detection rules (evaluated in priority order, first match wins):

| Priority | Type | Trigger keywords |
|----------|------|-----------------|
| 1 | `tf` | terraform, tf, hcl, iac, infrastructure as code |
| 2 | `arm` | arm template, azure resource manager, azure arm, arm |
| 3 | `cfn` | cloudformation, cfn, cloud formation, aws template/stack/resource |
| 4 | `yaml` | yaml, pipeline, github actions, ci/cd, kubernetes, helm, ansible, … |
| 5 | `json` | json, package.json, appsettings |
| 6 | `sh` | shell script, bash script, bash, shell, script, zsh |

### 5.8 Download and Copy
- **Copy** copies the active tab's content to the clipboard and shows a toast.
- **Download** saves the active tab's content as a file with the correct extension (`.tf`, `.yaml`, `.json`, `.sh`, `.yml`, `.groovy`).

---

## 6. Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Token exposure | `GITHUB_TOKEN` lives in `.env`, listed in `.gitignore`, never sent to the browser |
| Model injection | `ALLOWED_MODELS` allowlist on the server rejects unknown model IDs |
| File type injection | `ALLOWED_FILE_TYPES` set rejects anything outside `tf`, `yaml`, `json`, `sh`, `arm`, `cfn` |
| Input length abuse | `MAX_INPUT_LEN = 4000` and `MAX_CODE_LEN = 8000` enforced server-side |
| Request flooding | Rate limiter: 30 requests per 15-minute window per IP |
| Migration target injection | `ALLOWED_MIGRATE_TARGETS` rejects anything outside `github-actions`, `jenkins` |
| XSS in history | All user-supplied text passed through `escHtml()` before DOM insertion |

---

## 7. Data Flow — Primary Generate Path

```
User types prompt
       │
       ▼
300ms debounce → detectAndApplyFileType()   [auto file-type switch]
       │
User clicks Generate (or Ctrl+Enter)
       │
       ▼
generate() [client]
  ├── setBusy(true)          disable all buttons
  ├── showExplainSkeleton()  explanation tab shows shimmer
  ├── clear code panel       show raw token stream immediately
  └── fetch POST /generate/stream
             │
             ▼
      server.js /generate/stream
        ├── validateInput()
        ├── pickModel()
        └── axios POST → Azure AI Inference (stream: true)
                   │ SSE chunks
                   ▼
             pipe back to browser via res.write()
                   │
             ▼ (browser ReadableStream reader)
        delta tokens → append to <code> element live
                   │
             ▼ (on [DONE])
        renderCode(fullCode, fileType)
          ├── hljs.highlightElement()
          ├── hljs.lineNumbersBlock()
          ├── pushHistory()
          └── updateDownloadBtn()  enable Download
       │
       ▼
setBusy(false) + success toast
```

---

## 8. Deployment

### Local (development)
```bash
# 1. Clone the repository
git clone <repo-url>
cd iac-ai-tool

# 2. Install dependencies
npm install

# 3. Create .env with your GitHub PAT (Models scope required)
echo "GITHUB_TOKEN=ghp_xxxxxxxxxxxx" > .env

# 4. Start the server
npm start
# → Running on http://localhost:3000
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token with Models scope |

### Port
The server listens on **port 3000** (hardcoded). The frontend has `API_BASE = 'http://localhost:3000'` hardcoded and must be updated for any non-local deployment.

---

## 9. Limitations

- **Local only** — `API_BASE` is hardcoded to `localhost:3000`; production deployment requires changing this constant.
- **No authentication** — any user on the local network who can reach port 3000 can use the tool.
- **No persistent storage** — history is browser-local (`localStorage`); clearing browser data loses history.
- **No retry logic** — failed requests surface a toast; the user must retry manually.
- **DeepSeek non-streaming** — DeepSeek-V3 does not support SSE on this endpoint so it falls back to the blocking `/generate` path.

---

## 10. File Structure

```
iac-ai-tool/
├── index.html        Single-page frontend (HTML + CSS + JS, ~1485 lines)
├── server.js         Express API server (~259 lines)
├── prompts.js        System prompt definitions and builders (~69 lines)
├── package.json      Node.js project manifest
├── package-lock.json Lockfile (40 transitive dependencies)
├── .env              GITHUB_TOKEN (git-ignored)
├── .gitignore        Excludes node_modules/ and .env
└── docs/
    ├── HLD.md        This document
    └── LLD.md        Low-level design document
```
