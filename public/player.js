// ============================================================
//  PLAYER.JS â€” Script autonome pour la page joueur (/play)
//  Utilise SSE (EventSource) + fetch pour la communication cross-device
// ============================================================

// ---- Constantes ----
const AVATARS = [
  'ðŸ¼','ðŸ¦Š','ðŸ¸','ðŸ¦','ðŸ¯','ðŸ¨',
  'ðŸ¦„','ðŸº','ðŸ»','ðŸ¦','ðŸ™','ðŸ¦‹',
  'ðŸµ','ðŸ”','ðŸ¦†','ðŸ¦‰','ðŸ§','ðŸ ',
  'ðŸ¦–','ðŸ¦•','ðŸ²','ðŸ¦‘','ðŸ¦€','ðŸ',
];

const PLAYER_COLORS = [
  '#f7c948','#4fa3ff','#4ecb71','#ff6b6b',
  '#a78bfa','#ff9f43','#00d2d3','#e84393',
  '#fd79a8','#6c5ce7','#00b894','#e17055',
];

// ---- Ã‰tat joueur ----
const playerState = {
  currentPlayer: null,
  gameCode: null,
  selectedAvatar: AVATARS[0],
  sse: null,
};

// ---- Navigation entre Ã©crans ----
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
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2800);
}

// ---- Grille d'avatars ----
function initAvatarGrid() {
  const grid    = document.getElementById('avatar-grid');
  const preview = document.getElementById('join-avatar-preview');
  if (!grid) return;
  grid.innerHTML = '';
  AVATARS.forEach((a, i) => {
    const btn = document.createElement('button');
    btn.className = 'avatar-btn' + (i === 0 ? ' selected' : '');
    btn.textContent = a;
    btn.type = 'button';
    btn.onclick = () => {
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

// ---- Ã‰tapes du formulaire "rejoindre" ----
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
    const code = (document.getElementById('join-code')?.value || '').trim();
    if (code.length !== 4 || isNaN(code)) {
      showToast('Entrez un code valide (4 chiffres)', 'error');
      return;
    }
    // VÃ©rifier que la partie existe sur le serveur
    try {
      const res = await fetch(`/api/game/${code}`);
      if (!res.ok) {
        showToast('Code incorrect ! ðŸš«', 'error');
        return;
      }
    } catch {
      showToast('Impossible de joindre le serveur', 'error');
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
  const code   = playerState.gameCode || (document.getElementById('join-code')?.value || '').trim();
  const name   = (document.getElementById('join-name')?.value || '').trim();
  const avatar = playerState.selectedAvatar;

  if (!name) { showToast('Entrez votre prÃ©nom !', 'error'); return; }
  if (!code) { showToast('Code de partie manquant', 'error'); return; }

  try {
    const res = await fetch(`/api/join/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        avatar,
        color: PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Impossible de rejoindre', 'error');
      return;
    }
    const { player } = await res.json();
    playerState.currentPlayer = player;
    playerState.gameCode = code;

    // Afficher dans le lobby
    addPlayerToLobby(player);
    const codeDisplay = document.getElementById('lobby-code');
    if (codeDisplay) codeDisplay.textContent = code;
    showScreen('screen-lobby');

    // Se connecter au flux SSE
    connectSSE(code);
    showToast(`Bienvenue ${name} ! ðŸŽ‰`, 'success');
  } catch {
    showToast('Erreur de connexion', 'error');
  }
}

// ---- Connexion SSE ----
function connectSSE(code) {
  if (playerState.sse) { playerState.sse.close(); playerState.sse = null; }
  const sse = new EventSource(`/api/events/${code}`);
  playerState.sse = sse;

  // Ã‰tat initial : liste des joueurs dÃ©jÃ  connectÃ©s
  sse.addEventListener('init', e => {
    const { players } = JSON.parse(e.data);
    const container = document.getElementById('players-list');
    if (container) container.innerHTML = '';
    (players || []).forEach(p => addPlayerToLobby(p));
  });

  // Un nouveau joueur a rejoint
  sse.addEventListener('playerJoin', e => {
    addPlayerToLobby(JSON.parse(e.data));
  });

  // La partie dÃ©marre
  sse.addEventListener('gameStart', () => {
    showScreen('screen-game');
    const status = document.getElementById('game-status');
    if (status) status.textContent = 'â³ En attente de la premiÃ¨re question...';
  });

  // Une question est lancÃ©e
  sse.addEventListener('question', e => {
    const { question, idx, total, timeLeft } = JSON.parse(e.data);
    PlayerGame.showQuestion(question, idx, total, timeLeft);
  });

  // Fin de question â†’ rÃ©vÃ©ler la rÃ©ponse
  sse.addEventListener('questionEnd', e => {
    const { correctIndices, correctAnswer } = JSON.parse(e.data);
    PlayerGame.showAnswer(correctIndices, correctAnswer);
  });

  // Fin de partie â†’ podium
  sse.addEventListener('gameEnd', e => {
    const { players } = JSON.parse(e.data);
    PlayerGame.showPodium(players);
  });

  sse.onerror = () => {
    // Le navigateur tente de reconnecter automatiquement pour EventSource
  };
}

// ---- Lobby ----
function addPlayerToLobby(player) {
  const container = document.getElementById('players-list');
  if (!container) return;
  if (document.getElementById(`lobby-player-${player.id}`)) return;
  const card = document.createElement('div');
  card.className = 'lobby-player-card';
  card.id = `lobby-player-${player.id}`;
  card.innerHTML = `
    <div class="lobby-player-avatar">${player.avatar}</div>
    <div class="lobby-player-name" style="color:${player.color}">${player.name}</div>
  `;
  container.appendChild(card);
}

// ============================================================
//  MOTEUR JEU CÃ”TÃ‰ JOUEUR
// ============================================================
const PlayerGame = (() => {
  let answered = false;

  function showQuestion(q, idx, total, time) {
    answered = false;
    showScreen('screen-game');

    const counter = document.getElementById('track-question-num');
    const qCard   = document.getElementById('question-card');
    const qResult = document.getElementById('question-result');
    const qText   = document.getElementById('question-text');
    const qCat    = document.getElementById('question-category');
    const qStatus = document.getElementById('game-status');
    const grid    = document.getElementById('choices-grid');
    const openAns = document.getElementById('open-answer');

    if (counter) counter.textContent = `Q${idx + 1}/${total}`;
    if (qCat)    qCat.textContent = q.category || 'Question';
    if (qText)   qText.textContent = q.text;
    if (qCard)   qCard.style.display = 'flex';
    if (qResult) qResult.style.display = 'none';
    if (qStatus) qStatus.textContent = '';

    if (q.type === 'qcm' && grid) {
      grid.style.display = 'grid';
      if (openAns) openAns.style.display = 'none';
      grid.innerHTML = '';
      const letters = ['A', 'B', 'C', 'D'];
      q.choices.forEach((choice, i) => {
        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.type = 'button';
        btn.innerHTML = `<span class="choice-letter">${letters[i]}</span>${choice}`;
        btn.onclick = () => submitAnswer(i, null);
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
          input.onkeydown = e => { if (e.key === 'Enter') submitOpenAnswer(); };
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
    const code   = playerState.gameCode;
    if (player && code) {
      fetch(`/api/answer/${code}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId:    player.id,
          answerIndex: answerIndex,
          answer:      answerText,
        }),
      }).catch(() => {});
    }
    showToast('RÃ©ponse envoyÃ©e ! âœ…', 'success');
  }

  function submitOpenAnswer() {
    const input = document.getElementById('open-input');
    const text = input?.value.trim();
    if (!text) return;
    if (input) input.disabled = true;
    submitAnswer(null, text);
  }

  function updateTimer(time) {
    const bar  = document.getElementById('timer-bar');
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
    const qCard  = document.getElementById('question-card');
    const result = document.getElementById('question-result');
    const icon   = document.getElementById('result-icon');
    const text   = document.getElementById('result-text');
    const ans    = document.getElementById('result-answer');
    if (qCard)  qCard.style.display = 'none';
    if (result) {
      if (icon) icon.textContent = 'ðŸ’¡';
      if (text) text.textContent = 'RÃ©sultat !';
      if (ans)  ans.textContent = correctAnswer ? `RÃ©ponse : ${correctAnswer}` : '';
      result.style.display = 'flex';
    }
  }

  function showPodium(players) {
    const standings = document.getElementById('podium-standings');
    if (!standings) return;
    const sorted = [...players].sort((a, b) => b.score - a.score);
    const medals = ['ðŸ¥‡', 'ðŸ¥ˆ', 'ðŸ¥‰'];
    standings.innerHTML = sorted.map((p, i) => `
      <div class="podium-entry rank-${i + 1}">
        <span class="podium-rank">${medals[i] || (i + 1)}</span>
        <span class="podium-avatar">${p.avatar}</span>
        <span class="podium-name" style="color:${p.color}">${p.name}</span>
        <span class="podium-score">${p.score} pts</span>
      </div>
    `).join('');
    showScreen('screen-podium');
  }

  return { showQuestion, submitAnswer, submitOpenAnswer, updateTimer, showAnswer, showPodium };
})();

// ============================================================
//  INITIALISATION
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  showScreen('screen-join');

  // PrÃ©remplir le code depuis l'URL (?code=1234)
  const params = new URLSearchParams(window.location.search);
  const codeFromUrl = params.get('code');
  if (codeFromUrl) {
    const input = document.getElementById('join-code');
    if (input) {
      input.value = codeFromUrl;
      playerState.gameCode = codeFromUrl;
      setTimeout(() => goToJoinStep('info'), 400);
    }
  }
});
