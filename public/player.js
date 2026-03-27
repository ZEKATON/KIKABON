// ============================================================
//  PLAYER.JS - Script autonome pour la page joueur (/play)
//  Utilise SSE (EventSource) + fetch pour communication cross-device
// ============================================================

// ---- Constantes ----
const AVATARS = [
  '\ud83d\udc3c','\ud83d\udc0a','\ud83d\udc38','\ud83d\udc81','\ud83d\udc2f','\ud83d\udc28',
  '\ud83d\udc84','\ud83d\udc3a','\ud83d\udc3b','\ud83d\udc9d','\ud83d\udc19','\ud83d\udc0b',
  '\ud83d\udc35','\ud83d\udc14','\ud83d\udc86','\ud83d\udc89','\ud83d\udc27','\ud83d\udc20',
  '\ud83d\udc96','\ud83d\udc95','\ud83d\udc32','\ud83d\udc91','\ud83d\udc80','\ud83d\udc1d'
];

const PLAYER_COLORS = [
  '#f7c948','#4fa3ff','#4ecb71','#ff6b6b',
  '#a78bfa','#ff9f43','#00d2d3','#e84393',
  '#fd79a8','#6c5ce7','#00b894','#e17055'
];

// ---- Etat joueur ----
const playerState = {
  currentPlayer: null,
  gameCode: null,
  selectedAvatar: null,
  currentQuestion: null,
  sse: null,
  score: 0,
  correctCount: 0,
  totalQuestions: 0,
};
let reconnectTimeout = null;
let playerAudioCtx = null;
let heartbeatTimer = null;
let heartbeatFailureCount = 0;

function getOrCreateClientSessionId() {
  const key = 'kikabon_client_session';
  try {
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch (e) {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

function getQuestionTypeLabel(question) {
  if (!question || question.type === 'open') return 'Question ouverte';
  const correctIndices = Array.isArray(question.correctIndices)
    ? question.correctIndices.filter(i => Number.isInteger(i) && i >= 0)
    : (typeof question.correct === 'number' ? [question.correct] : []);
  const isMultipleChoice = question.multipleAnswers || correctIndices.length > 1;
  return isMultipleChoice ? 'Choix multiple' : 'Choix unique';
}

function formatQuestionMeta(question) {
  const typeLabel = getQuestionTypeLabel(question);
  const categoryLabel = String(question && question.category ? question.category : '').trim();
  return categoryLabel ? `${typeLabel} • ${categoryLabel}` : typeLabel;
}

function updateLobbyPlayerCount(countOverride) {
  const counter = document.getElementById('lobby-player-count');
  if (!counter) return;
  const count = Number.isInteger(countOverride)
    ? countOverride
    : document.querySelectorAll('#players-list .lobby-player-card').length;
  if (count === 0) {
    counter.textContent = 'Aucun joueur connecté';
    return;
  }
  counter.textContent = `${count} joueur${count > 1 ? 's' : ''} connecté${count > 1 ? 's' : ''}`;
}

function formatCorrectAnswerText(question, correctAnswer) {
  if (!correctAnswer) return '';
  const answerText = String(correctAnswer).trim();
  if (!question || question.type === 'qcm') {
    const hasMultiple = /^r[eé]ponses\s+correctes\s*:/i.test(answerText);
    const cleanAnswer = answerText.replace(/^r[eé]ponses\s+correctes\s*:\s*/i, '');
    return hasMultiple
      ? 'Les bonnes reponses sont : ' + cleanAnswer
      : 'La bonne reponse est : ' + cleanAnswer;
  }
  const acceptedAnswers = answerText
    .split(/\s*,\s*|\s+ou\s+/i)
    .map(item => item.trim())
    .filter(Boolean);
  return acceptedAnswers.length > 1
    ? 'Reponses acceptees : ' + acceptedAnswers.join(', ')
    : 'Reponse attendue : ' + answerText;
}

function resetPlayerStateOnly() {
  clearTimeout(reconnectTimeout);
  stopHeartbeat();
  if (playerState.sse) {
    try { playerState.sse.close(); } catch (e) {}
    playerState.sse = null;
  }
  playerState.currentPlayer = null;
  playerState.gameCode = null;
  playerState.score = 0;
  playerState.correctCount = 0;
  playerState.totalQuestions = 0;
  playerState.selectedAvatar = null;
  playerState.currentQuestion = null;
}

function redirectToJoinNewGame(redirectCode, message) {
  clearSession();
  try {
    sessionStorage.setItem('kikabon_join_message', message || 'Partie terminee. Reinscris-toi pour la nouvelle partie.');
  } catch (e) {}
  const hasValidCode = /^\d{4}$/.test(String(redirectCode || ''));
  const target = hasValidCode
    ? ('/join-new-game?code=' + String(redirectCode))
    : '/join-new-game';
  window.location.assign(target);
}

function playPlayerSound(type) {
  try {
    if (!playerAudioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      playerAudioCtx = new Ctx();
    }
    const now = playerAudioCtx.currentTime;
    if (type === 'question') {
      [659, 784, 988].forEach((f, i) => {
        const o = playerAudioCtx.createOscillator();
        const g = playerAudioCtx.createGain();
        o.type = 'triangle';
        o.frequency.value = f;
        o.connect(g); g.connect(playerAudioCtx.destination);
        const t0 = now + i * 0.06;
        g.gain.setValueAtTime(0.09, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
        o.start(t0); o.stop(t0 + 0.2);
      });
    } else if (type === 'submit') {
      const o = playerAudioCtx.createOscillator();
      const g = playerAudioCtx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(740, now);
      o.connect(g); g.connect(playerAudioCtx.destination);
      g.gain.setValueAtTime(0.08, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      o.start(now); o.stop(now + 0.14);
    }
  } catch (e) {}
}

function updatePlayerHeader() {
  const avatar = document.getElementById('player-avatar');
  const name = document.getElementById('player-name');
  const score = document.getElementById('score-display');
  if (avatar && playerState.currentPlayer) avatar.textContent = playerState.currentPlayer.avatar;
  if (name && playerState.currentPlayer) name.textContent = playerState.currentPlayer.name;
  if (score) score.textContent = 'Score: ' + playerState.score;
}

function updatePlayerStats() {
  const el = document.getElementById('stats-display');
  if (!el) return;
  if (playerState.totalQuestions === 0) { el.style.display = 'none'; return; }
  const pct = Math.round(playerState.correctCount / playerState.totalQuestions * 100);
  el.textContent = '\u2713 ' + playerState.correctCount + '/' + playerState.totalQuestions + ' (' + pct + '%)';
  el.style.display = 'block';
}

function saveSession() {
  if (!playerState.currentPlayer || !playerState.gameCode) return;
  try {
    localStorage.setItem('playerName', playerState.currentPlayer.name || '');
    localStorage.setItem('playerAvatar', playerState.currentPlayer.avatar || '');
    localStorage.setItem('currentPlayerId', String(playerState.currentPlayer.id || ''));
    localStorage.setItem('kikabon_session', JSON.stringify({
      playerId:       playerState.currentPlayer.id,
      name:           playerState.currentPlayer.name,
      avatar:         playerState.currentPlayer.avatar,
      color:          playerState.currentPlayer.color,
      gameCode:       playerState.gameCode,
      score:          playerState.score,
      correctCount:   playerState.correctCount,
      totalQuestions: playerState.totalQuestions,
    }));
  } catch (e) {}
}

function clearPlayerIdentityStorage() {
  try {
    localStorage.removeItem('playerName');
    localStorage.removeItem('playerAvatar');
    localStorage.removeItem('currentPlayerId');
    localStorage.removeItem('kikabon_session');
  } catch (e) {}
}

function clearSession() {
  clearPlayerIdentityStorage();
}

function getSavedSession() {
  try {
    return JSON.parse(localStorage.getItem('kikabon_session') || 'null');
  } catch (e) {
    return null;
  }
}

async function tryRestoreSession() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('kikabon_session') || 'null'); } catch (e) { saved = null; }
  if (!saved || !saved.playerId || !saved.gameCode) return false;
  try {
    const activeRes = await fetch('/api/game-active').catch(() => null);
    if (activeRes && activeRes.ok) {
      const activeData = await activeRes.json().catch(() => ({}));
      const activeCode = String(activeData.code || '').trim();
      if (/^\d{4}$/.test(activeCode) && String(saved.gameCode) !== activeCode) {
        redirectToJoinNewGame(activeCode, 'Une nouvelle partie est disponible. Reinscris-toi pour la rejoindre.');
        return false;
      }
    }

    const res = await fetch('/api/game/' + saved.gameCode);
    if (!res.ok) {
      const gameErr = await res.json().catch(() => ({}));
      if (res.status === 409 && /^\d{4}$/.test(String(gameErr.redirectCode || ''))) {
        redirectToJoinNewGame(String(gameErr.redirectCode), 'Une nouvelle partie est active. Reinscris-toi pour la rejoindre.');
        return false;
      }
      clearSession();
      return false;
    }

    const gameMeta = await res.json().catch(() => ({}));
    if (gameMeta && gameMeta.gamePhase === 'ended') {
      const activeRes = await fetch('/api/game-active').catch(() => null);
      if (activeRes && activeRes.ok) {
        const activeData = await activeRes.json().catch(() => ({}));
        const redirectCode = String(activeData.code || '').trim();
        if (/^\d{4}$/.test(redirectCode)) {
          redirectToJoinNewGame(redirectCode, 'Partie terminee. Reinscris-toi pour rejoindre la nouvelle partie.');
          return false;
        }
      }
      clearSession();
      return false;
    }

    const joinRes = await fetch('/api/join/' + saved.gameCode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: saved.playerId,
        sessionId: getOrCreateClientSessionId(),
        name: saved.name,
        avatar: saved.avatar,
        color: saved.color,
      })
    });
    if (!joinRes.ok) {
      const joinErr = await joinRes.json().catch(() => ({}));
      if (joinRes.status === 409 && /^\d{4}$/.test(String(joinErr.redirectCode || ''))) {
        redirectToJoinNewGame(String(joinErr.redirectCode), 'Une nouvelle partie est active. Reinscris-toi pour la rejoindre.');
        return false;
      }
      if (joinRes.status === 410 && /^\d{4}$/.test(String(joinErr.redirectCode || ''))) {
        redirectToJoinNewGame(String(joinErr.redirectCode), 'Partie terminee. Reinscris-toi pour rejoindre la nouvelle partie.');
        return false;
      }
      if (joinRes.status === 410 && joinErr.event === 'game_already_ended') {
        showToast('La partie est terminee. Veuillez attendre le lancement d\'un nouveau jeu.', 'error');
        return false;
      }
      clearSession();
      return false;
    }
    const joinData = await joinRes.json();
    const restoredPlayer = joinData.player || {};
    playerState.currentPlayer = {
      id: restoredPlayer.id || saved.playerId,
      name: restoredPlayer.name || saved.name,
      avatar: restoredPlayer.avatar || saved.avatar,
      color: restoredPlayer.color || saved.color,
      score: restoredPlayer.score || saved.score || 0,
    };
  } catch (e) { return false; }
  playerState.gameCode       = saved.gameCode;
  playerState.score          = playerState.currentPlayer.score || saved.score || 0;
  playerState.correctCount   = saved.correctCount || 0;
  playerState.totalQuestions = saved.totalQuestions || 0;
  updatePlayerHeader();
  updatePlayerStats();
  connectSSE(saved.gameCode);
  return true;
}

async function tryAutoReconnect() {
  if (playerState.currentPlayer && playerState.sse) return true;
  const restored = await tryRestoreSession();
  if (!restored) return false;
  showScreen('screen-lobby');
  updatePlayerHeader();
  updatePlayerStats();
  return true;
}

async function tryAutoJoinByStoredName() {
  if (playerState.currentPlayer) return true;
  let storedName = '';
  let storedAvatar = '';
  try {
    storedName = String(localStorage.getItem('playerName') || '').trim();
    storedAvatar = String(localStorage.getItem('playerAvatar') || '').trim();
  } catch (e) {
    return false;
  }
  if (!storedName) return false;

  try {
    const activeRes = await fetch('/api/game-active');
    if (!activeRes.ok) return false;
    const activeData = await activeRes.json().catch(() => ({}));
    const code = String(activeData.code || '').trim();
    if (!/^\d{4}$/.test(code)) return false;

    const joinRes = await fetch('/api/join/' + code, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: getOrCreateClientSessionId(),
        name: storedName,
        avatar: storedAvatar || '🐼',
        color: PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)],
      }),
    });
    if (!joinRes.ok) {
      const err = await joinRes.json().catch(() => ({}));
      if (joinRes.status === 410 && err.event === 'game_already_ended') {
        showToast('La partie est terminee. Veuillez attendre le lancement d\'un nouveau jeu.', 'error');
      }
      return false;
    }

    const data = await joinRes.json();
    const player = data.player || null;
    if (!player) return false;
    playerState.currentPlayer = player;
    playerState.gameCode = code;
    playerState.score = Number.isFinite(Number(player.score)) ? Number(player.score) : 0;
    updatePlayerHeader();
    updatePlayerStats();
    showScreen('screen-lobby');
    saveSession();

    if (data.gamePhase === 'game' && data.currentQuestion) {
      const incomingIdx = Number.isInteger(data.currentQuestionIndex)
        ? data.currentQuestionIndex
        : data.currentQuestion.idx;
      PlayerGame.showQuestion(data.currentQuestion.question, incomingIdx, data.currentQuestion.total, data.currentQuestion.timeLeft);
    } else if (data.gamePhase === 'game') {
      showScreen('screen-game');
      const status = document.getElementById('game-status');
      if (status) status.textContent = '⏳ Prochaine question...';
    }

    connectSSE(code);
    showToast('Reconnexion automatique reussie', 'success');
    return true;
  } catch (e) {
    return false;
  }
}

// ---- Navigation entre ecrans ----
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.style.display = '';
  });
  const target = document.getElementById(id);
  if (target) {
    target.style.display = 'flex';
    requestAnimationFrame(() => target.classList.add('active'));
  }
}

// ---- Notifications toast ----
function showToast(msg, type) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = 'toast ' + (type || '') + ' show';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function pingServerWithTimeout(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('/api/ping', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatFailureCount = 0;
  heartbeatTimer = setInterval(async function() {
    const ping = await pingServerWithTimeout(4500);
    if (!ping || !ping.ok) {
      heartbeatFailureCount += 1;
      if (heartbeatFailureCount === 1) {
        showToast('Connexion lente. Tentative de reconnexion...', 'error');
      }
      if (heartbeatFailureCount >= 2) {
        if (playerState.currentPlayer && playerState.gameCode && !playerState.sse) {
          connectSSE(playerState.gameCode);
        } else {
          tryAutoReconnect();
        }
      }
      return;
    }

    heartbeatFailureCount = 0;
    const activeCode = String(ping.activeCode || '').trim();
    const currentCode = String(playerState.gameCode || '').trim();
    if (currentCode && /^\d{4}$/.test(activeCode) && activeCode !== currentCode) {
      redirectToJoinNewGame(activeCode, 'Une nouvelle partie est active. Reinscris-toi pour la rejoindre.');
    }
  }, 15000);
}

function getActiveScreenId() {
  const active = document.querySelector('.screen.active');
  return active ? active.id : null;
}

function returnToJoinScreen() {
  clearPlayerIdentityStorage();
  resetPlayerStateOnly();

  const standings = document.getElementById('podium-standings');
  if (standings) standings.innerHTML = '';
  const playersList = document.getElementById('players-list');
  if (playersList) playersList.innerHTML = '';
  const joinName = document.getElementById('join-name');
  if (joinName) joinName.value = '';

  initAvatarGrid();
  showScreen('screen-join');
}

// ---- Grille d'avatars ----
function initAvatarGrid() {
  const grid = document.getElementById('avatar-grid');
  const preview = document.getElementById('join-avatar-preview');
  if (!grid) return;
  grid.innerHTML = '';
  AVATARS.forEach((a, i) => {
    const btn = document.createElement('button');
    btn.className = 'avatar-btn';
    btn.textContent = a;
    btn.type = 'button';
    btn.onclick = function() {
      grid.querySelectorAll('.avatar-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      playerState.selectedAvatar = a;
      if (preview) preview.textContent = a;
    };
    grid.appendChild(btn);
  });
  playerState.selectedAvatar = null;
  if (preview) preview.textContent = '❔';
}

// ---- Etapes du formulaire rejoindre ----
async function goToJoinStep(step) {
  const codeStep = document.getElementById('join-step-code');
  const infoStep = document.getElementById('join-step-info');
  if (!infoStep) return;

  if (step === 'code') {
    if (codeStep) codeStep.style.display = 'block';
    infoStep.style.display = 'none';
    return;
  }

  if (step === 'info') {
    const codeInput = document.getElementById('join-code');
    const code = (codeInput ? codeInput.value : '').trim();
    if (code.length !== 4 || isNaN(code)) {
      showToast('Code invalide', 'error');
      return;
    }
    try {
      const res = await fetch('/api/game/' + code);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 409 && /^\d{4}$/.test(String(err.redirectCode || ''))) {
          redirectToJoinNewGame(String(err.redirectCode), 'La partie active a change. Reinscris-toi pour la rejoindre.');
          return;
        }
        showToast('Partie introuvable pour ce code', 'error');
        return;
      }
    } catch (e) {
      console.error('API error:', e);
      showToast('Serveur indisponible', 'error');
      return;
    }
    playerState.gameCode = code;
    if (codeStep) codeStep.style.display = 'none';
    infoStep.style.display = 'block';
    setTimeout(initAvatarGrid, 50);
  }
}

// ---- Rejoindre la partie ----
async function joinGameWithCode() {
  const codeInput = document.getElementById('join-code');
  const nameInput = document.getElementById('join-name');
  let code = playerState.gameCode || (codeInput ? codeInput.value : '').trim();
  const typedName = (nameInput ? nameInput.value : '').trim();
  const name = typedName;
  const avatar = playerState.selectedAvatar;

  if (!name) {
    showToast('Entrez votre prénom', 'error');
    return;
  }

  if (!avatar) {
    showToast('Choisissez un avatar', 'error');
    return;
  }

  if (!code) {
    try {
      const activeRes = await fetch('/api/game-active');
      if (!activeRes.ok) {
        showToast('Aucune partie en cours. Attends que le professeur lance le jeu.', 'error');
        return;
      }
      const activeData = await activeRes.json();
      code = String(activeData.code || '').trim();
      if (!/^\d{4}$/.test(code)) {
        showToast('Aucune partie en cours. Attends que le professeur lance le jeu.', 'error');
        return;
      }
      playerState.gameCode = code;
    } catch (e) {
      showToast('Impossible de verifier la partie. Reessaie dans un instant.', 'error');
      return;
    }
  }

  const saved = getSavedSession();
  const canResume = !!(
    saved &&
    String(saved.gameCode) === String(code) &&
    saved.playerId &&
    saved.name === typedName
  );

  const performJoin = async (targetCode, canResumeForCode) => {
    return fetch('/api/join/' + targetCode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: canResumeForCode ? saved.playerId : null,
        sessionId: getOrCreateClientSessionId(),
        name: name,
        avatar: avatar,
        color: PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]
      })
    });
  };

  try {
    let res = await performJoin(code, canResume);
    if (!res.ok) {
      let err = await res.json().catch(() => ({}));

      if (res.status === 409 && /^\d{4}$/.test(String(err.redirectCode || ''))) {
        redirectToJoinNewGame(String(err.redirectCode), 'La partie active a change. Reinscris-toi pour la rejoindre.');
        return;
      }

      if (res.status === 410 && /^\d{4}$/.test(String(err.redirectCode || ''))) {
        // Session terminee: redirection vers route de reinscription
        redirectToJoinNewGame(String(err.redirectCode), 'Partie terminee. Entre ton prenom et choisis un avatar pour la nouvelle partie.');
        return;
      }

      if (res.status === 410 && err.event === 'game_already_ended') {
        showToast('La partie est terminee. Veuillez attendre le lancement d\'un nouveau jeu.', 'error');
        return;
      }

      if (!res.ok) {
      if (res.status === 404) {
        showToast('Aucune partie en cours. Attends que le professeur lance le jeu.', 'error');
      } else if (res.status === 410) {
        showToast('Cette session est close. Rejoins une nouvelle partie.', 'error');
      } else {
        showToast(err.error || 'Erreur', 'error');
      }
      return;
      }
    }
    const data = await res.json();
    const player = data.player;
    playerState.currentPlayer = player;
    playerState.gameCode = code;
    playerState.score = player.score || 0;
    playerState.correctCount = 0;
    playerState.totalQuestions = 0;

    addPlayerToLobby(player);
    showScreen('screen-lobby');
    const footerMsg = document.querySelector('#screen-lobby .lobby-footer p');
    if (footerMsg) footerMsg.textContent = 'En attente du professeur pour démarrer le quiz...';
    updatePlayerHeader();
    updatePlayerStats();
    try { localStorage.setItem('playerName', name); } catch (e) {}
    saveSession();

    if (data.gamePhase === 'game' && data.currentQuestion) {
      const incomingIdx = Number.isInteger(data.currentQuestionIndex)
        ? data.currentQuestionIndex
        : data.currentQuestion.idx;
      PlayerGame.showQuestion(data.currentQuestion.question, incomingIdx, data.currentQuestion.total, data.currentQuestion.timeLeft);
    }

    connectSSE(code);
    showToast((canResume ? 'Bon retour ' : 'Bienvenue ') + name, 'success');
  } catch (e) {
    console.error('Join error:', e);
    showToast('Erreur connexion', 'error');
  }
}

// ---- Connexion SSE ----
function connectSSE(code) {
  if (playerState.sse) {
    playerState.sse.close();
    playerState.sse = null;
  }
  clearTimeout(reconnectTimeout);

  try {
    const sse = new EventSource('/api/events/' + code);
    playerState.sse = sse;
    startHeartbeat();

    sse.addEventListener('init', function(e) {
      const data = JSON.parse(e.data);
      if (data.gamePhase === 'waiting' && getActiveScreenId() === 'screen-podium') {
        location.reload();
        return;
      }
      const players = data.players || [];
      const container = document.getElementById('players-list');
      if (container) container.innerHTML = '';
      players.forEach(p => addPlayerToLobby(p));
      updateLobbyPlayerCount(players.length);

      // Reconnexion : restaurer état depuis serveur
      if (playerState.currentPlayer) {
        const serverPlayer = players.find(p => p.id === playerState.currentPlayer.id);
        if (serverPlayer) {
          playerState.score = serverPlayer.score || playerState.score;
          playerState.currentPlayer.score = playerState.score;
          updatePlayerHeader();
          saveSession();
        }
        if (data.gamePhase === 'game') {
          showScreen('screen-game');
          if (data.currentQuestion) {
            PlayerGame.showQuestion(data.currentQuestion.question, data.currentQuestion.idx, data.currentQuestion.total, data.currentQuestion.timeLeft);
          } else {
            const st = document.getElementById('game-status');
            if (st) st.textContent = '\u23f3 Prochaine question...';
          }
        } else if (data.gamePhase === 'ended') {
          clearSession();
        } else {
          showScreen('screen-lobby');
        }
      }
    });

    sse.addEventListener('playerJoin', function(e) {
      const player = JSON.parse(e.data);
      addPlayerToLobby(player);
    });

    sse.addEventListener('gameStart', function() {
      showScreen('screen-game');
      const status = document.getElementById('game-status');
      if (status) status.textContent = 'En attente...';
    });

    sse.addEventListener('question', function(e) {
      const data = JSON.parse(e.data);
      const idx = Number.isInteger(data.currentQuestionIndex) ? data.currentQuestionIndex : data.idx;
      PlayerGame.showQuestion(data.question, idx, data.total, data.timeLeft);
    });

    sse.addEventListener('update_state', function(e) {
      const data = JSON.parse(e.data);
      if (data.phase !== 'question') return;
      const incomingIdx = Number.isInteger(data.currentQuestionIndex) ? data.currentQuestionIndex : null;
      if (incomingIdx === null || !data.question) return;
      const currentQuestion = PlayerGame.getCurrentQuestion();
      const needsSync = PlayerGame.getCurrentQuestionIndex() !== incomingIdx
        || !currentQuestion
        || String(currentQuestion.text || '') !== String(data.question.text || '');
      if (needsSync) {
        PlayerGame.showQuestion(data.question, incomingIdx, data.total, data.timeLeft);
      }
    });

    sse.addEventListener('questionEnd', function(e) {
      const data = JSON.parse(e.data);
      let myResult = null;
      if (playerState.currentPlayer && Array.isArray(data.results)) {
        myResult = data.results.find(r => r.playerId === playerState.currentPlayer.id) || null;
      }
      if (myResult && typeof myResult.score === 'number') {
        playerState.score = myResult.score;
        if (playerState.currentPlayer) playerState.currentPlayer.score = myResult.score;
        playerState.totalQuestions++;
        if (myResult.isCorrect) playerState.correctCount++;
        saveSession();
        updatePlayerHeader();
        updatePlayerStats();
      }
      PlayerGame.showAnswer(data.correctIndices, data.correctAnswer, myResult);
    });

    sse.addEventListener('gameEnd', function(e) {
      const data = JSON.parse(e.data);
      PlayerGame.showPodium(data.players);
    });

    sse.addEventListener('game_reset_force', function(e) {
      const data = JSON.parse(e.data || '{}');
      const targetCode = String(data.redirectCode || playerState.gameCode || '').trim();
      clearPlayerIdentityStorage();
      resetPlayerStateOnly();
      if (/^\d{4}$/.test(targetCode)) {
        window.location.href = '/join-new-game?code=' + targetCode;
      } else {
        window.location.href = '/play';
      }
    });

    sse.onerror = function() {
      if (playerState.sse === sse) playerState.sse = null;
      clearTimeout(reconnectTimeout);

      const currentCode = String(playerState.gameCode || '').trim();
      if (currentCode) {
        fetch('/api/game-active')
          .then(r => r.ok ? r.json() : null)
          .then(activeData => {
            const activeCode = String(activeData && activeData.code ? activeData.code : '').trim();
            if (/^\d{4}$/.test(activeCode) && activeCode !== currentCode) {
              redirectToJoinNewGame(activeCode, 'Une nouvelle partie est active. Reinscris-toi pour la rejoindre.');
            }
          })
          .catch(() => {});
      }

      if (playerState.currentPlayer && playerState.gameCode) {
        reconnectTimeout = setTimeout(function() {
          connectSSE(playerState.gameCode);
        }, 3000);
      } else {
        reconnectTimeout = setTimeout(function() {
          tryAutoReconnect();
        }, 3000);
      }
    };
  } catch (e) {
    console.error('SSE error:', e);
    showToast('Erreur connexion', 'error');
  }
}

// ---- Lobby ----
function addPlayerToLobby(player) {
  const container = document.getElementById('players-list');
  if (!container) return;
  const id = 'lobby-player-' + player.id;
  if (document.getElementById(id)) {
    updateLobbyPlayerCount();
    return;
  }
  const card = document.createElement('div');
  card.className = 'lobby-player-card';
  card.id = id;
  card.innerHTML = '<div class="lobby-player-avatar">' + player.avatar + '</div>' +
                   '<div class="lobby-player-name" style="color:' + player.color + '">' + player.name + '</div>';
  container.appendChild(card);
  updateLobbyPlayerCount();
}

// ============================================================
//  MOTEUR JEU COTE JOUEUR
// ============================================================
const PlayerGame = (function() {
  let answered = false;
  let selectedIndices = [];
  let playerTimerInterval = null;
  let playerTimerTotal = 60;
  let playerTimeLeft = 60;
  let currentDisplayedQuestionIndex = -1;
  let answerSubmitting = false;

  function showQuestion(q, idx, total, time) {
    answered = false;
    answerSubmitting = false;
    selectedIndices = [];
    currentDisplayedQuestionIndex = Number.isInteger(idx) ? idx : currentDisplayedQuestionIndex;
    playerState.currentQuestion = q;
    showScreen('screen-game');

    const counter = document.getElementById('track-question-num');
    const qCard = document.getElementById('question-card');
    const qResult = document.getElementById('question-result');
    const qText = document.getElementById('question-text');
    const qCat = document.getElementById('question-category');
    const qStatus = document.getElementById('game-status');
    const grid = document.getElementById('choices-grid');
    const openAns = document.getElementById('open-answer');

    if (counter) counter.textContent = 'Q' + (idx + 1) + '/' + total;
    playPlayerSound('question');
    if (qCat) qCat.textContent = formatQuestionMeta(q);
    if (qText) qText.textContent = q.text;
    if (qCard) qCard.style.display = 'flex';
    if (qResult) qResult.style.display = 'none';
    if (qStatus) qStatus.textContent = '';
    updatePlayerHeader();

    if (q.type === 'qcm' && grid) {
      grid.style.display = 'grid';
      if (openAns) openAns.style.display = 'none';
      grid.innerHTML = '';
      const letters = ['A', 'B', 'C', 'D'];
      q.choices.forEach((choice, i) => {
        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.type = 'button';
        btn.innerHTML = '<span class="choice-letter">' + letters[i] + '</span>' + choice;
        btn.addEventListener('pointerdown', function(event) {
          event.preventDefault();
        });
        btn.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          const clickedBtn = event.currentTarget && event.currentTarget.classList && event.currentTarget.classList.contains('choice-btn')
            ? event.currentTarget
            : null;
          toggleChoiceSelection(i, clickedBtn);
        });
        grid.appendChild(btn);
      });

      let submitBtn = document.getElementById('qcm-submit-btn');
      if (!submitBtn) {
        submitBtn = document.createElement('button');
        submitBtn.id = 'qcm-submit-btn';
        submitBtn.className = 'btn btn-primary';
        submitBtn.type = 'button';
        submitBtn.textContent = 'Valider mes reponses';
        submitBtn.onclick = submitQcmAnswer;
        grid.insertAdjacentElement('afterend', submitBtn);
      }
      submitBtn.style.display = 'block';
      submitBtn.disabled = true;
      submitBtn.classList.remove('answer-locked');
      submitBtn.textContent = 'Valider mes reponses';
    } else if (q.type === 'open') {
      if (grid) grid.style.display = 'none';
      const submitBtn = document.getElementById('qcm-submit-btn');
      if (submitBtn) {
        submitBtn.style.display = 'none';
        submitBtn.disabled = true;
      }
      if (openAns) {
        openAns.style.display = 'flex';
        const input = document.getElementById('open-input');
        if (input) {
          input.value = '';
          input.disabled = false;
          input.onkeydown = function(e) { if (e.key === 'Enter') submitOpenAnswer(); };
        }
      }
    }
    playerTimerTotal = time || 60;
    startPlayerTimer(time, playerTimerTotal);
  }

  function toggleChoiceSelection(choiceIndex, clickedBtn) {
    if (answered) return;
    const question = playerState.currentQuestion;
    if (!question || !Array.isArray(question.choices)) return;
    if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= question.choices.length) return;
    if (clickedBtn && (!clickedBtn.classList || !clickedBtn.classList.contains('choice-btn'))) return;

    const isSingleChoice = !(question.multipleAnswers || (Array.isArray(question.correctIndices) && question.correctIndices.length > 1));
    const pos = selectedIndices.indexOf(choiceIndex);
    if (pos >= 0) {
      // Reclick on the same answer toggles it off.
      selectedIndices = [];
    } else {
      if (isSingleChoice) {
        // In single-choice mode, selecting one answer unselects previous one.
        selectedIndices = [choiceIndex];
      } else {
        selectedIndices.push(choiceIndex);
      }
    }

    const grid = document.getElementById('choices-grid');
    if (grid) {
      grid.querySelectorAll('.choice-btn').forEach((b, i) => {
        b.classList.toggle('selected', selectedIndices.includes(i));
      });
    }

    const submitBtn = document.getElementById('qcm-submit-btn');
    if (submitBtn) submitBtn.disabled = selectedIndices.length === 0;
  }

  function submitQcmAnswer() {
    if (selectedIndices.length === 0) {
      showToast('Selectionnez au moins une reponse', 'error');
      return;
    }
    submitAnswer(selectedIndices.slice(), null);
  }

  async function submitAnswer(answerIndices, answerText) {
    if (answered || answerSubmitting) return;
    answerSubmitting = true;

    const normalizedIndices = Array.isArray(answerIndices)
      ? answerIndices.filter(i => typeof i === 'number')
      : (typeof answerIndices === 'number' ? [answerIndices] : []);
    const firstIndex = normalizedIndices.length > 0 ? normalizedIndices[0] : null;

    const grid = document.getElementById('choices-grid');
    if (grid) {
      grid.querySelectorAll('.choice-btn').forEach((b, i) => {
        b.disabled = true;
        b.classList.toggle('selected', normalizedIndices.includes(i));
        b.classList.add('answer-locked');
      });
    }
    const submitBtn = document.getElementById('qcm-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add('answer-locked');
    }

    const player = playerState.currentPlayer;
    const code = playerState.gameCode;
    if (player && code) {
      try {
        const res = await fetch('/api/answer/' + code, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: player.id,
          answerIndices: normalizedIndices,
          answerIndex: firstIndex,
          answer: answerText
        })
        });
        const ack = await res.json().catch(() => ({ ok: false }));
        if (!res.ok || ack.ok !== true) throw new Error('answer rejected');
        answered = true;
      } catch (e) {
        answerSubmitting = false;
        if (grid) {
          grid.querySelectorAll('.choice-btn').forEach((b, i) => {
            b.disabled = false;
            b.classList.toggle('selected', normalizedIndices.includes(i));
            b.classList.remove('answer-locked');
          });
        }
        if (submitBtn) {
          submitBtn.disabled = normalizedIndices.length === 0;
          submitBtn.classList.remove('answer-locked');
          submitBtn.textContent = 'Valider mes reponses';
        }
        const openInput = document.getElementById('open-input');
        if (openInput) openInput.disabled = false;
        showToast('Connexion instable: reessaie', 'error');
        return;
      }
    }
    answerSubmitting = false;
    playPlayerSound('submit');
    showToast('Reponse enregistree', 'success');
    if (submitBtn) {
      submitBtn.textContent = 'Reponse enregistree';
      submitBtn.disabled = true;
      submitBtn.classList.add('answer-locked');
    }
    const status = document.getElementById('game-status');
    if (status) status.textContent = '✅ Reponse enregistree';
  }

  function submitOpenAnswer() {
    const input = document.getElementById('open-input');
    const text = input ? input.value.trim() : '';
    if (!text) return;
    if (input) input.disabled = true;
    submitAnswer(null, text);
  }

  function startPlayerTimer(time, totalTime) {
    clearInterval(playerTimerInterval);
    playerTimeLeft = time || 60;
    playerTimerTotal = totalTime || playerTimerTotal || playerTimeLeft || 60;
    renderTimerUI(playerTimeLeft);
    playerTimerInterval = setInterval(function() {
      playerTimeLeft--;
      renderTimerUI(playerTimeLeft);
      if (playerTimeLeft <= 0) clearInterval(playerTimerInterval);
    }, 1000);
  }

  function stopPlayerTimer() {
    clearInterval(playerTimerInterval);
  }

  function renderTimerUI(time) {
    const bar = document.getElementById('timer-bar');
    const text = document.getElementById('timer-text');
    if (bar) {
      const pct = playerTimerTotal > 0 ? (time / playerTimerTotal) * 100 : 0;
      bar.style.setProperty('--progress', Math.max(0, pct) + '%');
      bar.className = 'timer-bar' + (time <= 10 ? ' warning' : '');
    }
    if (text) text.textContent = Math.max(0, time);
  }

  function updateTimer(time) {
    renderTimerUI(time);
  }

  function showAnswer(correctIndices, correctAnswer, myResult) {
    stopPlayerTimer();
    const grid = document.getElementById('choices-grid');
    if (grid) {
      grid.querySelectorAll('.choice-btn').forEach((btn, i) => {
        btn.disabled = true;
        if (correctIndices && correctIndices.includes(i)) {
          btn.classList.add('correct');
        } else if (btn.classList.contains('selected')) {
          btn.classList.add('wrong');
        }
      });
    }
    const submitBtn = document.getElementById('qcm-submit-btn');
    if (submitBtn) submitBtn.style.display = 'none';
    const qCard = document.getElementById('question-card');
    const result = document.getElementById('question-result');
    const icon = document.getElementById('result-icon');
    const text = document.getElementById('result-text');
    const ans = document.getElementById('result-answer');
    if (qCard) qCard.style.display = 'none';
    if (result) {
      if (myResult && myResult.isCorrect) {
        if (icon) icon.textContent = '✅';
        if (text) text.textContent = 'Bravo ! Bonne reponse';
      } else if (myResult && !myResult.isCorrect) {
        if (icon) icon.textContent = '❌';
        if (text) text.textContent = 'Bonne reponse affichee';
      } else {
        if (icon) icon.textContent = 'ℹ️';
        if (text) text.textContent = 'Resultat';
      }
      if (ans) {
        ans.textContent = formatCorrectAnswerText(playerState.currentQuestion, correctAnswer);
      }
      result.style.display = 'flex';
    }
  }

  function showPodium(players) {
    clearSession();
    const standings = document.getElementById('podium-standings');
    if (!standings) return;
    const sorted = players.slice().sort((a, b) => b.score - a.score);
    const me = playerState.currentPlayer && players.find(p => p.id === playerState.currentPlayer.id);
    if (me) {
      playerState.score = me.score || 0;
      updatePlayerHeader();
    }
    const medals = ['\ud83e\udd47', '\ud83e\udd48', '\ud83e\udd49'];
    let html = '';
    sorted.forEach((p, i) => {
      html += '<div class="podium-entry rank-' + (i + 1) + '">' +
              '<span class="podium-rank">' + (medals[i] || (i + 1)) + '</span>' +
              '<span class="podium-avatar">' + p.avatar + '</span>' +
              '<span class="podium-name" style="color:' + p.color + '">' + p.name + '</span>' +
              '<span class="podium-score">' + p.score + ' pts</span>' +
              '</div>';
    });
    standings.innerHTML = html;
    showScreen('screen-podium');
  }

  return {
    showQuestion: showQuestion,
    getCurrentQuestionIndex: function() { return currentDisplayedQuestionIndex; },
    getCurrentQuestion: function() { return playerState.currentQuestion; },
    toggleChoiceSelection: toggleChoiceSelection,
    submitQcmAnswer: submitQcmAnswer,
    submitAnswer: submitAnswer,
    submitOpenAnswer: submitOpenAnswer,
    updateTimer: updateTimer,
    showAnswer: showAnswer,
    showPodium: showPodium
  };
})();

// ============================================================
//  INITIALISATION
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  showScreen('screen-join');
  updateLobbyPlayerCount(0);
  startHeartbeat();

  const params = new URLSearchParams(window.location.search);
  const forcedCode = String(params.get('code') || '').trim();
  const isForcedJoinRoute = window.location.pathname === '/join-new-game';

  if (isForcedJoinRoute) {
    clearSession();
    playerState.currentPlayer = null;
    playerState.score = 0;
    playerState.correctCount = 0;
    playerState.totalQuestions = 0;
    playerState.gameCode = /^\d{4}$/.test(forcedCode) ? forcedCode : null;
    initAvatarGrid();
    try {
      const msg = sessionStorage.getItem('kikabon_join_message');
      if (msg) {
        showToast(msg, 'error');
        sessionStorage.removeItem('kikabon_join_message');
      }
    } catch (e) {}
    return;
  }

  // Restauration auto: si le joueur revient, il reprend sa partie sans ressaisir ses infos
  tryAutoReconnect().then(async restored => {
    if (restored) {
      showToast('Session restauree', 'success');
      return;
    }
    const autoJoined = await tryAutoJoinByStoredName();
    if (autoJoined) return;
    initAvatarGrid();
  });

  window.addEventListener('online', () => {
    showToast('Connexion retablie', 'success');
    startHeartbeat();
    tryAutoReconnect();
  });

  window.addEventListener('offline', () => {
    stopHeartbeat();
    showToast('Connexion perdue. Tentative de reconnexion...', 'error');
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      tryAutoReconnect();
    }
  });
});
