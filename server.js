/**
 * ⚔️  LOOT COUNCIL — Public Server
 * Pure Node.js, no dependencies.
 * Deploy to Railway, Render, Fly.io, or any Node host.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT          = process.env.PORT || 3000;
const SESSION_TTL   = 24 * 60 * 60 * 1000;

const sessions = {};

setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(sessions)) {
    if (now - sessions[id].createdAt > SESSION_TTL) {
      delete sessions[id];
      console.log(`[~] Session ${id} expired`);
    }
  }
}, 60 * 60 * 1000);

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function sendJSON(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch(e) { reject(e); } });
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

function rollForItem(session, itemIdx) {
  const item      = session.items[itemIdx];
  const needers   = [];
  const greeders  = [];
  session.participants.forEach(p => {
    const v = session.votes[p]?.[itemIdx];
    if (v === 'need')  needers.push(p);
    if (v === 'greed') greeders.push(p);
  });
  const pool  = needers.length ? needers : greeders;
  const rolls = {};
  let winner  = null;

  if (pool.length) {
    let best = -1;
    pool.forEach(p => {
      const roll = Math.floor(Math.random() * 100) + 1;
      rolls[p]   = { roll, type: needers.includes(p) ? 'need' : 'greed' };
      if (roll > best) { best = roll; winner = p; }
    });
  }
  session.participants.forEach(p => {
    if (session.votes[p]?.[itemIdx] === 'pass') rolls[p] = { roll: null, type: 'pass' };
  });

  return { rolls, winner, item };
}

async function handleAPI(req, res) {
  const url  = new URL(req.url, 'http://localhost');
  const p    = url.pathname;

  if (req.method === 'OPTIONS') return sendJSON(res, 200, {});

  // POST /api/session — create
  if (req.method === 'POST' && p === '/api/session') {
    const body = await readBody(req);
    if (!Array.isArray(body.items) || !body.items.length)        return sendJSON(res, 400, { error: 'items required' });
    if (!Array.isArray(body.participants) || !body.participants.length) return sendJSON(res, 400, { error: 'participants required' });
    let id; do { id = genCode(); } while (sessions[id]);
    sessions[id] = {
      id,
      items:           body.items.slice(0, 50),
      participants:    body.participants.slice(0, 30),
      rollMode:        body.rollMode || 'quick',
      votes:           {},
      resolved:        false,
      dramaticStarted: false,
      currentItem:     0,
      itemRolls:       {},
      results:         null,
      rollLog:         null,
      createdAt:       Date.now(),
    };
    console.log(`[+] ${id} — ${body.rollMode} mode, ${body.items.length} items, ${body.participants.length} players`);
    return sendJSON(res, 200, { id });
  }

  // GET /api/session/:id
  if (req.method === 'GET' && p.match(/^\/api\/session\/[A-Z0-9]{4,8}$/)) {
    const id = p.split('/')[3];
    const s  = sessions[id];
    if (!s) return sendJSON(res, 404, { error: 'Session not found' });
    return sendJSON(res, 200, s);
  }

  // POST /api/session/:id/vote
  if (req.method === 'POST' && p.match(/^\/api\/session\/[A-Z0-9]{4,8}\/vote$/)) {
    const id = p.split('/')[3];
    const s  = sessions[id];
    if (!s)         return sendJSON(res, 404, { error: 'Session not found' });
    if (s.resolved) return sendJSON(res, 400, { error: 'Session already resolved' });
    const body = await readBody(req);
    if (!body.name || !s.participants.includes(body.name)) return sendJSON(res, 400, { error: 'Invalid participant name' });
    s.votes[body.name] = body.votes;
    console.log(`[v] ${body.name} voted in ${id} (${Object.keys(s.votes).length}/${s.participants.length})`);
    return sendJSON(res, 200, { ok: true });
  }

  // POST /api/session/:id/start — dramatic mode: GM signals rolling has begun
  if (req.method === 'POST' && p.match(/^\/api\/session\/[A-Z0-9]{4,8}\/start$/)) {
    const id = p.split('/')[3];
    const s  = sessions[id];
    if (!s) return sendJSON(res, 404, { error: 'Session not found' });
    s.dramaticStarted = true;
    console.log(`[>] ${id} dramatic roll started`);
    return sendJSON(res, 200, s);
  }

  // POST /api/session/:id/resolve — quick mode: roll everything at once
  if (req.method === 'POST' && p.match(/^\/api\/session\/[A-Z0-9]{4,8}\/resolve$/)) {
    const id = p.split('/')[3];
    const s  = sessions[id];
    if (!s)         return sendJSON(res, 404, { error: 'Session not found' });
    if (s.resolved) return sendJSON(res, 200, s);

    const playerLoot = {};
    const rollLog    = {};
    s.items.forEach((_, idx) => {
      const { rolls, winner } = rollForItem(s, idx);
      rollLog[idx] = rolls;
      if (winner) { playerLoot[winner] = playerLoot[winner] || []; playerLoot[winner].push(s.items[idx]); }
    });
    s.resolved = true;
    s.results  = playerLoot;
    s.rollLog  = rollLog;
    console.log(`[!] ${id} resolved (quick)`);
    return sendJSON(res, 200, s);
  }

  // POST /api/session/:id/rollitem — dramatic mode: roll one item, triggered by each participant
  if (req.method === 'POST' && p.match(/^\/api\/session\/[A-Z0-9]{4,8}\/rollitem$/)) {
    const id   = p.split('/')[3];
    const s    = sessions[id];
    if (!s) return sendJSON(res, 404, { error: 'Session not found' });
    const body = await readBody(req);
    const idx  = s.currentItem;
    if (idx >= s.items.length) return sendJSON(res, 400, { error: 'All items already rolled' });

    // Store individual roll for this participant
    if (!s.itemRolls[idx]) s.itemRolls[idx] = { rolls: {}, rolledBy: [] };
    const ir    = s.itemRolls[idx];
    const name  = body.name;
    const vtype = s.votes[name]?.[idx];

    if (!ir.rolls[name] && vtype !== 'pass') {
      const roll     = Math.floor(Math.random() * 100) + 1;
      ir.rolls[name] = { roll, type: vtype || 'greed' };
      ir.rolledBy.push(name);
      console.log(`[r] ${name} rolled ${roll} for item ${idx} in ${id}`);
    } else if (vtype === 'pass') {
      ir.rolls[name] = { roll: null, type: 'pass' };
      if (!ir.rolledBy.includes(name)) ir.rolledBy.push(name);
    }

    return sendJSON(res, 200, { ok: true, rolls: ir.rolls });
  }

  // POST /api/session/:id/nextitem — GM advances to next item in dramatic mode
  if (req.method === 'POST' && p.match(/^\/api\/session\/[A-Z0-9]{4,8}\/nextitem$/)) {
    const id = p.split('/')[3];
    const s  = sessions[id];
    if (!s) return sendJSON(res, 404, { error: 'Session not found' });

    const idx = s.currentItem;
    // Finalise current item — anyone who didn't roll yet gets auto-rolled or pass
    if (!s.itemRolls[idx]) s.itemRolls[idx] = { rolls: {}, rolledBy: [] };
    const ir = s.itemRolls[idx];
    s.participants.forEach(p => {
      if (!ir.rolls[p]) {
        const vtype = s.votes[p]?.[idx];
        if (vtype === 'pass' || !vtype) {
          ir.rolls[p] = { roll: null, type: 'pass' };
        } else {
          ir.rolls[p] = { roll: Math.floor(Math.random() * 100) + 1, type: vtype };
        }
      }
    });

    // Determine winner for this item
    let winner = null, best = -1;
    const needers  = Object.entries(ir.rolls).filter(([,v]) => v.type === 'need');
    const greeders = Object.entries(ir.rolls).filter(([,v]) => v.type === 'greed');
    const pool     = needers.length ? needers : greeders;
    pool.forEach(([p, v]) => { if (v.roll > best) { best = v.roll; winner = p; } });
    ir.winner = winner;

    s.currentItem++;

    // If all items done, finalise session
    if (s.currentItem >= s.items.length) {
      const playerLoot = {};
      const rollLog    = {};
      s.items.forEach((item, i) => {
        const r = s.itemRolls[i] || { rolls: {}, winner: null };
        rollLog[i] = r.rolls;
        if (r.winner) { playerLoot[r.winner] = playerLoot[r.winner] || []; playerLoot[r.winner].push(item); }
      });
      s.resolved = true;
      s.results  = playerLoot;
      s.rollLog  = rollLog;
      console.log(`[!] ${id} resolved (dramatic)`);
    }

    return sendJSON(res, 200, s);
  }

  return sendJSON(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p   = url.pathname;
  if (p.startsWith('/api/')) {
    try { await handleAPI(req, res); }
    catch(e) { console.error(e); sendJSON(res, 500, { error: 'Internal server error' }); }
    return;
  }
  serveFile(res, path.join(__dirname, 'public/index.html'), 'text/html');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚔️  LOOT COUNCIL running on port ${PORT}\n`);
});
