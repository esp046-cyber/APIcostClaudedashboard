/**
 * ClaudeMetrics — Backend Server
 * ─────────────────────────────────────────────────────────────
 * What this does:
 *   1. Serves index.html at localhost:3000
 *   2. Proxies your Claude API calls → auto-logs token usage to SQLite
 *   3. Fetches Anthropic usage/billing data (if your key has access)
 *   4. Exposes REST endpoints the dashboard polls every 10s
 *
 * Security:
 *   - API key lives in .env only — never sent to the browser
 *   - CORS locked to localhost
 *   - No API key is ever exposed in responses
 *
 * Run:
 *   npm install
 *   node server.js
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const express    = require('express');
const Database   = require('better-sqlite3');
const fetch      = require('node-fetch');
const path       = require('path');
const crypto     = require('crypto');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// CORS — localhost only for safety
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (!origin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
    res.setHeader('Access-Control-Allow-Origin',  origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve dashboard
app.use(express.static(path.join(__dirname)));

// ─── SQLite Setup ─────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'usage.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id  TEXT    UNIQUE,
    model       TEXT    NOT NULL,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens   INTEGER DEFAULT 0,
    cache_write_tokens  INTEGER DEFAULT 0,
    cost_usd    REAL    NOT NULL DEFAULT 0,
    source      TEXT    DEFAULT 'proxy',   -- 'proxy' | 'manual' | 'import'
    endpoint    TEXT,
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_summary (
    date        TEXT PRIMARY KEY,
    total_cost  REAL DEFAULT 0,
    total_requests INTEGER DEFAULT 0,
    total_input_tokens  INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ─── Pricing Table (per 1M tokens, USD) ──────────────────────
const PRICES = {
  'claude-opus-4-5':          { in: 15.00, out: 75.00 },
  'claude-sonnet-4-5':        { in:  3.00, out: 15.00 },
  'claude-haiku-4-5':         { in:  0.80, out:  4.00 },
  'claude-3-opus-20240229':   { in: 15.00, out: 75.00 },
  'claude-3-5-sonnet-20241022':{ in: 3.00, out: 15.00 },
  'claude-3-haiku-20240307':  { in:  0.25, out:  1.25 },
  'claude-3-5-haiku-20241022':{ in:  0.80, out:  4.00 },
};

function calcCost(model, inputTok, outputTok) {
  // Match by prefix if exact not found
  const key = Object.keys(PRICES).find(k => model.startsWith(k) || k.startsWith(model)) || 'claude-sonnet-4-5';
  const p   = PRICES[key];
  return (inputTok * p.in + outputTok * p.out) / 1_000_000;
}

// ─── DB Helpers ───────────────────────────────────────────────
const insertRequest = db.prepare(`
  INSERT OR IGNORE INTO requests
    (request_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, source, endpoint)
  VALUES
    (@request_id, @model, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @cost_usd, @source, @endpoint)
`);

const updateDaily = db.prepare(`
  INSERT INTO daily_summary (date, total_cost, total_requests, total_input_tokens, total_output_tokens)
  VALUES (@date, @cost, 1, @input, @output)
  ON CONFLICT(date) DO UPDATE SET
    total_cost            = total_cost + excluded.total_cost,
    total_requests        = total_requests + 1,
    total_input_tokens    = total_input_tokens + excluded.total_input_tokens,
    total_output_tokens   = total_output_tokens + excluded.total_output_tokens,
    updated_at            = datetime('now')
`);

function logRequest(data) {
  const record = {
    request_id:          data.request_id || crypto.randomUUID(),
    model:               data.model,
    input_tokens:        data.input_tokens  || 0,
    output_tokens:       data.output_tokens || 0,
    cache_read_tokens:   data.cache_read_tokens  || 0,
    cache_write_tokens:  data.cache_write_tokens || 0,
    cost_usd:            calcCost(data.model, data.input_tokens || 0, data.output_tokens || 0),
    source:              data.source   || 'proxy',
    endpoint:            data.endpoint || '/v1/messages',
  };

  const today = new Date().toISOString().slice(0, 10);

  db.transaction(() => {
    insertRequest.run(record);
    updateDaily.run({
      date:   today,
      cost:   record.cost_usd,
      input:  record.input_tokens,
      output: record.output_tokens,
    });
  })();

  return record;
}

// ─── ROUTE: Health check ──────────────────────────────────────
app.get('/api/health', (req, res) => {
  const keySet = !!process.env.ANTHROPIC_API_KEY;
  res.json({
    status:    'ok',
    version:   '1.0.0',
    keyLoaded: keySet,
    dbPath:    path.join(__dirname, 'usage.db'),
    timestamp: new Date().toISOString(),
  });
});

// ─── ROUTE: GET /api/logs ─────────────────────────────────────
// Returns all logged requests (newest first), optional ?limit=N&days=N
app.get('/api/logs', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
    const days  = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const rows = db.prepare(`
      SELECT * FROM requests
      WHERE date(created_at) >= ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(since, limit);

    const summary = db.prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0)        AS total_cost,
        COALESCE(SUM(input_tokens), 0)    AS total_input,
        COALESCE(SUM(output_tokens), 0)   AS total_output,
        COUNT(*)                           AS total_requests
      FROM requests
    `).get();

    const today = new Date().toISOString().slice(0, 10);
    const todayRow = db.prepare(`
      SELECT * FROM daily_summary WHERE date = ?
    `).get(today);

    res.json({ rows, summary, today: todayRow || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ROUTE: GET /api/summary ──────────────────────────────────
// Daily summary for chart
app.get('/api/summary', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const rows = db.prepare(`
      SELECT * FROM daily_summary
      ORDER BY date DESC
      LIMIT ?
    `).all(days);
    res.json(rows.reverse());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ROUTE: POST /api/manual ─────────────────────────────────
// Manually log a request (from the dashboard form)
app.post('/api/manual', (req, res) => {
  try {
    const { model, input_tokens, output_tokens } = req.body;
    if (!model) return res.status(400).json({ error: 'model is required' });

    const record = logRequest({
      model,
      input_tokens:  parseInt(input_tokens)  || 0,
      output_tokens: parseInt(output_tokens) || 0,
      source:        'manual',
    });

    res.json({ ok: true, record });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ROUTE: POST /api/proxy ───────────────────────────────────
// Drop-in proxy for Anthropic API. Use this URL instead of api.anthropic.com
// e.g. fetch('http://localhost:3000/api/proxy', { method:'POST', body: JSON.stringify({...}) })
app.post('/api/proxy', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY not set in .env — the server cannot proxy without it.'
    });
  }

  try {
    const body      = req.body;
    const model     = body.model || 'claude-sonnet-4-5';
    const stream    = body.stream === true;
    const requestId = crypto.randomUUID();

    // Forward to Anthropic
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key':         apiKey,
      },
      body: JSON.stringify(body),
    });

    if (stream) {
      // ── Streaming mode ──────────────────────────────────────
      res.setHeader('Content-Type',  'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection',    'keep-alive');

      let inputTok = 0, outputTok = 0;

      upstream.body.on('data', chunk => {
        const text = chunk.toString();
        res.write(text);

        // Parse SSE events to extract usage
        text.split('\n').forEach(line => {
          if (!line.startsWith('data: ')) return;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'message_start' && evt.message?.usage) {
              inputTok  = evt.message.usage.input_tokens  || 0;
              outputTok = evt.message.usage.output_tokens || 0;
            }
            if (evt.type === 'message_delta' && evt.usage) {
              outputTok = evt.usage.output_tokens || outputTok;
            }
          } catch (_) {}
        });
      });

      upstream.body.on('end', () => {
        res.end();
        if (inputTok || outputTok) {
          logRequest({ request_id: requestId, model, input_tokens: inputTok, output_tokens: outputTok, source: 'proxy' });
          console.log(`[proxy] ${model} | in:${inputTok} out:${outputTok} | $${calcCost(model, inputTok, outputTok).toFixed(6)}`);
        }
      });

      upstream.body.on('error', err => {
        console.error('[proxy] stream error:', err.message);
        res.end();
      });

    } else {
      // ── Non-streaming mode ──────────────────────────────────
      const data = await upstream.json();

      if (!upstream.ok) {
        return res.status(upstream.status).json(data);
      }

      const usage = data.usage || {};
      logRequest({
        request_id:         requestId,
        model:              data.model || model,
        input_tokens:       usage.input_tokens          || 0,
        output_tokens:      usage.output_tokens         || 0,
        cache_read_tokens:  usage.cache_read_input_tokens  || 0,
        cache_write_tokens: usage.cache_creation_input_tokens || 0,
        source:             'proxy',
      });

      console.log(`[proxy] ${model} | in:${usage.input_tokens} out:${usage.output_tokens} | $${calcCost(model, usage.input_tokens||0, usage.output_tokens||0).toFixed(6)}`);
      res.status(upstream.status).json(data);
    }

  } catch (e) {
    console.error('[proxy] error:', e.message);
    res.status(502).json({ error: 'Proxy error: ' + e.message });
  }
});

// ─── ROUTE: GET /api/usage ────────────────────────────────────
// Attempt to fetch Anthropic's own usage API (requires Workspace API key)
// NOTE: As of 2025, this requires an Anthropic Workspace Admin key,
// not a standard user API key. Most users will get a 403.
app.get('/api/usage', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    // Anthropic usage API — requires workspace admin access
    const startDate = req.query.start_date || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const response = await fetch(
      `https://api.anthropic.com/v1/usage?start_date=${startDate}`,
      {
        headers: {
          'anthropic-version': '2023-06-01',
          'x-api-key':         apiKey,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.json({
        available: false,
        status:    response.status,
        note:      'Anthropic usage API requires a Workspace Admin API key. Standard user keys get a 403. Your proxy logs are the reliable source.',
        error:     data,
      });
    }

    res.json({ available: true, data });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── ROUTE: DELETE /api/logs ──────────────────────────────────
app.delete('/api/logs', (req, res) => {
  try {
    db.exec('DELETE FROM requests; DELETE FROM daily_summary;');
    res.json({ ok: true, message: 'All logs deleted.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ROUTE: GET /api/export ───────────────────────────────────
app.get('/api/export', (req, res) => {
  try {
    const fmt  = req.query.format || 'json';
    const rows = db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all();

    if (fmt === 'csv') {
      const header = 'id,request_id,model,input_tokens,output_tokens,cost_usd,source,created_at\n';
      const csv    = rows.map(r =>
        `${r.id},${r.request_id},${r.model},${r.input_tokens},${r.output_tokens},${r.cost_usd},${r.source},${r.created_at}`
      ).join('\n');
      res.setHeader('Content-Type',        'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="claudemetrics-export.csv"');
      return res.send(header + csv);
    }

    res.setHeader('Content-Type',        'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="claudemetrics-export.json"');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Fallback → serve index.html ─────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║       ClaudeMetrics Server               ║
╠══════════════════════════════════════════╣
║  Dashboard  →  http://localhost:${PORT}     ║
║  Proxy URL  →  http://localhost:${PORT}/api/proxy  ║
║  Health     →  http://localhost:${PORT}/api/health ║
╠══════════════════════════════════════════╣
║  API Key loaded: ${process.env.ANTHROPIC_API_KEY ? '✅ YES' : '❌ NO — add to .env'}   ║
╚══════════════════════════════════════════╝
  `);
});
