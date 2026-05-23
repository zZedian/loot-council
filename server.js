/**
 * ⚔️  LOOT COUNCIL — Public Server
 * ==================================
 * Pure Node.js, no dependencies.
 * Deploy to Railway, Render, Fly.io, or any Node host.
 *
 * Sessions are kept in memory — they reset on server restart.
 * For persistence across restarts, sessions auto-expire after 24h.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── In-memory session store ──────────────────────────────────────────────────
const sessions = {};

// Purge expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(sessions)) {
    if (now - sessions[id].createdAt > SESSION_TTL_MS) {
      delete sessions[id];
      console.log(`[~] Session ${id} expired and removed`);
    }
  }
}, 60 * 60 * 1000);

function genCode() {
  // 6-char alphanumeric, unambiguous chars (no 0/O/I/1)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function sendJSON(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── API handlers ─────────────────────────────────────────────────────────────
async function handleAPI(req, res) {
  const url  = new URL(req.url, `http://localhost`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') return sendJSON(res, 200, {});

  // POST /api/session — create
  if (req.method === 'POST' && path === '/api/session') {
    const body = await readBody(req);
    if (!Array.isArray(body.items) || !body.items.length)
      return sendJSON(res, 400, { error: 'items required' });
    if (!Array.isArray(body.participants) || !body.participants.length)
      return sendJSON(res, 400, { error: 'participants required' });

    // Ensure unique code
    let id;
    do { id = genCode(); } while (sessions[id]);

    sessions[id] = {
      id,
      items:        body.items.slice(0, 50),
      participants: body.participants.slice(0, 30),
      votes:        {},
      resolved:     false,
      results:      null,
      rollLog:      null,
      createdAt:    Date.now(),
    };
    console.log(`[+] ${id} created — ${body.items.length} items, ${body.participants.length} players`);
    return sendJSON(res, 200, { id });
  }

  // GET /api/session/:id
  if (req.method === 'GET' && path.match(/^\/api\/session\/[A-Z0-9]{4,8}$/)) {
    const id = path.split('/')[3];
    const s  = sessions[id];
    if (!s) return sendJSON(res, 404, { error: 'Session not found' });
    return sendJSON(res, 200, s);
  }

  // POST /api/session/:id/vote
  if (req.method === 'POST' && path.match(/^\/api\/session\/[A-Z0-9]{4,8}\/vote$/)) {
    const id = path.split('/')[3];
    const s  = sessions[id];
    if (!s)          return sendJSON(res, 404, { error: 'Session not found' });
    if (s.resolved)  return sendJSON(res, 400, { error: 'Session already resolved' });

    const body = await readBody(req);
    if (!body.name || !s.participants.includes(body.name))
      return sendJSON(res, 400, { error: 'Invalid participant name' });

    s.votes[body.name] = body.votes;
    const total = Object.keys(s.votes).length;
    console.log(`[v] ${body.name} voted in ${id} (${total}/${s.participants.length})`);
    return sendJSON(res, 200, { ok: true });
  }

  // POST /api/session/:id/resolve
  if (req.method === 'POST' && path.match(/^\/api\/session\/[A-Z0-9]{4,8}\/resolve$/)) {
    const id = path.split('/')[3];
    const s  = sessions[id];
    if (!s)         return sendJSON(res, 404, { error: 'Session not found' });
    if (s.resolved) return sendJSON(res, 200, s);

    const playerLoot = {};
    const rollLog    = {};

    s.items.forEach((item, idx) => {
      const needers  = [];
      const greeders = [];

      s.participants.forEach(p => {
        const vote = s.votes[p]?.[idx];
        if (vote === 'need')  needers.push(p);
        if (vote === 'greed') greeders.push(p);
      });

      const pool   = needers.length ? needers : greeders;
      const rolls  = {};
      let winner   = null;

      if (pool.length) {
        let best = -1;
        pool.forEach(p => {
          const roll = Math.floor(Math.random() * 100) + 1;
          rolls[p]   = { roll, type: needers.includes(p) ? 'need' : 'greed' };
          if (roll > best) { best = roll; winner = p; }
        });
      }

      s.participants.forEach(p => {
        if (s.votes[p]?.[idx] === 'pass') rolls[p] = { roll: null, type: 'pass' };
      });

      rollLog[idx] = rolls;
      if (winner) {
        playerLoot[winner] = playerLoot[winner] || [];
        playerLoot[winner].push(item);
      }
    });

    s.resolved = true;
    s.results  = playerLoot;
    s.rollLog  = rollLog;
    console.log(`[!] ${id} resolved`);
    return sendJSON(res, 200, s);
  }

  return sendJSON(res, 404, { error: 'Not found' });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const p   = url.pathname;

  // API
  if (p.startsWith('/api/')) {
    try { await handleAPI(req, res); }
    catch (e) {
      console.error(e);
      sendJSON(res, 500, { error: 'Internal server error' });
    }
    return;
  }

  // Static files from /public
  const staticMap = {
    '/':           ['public/index.html', 'text/html'],
    '/index.html': ['public/index.html', 'text/html'],
  };

  const [file, mime] = staticMap[p] || [];
  if (file) {
    serveFile(res, path.join(__dirname, file), mime);
  } else {
    // SPA fallback — always serve index.html
    serveFile(res, path.join(__dirname, 'public/index.html'), 'text/html');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚔️  LOOT COUNCIL running on port ${PORT}\n`);
});
