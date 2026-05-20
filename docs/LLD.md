# IaC & CI/CD AI Tool — Low Level Design (LLD)

---

## 1. Repository Layout

```
iac-ai-tool/
├── index.html          Frontend — HTML structure, all CSS (inline <style>), all JS (inline <script>)
├── server.js           Express API server — 6 routes, rate limiter, input validation, axios proxy
├── prompts.js          System prompt strings and builder functions
├── package.json        Node.js manifest — CommonJS, 5 direct dependencies
├── package-lock.json   Exact resolved versions and SHA-512 hashes for transitive deps
├── web.config          IIS + iisnode configuration (Azure App Service Windows deployment)
├── .env                Runtime secrets (git-ignored)
├── .gitignore          Excludes node_modules/ and .env
└── docs/
    ├── HLD.md          High-level design document
    ├── LLD.md          This document
    └── PROCESS.md      User-facing process and workflow guide
```

---

## 2. `package.json` — Dependencies

| Package | Version | Role |
|---------|---------|------|
| `express` | ^5.2.1 | HTTP framework — routing, static file serving |
| `axios` | ^1.16.0 | HTTP client used server-side to call Azure AI Inference |
| `cors` | ^2.8.6 | CORS middleware — allows browser fetch from same origin |
| `dotenv` | ^17.4.2 | Loads `GITHUB_TOKEN` from `.env` into `process.env` |
| `express-rate-limit` | ^8.5.1 | Per-IP rate limiter applied to all AI endpoints |

`"type": "commonjs"` — all `require()` / `module.exports` syntax.  
Entry point: `"main": "server.js"`.  
Start command: `npm start` → `node server.js`.

---

## 3. `prompts.js` — Prompt Definitions

### 3.1 `SYSTEM_PROMPTS` object

Five keys, one per IaC file type. Each is a plain-text string sent as the `system` role message.

| Key | Instruction summary |
|-----|-------------------|
| `tf` | Senior DevOps engineer; generate production-ready Terraform; use variables; add comments; no markdown; output only Terraform |
| `yaml` | DevOps engineer; generate valid YAML; proper indentation; no markdown; suitable for pipelines or infra configs |
| `sh` | Generate a shell script; add `#!/bin/bash`; include comments; no markdown |
| `arm` | Senior Azure cloud engineer; generate production-ready ARM template JSON; always include `$schema`, `contentVersion`, `parameters`, `variables`, `resources`, `outputs`; use parameters for environment-varying values; no markdown; output only ARM JSON |
| `cfn` | Senior AWS cloud engineer; generate production-ready CloudFormation YAML; always include `AWSTemplateFormatVersion`, `Description`, `Parameters`, `Resources`, `Outputs`; use intrinsic functions; no markdown; output only CloudFormation YAML |

### 3.2 `CICD_GENERATION_PROMPTS` object

Four keys, one per CI/CD platform. Each is a system prompt string used by the `/cicd/generate` route.

| Key | Instruction summary |
|-----|-------------------|
| `azure-devops` | Senior DevOps engineer specialising in Azure DevOps; use `trigger:`, `pool:`, `stages:`, `jobs:`, `steps:`, `task:` syntax; use built-in Azure DevOps tasks; use `$(variableName)` for secrets; output only valid YAML |
| `github-actions` | Senior DevOps engineer specialising in GitHub Actions; use `on:`, `jobs:`, `steps:`, `uses:`, `run:`, `env:` syntax; use well-known marketplace actions (`actions/checkout@v4`, etc.); use `${{ secrets.NAME }}` for secrets; output only valid YAML |
| `gitlab-ci` | Senior DevOps engineer specialising in GitLab CI/CD; use `stages:`, `variables:`, `before_script:`, `script:`, `after_script:`, `artifacts:`, `rules:`, `cache:`, `needs:`; define all stages in top-level `stages:` list; use `$VARIABLE_NAME` for secrets; output only valid YAML |
| `jenkins` | Senior DevOps engineer specialising in Jenkins; use `pipeline { agent { ... } stages { stage('name') { steps { } } } post { } }` declarative structure; include `post` conditions; use `environment { }` block for vars; output only valid Groovy Declarative Pipeline |

> **Template literal note:** The `${{` sequences inside the GitHub Actions prompt strings are escaped as `\${{` to prevent Node.js from interpreting them as JavaScript template expressions.

### 3.3 `buildSystemPrompt(fileType, explain)` function

| `explain` value | Returned prompt |
|----------------|----------------|
| `"explain"` (string) | Explain-only prompt — instructs model to describe the provided code in sections with plain-text headers like `## Variables` |
| any truthy (not `"explain"`) | Combined generate+explain prompt — instructs model to return a single JSON object with exactly two keys: `"code"` (plain string) and `"explanation"` (plain text with section headers) |
| falsy | `SYSTEM_PROMPTS[fileType]` or fallback `"Generate code..."` |

### 3.4 `buildCICDGenerationPrompt(platform)` function

Returns `CICD_GENERATION_PROMPTS[platform]`, falling back to `CICD_GENERATION_PROMPTS['github-actions']` for unknown platforms.

### 3.5 `buildCICDMigrationPrompt(sourcePlatform, targetPlatform)` function

Builds a migration system prompt that:
1. Names the source format using a `sourceNames` map (supports `github-actions`, `azure-devops`, `gitlab-ci`, `jenkins`, and `auto` for model-detected source).
2. Embeds target-platform-specific conversion instructions from a `targetInstructions` map covering all four platforms.
3. Instructs the model to preserve all pipeline logic and output only the converted code with no markdown fences.

### 3.6 `buildMigrationPrompt(targetPlatform)` function (legacy)

Thin wrapper: calls `buildCICDMigrationPrompt('azure-devops', targetPlatform)`. Used by the legacy `POST /migrate` route.

### 3.7 Exports

```js
module.exports = {
  SYSTEM_PROMPTS,
  buildSystemPrompt,
  buildCICDGenerationPrompt,
  buildCICDMigrationPrompt,
  buildMigrationPrompt
};
```

---

## 4. `server.js` — Express API Server

### 4.1 Startup Sequence

```
require('dotenv').config()           → loads .env into process.env
express app created
app.use(express.json())              → parse JSON request bodies
app.use(cors())                      → allow cross-origin requests
rate limiter created (see §4.2)
app.use('/generate', limiter)
app.use('/explain',  limiter)
app.use('/migrate',  limiter)
app.use('/cicd',     limiter)
GITHUB_TOKEN validated — exits with error if missing
routes registered (§4.6 – §4.11)
app.use(express.static(__dirname))   → serves index.html + assets from project root
PORT = process.env.PORT || 3000
app.listen(PORT)
```

`process.env.PORT` is injected by Azure App Service at runtime. Locally it defaults to `3000`.  
`express.static` is registered **after** all API routes so that API paths are never shadowed by static file resolution.

### 4.2 Rate Limiter

| Setting | Value |
|---------|-------|
| Window | 15 minutes (`15 * 60 * 1000` ms) |
| Max requests | 30 per window per IP |
| Standard headers | `true` (`RateLimit-*` headers sent) |
| Legacy headers | `false` (`X-RateLimit-*` NOT sent) |
| Error message | `{ error: "Too many requests — please wait before trying again." }` |

Applied to: `POST /generate`, `POST /generate/stream`, `POST /explain`, `POST /migrate`, `POST /cicd/generate`, `POST /cicd/migrate`.

### 4.3 Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `TOKEN` | `process.env.GITHUB_TOKEN` | Bearer token for Azure AI Inference |
| `API_URL` | `https://models.inference.ai.azure.com/chat/completions` | LLM endpoint |
| `DEFAULT_MODEL` | `"gpt-4o-mini"` | Fallback when client sends an unknown model ID |
| `MAX_INPUT_LEN` | `4000` | Maximum prompt/input length in characters |
| `MAX_CODE_LEN` | `8000` | Maximum code length accepted by `/explain`, `/migrate`, `/cicd/migrate` |
| `ALLOWED_FILE_TYPES` | `Set { "tf", "yaml", "json", "sh", "arm", "cfn" }` | Valid file type values for IaC routes |
| `ALLOWED_MIGRATE_TARGETS` | `Set { "github-actions", "jenkins" }` | Valid targets for legacy `/migrate` route |
| `ALLOWED_CICD_PLATFORMS` | `Set { "github-actions", "azure-devops", "gitlab-ci", "jenkins" }` | Valid platform values for CI/CD routes |
| `NON_STREAMING_MODELS` | `Set { "deepseek-v3" }` | Models that do not support SSE on this endpoint |

### 4.4 `ALLOWED_MODELS` Set

```
gpt-4o-mini, gpt-4o, gpt-4.1, gpt-4.1-mini,
o3-mini, o4-mini,
meta-llama-3.3-70b-instruct, meta-llama-3.1-405b-instruct,
Mistral-Large-2411, Codestral-2501,
Phi-4,
deepseek-v3
```

### 4.5 Helper Functions

#### `validateInput(input, fileType) → string | null`
Returns an error string on failure, `null` on success.

| Check | Error message |
|-------|--------------|
| `input` missing, not a string, or blank | `"input is required"` |
| `input.length > MAX_INPUT_LEN` | `"input exceeds 4000 characters"` |
| `fileType` not in `ALLOWED_FILE_TYPES` | `"fileType must be one of: tf, yaml, json, sh, arm, cfn"` |

#### `pickModel(requested) → string`
Returns `requested` if it is in `ALLOWED_MODELS`, otherwise returns `DEFAULT_MODEL`.

#### `errorMessage(err) → string`
Extracts a human-readable error:
1. `err.code === 'ECONNABORTED'` → `"Request timed out"`
2. `err.response?.data?.error?.message` (Azure error body)
3. `err.message`
4. `"Failed"`

### 4.6 Route: `POST /generate` (non-streaming)

**Purpose:** Generate IaC code with optional explanation in a single call.

**Request body:**
```json
{ "input": "string", "fileType": "tf|yaml|sh|arm|cfn", "explain": true, "model": "string" }
```

**Response parsing:**
- If `explain` is truthy: strip outer markdown fences if present, then `JSON.parse()` → return `{ result: code, explanation }`
- If `explain` is falsy: strip markdown fences → return `{ result: code }`

### 4.7 Route: `POST /generate/stream` (SSE streaming)

**Purpose:** Stream generated IaC code token-by-token to the browser.

**Non-streaming fallback:** If `NON_STREAMING_MODELS.has(pickedModel)`, fetches full response and emits as a single SSE event followed by `[DONE]`.

**SSE headers:**
```js
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.flushHeaders();
```

**Stream piping:** `response.data.pipe(res)` — Axios response stream is piped directly to the Express response.

### 4.8 Route: `POST /explain`

**Purpose:** Explain a piece of IaC code already present in the output panel.

**Request body:**
```json
{ "code": "string", "fileType": "tf|yaml|sh|arm|cfn", "model": "string" }
```

**System prompt:** `buildSystemPrompt(fileType, "explain")`.

**Response:** `{ explanation: content }` (200) or 500 `{ error }`.

### 4.9 Route: `POST /migrate` (legacy)

**Purpose:** Convert an Azure DevOps YAML pipeline to GitHub Actions or Jenkins.

**Request body:**
```json
{ "code": "string", "targetPlatform": "github-actions|jenkins", "model": "string" }
```

**Validation:** `ALLOWED_MIGRATE_TARGETS` (only `github-actions` and `jenkins`).

**System prompt:** `buildMigrationPrompt(targetPlatform)` → delegates to `buildCICDMigrationPrompt('azure-devops', targetPlatform)`.

**Post-processing:** Strips leading/trailing markdown fences.

**Response:** `{ result: cleanedCode, targetPlatform }` (200) or 500 `{ error }`.

### 4.10 Route: `POST /cicd/generate` (SSE streaming)

**Purpose:** Generate a CI/CD pipeline for a specified platform via streaming.

**Request body:**
```json
{ "prompt": "string", "platform": "github-actions|azure-devops|gitlab-ci|jenkins", "model": "string" }
```

**Validation:**
- `prompt` missing or blank → 400 `"prompt is required"`
- `prompt.length > MAX_INPUT_LEN` → 400 `"prompt exceeds 4000 characters"`
- `platform` not in `ALLOWED_CICD_PLATFORMS` → 400 `"platform must be one of: ..."`

**System prompt:** `buildCICDGenerationPrompt(platform)`.

**Streaming:** Same SSE pattern as `POST /generate/stream` — non-streaming fallback for DeepSeek, `response.data.pipe(res)` for all others.

**Response:** SSE token stream identical in shape to `/generate/stream`. Client reads via `ReadableStream` + `TextDecoder`.

### 4.11 Route: `POST /cicd/migrate`

**Purpose:** Convert a pipeline between any two supported platforms (non-streaming).

**Request body:**
```json
{ "code": "string", "sourcePlatform": "string", "targetPlatform": "github-actions|azure-devops|gitlab-ci|jenkins", "model": "string" }
```

**Validation:**
- `code` missing or blank → 400 `"code is required"`
- `code.length > MAX_CODE_LEN` → 400 `"code exceeds 8000 characters"`
- `targetPlatform` not in `ALLOWED_CICD_PLATFORMS` → 400

**Source platform resolution:**
```js
const source = ALLOWED_CICD_PLATFORMS.has(sourcePlatform) ? sourcePlatform : 'auto';
```
When `source === 'auto'` the model auto-detects the source format from the code content.

**System prompt:** `buildCICDMigrationPrompt(source, targetPlatform)`.

**Post-processing:** Strips leading/trailing markdown fences.

**Response:** `{ result: cleanedCode, targetPlatform }` (200) or 500 `{ error }`.

---

## 5. `index.html` — Frontend

### 5.1 CDN Dependencies (loaded in `<head>`)

| Library | CDN URL | Purpose |
|---------|---------|---------|
| highlight.js (atom-one-dark theme) | `cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/atom-one-dark.min.css` | Syntax highlight CSS theme |
| highlight.js | `cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js` | Syntax highlighting engine |
| highlightjs-line-numbers | `cdn.jsdelivr.net/npm/highlightjs-line-numbers.js@2.8.0/dist/highlightjs-line-numbers.min.js` | Adds line-number gutter to `<pre>` blocks |
| marked | `cdn.jsdelivr.net/npm/marked@9/marked.min.js` | Converts Markdown text to HTML for the Explanation tab |

### 5.2 HTML Element Inventory

#### Mode Navigation

| Element ID | Tag | Description |
|------------|-----|-------------|
| `modeNav` | `<nav>` | Top-level mode switcher bar (IaC Generator / CI/CD Generator) |
| `modeIac` | `<button>` | IaC Generator mode button |
| `modeCicd` | `<button>` | CI/CD Generator mode button |
| `iacPanel` | `<div>` | Full left+right layout for IaC mode |
| `cicdPanel` | `<div>` | Full left+right layout for CI/CD mode |

#### IaC Generator — Left Panel Inputs

| Element ID | Tag | Description |
|------------|-----|-------------|
| `fileType` | `<select>` | File type selector (tf / yaml / sh / arm / cfn) |
| `modelSelect` | `<select>` | Model selector (12 options across 5 `<optgroup>` providers) |
| `input` | `<textarea>` | Prompt input area |
| `charCounter` | `<div>` | Live character count display |
| `autoTag` | `<span>` | "auto" badge shown when file type is auto-detected |

#### IaC Generator — History

| Element ID | Tag | Description |
|------------|-----|-------------|
| `historyCount` | `<span>` | Count badge in history header |
| `historyClearBtn` | `<button>` | "Clear all" button in history header |
| `historyChevron` | `<svg>` | Animated chevron in history header |
| `historyList` | `<div>` | Scrollable container for history items |
| `historyEmpty` | `<div>` | "No history yet" placeholder |

#### IaC Generator — Buttons

| Element ID | Tag | Description |
|------------|-----|-------------|
| `generateBtn` | `<button>` | Primary generate button |
| `spinner` | `<div>` | Spinner inside generateBtn |
| `btnText` | `<span>` | Label inside generateBtn |
| `shortcutHint` | `<kbd>` | `⌘↵` / `Ctrl↵` badge inside generateBtn |
| `explainBtn` | `<button>` | Explain Code button |
| `explainSpinner` | `<div>` | Spinner inside explainBtn |
| `explainBtnText` | `<span>` | Label inside explainBtn |
| `downloadBtn` | `<button>` | Download button (disabled when no content) |

#### IaC Generator — Output Panel

| Element ID | Tag | Description |
|------------|-----|-------------|
| `langTag` | `<span>` | Output panel language badge (TF / YAML / SH / ARM / CFN) |
| `editToggleBtn` | `<button>` | "Edit" button in output header |
| `doneEditBtn` | `<button>` | "Done" button in output header (shown during edit mode) |
| `tabBar` | `<div>` | ARIA tablist container |
| `tab-code` | `<button>` | Code tab button |
| `tab-explain` | `<button>` | Explanation tab button |
| `tab-migrate` | `<button>` | Migration tab button |
| `tc-code` | `<div>` | Code tab content panel |
| `tc-explain` | `<div>` | Explanation tab content panel |
| `tc-migrate` | `<div>` | Migration tab content panel |
| `placeholder` | `<div>` | "Your generated code will appear here" message |
| `skeleton` | `<div>` | Shimmer skeleton for code tab |
| `outputPre` | `<pre>` | Syntax-highlighted code output container |
| `codeEl` | `<code>` | Code element inside outputPre |
| `editTextarea` | `<textarea>` | In-place edit textarea (hidden by default) |
| `explainEmpty` | `<div>` | Empty state in explanation tab |
| `explainSkeleton` | `<div>` | Shimmer skeleton for explanation tab |
| `explainContent` | `<div>` | Rendered Markdown explanation content |
| `migratePlaceholder` | `<div>` | Placeholder in migration tab |
| `migrateSkeleton` | `<div>` | Shimmer skeleton for migration tab |
| `migratedPre` | `<pre>` | Syntax-highlighted migrated code container |
| `migratedCodeEl` | `<code>` | Code element inside migratedPre |
| `migrateSection` | `<div>` | Migrate panel — visible only when fileType === 'yaml' |
| `migrateTarget` | `<select>` | Legacy migration target (github-actions / jenkins) |
| `migrateBtn` | `<button>` | Legacy migrate button |

#### CI/CD Generator — Sub-tab Navigation

| Element ID | Tag | Description |
|------------|-----|-------------|
| `cicdTabGen` | `<button>` | "Generate Pipeline" sub-tab button |
| `cicdTabMig` | `<button>` | "Migrate Pipeline" sub-tab button |
| `cicdGenPanel` | `<div>` | Generate Pipeline sub-panel |
| `cicdMigPanel` | `<div>` | Migrate Pipeline sub-panel |

#### CI/CD Generator — Generate Sub-panel

| Element ID | Tag | Description |
|------------|-----|-------------|
| `cicdPlatform` | `<select>` | Target platform (azure-devops / github-actions / gitlab-ci / jenkins) |
| `cicdModelSelect` | `<select>` | Model selector (same options as IaC) |
| `cicdInput` | `<textarea>` | Pipeline description prompt |
| `cicdGenerateBtn` | `<button>` | Generate Pipeline button |

#### CI/CD Generator — Migrate Sub-panel

| Element ID | Tag | Description |
|------------|-----|-------------|
| `cicdMigTarget` | `<select>` | Migrate-to platform (appears at top of panel) |
| `cicdMigModelSelect` | `<select>` | Model selector for migration |
| `cicdDropZone` | `<div>` | Drag-and-drop file upload zone |
| `cicdFileInput` | `<input type="file">` | Hidden file input for click-to-browse |
| `cicdMigInput` | `<textarea>` | Paste pipeline code area |
| `detectBadge` | `<span>` | Inline source-detection badge beside paste label |
| `cicdMigrateBtn` | `<button>` | Migrate Pipeline button |

#### CI/CD Generator — History

| Element ID | Tag | Description |
|------------|-----|-------------|
| `cicdHistoryCount` | `<span>` | Count badge in CI/CD history header |
| `cicdHistoryClearBtn` | `<button>` | "Clear all" in CI/CD history header |
| `cicdHistoryChevron` | `<svg>` | Animated chevron in CI/CD history header |
| `cicdHistoryList` | `<div>` | Scrollable container for CI/CD history items |
| `cicdHistoryEmpty` | `<div>` | "No history yet" placeholder |

#### CI/CD Generator — Output Panel

| Element ID | Tag | Description |
|------------|-----|-------------|
| `cicdLangTag` | `<span>` | Output panel language badge (ADO / GHA / GL CI / JENKINS) |
| `cicdOutputPre` | `<pre>` | Syntax-highlighted CI/CD output container |
| `cicdCodeEl` | `<code>` | Code element inside cicdOutputPre |
| `cicdPlaceholder` | `<div>` | "Your generated pipeline will appear here" message |
| `cicdSkeleton` | `<div>` | Shimmer skeleton for CI/CD output |

#### Shared / Toast Elements

| Element ID | Tag | Description |
|------------|-----|-------------|
| `copyToast` | `<div>` | Fixed-position copy confirmation toast |
| `statusToast` | `<div>` | Fixed-position status feedback toast |
| `statusToastText` | `<span>` | Text content inside statusToast |

### 5.3 CSS Architecture

All styles are inline in a single `<style>` block.

#### Layout

```
body (flex column, 100vh)
└── header (flex row, mode nav bar)
└── .main (flex row, 24px 32px padding, flex: 1)
    ├── .left-panel (480px fixed, min-width 380px, flex column)
    │   ├── .left-scroll (flex: 1, overflow-y: auto)
    │   └── history section (flex-shrink: 0)
    └── .right-panel (flex: 1, flex column)
```

Left panel was widened from 380px to **480px** (`min-width: 380px`) to accommodate the CI/CD sub-tabs and file upload zone. The right panel uses `flex: 1` and auto-shrinks accordingly.

#### Badge CSS Classes

IaC file type badges:

| Class | Background | Text colour |
|-------|-----------|------------|
| `.badge-tf` | `rgba(124,58,237,0.2)` | `#a78bfa` |
| `.badge-yaml` | `rgba(2,132,199,0.2)` | `#38bdf8` |
| `.badge-sh` | `rgba(5,150,105,0.2)` | `#34d399` |
| `.badge-arm` | `rgba(0,120,212,0.2)` | `#60a5fa` |
| `.badge-cfn` | `rgba(217,119,6,0.2)` | `#fbbf24` |

CI/CD platform badges:

| Class | Background | Text colour |
|-------|-----------|------------|
| `.badge-ado` | `rgba(0,120,212,0.2)` | `#60a5fa` |
| `.badge-gha` | `rgba(55,65,81,0.4)` | `#c4c4d8` |
| `.badge-glci` | `rgba(252,109,38,0.2)` | `#fb923c` |
| `.badge-jenkins` | `rgba(220,38,38,0.2)` | `#f87171` |
| `.badge-mig` | `rgba(217,119,6,0.15)` | `#fbbf24` |

#### CSS Animations

| Name | Duration | Purpose |
|------|----------|---------|
| `gradientBG` | 18s infinite | Animated background gradient pan |
| `shimmer` | 1.8s infinite | Skeleton loader sweep |
| `spin` | 0.7s infinite | Button loading spinners |
| `tabSlideIn` | 0.25s forward | Tab content fade-in + translateY |
| `fileTypeGlow` | 0.8s forward | Purple glow on auto file-type switch |

#### Responsive Breakpoint (`max-width: 768px`)
```css
.main { flex-direction: column; overflow: visible; height: auto; }
.left-panel { width: 100%; padding-right: 0; border-right: none; border-bottom: 1px solid ...; }
.right-panel { padding-left: 0; min-height: 400px; }
```

### 5.4 JavaScript — Module-Level State Variables

#### IaC Generator State

| Variable | Type | Initial | Description |
|----------|------|---------|-------------|
| `lastCode` | `string` | `''` | Most recently generated/edited IaC code |
| `lastFileType` | `string` | `'tf'` | File type of `lastCode` |
| `historyOpen` | `boolean` | `false` | Whether the IaC history accordion is expanded |
| `activeIndex` | `number` | `-1` | Index of the currently loaded IaC history entry |
| `currentTab` | `string` | `'code'` | Active IaC output tab: `'code'`, `'explain'`, or `'migrate'` |
| `editMode` | `boolean` | `false` | Whether the code panel is in edit mode |
| `migratedCode` | `string` | `''` | Most recently migrated code (legacy IaC migrate) |
| `migratedPlatform` | `string` | `''` | Migration target for `migratedCode` |
| `history` | `Array` | `[]` | In-memory IaC history array (max 10 entries) |

#### CI/CD Generator State

| Variable | Type | Initial | Description |
|----------|------|---------|-------------|
| `cicdHistoryOpen` | `boolean` | `false` | Whether the CI/CD history accordion is expanded |
| `cicdActiveIndex` | `number` | `-1` | Index of the currently loaded CI/CD history entry |
| `cicdHistory` | `Array` | `[]` | In-memory CI/CD history array (max 10 entries) |

#### Shared Timers

| Variable | Type | Initial | Description |
|----------|------|---------|-------------|
| `_statusTimer` | `number\|null` | `null` | `setTimeout` handle for success toast auto-dismiss |
| `_autoDetectTimer` | `number\|null` | `null` | `setTimeout` handle for debounced file-type detection |
| `_autoTagTimer` | `number\|null` | `null` | `setTimeout` handle for "auto" badge fade-out |

### 5.5 Constants (JS)

| Constant | Value | Description |
|----------|-------|-------------|
| `API_BASE` | `window.location.hostname === 'localhost' ? 'http://localhost:3000' : ''` | Base URL — absolute locally, relative in production (Azure App Service) |
| `langMap` | `{ tf:'hcl', yaml:'yaml', sh:'bash', arm:'json', cfn:'yaml' }` | Maps IaC file type to highlight.js language ID |
| `badgeMap` | `{ tf:'TF', yaml:'YAML', sh:'SH', arm:'ARM', cfn:'CFN' }` | Maps IaC file type to display badge text |
| `fileExtMap` | `{ tf:'tf', yaml:'yaml', sh:'sh', arm:'json', cfn:'yaml' }` | Maps IaC file type to download extension |
| `placeholderLeadMap` | See below | Maps IaC file type to context-appropriate prompt lead text |
| `cicdLangTagMap` | `{ 'azure-devops':'ADO', 'github-actions':'GHA', 'gitlab-ci':'GL CI', 'jenkins':'JENKINS' }` | Maps CI/CD platform to output panel badge text |
| `cicdBadgeMap` | `{ 'azure-devops':'ADO', 'github-actions':'GHA', 'gitlab-ci':'GL CI', 'jenkins':'JENKINS' }` | Maps CI/CD platform to history badge label |
| `cicdBadgeCssMap` | `{ 'azure-devops':'ado', 'github-actions':'gha', 'gitlab-ci':'glci', 'jenkins':'jenkins' }` | Maps CI/CD platform to CSS badge class suffix |
| `STORAGE_KEY` | `'iac-gen-history'` | `localStorage` key for IaC history |
| `CICD_STORAGE_KEY` | `'cicd-gen-history'` | `localStorage` key for CI/CD history |
| `TAB_ORDER` | `['code', 'explain', 'migrate']` | Ordered tab names for IaC keyboard navigation |

`placeholderLeadMap` values:

| Key | Lead text |
|-----|-----------|
| `tf` | `'Describe the infrastructure you want to generate…'` |
| `yaml` | `'Describe the Kubernetes / container configuration you want…'` |
| `sh` | `'Describe the shell script you want to create…'` |
| `arm` | `'Describe the Azure resource you want to provision…'` |
| `cfn` | `'Describe the AWS resource you want to provision…'` |

### 5.6 JavaScript — Function Reference

#### Mode Switching

---

**`switchMode(mode)`**  
Switches the top-level view between `'iac'` and `'cicd'`. Toggles `.mode-active` on `#modeIac` / `#modeCicd` and shows/hides `#iacPanel` / `#cicdPanel`.

---

#### IaC UI Helpers

**`updateLangTag()`**  
Reads `#fileType` value. Sets `#langTag` text to `badgeMap[ft]`. Sets `#input.placeholder` using the type-specific lead from `placeholderLeadMap` concatenated with the example text from `placeholderMap[ft]`. Shows/hides `#migrateSection`.

---

**`setStatus(msg, type)`**  
Manages the `#statusToast` element. Success toasts auto-dismiss after **2500 ms**; loading and error toasts persist.

---

**`setBusy(busy)`**  
Sets `.disabled` on: `#generateBtn`, `#explainBtn`, `#editToggleBtn`, `#doneEditBtn`, `#migrateBtn`.

---

**`getModel()`** / **`getCicdModel()`**  
Returns the selected model ID from `#modelSelect` or `#cicdModelSelect`/`#cicdMigModelSelect` depending on the active CI/CD sub-tab.

---

#### CI/CD Sub-tab Management

**`switchCicdTab(tab)`**  
Switches between `'gen'` (Generate Pipeline) and `'mig'` (Migrate Pipeline) sub-tabs. Toggles `.cicd-tab-active` on both tab buttons and shows/hides the corresponding panel divs. After switching:
- `'gen'` tab → calls `updateCicdPlaceholder()` (updates `#cicdLangTag` based on `#cicdPlatform`)
- `'mig'` tab → calls `updateCicdMigTag()` (updates `#cicdLangTag` based on `#cicdMigTarget`)

---

**`updateCicdPlaceholder()`**  
Reads `#cicdPlatform`. Sets `#cicdLangTag` text using `cicdLangTagMap[platform]`.

---

**`updateCicdMigTag()`**  
Reads `#cicdMigTarget`. Sets `#cicdLangTag` text using `cicdLangTagMap[platform]`. Called on `onchange` of `#cicdMigTarget` and when switching to the Migrate sub-tab.

---

#### CI/CD Source Detection

**`detectPipelineType(code) → string`**  
Client-side regex analysis of pipeline code. Returns one of `'jenkins'`, `'github-actions'`, `'azure-devops'`, `'gitlab-ci'`, or `'auto'`.

| Platform | Detection signals |
|----------|-----------------|
| Jenkins | `pipeline {` block |
| GitHub Actions | Top-level `on:` + `jobs:` |
| Azure DevOps | Top-level `trigger:` + `pool:` |
| GitLab CI | Top-level `stages:` + `script:` without `jobs:` |

---

**`updateDetectBadge(code)`**  
Calls `detectPipelineType(code)`. Updates `#detectBadge` text and CSS class. Called on `input` events to the `#cicdMigInput` textarea and immediately after a file is loaded.

---

#### CI/CD Generate Flow

**`cicdGenerate()`** — `async`  
1. Reads and trims `#cicdInput`. Validates non-empty.
2. Shows skeleton, sets SSE headers, streams from `POST /cicd/generate`.
3. Accumulates `fullCode` from delta tokens.
4. On `[DONE]`: calls `cicdRenderCode(fullCode, platform)`.
5. Calls `pushCicdHistory(prompt, platform, 'gen', fullCode)`.
6. Catch/finally: hides skeleton, re-enables button.

---

**`cicdRenderCode(code, platform)`**  
Strips markdown fences. Sets `#cicdCodeEl.textContent` + `className`. Removes `data-highlighted`. `hljs.highlightElement()` + `hljs.lineNumbersBlock()`. Hides `#cicdPlaceholder`, shows `#cicdOutputPre`. Sets `#cicdLangTag` to `cicdLangTagMap[platform]`.

---

#### CI/CD Migrate Flow

**`cicdMigrate()`** — `async`  
1. Reads `#cicdMigInput`. Validates non-empty.
2. Detects source platform via `detectPipelineType()`.
3. `fetch POST /cicd/migrate` with `{ code, sourcePlatform, targetPlatform, model }`.
4. `cicdRenderCode(data.result, data.targetPlatform)`.
5. `pushCicdHistory(code.slice(0, 80), targetPlatform, 'mig', data.result)`.

---

#### CI/CD History

**`pushCicdHistory(prompt, platform, type, result)`**  
`cicdHistory.unshift({ prompt, platform, type, result, ts: Date.now() })`. Trims to 10. Sets `cicdActiveIndex = 0`. Calls `saveCicdHistory()` and `renderCicdHistoryList()`.

---

**`renderCicdHistoryList()`**  
Rebuilds `#cicdHistoryList`. Each item shows a platform badge (`ADO` / `GHA` / `GL CI` / `JENKINS`) and, for migrations, a `MIG` badge. Timestamps via `timeAgo()`. Active item gets `.active` class.

---

**`loadCicdHistory(i)`**  
Sets `cicdActiveIndex = i`. Branches on `item.type`:
- `'gen'` → calls `switchCicdTab('gen')`, populates `#cicdInput` and `#cicdPlatform`, calls `updateCicdPlaceholder()`
- `'mig'` → calls `switchCicdTab('mig')`, populates `#cicdMigInput` and `#cicdMigTarget`, calls `updateCicdMigTag()` and `updateDetectBadge()`

Calls `cicdRenderCode(item.result, item.platform)`. Re-renders history list. Success toast.

---

**`saveCicdHistory()`** / **`loadStoredCicdHistory()`**  
Same pattern as IaC history — `localStorage` key `'cicd-gen-history'`.

---

#### IaC History (unchanged from prior design)

**`pushHistory(prompt, fileType, code, explanation)`** — unshifts to `history`, trims to 10, saves, renders.

**`loadHistory(i)`** — restores prompt, fileType, code, explanation from entry `i`.

**`renderHistoryList()`** — rebuilds IaC history items with file type badges and timestamps.

**`saveHistory()`** / **`loadStoredHistory()`** — `localStorage` key `'iac-gen-history'`.

---

#### IaC Code Generation and Explain (unchanged from prior design)

**`generate()`** — streams from `POST /generate/stream`, calls `pushHistory()` on completion.

**`explainCode()`** — delegates to `explainExistingCode()` if `lastCode` is truthy; otherwise calls `POST /generate` with `explain: true`.

**`explainExistingCode()`** — calls `POST /explain`, shows result in Explanation tab.

**`toggleEdit()`** / **`doneEdit()`** — in-place code editing.

---

### 5.7 Auto File-Type Detection

#### `FILE_TYPE_RULES` array (priority-ordered, first match wins)

| Priority | Type | Trigger keywords |
|----------|------|-----------------|
| 1 | `tf` | `terraform`, `hcl`, `iac`, `infrastructure as code` |
| 2 | `arm` | `arm template`, `azure resource manager`, `azure arm`, `\barm\b` |
| 3 | `cfn` | `cloudformation`, `\bcfn\b`, `cloud formation`, `aws template`, `aws stack`, `aws resource` |
| 4 | `yaml` | `yaml`, `pipeline`, `github actions`, `ci/cd`, `gitlab ci`, `azure devops`, `ansible`, `kubernetes`, `k8s`, `helm`, `docker compose`, `workflow`, `jenkinsfile`, `jenkins` |
| 5 | `sh` | `shell script`, `bash script`, `bash`, `shell`, `script`, `zsh` |

All patterns use the `i` (case-insensitive) flag.

#### `detectAndApplyFileType()`
Iterates `FILE_TYPE_RULES`. On first match, if the type differs from the current selection: updates `#fileType`, calls `updateLangTag()`, re-triggers the CSS glow animation, shows the `#autoTag` badge for **2000 ms**.

---

### 5.8 Initialization Block (runs on page load)

```
updateLangTag()
loadStoredHistory()
loadStoredCicdHistory()
setInterval(renderHistoryList, 30_000)
setInterval(renderCicdHistoryList, 30_000)

keydown on #input → Ctrl/Cmd+Enter → generate()

input event → updateCharCounter() + debounced detectAndApplyFileType(300ms)

tabBar keydown → ArrowLeft/ArrowRight → switchTab + focus

isMac = /Mac|iPhone|iPad/.test(navigator.platform)
#shortcutHint.textContent = isMac ? '⌘↵' : 'Ctrl↵'
```

---

### 5.9 `localStorage` Schema

#### IaC History

Key: `'iac-gen-history'`

```json
[
  {
    "prompt": "string",
    "fileType": "tf|yaml|sh|arm|cfn",
    "code": "string",
    "explanation": "string | null",
    "ts": 1716000000000
  }
]
```

#### CI/CD History

Key: `'cicd-gen-history'`

```json
[
  {
    "prompt": "string (truncated to 80 chars for migrate entries)",
    "platform": "github-actions|azure-devops|gitlab-ci|jenkins",
    "type": "gen|mig",
    "result": "string",
    "ts": 1716000000000
  }
]
```

Both stores hold up to 10 entries, ordered newest-first. `ts` is a Unix millisecond timestamp.

---

### 5.10 Keyboard Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Ctrl+Enter` / `Cmd+Enter` | IaC prompt textarea focused | Triggers `generate()` |
| `ArrowRight` | IaC tab bar focused | Move to next enabled tab |
| `ArrowLeft` | IaC tab bar focused | Move to previous enabled tab |

---

### 5.11 Toast System

Two independent toast elements shared across both modes:

#### Copy Toast (`#copyToast`)
- Position: `fixed; bottom: 28px; left: 50%` (centred)
- Auto-hides after **1800 ms**

#### Status Toast (`#statusToast`)
- Position: `fixed; top: 72px; right: 32px`
- States: `.success` (auto-dismiss 2500 ms), `.error` (persists), `.loading` (persists)

---

## 6. API Contract Summary

### `POST /generate`

| Field | Request | Response (200) |
|-------|---------|----------------|
| `input` | prompt string (≤4000 chars) | — |
| `fileType` | tf / yaml / sh / arm / cfn | — |
| `explain` | boolean | — |
| `model` | model ID string | — |
| `result` | — | generated code string |
| `explanation` | — | explanation string (if explain=true) |

### `POST /generate/stream`

SSE stream. Emits `data: <JSON>\n\n` lines. Each JSON: `{ "choices": [{ "delta": { "content": "token" } }] }`. Terminates with `data: [DONE]\n\n`.

### `POST /explain`

| Field | Request | Response (200) |
|-------|---------|----------------|
| `code` | code string (≤8000 chars) | — |
| `fileType` | tf / yaml / sh / arm / cfn | — |
| `model` | model ID string | — |
| `explanation` | — | explanation string |

### `POST /migrate` (legacy)

| Field | Request | Response (200) |
|-------|---------|----------------|
| `code` | YAML string (≤8000 chars) | — |
| `targetPlatform` | github-actions / jenkins | — |
| `model` | model ID string | — |
| `result` | — | migrated code string |
| `targetPlatform` | — | echoed back |

### `POST /cicd/generate`

SSE stream. Same token-delta format as `/generate/stream`.

| Field | Request |
|-------|---------|
| `prompt` | pipeline description (≤4000 chars) |
| `platform` | github-actions / azure-devops / gitlab-ci / jenkins |
| `model` | model ID string |

### `POST /cicd/migrate`

| Field | Request | Response (200) |
|-------|---------|----------------|
| `code` | pipeline code (≤8000 chars) | — |
| `sourcePlatform` | platform string (or omit for auto-detect) | — |
| `targetPlatform` | github-actions / azure-devops / gitlab-ci / jenkins | — |
| `model` | model ID string | — |
| `result` | — | migrated pipeline string |
| `targetPlatform` | — | echoed back |

Error responses on all routes: `{ "error": "message" }` with status 400 (validation) or 500 (upstream/server error).

---

## 7. Error Handling Matrix

| Scenario | Where caught | User feedback |
|----------|-------------|---------------|
| Empty IaC prompt | `generate()` / `explainCode()` — before fetch | Error toast: `'Please enter a prompt.'` |
| Empty CI/CD prompt | `cicdGenerate()` — before fetch | Error toast |
| Empty migrate input | `cicdMigrate()` — before fetch | Error toast |
| Server not running | `fetch` rejects (`TypeError`) | Error toast: `'Request failed — is the server running?'` |
| HTTP 400 (validation) | Server returns JSON error body | Error toast: server's `error` field |
| HTTP 500 (LLM error) | Server returns 500 | Error toast: model error message |
| Rate limit hit (429) | Server returns 429 | Error toast: `'Too many requests — please wait...'` |
| Empty stream response | `fullCode` check after stream ends | Error toast: `'No code was returned...'` |
| Clipboard denied | `navigator.clipboard` rejects | Silent fail |
| `localStorage` full | `try/catch` in `saveHistory()` / `saveCicdHistory()` | Silent fail |
| No code to edit | `toggleEdit()` guard | Error toast: `'Nothing to edit yet.'` |
| No content to download | `downloadFile()` guard | Error toast: `'No content to download.'` |

---

## 8. Model Configuration Details

| Model ID | Provider | Notes |
|----------|---------|-------|
| `gpt-4o-mini` | OpenAI | Default — fast and cost-effective |
| `gpt-4o` | OpenAI | Higher quality output |
| `gpt-4.1` | OpenAI | Latest GPT-4 generation |
| `gpt-4.1-mini` | OpenAI | Balanced speed and quality |
| `o3-mini` | OpenAI | Strong reasoning |
| `o4-mini` | OpenAI | Latest reasoning model |
| `meta-llama-3.3-70b-instruct` | Meta | Open-weight, strong instruction following |
| `meta-llama-3.1-405b-instruct` | Meta | Largest open-weight Meta model |
| `Mistral-Large-2411` | Mistral | Strong structured output |
| `Codestral-2501` | Mistral | Code specialist |
| `Phi-4` | Microsoft | Compact and efficient |
| `deepseek-v3` | DeepSeek | Strong coder — **non-streaming** (blocking fallback applied server-side) |

All models share the same endpoint (`https://models.inference.ai.azure.com/chat/completions`) and auth header (`Authorization: Bearer <GITHUB_TOKEN>`).
