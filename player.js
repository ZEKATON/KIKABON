// ============================================================
//  PLAYER.JS — Script autonome pour la page joueur (/play)
//  Aucune dépendance à app.js ou game.js
// ============================================================

// ---- Constantes ----
const AVATARS = [
  '🐼','🦊','🐸','🦁','🐯','🐨',
  '🦄','🐺','🐻','🦝','🐙','🦋',
  '🐵','🐔','🦆','🦉','🐧','🐠',
  '🦖','🦕','🐲','🦑','🦀','🐝',
];

const PLAYER_COLORS = [
  '#f7c948','#4fa3ff','#4ecb71','#ff6b6b',
  '#a78bfa','#ff9f43','#00d2d3','#e84393',
  '#fd79a8','#6c5ce7','#00b894','#e17055',
];

// ---- État joueur ----
const playerState = {
  currentPlayer: null,
  selectedAvatar: AVATARS[0],
};

// ---- Canal de synchronisation avec la page admin ----
const playerChannel = new BroadcastChannel('kikabon_sync');

// ---- Navigation entre écrans ----
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
  const grid = document.getElementById('avatar-grid');
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

// ---- Étapes du formulaire "rejoindre" ----
function goToJoinStep(step) {
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
    const activeCode = localStorage.getItem('kikabon_gameCode');
    if (!activeCode || code !== activeCode) {
      showToast('Code incorrect ! 🚫', 'error');
      return;
    }
    codeStep.style.display = 'none';
    infoStep.style.display = 'block';
    setTimeout(initAvatarGrid, 50);
  }
}

// ---- Rejoindre la partie ----
function joinGameWithCode() {
  const code = (document.getElementById('join-code')?.value || '').trim();
  const name = (document.getElementById('join-name')?.value || '').trim();
  const avatar = playerState.selectedAvatar;

  if (!name) { showToast('Entrez votre prénom !', 'error'); return; }

  const activeCode = localStorage.getItem('kikabon_gameCode');
  if (!activeCode || code !== activeCode) {
    showToast('Code incorrect ! 🚫', 'error');
    return;
  }

  const colorIdx = Math.floor(Math.random() * PLAYER_COLORS.length);
  const player = {
    id: Date.now(),
    name,
    avatar,
    color: PLAYER_COLORS[colorIdx],
    score: 0,
    answeredCurrentQuestion: false,
  };
  playerState.currentPlayer = player;

  // Afficher dans le lobby
  addPlayerToLobby(player);

  // Afficher le code dans le lobby
  const codeDisplay = document.getElementById('lobby-code');
  if (codeDisplay) codeDisplay.textContent = code;

  showScreen('screen-lobby');

  // Informer l'admin
  playerChannel.postMessage({ type: 'playerJoin', player });
  showToast(`Bienvenue ${name} ! 🎉`, 'success');
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
//  MOTEUR JEU CÔTÉ JOUEUR
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
      const btns = grid.querySelectorAll('.choice-btn');
      btns.forEach((b, i) => {
        b.disabled = true;
        if (i === answerIndex) b.classList.add('selected');
      });
    }

    const player = playerState.currentPlayer;
    if (player) {
      player.answeredCurrentQuestion = true;
      player.lastAnswerIndex = answerIndex;
      player.lastAnswer = answerText;
    }

    playerChannel.postMessage({
      type: 'playerAnswer',
      payload: {
        playerId: player?.id,
        answerIndex,
        answer: answerText,
      },
    });
    showToast('Réponse envoyée ! ✅', 'success');
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
      if (icon) icon.textContent = '💡';
      if (text) text.textContent = 'Résultat !';
      if (ans)  ans.textContent = correctAnswer ? `Réponse : ${correctAnswer}` : '';
      result.style.display = 'flex';
    }
  }

  function showPodium(players) {
    const standings = document.getElementById('podium-standings');
    if (!standings) return;
    const sorted = [...players].sort((a, b) => b.score - a.score);
    const medals = ['🥇', '🥈', '🥉'];
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
//  MESSAGES DU CANAL (envoyés par la page admin)
// ============================================================
playerChannel.onmessage = ({ data }) => {
  if (!data || !data.type) return;
  const { type, payload } = data;

  // Un autre joueur a rejoint → afficher dans le lobby
  if (type === 'playerJoin' && payload) {
    addPlayerToLobby(payload);
    return;
  }

  // La partie démarre
  if (type === 'gameStart') {
    showScreen('screen-game');
    const status = document.getElementById('game-status');
    if (status) status.textContent = '⏳ En attente de la première question...';
    return;
  }

  // Une question est affichée
  if (type === 'question' && payload) {
    PlayerGame.showQuestion(payload.question, payload.idx, payload.total, payload.timeLeft);
    return;
  }

  // Tick du chrono
  if (type === 'timerTick' && payload) {
    PlayerGame.updateTimer(payload.timeLeft);
    return;
  }

  // Fin de question → révéler la réponse
  if (type === 'questionEnd' && payload) {
    PlayerGame.showAnswer(payload.correctIndices, payload.correctAnswer);
    return;
  }

  // Fin de partie → podium
  if (type === 'gameEnd' && payload) {
    PlayerGame.showPodium(payload.players);
    return;
  }
};

// ============================================================
//  INITIALISATION
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  showScreen('screen-join');

  // Préremplir le code depuis l'URL (?code=1234)
  const params = new URLSearchParams(window.location.search);
  const codeFromUrl = params.get('code');
  if (codeFromUrl) {
    const input = document.getElementById('join-code');
    if (input) {
      input.value = codeFromUrl;
      setTimeout(() => goToJoinStep('info'), 400);
    }
  }
});
