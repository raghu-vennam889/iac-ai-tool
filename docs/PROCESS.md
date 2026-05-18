# IaC AI Tool — Process Document

---

## Table of Contents

1. [Purpose and Scope](#1-purpose-and-scope)
2. [Prerequisites](#2-prerequisites)
3. [Installation and Setup](#3-installation-and-setup)
4. [Starting and Stopping the Tool](#4-starting-and-stopping-the-tool)
5. [Using the Tool — Step-by-Step Workflows](#5-using-the-tool--step-by-step-workflows)
   - 5.1 [Generate IaC Code](#51-generate-iac-code)
   - 5.2 [Generate Code with Explanation](#52-generate-code-with-explanation)
   - 5.3 [Explain Existing Code](#53-explain-existing-code)
   - 5.4 [Migrate a Pipeline](#54-migrate-a-pipeline)
   - 5.5 [Edit Generated Code In-Browser](#55-edit-generated-code-in-browser)
   - 5.6 [Download or Copy Output](#56-download-or-copy-output)
   - 5.7 [Restore a Previous Generation](#57-restore-a-previous-generation)
   - 5.8 [Clear History](#58-clear-history)
6. [Choosing a Model](#6-choosing-a-model)
7. [Keyboard Shortcuts](#7-keyboard-shortcuts)
8. [Auto File-Type Detection](#8-auto-file-type-detection)
9. [Rate Limits and Quotas](#9-rate-limits-and-quotas)
10. [Error Reference](#10-error-reference)
11. [Troubleshooting](#11-troubleshooting)
12. [Security Guidelines](#12-security-guidelines)

---

## 1. Purpose and Scope

The **IaC AI Tool** is a local, browser-based application that generates, explains, and migrates Infrastructure-as-Code (IaC) files using large language models (LLMs). Users write prompts in plain English; the tool returns production-ready Terraform, YAML, JSON, or Shell Script output in real time.

**In scope:**
- Generating new IaC files from a text description
- Getting a Markdown explanation alongside generated code
- Explaining code that already exists in the output panel
- Migrating Azure DevOps YAML pipelines to GitHub Actions or Jenkins

**Out of scope:**
- Applying generated code directly to any cloud account
- Storing files server-side
- Multi-user or authenticated access

---

## 2. Prerequisites

| Requirement | Details |
|-------------|---------|
| **Node.js** | LTS version (18.x or later recommended) |
| **npm** | Bundled with Node.js |
| **GitHub Personal Access Token (PAT)** | Must have the **Models** scope enabled |
| **Internet access** | Required for AI model calls to `models.inference.ai.azure.com` |
| **Modern browser** | Chrome, Edge, Firefox, or Safari (must support `ReadableStream` and `EventSource`) |

### Obtaining a GitHub Token

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens** (or classic tokens).
2. Click **Generate new token**.
3. Under **Permissions**, enable **Models** (read access).
4. Copy the token immediately — it will not be shown again.

---

## 3. Installation and Setup

```bash
# 1. Clone or download the repository
git clone <repo-url>
cd iac-ai-tool

# 2. Install Node.js dependencies
npm install

# 3. Create the environment file
echo "GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx" > .env
```

> **Important:** Never commit `.env` to version control. It is already listed in `.gitignore`.

### Verify the setup

```
iac-ai-tool/
├── index.html        ← Frontend (single page)
├── server.js         ← Express API server
├── prompts.js        ← System prompt definitions
├── package.json
├── .env              ← Your GITHUB_TOKEN (git-ignored)
└── node_modules/     ← Created by npm install
```

---

## 4. Starting and Stopping the Tool

### Start

```bash
npm start
# Output: Running on 3000
```

Open a browser and navigate to `http://localhost:3000`.

### Stop

Press `Ctrl + C` in the terminal where the server is running.

### Restart (after changing `.env`)

```bash
# Stop with Ctrl+C, then:
npm start
```

---

## 5. Using the Tool — Step-by-Step Workflows

### 5.1 Generate IaC Code

This is the primary workflow. Tokens stream to the browser character-by-character as the model generates them.

1. **Write a prompt** in the large text area (e.g., *"Create a Terraform module for an AWS S3 bucket with versioning and lifecycle rules"*).
2. **Select a file type** from the **File Type** dropdown:
   - `Terraform (.tf)`
   - `YAML (.yaml)`
   - `JSON (.json)`
   - `Shell Script (.sh)`
   > The file type may switch automatically as you type — see [Section 8](#8-auto-file-type-detection).
3. **Select a model** from the **Model** dropdown (optional; defaults to `gpt-4o-mini`).
4. Click **Generate** or press **Ctrl + Enter**.
5. Watch tokens appear in the **Code** tab in real time.
6. When complete, the code is syntax-highlighted with line numbers and a **Download** button becomes active.

---

### 5.2 Generate Code with Explanation

Use this when you want the model to produce both the code **and** a structured Markdown explanation in a single call.

1. Complete steps 1–3 from [Section 5.1](#51-generate-iac-code).
2. Click **Explain Code** (not **Generate**).
3. The tool calls `/generate` (non-streaming) with `explain: true`.
4. The **Explanation** tab automatically becomes active and shows a shimmer skeleton while waiting.
5. When the response arrives:
   - The **Code** tab displays syntax-highlighted code.
   - The **Explanation** tab displays the Markdown-rendered explanation with section headers, bullet points, and readable prose.

---

### 5.3 Explain Existing Code

Use this when code is already in the **Code** tab and you want an explanation without regenerating it.

**Precondition:** The Code tab must contain code (generated or manually pasted via the Edit flow).

1. Ensure the **Code** tab has content.
2. Click **Explain Code**.
3. The tool detects existing code and calls `/explain` with the current code and file type.
4. The **Explanation** tab switches to active and shows a shimmer skeleton.
5. When complete, the Markdown explanation is rendered in the Explanation tab.

---

### 5.4 Migrate a Pipeline

**Precondition:** The **File Type** must be set to `YAML (.yaml)`.

1. Generate or paste an Azure DevOps YAML pipeline into the Code tab.
2. Ensure **File Type** is `YAML`.
3. A **Migrate to** dropdown appears — select either:
   - `GitHub Actions`
   - `Jenkins`
4. Click **Migrate Pipeline**.
5. The tool calls `/migrate`. A loading skeleton appears in the **Migration** tab.
6. When complete, the Migration tab becomes active and displays the converted pipeline YAML (or Jenkinsfile).

> **Note:** The Migration tab and **Migrate Pipeline** button are hidden when the file type is not YAML.

---

### 5.5 Edit Generated Code In-Browser

1. After code has been generated, click the **Edit** button in the output panel toolbar.
2. The syntax-highlighted view is replaced by an editable `<textarea>` containing the raw code.
3. Make any changes directly in the textarea.
4. Click **Done** to re-apply syntax highlighting and save the edits back to the current history entry.

> **Note:** Edits are persisted to `localStorage` and will be restored if you click the history entry again.

---

### 5.6 Download or Copy Output

#### Copy

1. Switch to the tab whose content you want (**Code**, **Explanation**, or **Migration**).
2. Click **Copy**.
3. A toast notification confirms the content was copied to the clipboard.

#### Download

1. Ensure the **Code** tab has content (the Download button is disabled when empty).
2. Click **Download**.
3. The active tab's content is saved as a file with the correct extension:

| File Type | Extension |
|-----------|-----------|
| Terraform | `.tf` |
| YAML | `.yaml` |
| JSON | `.json` |
| Shell Script | `.sh` |
| Migrated GitHub Actions | `.yml` |
| Migrated Jenkins | `.groovy` |

---

### 5.7 Restore a Previous Generation

The tool automatically saves up to **10 recent generations** in browser `localStorage`.

1. Click **History** in the top-right to expand the history panel.
2. Each entry shows:
   - A colored file-type badge (`TF`, `YAML`, `JSON`, `SH`)
   - The timestamp (e.g., *2 min ago*, refreshed every 30 seconds)
   - The first ~40 characters of the prompt in bold, with the remainder in a lighter weight
3. Click any entry to restore:
   - The prompt text is populated in the input area.
   - The code is rendered in the Code tab.
   - The explanation (if any) is rendered in the Explanation tab.
   - The file type selector is updated to match.

---

### 5.8 Clear History

1. Expand the **History** panel.
2. Click **Clear History** (displayed at the bottom of the panel when entries exist).
3. All entries are removed from `localStorage` and the panel is cleared.

> **Warning:** This action is irreversible. Cleared history cannot be recovered.

---

## 6. Choosing a Model

Use the **Model** dropdown to select from 11 available models across 5 providers. All models route through the same Azure AI Inference endpoint using the `GITHUB_TOKEN` credential.

| Provider | Model | Strengths | Streaming |
|----------|-------|-----------|-----------|
| **OpenAI** | `gpt-4o-mini` *(default)* | Fast, cost-effective, reliable | Yes |
| **OpenAI** | `gpt-4o` | Higher quality, better reasoning | Yes |
| **OpenAI** | `gpt-4.1` | Latest GPT-4 generation | Yes |
| **OpenAI** | `gpt-4.1-mini` | Balanced speed and quality | Yes |
| **OpenAI** | `o3-mini` | Strong reasoning, multi-step logic | Yes |
| **OpenAI** | `o4-mini` | Latest reasoning model | Yes |
| **Meta** | `meta-llama-3.3-70b-instruct` | Open-weight, strong instruction following | Yes |
| **Meta** | `meta-llama-3.1-405b-instruct` | Largest open-weight Meta model | Yes |
| **Mistral** | `Mistral-Large-2411` | Strong at structured output | Yes |
| **Mistral** | `Codestral-2501` | Optimised for code generation | Yes |
| **Microsoft** | `Phi-4` | Compact, efficient | Yes |
| **DeepSeek** | `deepseek-v3` | Strong code generation | No (blocking fallback) |

> **DeepSeek note:** DeepSeek-V3 does not support Server-Sent Events on this endpoint. The server automatically fetches the full response and sends it as a single batch, so output appears all at once rather than streaming character-by-character.

**General guidance:**
- Use `gpt-4o-mini` for fast iteration and everyday tasks.
- Use `gpt-4o` or `gpt-4.1` when output quality matters most.
- Use `Codestral-2501` for code-heavy tasks such as complex shell scripts or Terraform modules.
- Use `o3-mini` or `o4-mini` for multi-step reasoning (e.g., complex Kubernetes manifests with multiple interdependent resources).

---

## 7. Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + Enter` | Generate (same as clicking the Generate button) |
| `Tab` / `Shift+Tab` | Navigate between Code / Explanation / Migration tabs |
| `Enter` / `Space` | Activate the focused tab |

---

## 8. Auto File-Type Detection

As you type in the prompt textarea, the tool runs a debounced (300 ms) keyword scan and automatically switches the **File Type** selector when a strong signal is found.

| Keywords detected | File type selected |
|-------------------|--------------------|
| `terraform`, `tf`, `hcl`, `iac`, `infrastructure as code` | Terraform (`.tf`) |
| `yaml`, `pipeline`, `github actions`, `ci/cd`, `gitlab ci`, `azure devops`, `ansible`, `kubernetes`, `k8s`, `helm`, `docker compose`, `workflow`, `jenkinsfile`, `jenkins` | YAML (`.yaml`) |
| `json`, `package.json`, `appsettings` | JSON (`.json`) |
| `shell script`, `bash script`, `bash`, `shell`, `script`, `zsh` | Shell Script (`.sh`) |

**Detection priority:** Terraform is matched first. This means a prompt like *"terraform script"* correctly selects Terraform, not Shell Script.

**Visual feedback:**
- The File Type selector briefly glows (CSS `fileTypeGlow` animation).
- An **auto** badge appears next to the selector to indicate the switch was automatic.

**Manual override:** You can always change the file type manually after an auto-switch. Manual selections are respected and do not revert until the next debounce cycle detects a different strong signal.

---

## 9. Rate Limits and Quotas

### Server-side rate limit

The Express server enforces a rate limit on all API routes:

| Limit | Window |
|-------|--------|
| **30 requests** | 15 minutes per IP address |

When the limit is exceeded the server returns HTTP 429 with the message:

```
Too many requests — please wait before trying again.
```

The error is displayed as a toast notification in the browser.

### Input length limits

| Field | Maximum length |
|-------|---------------|
| Prompt / Code input | 4,000 characters |
| Existing code (Explain, Migrate) | 8,000 characters |

Requests exceeding these limits are rejected with HTTP 400 before reaching the AI model.

### GitHub Models quota

GitHub imposes its own request and token quotas on the AI Inference endpoint, separate from the server-side rate limit. If you receive model-level errors (e.g., *"rate limit exceeded"* from the upstream API), wait and retry.

---

## 10. Error Reference

| Error message | Cause | Resolution |
|---------------|-------|-----------|
| `GITHUB_TOKEN is not set in .env` | Server started without a token | Create `.env` with `GITHUB_TOKEN=...` and restart |
| `HTTP 401` | Token is invalid or expired | Generate a new GitHub PAT and update `.env` |
| `HTTP 429` | Rate limit exceeded | Wait for the 15-minute window to reset |
| `HTTP 400 — input exceeds 4000 characters` | Prompt too long | Shorten the prompt |
| `HTTP 400 — code exceeds 8000 characters` | Code too large for explain/migrate | Split the code into smaller sections |
| `HTTP 400 — fileType must be one of: tf, yaml, json, sh` | Invalid file type sent by client | Refresh the page; this should not occur in normal use |
| `Request timed out` | Model took longer than 30–60 s | Retry, or switch to a faster model (e.g., `gpt-4o-mini`) |
| `Failed to fetch` | Server is not running | Start the server with `npm start` |
| `targetPlatform must be github-actions or jenkins` | Invalid migration target | Refresh the page; this should not occur in normal use |

---

## 11. Troubleshooting

### The server will not start

**Symptom:** `npm start` exits immediately or prints an error.

Checks:
1. Confirm Node.js is installed: `node --version`
2. Confirm dependencies are installed: `npm install`
3. Confirm `.env` exists and contains `GITHUB_TOKEN=ghp_...`
4. Check that port 3000 is not already in use:
   ```bash
   # macOS / Linux
   lsof -i :3000

   # Windows
   netstat -ano | findstr :3000
   ```

---

### The page loads but Generate produces no output

**Symptom:** Clicking Generate shows a spinner that never resolves, or shows an error toast.

Checks:
1. Open the browser **Developer Tools → Console** tab for client-side errors.
2. Check the server terminal window for backend errors.
3. Confirm your GitHub token has the **Models** scope and has not expired.
4. Try switching to the `gpt-4o-mini` model (the most reliable fallback).

---

### The Explanation tab is blank after Explain Code

**Symptom:** The shimmer skeleton disappears but no explanation appears.

Checks:
1. Confirm the Code tab has content before clicking Explain Code.
2. Check the server terminal for upstream API errors.
3. The explanation response uses Markdown rendering — if the response contains only whitespace or was empty, the tab will appear blank. Retry the request.

---

### History entries are missing after a browser refresh

**Cause:** History is stored in `localStorage`. This storage is per-browser, per-origin, and per-profile.

Resolution: Do not clear browser data (cookies, site data, local storage) if you need to retain history. History cannot be recovered once the browser data is cleared.

---

### The Migrate Pipeline button / dropdown is not visible

**Cause:** The migration controls are hidden when the file type is not `YAML`.

Resolution: Set the **File Type** selector to `YAML (.yaml)`.

---

### DeepSeek-V3 output appears all at once instead of streaming

**Cause:** DeepSeek-V3 does not support SSE on the Azure AI Inference endpoint. The server fetches the full response and sends it as a single event. This is expected behaviour.

---

## 12. Security Guidelines

### GITHUB_TOKEN

- Store the token **only** in `.env`. Never hard-code it in `server.js`, `index.html`, or any other file.
- The `.env` file is listed in `.gitignore`. Verify before every commit:
  ```bash
  git status
  # .env must NOT appear as a tracked or staged file
  ```
- If the token is accidentally committed, revoke it immediately at **GitHub → Settings → Developer settings → Personal access tokens** and generate a new one.
- The token is **never sent to the browser**. All AI calls are proxied through the server.

### Network access

- By default the server binds to all interfaces on port 3000. Anyone on the local network who can reach your machine on port 3000 can use the tool and trigger AI calls against your GitHub token.
- If running on a shared network, add a firewall rule to restrict access to `127.0.0.1` only, or change the `app.listen` call in `server.js`:
  ```js
  app.listen(3000, '127.0.0.1', () => console.log("Running on 3000"));
  ```

### Input validation

The server rejects:
- Prompts longer than 4,000 characters
- Code inputs longer than 8,000 characters
- File types outside `tf`, `yaml`, `json`, `sh`
- Model IDs outside the allowlist
- Migration targets outside `github-actions`, `jenkins`

Do not remove or weaken these checks.

### XSS

All user-supplied strings inserted into the DOM are passed through `escHtml()` before insertion. The Explanation tab uses `marked.js` to render Markdown as HTML — only explanation content from the AI response is rendered this way, never raw user input.

---

*Document version: 1.0 — May 2026*
