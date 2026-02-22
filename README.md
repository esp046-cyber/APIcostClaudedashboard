# ⚡ ClaudeMetrics — API Cost Tracker

A two-mode Claude API cost tracker: **manual entry** (no server needed) and **auto-logging** via a local proxy server that stores everything in SQLite.

---

## What this actually is (honest description)

| Mode | How it works | What's "real-time" |
|------|-------------|-------------------|
| **Manual** | You enter token counts yourself | Nothing — you type the data |
| **Server (proxy)** | Your app calls `localhost:3000/api/proxy` instead of `api.anthropic.com` — the server forwards the call, reads token usage from the response, and saves it to SQLite | ✅ Automatic — logged on every API call |

> **Why not pull from Anthropic's billing API?**
> Anthropic's `/v1/usage` endpoint requires a **Workspace Admin API key**, not a standard user key. Most developers get a `403 Forbidden`. The proxy approach is the reliable alternative — it logs usage from the actual API response.

---

## Files

```
claudemetrics/
├── server.js        ← Node.js/Express backend
├── index.html       ← Dashboard (served by server OR opened directly)
├── package.json     ← Dependencies
├── .env.example     ← Copy to .env and add your API key
├── .env             ← Your secrets (never commit this)
├── usage.db         ← SQLite database (auto-created on first run)
└── README.md
```

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

Installs: `express`, `better-sqlite3`, `node-fetch`, `dotenv`

**Requirements:** Node.js ≥ 18

---

### 2. Add your API key

```bash
cp .env.example .env
```

Edit `.env`:
```
ANTHROPIC_API_KEY=sk-ant-api03-your-real-key-here
PORT=3000
```

> ⚠️ **Your API key never touches the browser.** It lives in `.env` and is only used server-side to forward requests to Anthropic.

---

### 3. Start the server

```bash
node server.js
# or for auto-reload during development:
node --watch server.js
```

Output:
```
╔══════════════════════════════════════════╗
║       ClaudeMetrics Server               ║
╠══════════════════════════════════════════╣
║  Dashboard  →  http://localhost:3000     ║
║  Proxy URL  →  http://localhost:3000/api/proxy  ║
║  Health     →  http://localhost:3000/api/health ║
╠══════════════════════════════════════════╣
║  API Key loaded: ✅ YES                  ║
╚══════════════════════════════════════════╝
```

---

### 4. Open the dashboard

```
http://localhost:3000
```

The dashboard auto-detects the server and switches to **"Server Connected"** mode. It polls every 10 seconds for new data.

---

## How to Use the Proxy

This is the key feature. Replace `api.anthropic.com` with `localhost:3000` in your code:

### JavaScript / Node.js

```js
// BEFORE (direct to Anthropic)
const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
  },
  body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [...] }),
});

// AFTER (through proxy — auto-logs usage)
const response = await fetch('http://localhost:3000/api/proxy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  // No API key needed here — server adds it
  body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [...] }),
});
```

The proxy:
1. Adds your API key from `.env`
2. Forwards the request to Anthropic
3. Reads `input_tokens` and `output_tokens` from the response
4. Saves them to `usage.db`
5. Returns the original Anthropic response unmodified

### Python

```python
import requests

# AFTER (through proxy)
response = requests.post(
    'http://localhost:3000/api/proxy',
    json={
        'model': 'claude-sonnet-4-5',
        'max_tokens': 1024,
        'messages': [{'role': 'user', 'content': 'Hello!'}]
    }
)
data = response.json()
```

### Streaming

Streaming is supported. The server parses SSE events to extract token counts from `message_start` events.

```js
const response = await fetch('http://localhost:3000/api/proxy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    stream: true,
    messages: [...]
  }),
});
// Handle as normal SSE stream — token logging happens server-side
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/health` | Server status + key loaded check |
| `POST` | `/api/proxy` | Proxy to Anthropic + auto-log |
| `GET`  | `/api/logs` | All logged requests (JSON) |
| `GET`  | `/api/logs?days=7&limit=100` | Filtered logs |
| `POST` | `/api/manual` | Manually log a request |
| `GET`  | `/api/summary` | Daily cost summaries for charts |
| `GET`  | `/api/usage` | Attempt Anthropic usage API (may 403) |
| `GET`  | `/api/export?format=json` | Export all logs as JSON |
| `GET`  | `/api/export?format=csv` | Export all logs as CSV |
| `DELETE` | `/api/logs` | Delete all logs |

---

## Security Notes

### What IS safe ✅

- **API key in `.env` only** — never sent to the browser, never in responses
- **CORS locked to localhost** — the server rejects requests from any non-localhost origin
- **Local-only** — nothing is sent to any external service except Anthropic (via proxy)
- **SQLite on disk** — your data stays on your machine

### What is NOT safe for production ⚠️

- **No authentication** — anyone on your network who can reach port 3000 can call the proxy
- **No rate limiting** — a malicious caller could run up your API bill
- **HTTP only** — not HTTPS (fine for localhost, not for public deployment)
- **Single-user** — no multi-tenant support

### If you want to deploy publicly

1. Add API key authentication middleware
2. Enable HTTPS (use nginx or Caddy as a reverse proxy)
3. Add rate limiting (e.g., `express-rate-limit`)
4. Add request signing or an allowlist
5. Move to a proper secrets manager (AWS Secrets Manager, etc.)

---

## Manual Mode (no server)

Open `index.html` directly in a browser (double-click or `file://...`). Everything works offline:

- Enter token counts manually in the Log Request form
- Data saved to `localStorage`
- No server, no API key, no internet required
- Works as a PWA (installable on mobile)

---

## Database Schema

```sql
-- Every logged request
CREATE TABLE requests (
  id                  INTEGER PRIMARY KEY,
  request_id          TEXT UNIQUE,
  model               TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER,
  cost_usd            REAL,
  source              TEXT,   -- 'proxy' | 'manual' | 'sim'
  endpoint            TEXT,
  created_at          TEXT
);

-- Aggregated per day (fast dashboard queries)
CREATE TABLE daily_summary (
  date                TEXT PRIMARY KEY,
  total_cost          REAL,
  total_requests      INTEGER,
  total_input_tokens  INTEGER,
  total_output_tokens INTEGER,
  updated_at          TEXT
);
```

---

## Anthropic Usage API (why it probably won't work)

The server tries `GET https://api.anthropic.com/v1/usage` with your key. Here's what you'll get:

| Key type | Result |
|----------|--------|
| Standard user API key | `403 Forbidden` |
| Workspace Admin key | ✅ Returns usage data |

Most developers have standard keys. The proxy approach is the reliable alternative — it logs usage from every actual API response automatically.

To check your key type: [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)

---

## Add to .gitignore

```
.env
usage.db
node_modules/
```

---

## License

MIT — use freely, attribution appreciated.
