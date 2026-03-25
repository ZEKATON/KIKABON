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
  selectedAvatar: AVATARS[0],
  sse: null,
  score: 0,
  correctCount: 0,
  totalQuestions: 0,
};
let reconnectTimeout = null;

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
    sessionStorage.setItem('kikabon_session', JSON.stringify({
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

function clearSession() {
  try { sessionStorage.removeItem('kikabon_session'); } catch (e) {}
}

function getSavedSession() {
  try {
    return JSON.parse(sessionStorage.getItem('kikabon_session') || 'null');
  } catch (e) {
    return null;
  }
}

async function tryRestoreSession() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem('kikabon_session') || 'null'); } catch (e) { saved = null; }
  if (!saved || !saved.playerId || !saved.gameCode) return false;
  try {
    const res = await fetch('/api/game/' + saved.gameCode);
    if (!res.ok) { clearSession(); return false; }
  } catch (e) { return false; }
  playerState.currentPlayer = { id: saved.playerId, name: saved.name, avatar: saved.avatar, color: saved.color, score: saved.score || 0 };
  playerState.gameCode       = saved.gameCode;
  playerState.score          = saved.score || 0;
  playerState.correctCount   = saved.correctCount || 0;
  playerState.totalQuestions = saved.totalQuestions || 0;
  updatePlayerHeader();
  updatePlayerStats();
  connectSSE(saved.gameCode);
  return true;
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

// ---- Grille d'avatars ----
function initAvatarGrid() {
  const grid = document.getElementById('avatar-grid');
  const preview = document.getElementById('join-avatar-preview');
  if (!grid) return;
  grid.innerHTML = '';
  AVATARS.forEach((a, i) => {
    const btn = document.createElement('button');
    btn.className = 'avatar-btn' + (i === 0 ? ' selected' : '');
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
  playerState.selectedAvatar = AVATARS[0];
  if (preview) preview.textContent = AVATARS[0];
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
  const avatar = playerState.selectedAvatar || AVATARS[0];

  if (!name) {
    showToast('Entrez votre prénom', 'error');
    return;
  }

  if (!code) {
    try {
      const activeRes = await fetch('/api/game-active');
      if (!activeRes.ok) {
        showToast('Aucune partie active pour le moment', 'error');
        return;
      }
      const activeData = await activeRes.json();
      code = String(activeData.code || '').trim();
      if (!/^\d{4}$/.test(code)) {
        showToast('Aucune partie active pour le moment', 'error');
        return;
      }
      playerState.gameCode = code;
    } catch (e) {
      showToast('Serveur indisponible', 'error');
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

  try {
    const res = await fetch('/api/join/' + code, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: canResume ? saved.playerId : null,
        name: name,
        avatar: avatar,
        color: PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 404) {
        showToast('Le professeur n a pas encore lance la partie', 'error');
      } else {
        showToast(err.error || 'Erreur', 'error');
      }
      return;
    }
    const data = await res.json();
    const player = data.player;
    playerState.currentPlayer = player;
    playerState.gameCode = code;
    playerState.score = player.score || 0;
    playerState.correctCount = 0;
    playerState.totalQuestions = 0;

    addPlayerToLobby(player);
    const codeDisplay = document.getElementById('lobby-code');
    if (codeDisplay) codeDisplay.textContent = code;
    showScreen('screen-lobby');
    const footerMsg = document.querySelector('#screen-lobby .lobby-footer p');
    if (footerMsg) footerMsg.textContent = 'En attente du professeur pour démarrer le quiz...';
    updatePlayerHeader();
    updatePlayerStats();
    saveSession();

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

    sse.addEventListener('init', function(e) {
      const data = JSON.parse(e.data);
      const players = data.players || [];
      const container = document.getElementById('players-list');
      if (container) container.innerHTML = '';
      players.forEach(p => addPlayerToLobby(p));

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
          const codeDisplay = document.getElementById('lobby-code');
          if (codeDisplay) codeDisplay.textContent = code;
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
      PlayerGame.showQuestion(data.question, data.idx, data.total, data.timeLeft);
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

    sse.onerror = function() {
      if (playerState.sse === sse) playerState.sse = null;
      clearTimeout(reconnectTimeout);
      if (playerState.currentPlayer && playerState.gameCode) {
        reconnectTimeout = setTimeout(function() {
          connectSSE(playerState.gameCode);
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
  if (document.getElementById(id)) return;
  const card = document.createElement('div');
  card.className = 'lobby-player-card';
  card.id = id;
  card.innerHTML = '<div class="lobby-player-avatar">' + player.avatar + '</div>' +
                   '<div class="lobby-player-name" style="color:' + player.color + '">' + player.name + '</div>';
  container.appendChild(card);
}

// ============================================================
//  MOTEUR JEU COTE JOUEUR
// ============================================================
const PlayerGame = (function() {
  let answered = false;
  let selectedIndices = [];
  let playerTimerInterval = null;
  let playerTimerTotal = 60;

  function showQuestion(q, idx, total, time) {
    answered = false;
    selectedIndices = [];
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
    if (qCat) qCat.textContent = q.category || 'Question';
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
        btn.onclick = function() { toggleChoiceSelection(i); };
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
    startPlayerTimer(time);
  }

  function toggleChoiceSelection(choiceIndex) {
    if (answered) return;
    const pos = selectedIndices.indexOf(choiceIndex);
    if (pos >= 0) {
      selectedIndices.splice(pos, 1);
    } else {
      selectedIndices.push(choiceIndex);
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

  function submitAnswer(answerIndices, answerText) {
    if (answered) return;
    answered = true;

    const normalizedIndices = Array.isArray(answerIndices)
      ? answerIndices.filter(i => typeof i === 'number')
      : (typeof answerIndices === 'number' ? [answerIndices] : []);
    const firstIndex = normalizedIndices.length > 0 ? normalizedIndices[0] : null;

    const grid = document.getElementById('choices-grid');
    if (grid) {
      grid.querySelectorAll('.choice-btn').forEach((b, i) => {
        b.disabled = true;
        b.classList.toggle('selected', normalizedIndices.includes(i));
      });
    }
    const submitBtn = document.getElementById('qcm-submit-btn');
    if (submitBtn) submitBtn.disabled = true;

    const player = playerState.currentPlayer;
    const code = playerState.gameCode;
    if (player && code) {
      fetch('/api/answer/' + code, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: player.id,
          answerIndices: normalizedIndices,
          answerIndex: firstIndex,
          answer: answerText
        })
      }).catch(e => console.log('Answer error:', e));
    }
    showToast('Reponse envoyee', 'success');
  }

  function submitOpenAnswer() {
    const input = document.getElementById('open-input');
    const text = input ? input.value.trim() : '';
    if (!text) return;
    if (input) input.disabled = true;
    submitAnswer(null, text);
  }

  function startPlayerTimer(time) {
    clearInterval(playerTimerInterval);
    playerTimerTotal = time || 60;
    renderTimerUI(time);
    playerTimerInterval = setInterval(function() {
      time--;
      renderTimerUI(time);
      if (time <= 0) clearInterval(playerTimerInterval);
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
        if (correctAnswer) {
          const hasMultiple = String(correctAnswer).toLowerCase().includes('reponses correctes');
          const cleanAnswer = String(correctAnswer).replace(/^reponses\s+correctes\s*:\s*/i, '');
          ans.textContent = hasMultiple
            ? ('Les bonnes reponses sont : ' + cleanAnswer)
            : ('La bonne reponse est : ' + cleanAnswer);
        } else {
          ans.textContent = '';
        }
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

  // Flux impose: le joueur saisit manuellement le code puis clique sur Suivant
  const input = document.getElementById('join-code');
  if (input) input.value = '';
  initAvatarGrid();
});
