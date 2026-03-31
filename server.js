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

function normalizePlayerName(value) {
  return String(value || '').trim().toLowerCase();
}

function getLatestActiveGame(excludeCode = null) {
  const activeGames = [...games.values()]
    .filter(g => g && g.gamePhase !== 'ended' && g.code !== excludeCode)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return activeGames.length > 0 ? activeGames[0] : null;
}

function forceResetGameSession(code, options = {}) {
  const game = games.get(code);
  if (!game) return;
  if (game.resetTimer) {
    clearTimeout(game.resetTimer);
    game.resetTimer = null;
  }
  game.gamePhase = 'waiting';
  game.currentQuestion = null;
  game.currentQuestionIndex = 0;
  game.currentFill = null;
  game.fillStartedAt = null;
  game.fillTimerEnded = false;
  game.players = [];

  broadcast(code, 'game_reset_force', {
    status: 'waiting',
    reason: options.reason || 'new_session',
    redirectCode: options.redirectCode || null,
  });
}

function clearStaleGamesForNewHostSession(activeCode) {
  for (const [code, game] of games) {
    if (!game || code === activeCode) continue;
    forceResetGameSession(code, { reason: 'new_session', redirectCode: activeCode });
    game.sseClients.forEach(r => { try { r.end(); } catch {} });
    games.delete(code);
  }
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

function getCurrentFillPayload(game) {
  if (!game || !game.currentFill) return null;
  const timeLimit = Number.isFinite(Number(game.currentFill.timeLimit)) ? Number(game.currentFill.timeLimit) : 300;
  const startedAt = Number.isFinite(Number(game.fillStartedAt)) ? Number(game.fillStartedAt) : Date.now();
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const timeLeft = game.fillTimerEnded ? 0 : Math.max(0, timeLimit - elapsed);
  return {
    activityId: game.currentFill.activityId,
    name: game.currentFill.name,
    level: game.currentFill.level,
    segments: Array.isArray(game.currentFill.segments) ? game.currentFill.segments : [],
    holes: Array.isArray(game.currentFill.holes) ? game.currentFill.holes : [],
    timeLimit,
    timeLeft,
    timerEnded: !!game.fillTimerEnded || timeLeft <= 0,
  };
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
    res.writeHead(200, {
      'Content-Type': mime,
      // Avoid stale JS/CSS/HTML after deploys on shared classroom devices.
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store',
    });
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
      forceResetGameSession(code, { reason: 'new_session', redirectCode: code });
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
      currentFill:     null,
      fillStartedAt:   null,
      fillTimerEnded:  false,
      resetTimer:      null,
    });
    clearStaleGamesForNewHostSession(code);
    return json(200, { code, adminToken });
  }

  // ── GET /api/ping ─────────────────────────────────────────
  // Heartbeat pour limiter les effets du sommeil Render côté clients
  if (pathname === '/api/ping' && method === 'GET') {
    const active = getLatestActiveGame();
    return json(200, {
      ok: true,
      now: Date.now(),
      activeCode: active ? active.code : null,
    });
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
    if (game.gamePhase !== 'ended') {
      const active = getLatestActiveGame();
      if (active && active.code !== code) {
        return json(409, {
          error: 'Partie inactive',
          redirectCode: active.code,
          redirectPath: '/join-new-game?code=' + active.code,
        });
      }
    }
    return json(200, {
      code,
      playerCount: game.players.length,
      gamePhase: game.gamePhase,
      currentFill: game.gamePhase === 'fill' ? getCurrentFillPayload(game) : null,
    });
  }

  // ── POST /api/join/:code ───────────────────────────────────
  // Un joueur rejoint la partie
  if (pathname.startsWith('/api/join/') && method === 'POST') {
    const code = pathname.split('/')[3];
    const game = games.get(code);
    if (!game) return json(404, { error: 'Partie introuvable' });

    if (game.gamePhase !== 'ended') {
      const active = getLatestActiveGame();
      if (active && active.code !== code) {
        return json(409, {
          error: 'Partie inactive',
          redirectCode: active.code,
          redirectPath: '/join-new-game?code=' + active.code,
        });
      }
    }

    if (game.gamePhase === 'ended') {
      const active = getLatestActiveGame(code);
      const redirectCode = active ? active.code : null;
      return json(410, {
        error: 'Session close',
        event: 'game_already_ended',
        redirectCode,
        redirectPath: redirectCode ? ('/join-new-game?code=' + redirectCode) : '/join-new-game',
      });
    }

    const body = await readBody(req);
    const requestedPlayerId = Number(body.playerId);
    const requestedName = String(body.name || '').slice(0, 30);
    const requestedSessionId = String(body.sessionId || '').slice(0, 80);
    const normalizedRequestedName = normalizePlayerName(requestedName);
    const currentQuestionPayload = game.currentQuestion
      ? {
          question: game.currentQuestion.question,
          idx: game.currentQuestion.idx,
          total: game.currentQuestion.total,
          timeLeft: Math.max(0, game.currentQuestion.duration - Math.floor((Date.now() - game.currentQuestion.startedAt) / 1000)),
        }
      : null;
    const currentFillPayload = game.gamePhase === 'fill' ? getCurrentFillPayload(game) : null;
    if (Number.isFinite(requestedPlayerId)) {
      const existing = game.players.find(p => p.id === requestedPlayerId);
      if (existing) {
        if (requestedSessionId) existing.sessionId = requestedSessionId;
        return json(200, {
          player: existing,
          rejoined: true,
          score: Number.isFinite(Number(existing.score)) ? Number(existing.score) : 0,
          currentQuestionIndex: Number.isInteger(game.currentQuestionIndex) ? game.currentQuestionIndex : 0,
          gamePhase: game.gamePhase,
          currentQuestion: currentQuestionPayload,
          currentFill: currentFillPayload,
        });
      }
    }

    // Reconnexion prioritaire par sessionId client (plus robuste qu'un simple pseudo)
    if (requestedSessionId) {
      const sameSessionPlayer = game.players.find(p => String(p.sessionId || '') === requestedSessionId);
      if (sameSessionPlayer) {
        if (body.avatar) sameSessionPlayer.avatar = body.avatar;
        if (body.color) sameSessionPlayer.color = body.color;
        return json(200, {
          player: sameSessionPlayer,
          rejoined: true,
          score: Number.isFinite(Number(sameSessionPlayer.score)) ? Number(sameSessionPlayer.score) : 0,
          currentQuestionIndex: Number.isInteger(game.currentQuestionIndex) ? game.currentQuestionIndex : 0,
          gamePhase: game.gamePhase,
          currentQuestion: currentQuestionPayload,
          currentFill: currentFillPayload,
        });
      }
    }

    // Reconnexion de secours: meme nom => recuperer le profil (score/position) existant.
    if (normalizedRequestedName) {
      const sameNamePlayer = game.players.find(p => normalizePlayerName(p.name) === normalizedRequestedName);
      if (sameNamePlayer) {
        if (requestedSessionId) sameNamePlayer.sessionId = requestedSessionId;
        if (body.avatar) sameNamePlayer.avatar = body.avatar;
        if (body.color) sameNamePlayer.color = body.color;
        return json(200, {
          player: sameNamePlayer,
          rejoined: true,
          score: Number.isFinite(Number(sameNamePlayer.score)) ? Number(sameNamePlayer.score) : 0,
          currentQuestionIndex: Number.isInteger(game.currentQuestionIndex) ? game.currentQuestionIndex : 0,
          gamePhase: game.gamePhase,
          currentQuestion: currentQuestionPayload,
          currentFill: currentFillPayload,
        });
      }
    }

    if (!requestedName) return json(400, { error: 'name required' });
    const player = {
      id:     Date.now() + Math.random(),
      name:   requestedName,
      avatar: body.avatar || '🐼',
      color:  body.color  || '#4fa3ff',
      sessionId: requestedSessionId || null,
      score:  0,
      position: 0,
      answeredCurrentQuestion: false,
    };
    game.players.push(player);
    broadcast(code, 'playerJoin', player);
    return json(200, {
      player,
      rejoined: false,
      score: 0,
      currentQuestionIndex: Number.isInteger(game.currentQuestionIndex) ? game.currentQuestionIndex : 0,
      gamePhase: game.gamePhase,
      currentQuestion: currentQuestionPayload,
      currentFill: currentFillPayload,
    });
  }

  // ── GET /api/events/:code ──────────────────────────────────
  // Flux SSE — l'admin ET les joueurs s'y connectent
  if (pathname.startsWith('/api/events/') && method === 'GET') {
    const code = pathname.split('/')[3];
    const game = games.get(code);
    if (!game) { res.writeHead(404); res.end('Game not found'); return; }
    if (game.gamePhase !== 'ended') {
      const active = getLatestActiveGame();
      if (active && active.code !== code) {
        return json(409, {
          error: 'Partie inactive',
          redirectCode: active.code,
          redirectPath: '/join-new-game?code=' + active.code,
        });
      }
    }

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
      const filteredQuestion = { ...game.currentQuestion.question };
      delete filteredQuestion.correct;      // QCM answer index
      delete filteredQuestion.correctIndices; // pour multiple-select
      delete filteredQuestion.answer;       // pour open-ended
      initPayload.currentQuestion = {
        question: filteredQuestion,
        idx:      game.currentQuestion.idx,
        total:    game.currentQuestion.total,
        timeLeft: remaining,
      };
    }
    if (game.gamePhase === 'fill') {
      initPayload.currentFill = getCurrentFillPayload(game);
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
    if (game.gamePhase !== 'game' || !game.currentQuestion) {
      return json(409, { error: 'Question inactive' });
    }
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

  // ── POST /api/fill-answer/:code ───────────────────────────
  // Un joueur soumet ses réponses au texte à trous
  if (pathname.startsWith('/api/fill-answer/') && method === 'POST') {
    const code = pathname.split('/')[3];
    const game = games.get(code);
    if (!game) return json(404, { error: 'Partie introuvable' });
    if (game.gamePhase !== 'fill') return json(409, { error: 'Texte a trous inactif' });
    const body = await readBody(req);
    const { playerId, answers } = body; // answers = [{holeId, word}]
    const player = game.players.find(p => p.id === playerId);
    if (player && !player.fillSubmitted) {
      player.fillSubmitted = true;
      player.fillAnswers = Array.isArray(answers) ? answers : [];
      broadcast(code, 'fillPlayerSubmit', {
        playerId,
        playerName: player.name,
        playerAvatar: player.avatar,
        answers: player.fillAnswers,
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
        if (p) {
          p.score = Number.isFinite(Number(upd.score)) ? Number(upd.score) : 0;
          p.position = Number.isFinite(Number(upd.position)) ? Number(upd.position) : 0;
        }
      });
    }

    // Suivre la phase de jeu et la question courante (pour reconnexion)
    if (body.type === 'gameStart') {
      if (game.resetTimer) {
        clearTimeout(game.resetTimer);
        game.resetTimer = null;
      }
      game.gamePhase = 'game';
      game.currentFill = null;
      game.fillStartedAt = null;
      game.fillTimerEnded = false;
    } else if (body.type === 'fillStart') {
      if (game.resetTimer) { clearTimeout(game.resetTimer); game.resetTimer = null; }
      game.gamePhase = 'fill';
      game.currentQuestion = null;
      game.currentFill = {
        activityId: body.payload && body.payload.activityId,
        name: body.payload && body.payload.name,
        level: body.payload && body.payload.level,
        segments: body.payload && body.payload.segments,
        holes: body.payload && body.payload.holes,
        timeLimit: body.payload && body.payload.timeLimit,
      };
      game.fillStartedAt = Date.now();
      game.fillTimerEnded = false;
      game.players.forEach(p => { p.fillSubmitted = false; p.fillAnswers = []; });
    } else if (body.type === 'fillTimerEnd') {
      game.fillTimerEnded = true;
    } else if (body.type === 'fillCorrectionEnd') {
      // Mise à jour des scores depuis le payload
      if (Array.isArray(body.payload && body.payload.scores)) {
        body.payload.scores.forEach(({ playerId, score }) => {
          const p = game.players.find(p => p.id === playerId);
          if (p) p.score = Number.isFinite(Number(score)) ? Number(score) : 0;
        });
      }
      game.gamePhase = 'ended';
      game.currentFill = null;
      game.fillStartedAt = null;
      game.fillTimerEnded = false;
      game.resetTimer = setTimeout(() => {
        forceResetGameSession(code, { reason: 'ended' });
      }, 1500);
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
      game.currentFill = null;
      game.fillStartedAt = null;
      game.fillTimerEnded = false;
    } else if (body.type === 'update_state') {
      if (!body.payload || typeof body.payload !== 'object') body.payload = {};
      if (!Number.isInteger(body.payload.currentQuestionIndex)) {
        body.payload.currentQuestionIndex = game.currentQuestionIndex;
      }
      if (body.payload.phase === 'question' && !body.payload.question && game.currentQuestion) {
        body.payload.question = game.currentQuestion.question;
        body.payload.total = game.currentQuestion.total;
        const elapsed = Math.floor((Date.now() - game.currentQuestion.startedAt) / 1000);
        body.payload.timeLeft = Math.max(0, game.currentQuestion.duration - elapsed);
      }
      game.gamePhase = body.payload.phase === 'question' ? 'game' : game.gamePhase;
    } else if (body.type === 'next_question') {
      const payload = body.payload || {};
      const nextIndex = Number.isInteger(payload.currentQuestionIndex)
        ? payload.currentQuestionIndex
        : (Number.isInteger(payload.idx) ? payload.idx : null);
      if (nextIndex !== null) {
        game.currentQuestionIndex = nextIndex;
      }
      game.gamePhase = 'game';
      game.currentFill = null;
      game.fillStartedAt = null;
      game.fillTimerEnded = false;
    } else if (body.type === 'questionEnd') {
      game.currentQuestion = null;
    } else if (body.type === 'gameEnd') {
      game.gamePhase = 'ended';
      game.currentQuestion = null;
      game.currentFill = null;
      game.fillStartedAt = null;
      game.fillTimerEnded = false;
      game.resetTimer = setTimeout(() => {
        forceResetGameSession(code, { reason: 'ended' });
      }, 1500);
    }

    // Filtrer les champs sensibles avant broadcast aux joueurs
    let payloadToBroadcast = body.payload || {};
    if ((body.type === 'question' || body.type === 'update_state') && payloadToBroadcast.question) {
      const filteredQuestion = { ...payloadToBroadcast.question };
      delete filteredQuestion.correct;      // QCM answer index
      delete filteredQuestion.correctIndices; // pour multiple-select
      delete filteredQuestion.answer;       // pour open-ended
      payloadToBroadcast = {
        ...payloadToBroadcast,
        question: filteredQuestion,
      };
    }

    broadcast(code, body.type, payloadToBroadcast);
    return json(200, { ok: true });
  }

  // ── Fichiers statiques ─────────────────────────────────────
  serveStatic(pathname, res);
});

server.listen(port, () => {
  console.log(`Kikabon running at http://localhost:${port}`);
});
