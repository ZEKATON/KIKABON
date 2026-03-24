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
  score: 0
};

function updatePlayerHeader() {
  const avatar = document.getElementById('player-avatar');
  const name = document.getElementById('player-name');
  const score = document.getElementById('score-display');
  if (avatar && playerState.currentPlayer) avatar.textContent = playerState.currentPlayer.avatar;
  if (name && playerState.currentPlayer) name.textContent = playerState.currentPlayer.name;
  if (score) score.textContent = 'Score: ' + playerState.score;
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
  if (!codeStep || !infoStep) return;

  if (step === 'code') {
    codeStep.style.display = 'block';
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
        showToast('Code incorrect', 'error');
        return;
      }
    } catch (e) {
      console.error('API error:', e);
      showToast('Erreur serveur', 'error');
      return;
    }
    playerState.gameCode = code;
    codeStep.style.display = 'none';
    infoStep.style.display = 'block';
    setTimeout(initAvatarGrid, 50);
  }
}

// ---- Rejoindre la partie ----
async function joinGameWithCode() {
  const codeInput = document.getElementById('join-code');
  const nameInput = document.getElementById('join-name');
  const code = playerState.gameCode || (codeInput ? codeInput.value : '').trim();
  const name = (nameInput ? nameInput.value : '').trim();
  const avatar = playerState.selectedAvatar;

  if (!name) {
    showToast('Entrez votre nom', 'error');
    return;
  }
  if (!code) {
    showToast('Code manquant', 'error');
    return;
  }

  try {
    const res = await fetch('/api/join/' + code, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        avatar: avatar,
        color: PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Erreur', 'error');
      return;
    }
    const data = await res.json();
    const player = data.player;
    playerState.currentPlayer = player;
    playerState.gameCode = code;
    playerState.score = 0;

    addPlayerToLobby(player);
    const codeDisplay = document.getElementById('lobby-code');
    if (codeDisplay) codeDisplay.textContent = code;
    showScreen('screen-lobby');
    updatePlayerHeader();

    connectSSE(code);
    showToast('Bienvenue ' + name, 'success');
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

  try {
    const sse = new EventSource('/api/events/' + code);
    playerState.sse = sse;

    sse.addEventListener('init', function(e) {
      const data = JSON.parse(e.data);
      const players = data.players || [];
      const container = document.getElementById('players-list');
      if (container) container.innerHTML = '';
      players.forEach(p => addPlayerToLobby(p));
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
      PlayerGame.showAnswer(data.correctIndices, data.correctAnswer);
    });

    sse.addEventListener('gameEnd', function(e) {
      const data = JSON.parse(e.data);
      PlayerGame.showPodium(data.players);
    });

    sse.onerror = function() {
      console.log('SSE error');
    };
  } catch (e) {
    console.error('SSE error:', e);
    showToast('Erreur SSE', 'error');
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

  function showQuestion(q, idx, total, time) {
    answered = false;
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
        btn.onclick = function() { submitAnswer(i, null); };
        grid.appendChild(btn);
      });
    } else if (q.type === 'open') {
      if (grid) grid.style.display = 'none';
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
    updateTimer(time);
  }

  function submitAnswer(answerIndex, answerText) {
    if (answered) return;
    answered = true;

    const grid = document.getElementById('choices-grid');
    if (grid) {
      grid.querySelectorAll('.choice-btn').forEach((b, i) => {
        b.disabled = true;
        if (i === answerIndex) b.classList.add('selected');
      });
    }

    const player = playerState.currentPlayer;
    const code = playerState.gameCode;
    if (player && code) {
      fetch('/api/answer/' + code, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: player.id,
          answerIndex: answerIndex,
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

  function updateTimer(time) {
    const bar = document.getElementById('timer-bar');
    const text = document.getElementById('timer-text');
    if (bar) {
      bar.style.setProperty('--progress', (time / 60 * 100) + '%');
      bar.className = 'timer-bar' + (time <= 10 ? ' warning' : '');
    }
    if (text) text.textContent = time;
  }

  function showAnswer(correctIndices, correctAnswer) {
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
    const qCard = document.getElementById('question-card');
    const result = document.getElementById('question-result');
    const icon = document.getElementById('result-icon');
    const text = document.getElementById('result-text');
    const ans = document.getElementById('result-answer');
    if (qCard) qCard.style.display = 'none';
    if (result) {
      if (icon) icon.textContent = 'Reponse';
      if (text) text.textContent = 'Resultat';
      if (ans) ans.textContent = correctAnswer ? 'Reponse: ' + correctAnswer : '';
      result.style.display = 'flex';
    }
  }

  function showPodium(players) {
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

  const params = new URLSearchParams(window.location.search);
  const codeFromUrl = params.get('code');
  if (codeFromUrl) {
    const input = document.getElementById('join-code');
    if (input) {
      input.value = codeFromUrl;
      playerState.gameCode = codeFromUrl;
      setTimeout(function() { goToJoinStep('info'); }, 400);
    }
  }
});
