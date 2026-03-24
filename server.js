// ============================================================
//  SERVER.JS — Serveur Node.js avec API REST + SSE
//  Permet la communication cross-device (prof + téléphones élèves)
// ============================================================
const http = require('http');
const fs   = require('fs');
const path = require('path');

const port       = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- Util: lire le body JSON ----
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

// ---- État en mémoire ----
// Map<code, { code, adminToken, questions, players, sseClients, createdAt }>
const games = new Map();

// Nettoyage automatique des parties > 4h
setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [code, game] of games) {
    if (game.createdAt < cutoff) {
      game.sseClients.forEach(r => { try { r.end(); } catch {} });
      games.delete(code);
    }
  }
}, 30 * 60 * 1000);

function uniqueCode() {
  let code;
  do { code = String(Math.floor(Math.random() * 10000)).padStart(4, '0'); }
  while (games.has(code));
  return code;
}

// Diffuser un événement SSE à tous les clients d'une partie
function broadcast(code, eventName, data) {
  const game = games.get(code);
  if (!game) return;
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of game.sseClients) {
    try { r.write(msg); } catch { game.sseClients.delete(r); }
  }
}

// ---- Types MIME ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
};

// ---- Servir les fichiers statiques depuis ./public/ ----
function serveStatic(pathname, res) {
  let filePath;
  if (pathname === '/' || pathname === '/admin') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else if (pathname === '/play') {
    filePath = path.join(PUBLIC_DIR, 'player.html');
  } else {
    filePath = path.join(PUBLIC_DIR, pathname);
  }

  // Sécurité : empêcher le path traversal
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') { res.writeHead(404); res.end('Not Found'); }
      else { res.writeHead(500); res.end('Server Error'); }
      return;
    }
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  });
}

// ---- Serveur HTTP ----
const server = http.createServer(async (req, res) => {
  const url      = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method   = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const json = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // ── POST /api/host ─────────────────────────────────────────
  // L'admin crée une nouvelle session de jeu
  if (pathname === '/api/host' && method === 'POST') {
    const body = await readBody(req);
    if (!Array.isArray(body.questions) || body.questions.length === 0) {
      return json(400, { error: 'questions required' });
    }
    const code       = uniqueCode();
    const adminToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    games.set(code, {
      code, adminToken,
      questions:  body.questions,
      players:    [],
      sseClients: new Set(),
      createdAt:  Date.now(),
    });
    return json(200, { code, adminToken });
  }

  // ── GET /api/game/:code ────────────────────────────────────
  // Le joueur vérifie si la partie existe avant de rejoindre
  if (pathname.startsWith('/api/game/') && method === 'GET') {
    const code = pathname.split('/')[3];
    const game = games.get(code);
    if (!game) return json(404, { error: 'Partie introuvable' });
    return json(200, { code, playerCount: game.players.length });
  }

  // ── POST /api/join/:code ───────────────────────────────────
  // Un joueur rejoint la partie
  if (pathname.startsWith('/api/join/') && method === 'POST') {
    const code = pathname.split('/')[3];
    const game = games.get(code);
    if (!game) return json(404, { error: 'Partie introuvable' });
    const body = await readBody(req);
    if (!body.name) return json(400, { error: 'name required' });
    const player = {
      id:     Date.now() + Math.random(),
      name:   String(body.name).slice(0, 30),
      avatar: body.avatar || '🐼',
      color:  body.color  || '#4fa3ff',
      score:  0,
      position: 0,
      answeredCurrentQuestion: false,
    };
    game.players.push(player);
    broadcast(code, 'playerJoin', player);
    return json(200, { player });
  }

  // ── GET /api/events/:code ──────────────────────────────────
  // Flux SSE — l'admin ET les joueurs s'y connectent
  if (pathname.startsWith('/api/events/') && method === 'GET') {
    const code = pathname.split('/')[3];
    const game = games.get(code);
    if (!game) { res.writeHead(404); res.end('Game not found'); return; }

    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': stream open\n\n');
    // Envoyer l'état courant aux nouveaux connectés
    res.write(`event: init\ndata: ${JSON.stringify({ players: game.players })}\n\n`);

    game.sseClients.add(res);

    // Keepalive toutes les 20s (évite timeout proxy)
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); }
      catch { clearInterval(ping); game.sseClients.delete(res); }
    }, 20000);

    req.on('close', () => {
      clearInterval(ping);
      game.sseClients.delete(res);
    });
    return;
  }

  // ── POST /api/answer/:code ─────────────────────────────────
  // Un joueur soumet sa réponse
  if (pathname.startsWith('/api/answer/') && method === 'POST') {
    const code = pathname.split('/')[3];
    const game = games.get(code);
    if (!game) return json(404, { error: 'Partie introuvable' });
    const body = await readBody(req);
    const { playerId, answerIndex, answer } = body;
    const player = game.players.find(p => p.id === playerId);
    if (player && !player.answeredCurrentQuestion) {
      player.answeredCurrentQuestion = true;
      player.lastAnswerIndex = typeof answerIndex === 'number' ? answerIndex : null;
      player.lastAnswer = typeof answer === 'string' ? answer.slice(0, 200) : null;
      broadcast(code, 'playerAnswer', { playerId, answerIndex, answer });
    }
    return json(200, { ok: true });
  }

  // ── POST /api/admin/:code/broadcast ───────────────────────
  // L'admin diffuse un événement à tous les clients SSE
  if (pathname.startsWith('/api/admin/') && pathname.endsWith('/broadcast') && method === 'POST') {
    const code = pathname.split('/')[3];
    const game = games.get(code);
    if (!game) return json(404, { error: 'Partie introuvable' });
    const body = await readBody(req);
    if (body.adminToken !== game.adminToken) return json(403, { error: 'Unauthorized' });

    // Réinitialiser les réponses des joueurs à chaque nouvelle question
    if (body.type === 'question') {
      game.players.forEach(p => {
        p.answeredCurrentQuestion = false;
        p.lastAnswerIndex = undefined;
        p.lastAnswer = undefined;
      });
    }
    // Mettre à jour les scores depuis le payload gameEnd
    if (body.type === 'gameEnd' && Array.isArray(body.payload?.players)) {
      body.payload.players.forEach(upd => {
        const p = game.players.find(p => p.id === upd.id);
        if (p) { p.score = upd.score || 0; p.position = upd.position || 0; }
      });
    }

    broadcast(code, body.type, body.payload || {});
    return json(200, { ok: true });
  }

  // ── Fichiers statiques ─────────────────────────────────────
  serveStatic(pathname, res);
});

server.listen(port, () => {
  console.log(`Kikabon running at http://localhost:${port}`);
});
