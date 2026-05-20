# IaC & CI/CD AI Tool — High Level Design (HLD)

---

## 1. Overview

**IaC & CI/CD AI Tool** is a browser-based, single-page application that uses large language models (LLMs) to generate, explain, and migrate Infrastructure-as-Code (IaC) files **and** CI/CD pipeline configurations. Users write prompts in plain English; the tool returns production-ready code in real time via two distinct modes:

- **IaC Generator** — Terraform, YAML, Shell Script, ARM Templates, CloudFormation
- **CI/CD Generator** — Azure DevOps, GitHub Actions, GitLab CI, Jenkins pipelines (generate + migrate)

---

## 2. Goals

| Goal | Description |
|------|-------------|
| IaC code generation | Produce production-ready IaC from a natural-language prompt (streaming) |
| IaC code explanation | Explain any generated code in structured, readable prose |
| CI/CD pipeline generation | Generate pipelines for Azure DevOps, GitHub Actions, GitLab CI, and Jenkins |
| CI/CD pipeline migration | Convert any pipeline format to any other (4 × 4 platform matrix) |
| Pipeline file upload | Drag-and-drop or paste a pipeline file; auto-detect its source platform |
| Multi-model support | Allow the user to pick from 12 models across 5 AI providers |
| Multi-format IaC | Generate Terraform, YAML, Shell Script, ARM Templates, and CloudFormation |
| Session history | Separate persistent history panels for IaC and CI/CD outputs |
| Zero build tooling | Run with a single `node server.js` — no webpack, no bundler |
| Cloud deployment | Deploy to Azure App Service (Windows) via IIS + iisnode |

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
                        │ HTTP  (localhost:3000 or Azure)
┌───────────────────────▼─────────────────────────────────┐
│   IIS + iisnode (Azure App Service Windows)  [optional]  │
│   web.config routes all requests → server.js             │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│               Node.js / Express  (server.js)             │
│                                                          │
│   POST /generate/stream  ── streaming proxy (SSE)        │
│   POST /generate         ── non-streaming (code+explain) │
│   POST /explain          ── explain existing code        │
│   POST /migrate          ── legacy ADO→GHA/Jenkins       │
│   POST /cicd/generate    ── CI/CD pipeline (SSE)         │
│   POST /cicd/migrate     ── pipeline format conversion   │
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
- IaC Generate → streaming (Server-Sent Events via `ReadableStream`)
- IaC Explain Code (fresh) → single HTTP POST, JSON response with two keys
- IaC Explain Code (existing) → single HTTP POST, JSON response
- IaC Migrate / CI/CD Migrate → single HTTP POST, JSON response
- CI/CD Generate → streaming (Server-Sent Events)

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
| IIS adapter (Azure) | iisnode | — |

---

## 5. Key Features

### 5.1 Dual-Mode UI

The UI is split into two top-level modes switched via a navigation bar:

- **IaC Generator** — generates, explains, and edits IaC files
- **CI/CD Generator** — generates and migrates CI/CD pipeline files

Each mode has its own left input panel, output panel, and history section. Switching modes resets the output area.

### 5.2 IaC Code Generation (Streaming)

The primary IaC flow. Tokens stream to the browser in real time via Server-Sent Events. On completion, the code is syntax-highlighted with line numbers.

Five file types are supported:

| File Type | Value | Output | Description |
|-----------|-------|--------|-------------|
| Terraform | `tf` | `.tf` | HCL-syntax Terraform modules |
| YAML | `yaml` | `.yaml` | Kubernetes manifests, Ansible playbooks |
| Shell Script | `sh` | `.sh` | Bash scripts with `#!/bin/bash` |
| ARM Template | `arm` | `.json` | Azure Resource Manager JSON templates |
| CloudFormation | `cfn` | `.yaml` | AWS CloudFormation YAML templates |

> JSON was removed as a standalone file type; ARM Template covers JSON-based Azure resource definitions.

### 5.3 IaC Explain Code

Two sub-modes:
- **No existing code** — a single API call returns both code and a Markdown explanation simultaneously.
- **Existing code** — the current code in the output panel is sent to a dedicated `/explain` endpoint.

### 5.4 IaC Multi-Model Selection

12 models from 5 providers available via a grouped `<select>`. DeepSeek-V3 uses the non-streaming path because it does not support SSE on this endpoint.

### 5.5 IaC Session History

Up to 10 recent generations stored in `localStorage` under `iac-gen-history`. Each entry stores prompt, file type, code, explanation (if any), and timestamp. Collapsible, click-to-restore, timestamps refresh every 30 seconds.

### 5.6 IaC In-Place Code Editing

The output code can be edited directly in the browser. **Edit** swaps the highlighted view for a raw `<textarea>`; **Done** re-highlights and persists the edit back to the history entry.

### 5.7 IaC Auto File-Type Detection

As the user types, a debounced (300 ms) regex engine auto-switches the file type selector. A glow animation and "auto" badge confirm the switch.

Detection rules (priority order):

| Priority | Type | Trigger keywords |
|----------|------|-----------------|
| 1 | `tf` | terraform, tf, hcl, iac, infrastructure as code |
| 2 | `arm` | arm template, azure resource manager, azure arm, arm |
| 3 | `cfn` | cloudformation, cfn, cloud formation, aws template/stack/resource |
| 4 | `yaml` | yaml, pipeline, github actions, ci/cd, kubernetes, helm, ansible, … |
| 5 | `sh` | shell script, bash script, bash, shell, script, zsh |

### 5.8 CI/CD Pipeline Generation (Streaming)

Users describe the pipeline in plain English; the tool generates a production-ready pipeline YAML or Jenkinsfile via streaming SSE. Four target platforms are supported:

| Platform | Output format |
|----------|--------------|
| Azure DevOps | `azure-pipelines.yml` |
| GitHub Actions | `.github/workflows/pipeline.yml` |
| GitLab CI | `.gitlab-ci.yml` |
| Jenkins | `Jenkinsfile` (Declarative Pipeline) |

Each platform has a dedicated system prompt with idiomatic syntax rules and built-in task recommendations.

### 5.9 CI/CD Pipeline Migration

Users upload or paste an existing pipeline; the tool converts it to any of the four supported platforms.

**Source detection:** Client-side regex analysis identifies the source platform in real time as the user types or uploads, displaying an inline colour-coded badge:

| Platform | Detection signals |
|----------|-----------------|
| Jenkins | `pipeline {` block |
| GitHub Actions | Top-level `on:` + `jobs:` |
| Azure DevOps | Top-level `trigger:` + `pool:` |
| GitLab CI | Top-level `stages:` + `script:` without `jobs:` |

If detection is inconclusive, source defaults to `"auto"` and the model auto-detects from the content.

**File upload:** Drag-and-drop or click-to-browse accepts `.yaml`, `.yml`, `.groovy`, `Jenkinsfile`, `.json`, `.txt`. The file content is loaded into the paste textarea and detection runs immediately.

### 5.10 CI/CD Session History

Separate from IaC history. Up to 10 entries stored under `cicd-gen-history`. Each entry records the prompt/source snippet, target platform, type (generate vs migrate), result, and timestamp. Platform badges (ADO / GHA / GL CI / JENKINS) and a MIG indicator for migrations.

### 5.11 Download and Copy

- **Copy** copies the active output to the clipboard.
- **Download** saves with the correct extension (`.tf`, `.yaml`, `.yml`, `.sh`, `.json`, `.groovy`).

---

## 6. Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Token exposure | `GITHUB_TOKEN` lives in `.env`, git-ignored, never sent to the browser |
| Model injection | `ALLOWED_MODELS` allowlist on the server rejects unknown model IDs |
| IaC file type injection | `ALLOWED_FILE_TYPES` set: `tf`, `yaml`, `sh`, `arm`, `cfn` |
| CI/CD platform injection | `ALLOWED_CICD_PLATFORMS` set: `github-actions`, `azure-devops`, `gitlab-ci`, `jenkins` |
| Input length abuse | `MAX_INPUT_LEN = 4000` and `MAX_CODE_LEN = 8000` enforced server-side |
| Request flooding | Rate limiter: 30 requests per 15-minute window per IP (applied to all AI routes) |
| XSS in history | All user-supplied text passed through `escHtml()` before DOM insertion |

---

## 7. Data Flow — IaC Generate Path

```
User types prompt
       │
       ▼
300ms debounce → detectAndApplyFileType()
       │
User clicks Generate (or Ctrl+Enter)
       │
       ▼
generate() [client]
  ├── setBusy(true)
  ├── clearExplanation()
  └── fetch POST /generate/stream
             │
             ▼
      server.js /generate/stream
        ├── validateInput()
        ├── pickModel()
        └── axios POST → Azure AI Inference (stream: true)
                   │ SSE chunks
                   ▼
             pipe back to browser
                   │ delta tokens → append to <code> element live
                   │
             ▼ (on [DONE])
        renderCode(fullCode, fileType)
          ├── hljs.highlightElement()
          ├── hljs.lineNumbersBlock()
          └── pushHistory()
```

## 8. Data Flow — CI/CD Generate Path

```
User describes pipeline + selects platform
       │
User clicks Generate Pipeline
       │
       ▼
cicdGenerate() [client]
  └── fetch POST /cicd/generate (SSE)
             │
             ▼
      server.js /cicd/generate
        ├── validates prompt, platform in ALLOWED_CICD_PLATFORMS
        ├── buildCICDGenerationPrompt(platform)
        └── axios POST → Azure AI Inference (stream: true)
                   │ SSE tokens
                   ▼
             pipe back to browser
                   │ live token append
                   ▼
        cicdRenderCode(fullCode, platform)
          └── pushCicdHistory()
```

## 9. Data Flow — CI/CD Migrate Path

```
User uploads / pastes pipeline code
       │
       ▼
updateDetectBadge() → detectPipelineType() [client-side regex]
  Shows colour-coded badge (Jenkins / GHA / ADO / GL CI / Unknown)
       │
User selects target platform + clicks Migrate Pipeline
       │
       ▼
cicdMigrate() [client]
  └── fetch POST /cicd/migrate
             │
             ▼
      server.js /cicd/migrate
        ├── validates code, targetPlatform
        ├── sourcePlatform = detected || 'auto'
        ├── buildCICDMigrationPrompt(source, target)
        └── axios POST → Azure AI Inference (non-streaming)
                   │ full response
                   ▼
        strip markdown fences
        res.json({ result, targetPlatform })
                   │
                   ▼
        cicdRenderCode(result, targetPlatform)
          └── pushCicdHistory()
```

---

## 10. Deployment

### Local (development)
```bash
git clone <repo-url>
cd iac-ai-tool
npm install
echo "GITHUB_TOKEN=ghp_xxxxxxxxxxxx" > .env
npm start
# → Running on http://localhost:3000
```

### Azure App Service (Windows)

The tool is deployable to Azure App Service (Windows) using the iisnode module. IIS acts as a reverse proxy, forwarding all HTTP requests to the Node.js process via `web.config`.

**Required files:**
- `web.config` — configures iisnode handler and URL rewrite rules
- `GITHUB_TOKEN` — set as an Application Setting (Environment Variable) in the Azure portal

**`web.config` key rules:**
1. Register `iisnode` handler for `server.js`
2. URL rewrite: all requests → `server.js`
3. `httpErrors existingResponse="PassThrough"` — lets Express send its own error responses

**Dynamic port:** The server reads `process.env.PORT || 3000`. Azure App Service injects the correct IPC port via `process.env.PORT`; the application does not need a hardcoded port.

**Dynamic API_BASE:** The frontend sets `API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3000' : ''`. In production, API calls use relative URLs, which are resolved by the same IIS/iisnode host.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token with Models scope |
| `PORT` | No (injected by Azure) | Server port; defaults to 3000 locally |

---

## 11. Limitations

- **No authentication** — any user who can reach the server can use the tool and consume the GitHub token quota.
- **No persistent storage** — history is browser-local (`localStorage`); clearing browser data loses history.
- **No retry logic** — failed requests surface a toast; the user must retry manually.
- **DeepSeek non-streaming** — DeepSeek-V3 does not support SSE on this endpoint; it falls back to the blocking path.
- **CI/CD migration non-streaming** — the `/cicd/migrate` endpoint is non-streaming (full response); output appears all at once.

---

## 12. File Structure

```
iac-ai-tool/
├── index.html        Single-page frontend (HTML + CSS + JS)
├── server.js         Express API server
├── prompts.js        System prompt definitions and builders
├── package.json      Node.js project manifest
├── package-lock.json Lockfile
├── web.config        IIS + iisnode configuration (Azure App Service)
├── .env              GITHUB_TOKEN (git-ignored)
├── .gitignore        Excludes node_modules/ and .env
└── docs/
    ├── HLD.md        This document
    ├── LLD.md        Low-level design document
    └── PROCESS.md    User-facing process and workflow guide
```
