# IaC AI Tool — Low Level Design (LLD)

---

## 1. Repository Layout

```
iac-ai-tool/
├── index.html          Frontend — HTML structure, all CSS (inline <style>), all JS (inline <script>)
├── server.js           Express API server — 4 routes, rate limiter, input validation, axios proxy
├── prompts.js          System prompt strings and builder functions
├── package.json        Node.js manifest — CommonJS, 5 direct dependencies
├── package-lock.json   Exact resolved versions and SHA-512 hashes for 40 transitive deps
├── .env                Runtime secrets (git-ignored)
└── .gitignore          Excludes node_modules/ and .env
```

---

## 2. `package.json` — Dependencies

| Package | Version | Role |
|---------|---------|------|
| `express` | ^5.2.1 | HTTP framework — routing, static file serving |
| `axios` | ^1.16.0 | HTTP client used server-side to call Azure AI Inference |
| `cors` | ^2.8.6 | CORS middleware — allows browser fetch from same origin |
| `dotenv` | ^17.4.2 | Loads `GITHUB_TOKEN` from `.env` into `process.env` |
| `express-rate-limit` | ^8.5.1 | Per-IP rate limiter applied to all three AI endpoints |

`"type": "commonjs"` — all `require()` / `module.exports` syntax.  
Entry point: `"main": "server.js"`.  
Start command: `npm start` → `node server.js`.

---

## 3. `prompts.js` — Prompt Definitions

### 3.1 `SYSTEM_PROMPTS` object

Six keys, one per file type. Each is a plain-text string sent as the `system` role message.

| Key | Instruction summary |
|-----|-------------------|
| `tf` | Senior DevOps engineer; generate production-ready Terraform; use variables; add comments; no markdown; output only Terraform |
| `yaml` | DevOps engineer; generate valid YAML; proper indentation; no markdown; suitable for pipelines or infra configs |
| `json` | Generate valid JSON; proper syntax; no comments; no markdown |
| `sh` | Generate a shell script; add `#!/bin/bash`; include comments; no markdown |
| `arm` | Senior Azure cloud engineer; generate production-ready ARM template JSON; always include `$schema`, `contentVersion`, `parameters`, `variables`, `resources`, `outputs`; use parameters for environment-varying values; add `metadata` descriptions; no markdown; output only ARM JSON |
| `cfn` | Senior AWS cloud engineer; generate production-ready CloudFormation YAML; always include `AWSTemplateFormatVersion`, `Description`, `Parameters`, `Resources`, `Outputs`; use intrinsic functions (`!Ref`, `!Sub`, `!GetAtt`, etc.); add `DeletionPolicy`/`UpdateReplacePolicy` on stateful resources; no markdown; output only CloudFormation YAML |

### 3.2 `MIGRATION_PROMPTS` object

Two keys mapping to target platform:

**`github-actions`** — Senior DevOps engineer specialising in CI/CD migration.  
Rules encoded in the prompt:
- Output only valid GitHub Actions YAML — no fences, no extra text
- Map ADO triggers (`trigger`, `pr`, `schedules`) → GHA `on:` events
- Map ADO stages/jobs/steps → GHA jobs and steps
- Replace ADO built-in tasks (`CmdLine@2`, `Bash@3`, `PublishBuildArtifacts@1`, `DotNetCoreCLI@2`, `NodeTool@0`) with equivalent GHA actions
- Use `actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-dotnet@v4`, `actions/upload-artifact@v4`
- Preserve environment variables, secrets, parameters
- Add top-level `name:` for the workflow
- Use `needs:` for job dependencies; `runs-on: ubuntu-latest` as default

**`jenkins`** — Senior DevOps engineer specialising in CI/CD migration.  
Rules encoded in the prompt:
- Output only valid Groovy Declarative Pipeline — no fences, no extra text
- Use `pipeline { ... }` declarative structure
- Map ADO stages → Jenkins `stage('name') { steps { ... } }` blocks
- Map ADO triggers → Jenkins `triggers { ... }` block
- Map ADO variables/parameters → Jenkins `environment { ... }` / `parameters { ... }`
- Replace ADO tasks with `sh` or `bat` steps
- Use `agent any` unless a specific agent is implied

### 3.3 `buildSystemPrompt(fileType, explain)` function

| `explain` value | Returned prompt |
|----------------|----------------|
| `"explain"` (string) | Explain-only prompt — instructs model to describe the provided code in sections with plain-text headers like `## Variables` |
| any truthy (not `"explain"`) | Combined generate+explain prompt — instructs model to return a single JSON object with exactly two keys: `"code"` (plain string) and `"explanation"` (plain text with section headers) |
| falsy | `SYSTEM_PROMPTS[fileType]` or fallback `"Generate code..."` |

### 3.4 `buildMigrationPrompt(targetPlatform)` function

Returns `MIGRATION_PROMPTS[targetPlatform]`, falling back to `MIGRATION_PROMPTS['github-actions']` for unknown targets.

### 3.5 Exports

```js
module.exports = { SYSTEM_PROMPTS, buildSystemPrompt, buildMigrationPrompt };
```

---

## 4. `server.js` — Express API Server

### 4.1 Startup Sequence

```
require('dotenv').config()           → loads .env into process.env
express app created
app.use(express.json())              → parse JSON request bodies
app.use(cors())                      → allow cross-origin requests
app.use(express.static(__dirname))   → serves index.html + assets from project root
rate limiter created (see §4.2)
app.use('/generate', limiter)
app.use('/explain',  limiter)
app.use('/migrate',  limiter)
GITHUB_TOKEN validated — exits with error if missing
app.listen(3000)
```

### 4.2 Rate Limiter

| Setting | Value |
|---------|-------|
| Window | 15 minutes (`15 * 60 * 1000` ms) |
| Max requests | 30 per window per IP |
| Standard headers | `true` (`RateLimit-*` headers sent) |
| Legacy headers | `false` (`X-RateLimit-*` NOT sent) |
| Error message | `{ error: "Too many requests — please wait before trying again." }` |

Applied to: `POST /generate`, `POST /explain`, `POST /migrate`, and by prefix also `POST /generate/stream`.

### 4.3 Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `TOKEN` | `process.env.GITHUB_TOKEN` | Bearer token for Azure AI Inference |
| `API_URL` | `https://models.inference.ai.azure.com/chat/completions` | LLM endpoint |
| `DEFAULT_MODEL` | `"gpt-4o-mini"` | Fallback when client sends an unknown model ID |
| `MAX_INPUT_LEN` | `4000` | Maximum prompt length in characters |
| `MAX_CODE_LEN` | `8000` | Maximum code length accepted by `/explain` and `/migrate` |
| `ALLOWED_FILE_TYPES` | `Set { "tf", "yaml", "json", "sh", "arm", "cfn" }` | Valid file type values accepted by all routes |
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
| `fileType` not in `ALLOWED_FILE_TYPES` | `"fileType must be one of: tf, yaml, json, sh"` |

#### `pickModel(requested) → string`
Returns `requested` if it is in `ALLOWED_MODELS`, otherwise returns `DEFAULT_MODEL`.

#### `errorMessage(err) → string`
Extracts a human-readable error:
1. `err.code === 'ECONNABORTED'` → `"Request timed out"`
2. `err.response?.data?.error?.message` (Azure error body)
3. `err.message`
4. `"Failed"`

### 4.6 Route: `POST /generate` (non-streaming)

**Purpose:** Generate code with optional explanation in a single call.

**Request body:**
```json
{ "input": "string", "fileType": "tf|yaml|json|sh", "explain": true, "model": "string" }
```

**Validation:** `validateInput(input, fileType)` — 400 on failure.

**System prompt:** `buildSystemPrompt(fileType, explain)` — if `explain` is truthy, the prompt instructs the model to return `{ "code": "...", "explanation": "..." }` JSON.

**Axios call:**
```js
axios.post(API_URL, {
  model: pickedModel,
  messages: [
    { role: 'system',  content: systemPrompt },
    { role: 'user',    content: input }
  ],
  temperature: 0.3,
  max_tokens: 4096,
}, {
  headers: { Authorization: `Bearer ${TOKEN}` },
  timeout: 60000,
})
```

**Response parsing:**
- Extract `choices[0].message.content`
- If `explain` is truthy: strip outer markdown fences if present, then `JSON.parse()` the result
  - Return `{ result: data.code, explanation: data.explanation }` (200)
- If `explain` is falsy: return `{ result: content }` (200)

**Error responses:** 502 with `{ error: errorMessage(err) }`.

### 4.7 Route: `POST /generate/stream` (SSE streaming)

**Purpose:** Stream generated code token-by-token to the browser.

**Request body:**
```json
{ "input": "string", "fileType": "tf|yaml|json|sh", "model": "string" }
```

**Validation:** same as above — 400 on failure.

**Non-streaming fallback:** If `NON_STREAMING_MODELS.has(pickedModel)` (currently only `deepseek-v3`), the route calls the non-streaming `/generate` logic and emits the full content as a single SSE event, then `[DONE]`.

**SSE setup:**
```js
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.flushHeaders();
```

**Axios streaming call:**
```js
axios.post(API_URL, { ..., stream: true }, {
  headers: { Authorization: `Bearer ${TOKEN}` },
  responseType: 'stream',
  timeout: 120000,
})
```

**Stream piping:** Reads the Axios response stream line by line. Lines starting with `data: ` are parsed as JSON. Each `choices[0].delta.content` token is re-emitted as `data: <JSON>\n\n`. `[DONE]` signal is forwarded verbatim.

**Cleanup:** `req.on('close')` destroys the Axios response stream to prevent resource leaks.

**Error responses:** SSE `data: { "error": "message" }` for in-stream errors; `res.end()` always called in `finally`.

### 4.8 Route: `POST /explain`

**Purpose:** Explain a piece of code that has already been generated.

**Request body:**
```json
{ "code": "string", "fileType": "tf|yaml|json|sh", "model": "string" }
```

**Validation:**
- `code` missing or blank → 400 `"code is required"`
- `code.length > MAX_CODE_LEN` → 400 `"code exceeds 8000 characters"`
- `fileType` not in `ALLOWED_FILE_TYPES` → 400

**System prompt:** `buildSystemPrompt(fileType, "explain")` — returns the explain-only prompt.

**Axios call:** same shape as `/generate`, `temperature: 0.3`, `max_tokens: 2048`, no streaming.

**Response:** `{ explanation: content }` (200) or 502 `{ error }`.

### 4.9 Route: `POST /migrate`

**Purpose:** Convert an ADO YAML pipeline to GitHub Actions or Jenkins.

**Request body:**
```json
{ "code": "string", "targetPlatform": "github-actions|jenkins", "model": "string" }
```

**Validation:**
- `code` missing or blank → 400 `"code is required"`
- `code.length > MAX_CODE_LEN` → 400 `"code exceeds 8000 characters"`
- `targetPlatform` not in `ALLOWED_MIGRATE_TARGETS` → 400 `"targetPlatform must be one of: github-actions, jenkins"`

**System prompt:** `buildMigrationPrompt(targetPlatform)`.

**Axios call:** same shape, `temperature: 0.2` (lower for more deterministic migration), `max_tokens: 4096`.

**Post-processing:** Strips leading/trailing markdown fences from the response content.

**Response:** `{ result: cleanedCode }` (200) or 502 `{ error }`.

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

| Element ID | Tag | Description |
|------------|-----|-------------|
| `fileType` | `<select>` | File type selector (tf / yaml / json / sh) |
| `modelSelect` | `<select>` | Model selector (13 options across 5 `<optgroup>` providers) |
| `input` | `<textarea>` | Prompt input area |
| `charCounter` | `<div>` | Live character count display |
| `autoTag` | `<span>` | "auto" badge shown when file type is auto-detected |
| `historyCount` | `<span>` | Count badge in history header |
| `historyClearBtn` | `<button>` | "Clear all" button in history header |
| `historyChevron` | `<svg>` | Animated chevron in history header |
| `historyList` | `<div>` | Scrollable container for history items |
| `historyEmpty` | `<div>` | "No history yet" placeholder |
| `generateBtn` | `<button>` | Primary generate button |
| `spinner` | `<div>` | Spinner inside generateBtn |
| `btnText` | `<span>` | Label inside generateBtn |
| `shortcutHint` | `<kbd>` | `⌘↵` / `Ctrl↵` badge inside generateBtn |
| `explainBtn` | `<button>` | Explain Code button |
| `explainSpinner` | `<div>` | Spinner inside explainBtn |
| `explainBtnText` | `<span>` | Label inside explainBtn |
| `downloadBtn` | `<button>` | Download button (disabled when no content) |
| `migrateSection` | `<div>` | Migrate panel — visible only when fileType === 'yaml' |
| `migrateTarget` | `<select>` | Migration target (github-actions / jenkins) |
| `migrateBtn` | `<button>` | Migrate button |
| `migrateSpinner` | `<div>` | Spinner inside migrateBtn |
| `migrateBtnText` | `<span>` | Label inside migrateBtn |
| `statusBar` | `<div>` | Legacy status bar (CSS `display:none` — replaced by statusToast) |
| `langTag` | `<span>` | Output panel language badge (TF / YAML / JSON / SH) |
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
| `skeleton` | `<div>` | 10-line shimmer skeleton for code tab |
| `outputPre` | `<pre>` | Syntax-highlighted code output container |
| `codeEl` | `<code>` | Code element inside outputPre (highlight.js target) |
| `editTextarea` | `<textarea>` | In-place edit textarea (hidden by default) |
| `explainEmpty` | `<div>` | "Run Explain Code..." empty state in explanation tab |
| `explainSkeleton` | `<div>` | 10-line shimmer skeleton for explanation tab |
| `explainContent` | `<div>` | Rendered Markdown explanation content |
| `migratePlaceholder` | `<div>` | Placeholder message in migration tab |
| `migrateSkeleton` | `<div>` | 10-line shimmer skeleton for migration tab |
| `migratedPre` | `<pre>` | Syntax-highlighted migrated code container |
| `migratedCodeEl` | `<code>` | Code element inside migratedPre |
| `copyToast` | `<div>` | Fixed-position copy confirmation toast |
| `statusToast` | `<div>` | Fixed-position status feedback toast |
| `statusToastText` | `<span>` | Text content inside statusToast |

### 5.3 CSS Architecture

All styles are inline in a single `<style>` block. Key sections:

#### Reset
```css
* { margin: 0; padding: 0; box-sizing: border-box; }
```

#### Animated Background
```css
body {
  animation: gradientBG 18s ease infinite;
  background: linear-gradient(-45deg, #0f0c29, #302b63, #24243e, #1a0e3d, #0d1b3e);
  background-size: 400% 400%;
}
@keyframes gradientBG {
  0%   { background-position: 0% 50%; }
  50%  { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
```

#### Layout
```
body (flex column, 100vh)
└── header (flex row, 20px 40px padding, blur backdrop)
└── .main (flex row, 24px 32px padding, flex: 1)
    ├── .left-panel (380px fixed, flex column, overflow hidden)
    │   ├── .left-scroll (flex: 1, overflow-y: auto)
    │   └── .left-footer (flex-shrink: 0)
    └── .right-panel (flex: 1, flex column)
```

#### Colour Palette

| Token | Hex | Usage |
|-------|-----|-------|
| Primary accent | `#a78bfa` | Violet — active tabs, borders, badges |
| Secondary accent | `#60a5fa` | Blue — lang tag, code spans |
| Success | `#34d399` | Green — success toast, explain btn, done btn |
| Error | `#f87171` | Red — error toast, char counter over-limit, clear history |
| Warning | `#fbbf24` | Amber — char counter warn, JSON badge, migrate btn |
| Body text | `#e0e0e0` | Primary text |
| Label text | `#a0a3c4` | Form labels |
| Secondary text | `#7c7f9e` | Secondary text |
| Muted text | `#555878` | Timestamps, placeholders |
| Background deep | `#0f0c29..#0d1b3e` | Animated gradient |
| Panel bg | `rgba(255,255,255,0.03–0.09)` | Glassmorphism surfaces |

#### Shimmer Skeleton Loader
```css
.sk-line {
  height: 12px; border-radius: 6px;
  background: linear-gradient(90deg,
    rgba(255,255,255,0.03) 0%,
    rgba(255,255,255,0.09) 50%,
    rgba(255,255,255,0.03) 100%);
  background-size: 200% 100%;
  animation: shimmer 1.8s ease-in-out infinite;
}
```
Ten `.sk-line` elements per skeleton with staggered `animation-delay` values from `0s` to `0.35s`, and varying widths (25% – 82%) to mimic realistic content.

#### Button Variants

| Class | Gradient / BG | Usage |
|-------|--------------|-------|
| `.btn-primary` | `#7c3aed → #4f46e5` | Generate |
| `.btn-explain` | `#059669 → #0891b2` | Explain Code |
| `.btn-secondary` | `rgba(255,255,255,0.07)` | Download |
| `.btn-migrate` | `#d97706 → #b45309` | Migrate |
| `.copy-btn` | `rgba(255,255,255,0.06)` | Edit / Done / Copy |

All action buttons use `transform: translateY(-1px)` on hover and `translateY(0)` on active.  
`.btn-primary:disabled`, `.btn-explain:disabled`, `.btn-migrate:disabled` → `opacity: 0.6`.  
`.btn-secondary:disabled` → `opacity: 0.35`.

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

#### Highlight.js Overrides
```css
.hljs-ln { border-collapse: collapse; width: 100%; }
.hljs-ln-numbers {
  user-select: none; text-align: right; color: #3a3d5c;
  padding: 0 14px 0 20px; border-right: 1px solid rgba(255,255,255,0.07);
  min-width: 48px;
}
.hljs-ln-code { padding-left: 18px; white-space: pre; }
```

### 5.4 JavaScript — Module-Level State Variables

| Variable | Type | Initial | Description |
|----------|------|---------|-------------|
| `lastCode` | `string` | `''` | Most recently generated/edited code in the Code tab |
| `lastFileType` | `string` | `'tf'` | File type of `lastCode` |
| `historyOpen` | `boolean` | `false` | Whether the history accordion is expanded |
| `activeIndex` | `number` | `-1` | Index of the currently loaded history entry (`-1` = none) |
| `currentTab` | `string` | `'code'` | Active tab: `'code'`, `'explain'`, or `'migrate'` |
| `editMode` | `boolean` | `false` | Whether the code panel is in edit mode |
| `migratedCode` | `string` | `''` | Most recently migrated code |
| `migratedPlatform` | `string` | `''` | Migration target for the current `migratedCode` |
| `history` | `Array` | `[]` | In-memory history array (max 10 entries) |
| `_statusTimer` | `number\|null` | `null` | `setTimeout` handle for success toast auto-dismiss |
| `_autoDetectTimer` | `number\|null` | `null` | `setTimeout` handle for debounced file-type detection |
| `_autoTagTimer` | `number\|null` | `null` | `setTimeout` handle for "auto" badge fade-out |

### 5.5 Constants (JS)

| Constant | Value | Description |
|----------|-------|-------------|
| `API_BASE` | `'http://localhost:3000'` | Base URL for all API calls |
| `langMap` | `{ tf:'hcl', yaml:'yaml', json:'json', sh:'bash' }` | Maps file type to highlight.js language ID |
| `badgeMap` | `{ tf:'TF', yaml:'YAML', json:'JSON', sh:'SH' }` | Maps file type to display badge text |
| `migrateLangMap` | `{ 'github-actions':'yaml', 'jenkins':'groovy' }` | Maps migration target to highlight.js language |
| `migrateExtMap` | `{ 'github-actions':'yml', 'jenkins':'groovy' }` | Maps migration target to file extension |
| `STORAGE_KEY` | `'iac-gen-history'` | `localStorage` key for history persistence |
| `TAB_ORDER` | `['code', 'explain', 'migrate']` | Ordered tab names for keyboard navigation |

### 5.6 JavaScript — Function Reference

#### UI Helpers

---

**`updateLangTag()`**  
Reads `#fileType` value. Sets `#langTag` text to `badgeMap[ft]`. Shows/hides `#migrateSection` using `display: flex` when `ft === 'yaml'`, `display: none` otherwise.

---

**`setStatus(msg, type)`**  
Manages the `#statusToast` element.
- Clears any pending `_statusTimer`.
- If `msg` or `type` is falsy: removes all classes → toast hides.
- Otherwise: sets `#statusToastText` to `msg`; sets `className` to `'status-toast ' + type + ' show'`.
- If `type === 'success'`: schedules `_statusTimer` to remove `.show` after **2500 ms**.
- Loading and error toasts persist until `setStatus` is called again.

---

**`updateDownloadBtn()`**  
Sets `#downloadBtn.disabled = !(lastCode || migratedCode)`.

---

**`setBusy(busy)`**  
Sets `.disabled` on: `#generateBtn`, `#explainBtn`, `#editToggleBtn`, `#doneEditBtn`, `#migrateBtn`.

---

**`getModel()`**  
Returns `document.getElementById('modelSelect').value`.

---

#### Tab Management

**`switchTab(tab)`**  
If `tab === currentTab`, returns early. Updates `currentTab`. For each of `['code','explain','migrate']`: toggles `.tab-active` on both the button (`#tab-{t}`) and the panel (`#tc-{t}`); sets `aria-selected` attribute.

---

**`updateMigrateTab()`**  
`canMigrate = !!(lastCode && lastFileType === 'yaml')`. Disables `#tab-migrate` if false. If tab was active and can no longer migrate, calls `switchTab('code')`.

---

#### Code Panel State

**`showPlaceholder()`**  
Shows `#placeholder` (flex), hides `#skeleton` and `#outputPre`. Calls `updateDownloadBtn()`.

---

**`showSkeleton()`**  
Hides `#placeholder` and `#outputPre`, shows `#skeleton` (flex). Calls `switchTab('code')`.

---

**`renderCode(code, fileType)`**  
1. If `editMode` is true: reset edit mode — hide `#editTextarea`, show `#editToggleBtn`, hide `#doneEditBtn`.
2. Set `#codeEl.textContent = code`, `className = 'language-' + langMap[fileType]`, remove `data-highlighted` attribute.
3. `hljs.highlightElement(codeEl)` then `hljs.lineNumbersBlock(codeEl)`.
4. Hide `#placeholder` and `#skeleton`, show `#outputPre` (block).
5. Set `lastCode = code`, `lastFileType = fileType`.
6. Reset `migratedCode = ''`, `migratedPlatform = ''`; hide `#migratedPre`, show `#migratePlaceholder`.
7. Call `updateMigrateTab()` and `updateDownloadBtn()`.

---

#### Explanation Panel

**`showExplainSkeleton()`**  
Enables `#tab-explain`. Hides `#explainEmpty` and `#explainContent`. Shows `#explainSkeleton` (flex). Calls `switchTab('explain')`.

---

**`showExplanation(text)`**  
Hides `#explainSkeleton`. Hides `#explainEmpty`. Shows `#explainContent` (block). Sets `innerHTML = marked.parse(text)`. Enables `#tab-explain`. Calls `switchTab('explain')`.

---

**`clearExplanation()`**  
Hides `#explainSkeleton`. Shows `#explainEmpty` (flex). Hides and clears `#explainContent` (`innerHTML = ''`). Disables `#tab-explain`. Calls `switchTab('code')`.

---

#### History

**`pushHistory(prompt, fileType, code, explanation)`**  
`history.unshift({ prompt, fileType, code, explanation, ts: Date.now() })`. Trims to 10 entries. Sets `activeIndex = 0`. Calls `saveHistory()` and `renderHistoryList()`.

---

**`renderHistoryList()`**  
1. Updates `#historyCount` text and visibility.
2. Shows/hides `#historyClearBtn`.
3. Removes existing `.history-item` elements.
4. If empty: shows `#historyEmpty`, returns.
5. For each entry: creates a div with `history-item` class (adds `active` if `i === activeIndex`). Sets `onclick = () => loadHistory(i)`. HTML structure:
   ```html
   <div class="history-item-top">
     <span class="history-badge badge-{fileType}">{BADGE}</span>
     <span class="history-time">{timeAgo}</span>
   </div>
   <div class="history-prompt">
     <span class="history-prompt-bold">{first 40 chars}</span>
     <span class="history-prompt-rest">{remainder}</span>
   </div>
   ```

---

**`loadHistory(i)`**  
Sets `activeIndex = i`. Populates `#input` with `item.prompt`, `#fileType` with `item.fileType`. Calls `updateLangTag()`, `renderCode(item.code, item.fileType)`. If explanation exists: `showExplanation`; else `clearExplanation(); switchTab('code')`. Re-renders history list. Sets success status `'Loaded from history.'`.

---

**`clearHistory(event)`**  
`event.stopPropagation()` (prevent accordion toggle). Sets `history.length = 0`. Resets `activeIndex = -1`. Calls `saveHistory()` and `renderHistoryList()`.

---

**`toggleHistory()`**  
Toggles `historyOpen`. Adds/removes `.open` on `#historyList` and `#historyChevron`.

---

**`saveHistory()`**  
```js
localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
```
Silently fails on `localStorage` errors (try/catch).

---

**`loadStoredHistory()`**  
Parses `localStorage.getItem(STORAGE_KEY)` as JSON array. Pushes all entries into `history`. Calls `renderHistoryList()`.

---

**`timeAgo(ts)`**  
`s = Math.floor((Date.now() - ts) / 1000)`:
- `s < 60` → `'just now'`
- `s < 3600` → `'{n}m ago'`
- `s < 86400` → `'{n}h ago'`
- else → `'{n}d ago'`

---

**`escHtml(str)`**  
Replaces `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`. Used before all `innerHTML` insertions of user-supplied text.

---

#### Generate (Streaming)

**`generate()`** — `async`

1. Reads and trims `#input`. Validates non-empty.
2. `setBusy(true)`, show `#spinner`, set `#btnText = 'Generating…'`.
3. `setStatus('Streaming code…', 'loading')`.
4. `clearExplanation(); switchTab('code')`.
5. Disable `#downloadBtn`. Hide `#placeholder`/`#skeleton`. Show `#outputPre`. Clear `#codeEl`.
6. `fetch(API_BASE + '/generate/stream', { method: 'POST', ... })`.
7. On `!res.ok`: reads JSON body for error message; throws `new Error(errMsg)`.
8. Creates `ReadableStream` reader + `TextDecoder`. Loops `reader.read()` until `done`.
9. Each chunk: splits by `\n`, retains trailing incomplete line in `buffer`. For each `data: ` line: parses JSON, extracts `choices[0].delta.content`, appends to `fullCode` + `codeEl.textContent`, scrolls `outputPre` to bottom.
10. After stream ends: strips markdown fences via two regexes:
    - Leading: `/^```[a-z]*\n?/i`
    - Trailing: `/```\s*$/`
11. If `fullCode` is empty: throws `'No code was returned...'`.
12. `renderCode(fullCode, fileType)`, `pushHistory(...)`, success toast.
13. Catch: `showPlaceholder()`, error toast.
14. Finally: `setBusy(false)`, hide spinner, reset button text.

---

#### Explain Code

**`explainCode()`** — `async`  
If `lastCode` truthy → delegates to `explainExistingCode()` and returns.  
Otherwise (fresh generate+explain):
1. Validate `#input` non-empty.
2. `setBusy(true)`, `showSkeleton()`, `showExplainSkeleton()`.
3. `fetch POST /generate` with `explain: true`.
4. `if (!res.ok) throw new Error(data.error || HTTP status)`.
5. `renderCode(data.result, fileType)`.
6. If `data.explanation`: `showExplanation(data.explanation)`.
7. `pushHistory(input, fileType, data.result, data.explanation)`.
8. Catch: `showPlaceholder()`, `clearExplanation()`, error toast.

---

**`explainExistingCode()`** — `async`  
1. `setBusy(true)`, `showExplainSkeleton()`.
2. `fetch POST /explain` with `{ code: lastCode, fileType: lastFileType, model }`.
3. `showExplanation(data.explanation)`.
4. If `activeIndex` is valid: updates `history[activeIndex].explanation` and calls `saveHistory()`.
5. Catch: hides `#explainSkeleton`, shows `#explainEmpty`, error toast.

---

#### Edit

**`toggleEdit()`**  
Guards on `!lastCode`. Sets `editMode = true`. Sets `#editTextarea.value = lastCode`. Shows textarea. Hides `#outputPre`, `#editToggleBtn`. Shows `#doneEditBtn`. Focuses textarea.

---

**`doneEdit()`**  
Reads `#editTextarea.value`. Hides textarea. Shows `#editToggleBtn`. Hides `#doneEditBtn`. Sets `editMode = false`. Calls `renderCode(newCode, lastFileType)`. If `activeIndex` valid: updates `history[activeIndex].code` + `saveHistory()`. Success toast `'Code updated.'`.

---

#### Download / Copy

**`triggerDownload(content, filename)`**  
Creates `new Blob([content], { type: 'text/plain' })`, `URL.createObjectURL(blob)`, synthetic `<a>` with `download = filename`, `.click()`, then `URL.revokeObjectURL(url)`.

---

**`downloadFile()`**  
- `currentTab === 'migrate' && migratedCode` → `triggerDownload(migratedCode, 'migrated.{ext}')` where ext comes from `migrateExtMap`.
- else → guard on `!lastCode`; `triggerDownload(lastCode, 'generated.{lastFileType}')`.

---

**`copyOutput()`**  
Reads content based on active tab:
- `'explain'` → `#explainContent.innerText.trim()`, toast `'Explanation copied!'`
- `'migrate'` → `migratedCode`, toast `'Migration copied!'`
- `'code'` → `lastCode`, toast `'Copied!'`

If content empty: returns. `navigator.clipboard.writeText(content)` → shows `#copyToast` with class `show`, removes after **1800 ms**.

---

#### Migration

**`migrateCode()`** — `async`  
1. Guards on `!lastCode`.
2. `setBusy(true)`. Shows `#migrateSpinner`. Hides `#migratePlaceholder`, `#migratedPre`. Shows `#migrateSkeleton` (flex). Calls `switchTab('migrate')`.
3. `fetch POST /migrate`.
4. `renderMigratedCode(data.result, targetPlatform)`. Success toast.
5. Catch: hides `#migrateSkeleton`, shows `#migratePlaceholder`, error toast.
6. Finally: hides skeleton (double-guarded), `setBusy(false)`, reset button.

---

**`renderMigratedCode(code, platform)`**  
Gets `lang = migrateLangMap[platform]`. Sets `#migratedCodeEl.textContent`, `className = 'language-' + lang`. Removes `data-highlighted`. `hljs.highlightElement()` + `hljs.lineNumbersBlock()`. Hides `#migratePlaceholder`. Shows `#migratedPre`. Calls `updateDownloadBtn()`.

---

### 5.7 Auto File-Type Detection

#### `FILE_TYPE_RULES` array (priority-ordered, first match wins)

| Priority | Type | Patterns |
|----------|------|---------|
| 1 | `tf` | `\bterraform\b`, `\bhcl\b`, `\biac\b`, `infrastructure[\s-]as[\s-]code` |
| 2 | `yaml` | `\byaml\b`, `\bpipeline\b`, `\bgithub[\s-]actions?\b`, `\bci[\s/]?cd\b`, `\bgitlab[\s-]ci\b`, `\bazure[\s-]devops\b`, `\bansible\b`, `\bkubernetes\b`, `\bk8s\b`, `\bhelm\b`, `\bdocker[\s-]?compose\b`, `\bworkflow\b`, `\bjenkinsfile\b`, `\bjenkins\b` |
| 3 | `json` | `\bjson\b`, `\bpackage\.json\b`, `\bappsettings\b` |
| 4 | `sh` | `\bshell[\s-]script\b`, `\bbash[\s-]script\b`, `\bbash\b`, `\bshell\b`, `\bscript\b`, `\bzsh\b` |

All patterns use the `i` (case-insensitive) flag and `\b` word-boundary anchors.

#### `detectAndApplyFileType()`
1. Iterates `FILE_TYPE_RULES` in order.
2. For first matching rule: if `rule.type === fileTypeEl.value`, returns (no-op).
3. Otherwise: sets `fileTypeEl.value = rule.type`, calls `updateLangTag()`.
4. Restarts `.file-type-glow` animation (remove class → force reflow via `offsetWidth` → re-add class).
5. Clears `_autoTagTimer`. Adds `.show` to `#autoTag`. Schedules removal after **2000 ms**.

---

### 5.8 Initialization Block (runs on page load)

```
updateLangTag()
loadStoredHistory()
setInterval(renderHistoryList, 30_000)

keydown on #input → Ctrl/Cmd+Enter → generate()

updateCharCounter() setup:
  input event → updateCharCounter() + debounced detectAndApplyFileType(300ms)

tabBar keydown → ArrowLeft/ArrowRight → switchTab + focus (skip disabled tabs)

isMac = /Mac|iPhone|iPad/.test(navigator.platform)
#shortcutHint.textContent = isMac ? '⌘↵' : 'Ctrl↵'
```

---

### 5.9 `localStorage` Schema

Key: `'iac-gen-history'`  
Value: JSON-serialised array of up to 10 objects:

```json
[
  {
    "prompt": "string",
    "fileType": "tf|yaml|json|sh",
    "code": "string",
    "explanation": "string | null",
    "ts": 1716000000000
  }
]
```

`ts` is a Unix millisecond timestamp from `Date.now()`. Entries are ordered newest-first (index 0 = most recent). `explanation` is `null` when the entry was created via `generate()` alone.

---

### 5.10 Keyboard Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Ctrl+Enter` / `Cmd+Enter` | Prompt textarea focused | Triggers `generate()` |
| `ArrowRight` | Tab bar focused | Move to next enabled tab |
| `ArrowLeft` | Tab bar focused | Move to previous enabled tab |

---

### 5.11 Toast System

Two independent toast elements:

#### Copy Toast (`#copyToast`)
- Position: `fixed; bottom: 28px; left: 50%` (centred)
- Transition: `opacity + translateY` in 180 ms
- Shows on `clipboard.writeText` success
- Auto-hides after **1800 ms**

#### Status Toast (`#statusToast`)
- Position: `fixed; top: 72px; right: 32px`
- Contains: `.status-toast-spinner` (CSS spinner, only visible on `.loading`) + `#statusToastText`
- Three states:

| Class | Background | Border | Text |
|-------|-----------|--------|------|
| `.success` | `rgba(5,150,105,0.18)` | `rgba(52,211,153,0.3)` | `#34d399` |
| `.error` | `rgba(239,68,68,0.18)` | `rgba(248,113,113,0.3)` | `#f87171` |
| `.loading` | `rgba(124,58,237,0.18)` | `rgba(167,139,250,0.3)` | `#a78bfa` |

- Loading: persists until next `setStatus()` call
- Success: auto-dismisses after **2500 ms**
- Error: persists until next `setStatus()` call

---

## 6. API Contract Summary

### `POST /generate`

| Field | Request | Response (200) |
|-------|---------|----------------|
| `input` | prompt string (≤4000 chars) | — |
| `fileType` | tf / yaml / json / sh | — |
| `explain` | boolean | — |
| `model` | model ID string | — |
| `result` | — | generated code string |
| `explanation` | — | explanation string (if explain=true) |

Error: `{ "error": "message" }` with status 400 or 502.

### `POST /generate/stream`

SSE stream. Emits `data: <JSON>\n\n` lines. Each JSON: `{ "choices": [{ "delta": { "content": "token" } }] }`. Terminates with `data: [DONE]\n\n`.

Error mid-stream: `data: { "error": "message" }\n\n`.

### `POST /explain`

| Field | Request | Response (200) |
|-------|---------|----------------|
| `code` | code string (≤8000 chars) | — |
| `fileType` | tf / yaml / json / sh | — |
| `model` | model ID string | — |
| `explanation` | — | explanation string |

### `POST /migrate`

| Field | Request | Response (200) |
|-------|---------|----------------|
| `code` | YAML string (≤8000 chars) | — |
| `targetPlatform` | github-actions / jenkins | — |
| `model` | model ID string | — |
| `result` | — | migrated code string |

---

## 7. Error Handling Matrix

| Scenario | Where caught | User feedback |
|----------|-------------|---------------|
| Empty prompt | `generate()` / `explainCode()` — before fetch | Error toast: `'Please enter a prompt.'` |
| Server not running | `fetch` rejects (`TypeError`) | Error toast: `'Request failed — is the server running?'` |
| HTTP 4xx (validation) | Server returns JSON error body | Error toast: server's `error` field |
| HTTP 5xx (LLM error) | Server returns 502 with `errorMessage(err)` | Error toast: model error message |
| Rate limit hit | Server returns 429 + JSON error | Error toast: `'Too many requests — please wait...'` |
| Empty stream response | `fullCode` check after stream ends | Error toast: `'No code was returned...'` |
| Clipboard denied | `navigator.clipboard` rejects | Silent fail (copy toast not shown) |
| `localStorage` full | `try/catch` in `saveHistory()` | Silent fail (history not persisted) |
| No code to edit | `toggleEdit()` guard | Error toast: `'Nothing to edit yet.'` |
| No code to download | `downloadFile()` guard | Error toast: `'No content to download.'` |
| No YAML to migrate | `migrateCode()` guard | Error toast: `'No YAML code to migrate.'` |

---

## 8. Model Configuration Details

| Model ID | Provider | Notes |
|----------|---------|-------|
| `gpt-4o-mini` | OpenAI | Default — fast and cheap |
| `gpt-4o` | OpenAI | Advanced |
| `gpt-4.1` | OpenAI | Latest |
| `gpt-4.1-mini` | OpenAI | Fast, latest |
| `o3-mini` | OpenAI | Reasoning |
| `o4-mini` | OpenAI | Fast reasoning |
| `meta-llama-3.3-70b-instruct` | Meta | Open-weight, capable |
| `meta-llama-3.1-405b-instruct` | Meta | Open-weight, largest |
| `Mistral-Large-2411` | Mistral | Advanced |
| `Codestral-2501` | Mistral | Code specialist |
| `Phi-4` | Microsoft | Compact, smart |
| `deepseek-v3` | DeepSeek | Strong coder — **non-streaming** |

All models share:
- Endpoint: `https://models.inference.ai.azure.com/chat/completions`
- Auth: `Authorization: Bearer <GITHUB_TOKEN>`
- `temperature: 0.3` (generate/explain), `0.2` (migrate)
- `max_tokens: 4096` (generate/migrate), `2048` (explain)
