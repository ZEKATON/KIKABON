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

function normalizeRequestedCode(value) {
  const code = String(value || '').trim();
  return /^\d{4}$/.test(code) ? code : null;
}

function getLatestActiveGame(excludeCode = null) {
  const activeGames = [...games.values()]
    .filter(g => g && g.gamePhase !== 'ended' && g.code !== excludeCode)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return activeGames.length > 0 ? activeGames[0] : null;
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
  } else if (pathname === '/join-new-game') {
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
    const requestedCode = normalizeRequestedCode(body.code);
    const code = requestedCode || uniqueCode();
    const adminToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const previousGame = games.get(code);
    if (previousGame) {
      previousGame.sseClients.forEach(r => { try { r.end(); } catch {} });
      games.delete(code);
    }
    games.set(code, {
      code, adminToken,
      questions:       body.questions,
      players:         [],
      sseClients:      new Set(),
      createdAt:       Date.now(),
      gamePhase:       'lobby',
      currentQuestion: null,
      currentQuestionIndex: 0,
      resetTimer:      null,
    });
    return json(200, { code, adminToken });
  }

  // ── GET /api/game/:code ────────────────────────────────────
  // Le joueur vérifie si la partie existe avant de rejoindre
  if (pathname === '/api/game-active' && method === 'GET') {
    const game = getLatestActiveGame();
    if (!game) return json(404, { error: 'Aucune partie active' });
    return json(200, { code: game.code, playerCount: game.players.length, gamePhase: game.gamePhase });
  }

  if (pathname.startsWith('/api/game/') && method === 'GET') {
    const code = pathname.split('/')[3];
    const game = games.get(code);
    if (!game) return json(404, { error: 'Partie introuvable' });
    return json(200, { code, playerCount: game.players.length, gamePhase: game.gamePhase });
  }

  // ── POST /api/join/:code ───────────────────────────────────
  // Un joueur rejoint la partie
  if (pathname.startsWith('/api/join/') && method === 'POST') {
    const code = pathname.split('/')[3];
    const game = games.get(code);
    if (!game) return json(404, { error: 'Partie introuvable' });

    if (game.gamePhase === 'ended') {
      const active = getLatestActiveGame(code);
      const redirectCode = active ? active.code : null;
      return json(410, {
        error: 'Session close',
        redirectCode,
        redirectPath: redirectCode ? ('/join-new-game?code=' + redirectCode) : '/join-new-game',
      });
    }

    const body = await readBody(req);
    const requestedPlayerId = Number(body.playerId);
    if (Number.isFinite(requestedPlayerId)) {
      const existing = game.players.find(p => p.id === requestedPlayerId);
      if (existing) {
        return json(200, { player: existing, rejoined: true });
      }
    }
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
    // Envoyer l'état courant aux nouveaux connectés (y compris question active pour reconnexion)
    const initPayload = { players: game.players, gamePhase: game.gamePhase };
    if (game.currentQuestion) {
      const elapsed = Math.floor((Date.now() - game.currentQuestion.startedAt) / 1000);
      const remaining = Math.max(0, game.currentQuestion.duration - elapsed);
      initPayload.currentQuestion = {
        question: game.currentQuestion.question,
        idx:      game.currentQuestion.idx,
        total:    game.currentQuestion.total,
        timeLeft: remaining,
      };
    }
    res.write(`event: init\ndata: ${JSON.stringify(initPayload)}\n\n`);

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
    const { playerId, answerIndices, answerIndex, answer } = body;
    const player = game.players.find(p => p.id === playerId);
    if (player && !player.answeredCurrentQuestion) {
      const normalizedIndices = Array.isArray(answerIndices)
        ? [...new Set(answerIndices.filter(i => Number.isInteger(i) && i >= 0))].sort((a, b) => a - b)
        : (typeof answerIndex === 'number' ? [answerIndex] : []);
      player.answeredCurrentQuestion = true;
      player.lastAnswerIndices = normalizedIndices;
      player.lastAnswerIndex = normalizedIndices.length > 0 ? normalizedIndices[0] : null;
      player.lastAnswer = typeof answer === 'string' ? answer.slice(0, 200) : null;
      broadcast(code, 'playerAnswer', {
        playerId,
        answerIndices: normalizedIndices,
        answerIndex: normalizedIndices.length > 0 ? normalizedIndices[0] : null,
        answer,
      });
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
        p.lastAnswerIndices = undefined;
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

    // Suivre la phase de jeu et la question courante (pour reconnexion)
    if (body.type === 'gameStart') {
      if (game.resetTimer) {
        clearTimeout(game.resetTimer);
        game.resetTimer = null;
      }
      game.gamePhase = 'game';
    } else if (body.type === 'question') {
      game.currentQuestion = {
        question:  body.payload.question,
        idx:       body.payload.idx,
        total:     body.payload.total,
        duration:  body.payload.timeLeft,
        startedAt: Date.now(),
      };
      game.currentQuestionIndex = Number.isInteger(body.payload.idx) ? body.payload.idx : game.currentQuestionIndex;
      game.gamePhase = 'game';
    } else if (body.type === 'questionEnd') {
      game.currentQuestion = null;
    } else if (body.type === 'gameEnd') {
      game.gamePhase = 'ended';
      game.currentQuestion = null;
      if (game.resetTimer) {
        clearTimeout(game.resetTimer);
      }
      game.resetTimer = setTimeout(() => {
        const currentGame = games.get(code);
        if (!currentGame || currentGame !== game) return;

        currentGame.gamePhase = 'waiting';
        currentGame.questions = [];
        currentGame.currentQuestion = null;
        currentGame.currentQuestionIndex = 0;
        currentGame.players = [];
        currentGame.resetTimer = null;

        broadcast(code, 'game_reset_force', { status: 'waiting' });
      }, 30000);
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
