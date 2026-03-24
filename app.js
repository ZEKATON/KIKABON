// ============================================================
//  APP.JS — État global, navigation, utilitaires
// ============================================================

const App = (() => {
  // ---- État global ----
  const state = {
    players: [],
    questions: [],
    currentPlayer: null,  // pour la vue "étudiant"
    settings: {
      timePerQuestion: 30,
      advancePerCorrect: 1,
      trackLength: 10,
      soundEnabled: true,
    },
    savedQuizzes: [],
    // Pour la gestion des jeux
    gameCode: null,  // Code à 4 chiffres pour la session actuelle
    currentQuiz: null,  // Quiz en cours (referential)
    accessGranted: true, // accès admin automatique
  };

  // ---- Avatars disponibles ----
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

  // ---- Écrans ----
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.remove('active');
      s.style.display = '';
    });
    const target = document.getElementById(id);
    if (target) {
      target.style.display = 'flex';
      // légère pause pour le reflow
      requestAnimationFrame(() => {
        target.classList.add('active');
        
        // Screen-specific initialization
        if (id === 'screen-lobby') {
          Lobby.refreshPlayers();
        }
      });
    }
  }

  // ---- Fonction supprimée: vérification du mot de passe ----

  // ---- Init avatars sur écran Join ----
  function initAvatarGrid() {
    const grid = document.getElementById('avatar-grid');
    grid.innerHTML = '';
    AVATARS.forEach((a, i) => {
      const btn = document.createElement('button');
      btn.className = 'avatar-btn';
      btn.textContent = a;
      btn.onclick = () => selectAvatar(a, btn);
      if (i === 0) btn.classList.add('selected');
      grid.appendChild(btn);
    });
    document.getElementById('join-avatar-preview').textContent = AVATARS[0];
  }

  function selectAvatar(avatar, btn) {
    document.querySelectorAll('.avatar-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    document.getElementById('join-avatar-preview').textContent = avatar;
  }

  // ---- Rejoindre la partie ----
  function joinGame() {
    const name = document.getElementById('join-name').value.trim();
    const avatar = document.querySelector('.avatar-btn.selected')?.textContent || '🐼';
    if (!name) { showToast('Entrez votre prénom !', 'error'); return; }

    const colorIdx = state.players.length % PLAYER_COLORS.length;
    const player = {
      id: Date.now(),
      name,
      avatar,
      color: PLAYER_COLORS[colorIdx],
      score: 0,
      position: 0,
      finished: false,
      finishRank: null,
      answeredCurrentQuestion: false,
    };
    state.players.push(player);
    state.currentPlayer = player;
    showScreen('screen-lobby');
    Lobby.addPlayer(player);
    showToast(`Bienvenue ${name} ! 🎉`, 'success');
  }

  // ---- Rejoindre avec code 4 chiffres ----
  function joinGameWithCode(code) {
    const name = document.getElementById('join-name').value.trim();
    const avatar = document.querySelector('.avatar-btn.selected')?.textContent || '🐼';
    if (!name) { showToast('Entrez votre prénom !', 'error'); return; }

    // Vérifier le code : mémoire (admin) ou localStorage (joueur séparé)
    const activeCode = state.gameCode || localStorage.getItem('kikabon_gameCode');
    if (!activeCode || code !== activeCode) {
      showToast('Code incorrect ! 🚫', 'error');
      return;
    }

    const colorIdx = state.players.length % PLAYER_COLORS.length;
    const player = {
      id: Date.now(),
      name,
      avatar,
      color: PLAYER_COLORS[colorIdx],
      score: 0,
      position: 0,
      finished: false,
      finishRank: null,
      answeredCurrentQuestion: false,
    };
    state.players.push(player);
    state.currentPlayer = player;
    showScreen('screen-lobby');
    if (document.getElementById('lobby-players') || document.getElementById('players-list')) {
      Lobby.addPlayer(player);
    }
    // Notifier l'admin via BroadcastChannel
    if (syncChannel) syncChannel.postMessage({ type: 'playerJoin', player });
    showToast(`Bienvenue ${name} ! 🎉`, 'success');
  }

  // ---- Toast ----
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = `toast ${type} show`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2800);
  }

  // ---- Charger les paramètres ----
  function loadSettings() {
    const saved = localStorage.getItem('quizrace_settings');
    if (saved) Object.assign(state.settings, JSON.parse(saved));
    if (document.getElementById('setting-time')) {
      document.getElementById('setting-time').value = state.settings.timePerQuestion;
      document.getElementById('setting-advance').value = state.settings.advancePerCorrect;
      document.getElementById('setting-track').value = state.settings.trackLength;
      document.getElementById('setting-sound').checked = state.settings.soundEnabled;
    }
  }

  function saveSettings() {
    if (!document.getElementById('setting-time')) return;
    state.settings.timePerQuestion = parseInt(document.getElementById('setting-time').value) || 30;
    state.settings.advancePerCorrect = parseInt(document.getElementById('setting-advance').value) || 1;
    state.settings.trackLength = parseInt(document.getElementById('setting-track').value) || 10;
    state.settings.soundEnabled = document.getElementById('setting-sound').checked;
    localStorage.setItem('quizrace_settings', JSON.stringify(state.settings));
  }

  // ---- Charger quiz sauvegardés ----
  function loadSavedQuizzes() {
    const saved = localStorage.getItem('quizrace_saved');
    if (saved) state.savedQuizzes = JSON.parse(saved);
  }

  function persistSavedQuizzes() {
    localStorage.setItem('quizrace_saved', JSON.stringify(state.savedQuizzes));
    renderQuizList(); // Re-render la liste des quiz quand les sauvegardés changent
  }

  // ---- Sons ----
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;

  function playSound(type) {
    if (!state.settings.soundEnabled) return;
    if (!audioCtx) audioCtx = new AudioCtx();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    if (type === 'correct') {
      osc.frequency.setValueAtTime(523, now);
      osc.frequency.setValueAtTime(659, now + 0.1);
      osc.frequency.setValueAtTime(784, now + 0.2);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
      osc.start(now); osc.stop(now + 0.5);
    } else if (type === 'wrong') {
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.setValueAtTime(200, now + 0.15);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.start(now); osc.stop(now + 0.4);
    } else if (type === 'start') {
      const notes = [392, 494, 587, 784];
      notes.forEach((f, i) => {
        const o2 = audioCtx.createOscillator();
        const g2 = audioCtx.createGain();
        o2.connect(g2); g2.connect(audioCtx.destination);
        o2.frequency.value = f;
        g2.gain.setValueAtTime(0.25, now + i * 0.12);
        g2.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.25);
        o2.start(now + i * 0.12); o2.stop(now + i * 0.12 + 0.3);
      });
    } else if (type === 'finish') {
      [523,659,784,1047].forEach((f, i) => {
        const o2 = audioCtx.createOscillator();
        const g2 = audioCtx.createGain();
        o2.connect(g2); g2.connect(audioCtx.destination);
        o2.frequency.value = f;
        g2.gain.setValueAtTime(0.2, now + i * 0.1);
        g2.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.3);
        o2.start(now + i * 0.1); o2.stop(now + i * 0.1 + 0.35);
      });
    }
  }

  // ---- Init ----
  function init() {
    initAvatarGrid();
    loadSettings();
    loadSavedQuizzes();

    // Sauvegarde auto des paramètres (admin seulement)
    ['setting-time','setting-advance','setting-track','setting-sound'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', saveSettings);
    });

    // Drag & drop fichier import (admin seulement)
    const drop = document.getElementById('file-drop');
    if (drop) {
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; });
      drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
      drop.addEventListener('drop', e => {
        e.preventDefault(); drop.style.borderColor = '';
        const file = e.dataTransfer.files[0];
        if (file) Admin.importFromFileObj(file);
      });
    }

    // Charger des questions de démo si rien
    if (!localStorage.getItem('quizrace_questions')) {
      state.questions = getDemoQuestions();
    } else {
      state.questions = JSON.parse(localStorage.getItem('quizrace_questions'));
    }

    // Rendu admin uniquement si le module Admin est disponible
    if (typeof Admin !== 'undefined') {
      Admin.renderQuestions();
      Admin.renderSaved();
    }
    if (document.getElementById('quiz-grid')) {
      renderQuizList();
    }

    // Afficher l'écran d'accueil (admin) ou rejoindre (joueur)
    if (document.getElementById('screen-home')) {
      showScreen('screen-home');
    }
  }

  function getDemoQuestions() {
    return [
      {
        id: 1, type: 'qcm', category: 'Géographie',
        text: 'Quelle est la capitale de la France ?',
        choices: ['Paris', 'Lyon', 'Marseille', 'Bordeaux'],
        correct: 0,
      },
      {
        id: 2, type: 'qcm', category: 'Sciences',
        text: 'Combien y a-t-il d\'os dans le corps humain adulte ?',
        choices: ['106', '206', '306', '506'],
        correct: 1,
      },
      {
        id: 3, type: 'open', category: 'Culture générale',
        text: 'Quel est le plus grand océan du monde ?',
        answer: 'pacifique',
      },
      {
        id: 4, type: 'qcm', category: 'Mathématiques',
        text: 'Combien font 7 × 8 ?',
        choices: ['48', '54', '56', '64'],
        correct: 2,
      },
      {
        id: 5, type: 'qcm', category: 'Histoire',
        text: 'En quelle année a eu lieu la Révolution Française ?',
        choices: ['1689', '1789', '1869', '1889'],
        correct: 1,
      },
    ];
  }

  // ---- Naviguer entre étapes du formulaire join ----
  function goToJoinStep(step) {
    const codeStep = document.getElementById('join-step-code');
    const infoStep = document.getElementById('join-step-info');
    
    if (step === 'code') {
      codeStep.style.display = 'block';
      infoStep.style.display = 'none';
    } else if (step === 'info') {
      const code = document.getElementById('join-code').value.trim();
      if (code.length !== 4 || isNaN(code)) {
        showToast('Entrez un code valide (4 chiffres)', 'error');
        return;
      }
      // Vérifier le code : d'abord en mémoire (admin), puis localStorage (page joueur)
      const activeCode = state.gameCode || localStorage.getItem('kikabon_gameCode');
      if (!activeCode || code !== activeCode) {
        showToast('Code incorrect ! 🚫', 'error');
        return;
      }
      codeStep.style.display = 'none';
      infoStep.style.display = 'block';
      // Initialiser le grid d'avatars
      setTimeout(initAvatarGrid, 100);
    }
  }

  // ---- Générer code de jeu (4 chiffres) ----
  function generateGameCode() {
    state.gameCode = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    localStorage.setItem('kikabon_gameCode', state.gameCode);
    return state.gameCode;
  }

  // ---- Mettre à jour la longueur de la piste selon le nombre de questions ----
  function updateTrackLength() {
    state.settings.trackLength = Math.max(state.questions.length, 5);
  }

  // ---- Afficher la page de sélection de quiz ----
  function renderQuizList() {
    const grid = document.getElementById('quiz-grid');
    const empty = document.getElementById('quiz-empty');
    
    grid.innerHTML = '';
    
    // Afficher le quiz actuel s'il y a des questions
    if (state.questions.length > 0) {
      const currentCard = document.createElement('div');
      currentCard.className = 'quiz-card';
      currentCard.onclick = () => showScreen('screen-admin');
      
      const stats = `${state.questions.length} question${state.questions.length > 1 ? 's' : ''}`;
      
      currentCard.innerHTML = `
        <div class="quiz-card-title">📋 Quiz Actuel</div>
        <div class="quiz-card-stats">
          <div class="quiz-card-stat">❓ ${stats}</div>
        </div>
        <div class="quiz-card-actions">
          <button class="quiz-card-btn" onclick="App.showScreen('screen-admin'); event.stopPropagation();">
            ✏️ Modifier
          </button>
          <button class="quiz-card-btn" onclick="Admin.launchGame(); event.stopPropagation();">
            ▶️ Lancer
          </button>
        </div>
      `;
      
      grid.appendChild(currentCard);
    }
    
    // Afficher les quiz sauvegardés
    state.savedQuizzes.forEach(quiz => {
      const card = document.createElement('div');
      card.className = 'quiz-card saved-quiz';
      
      card.innerHTML = `
        <div class="quiz-card-title">💾 ${quiz.name}</div>
        <div class="quiz-card-stats">
          <div class="quiz-card-stat">❓ ${quiz.count} question${quiz.count > 1 ? 's' : ''}</div>
          <div class="quiz-card-stat">📅 ${quiz.date}</div>
        </div>
        <div class="quiz-card-actions">
          <button class="quiz-card-btn" onclick="Admin.loadAndLaunchQuiz(${quiz.id}); event.stopPropagation();">
            ▶️ Lancer
          </button>
          <button class="quiz-card-btn secondary" onclick="Admin.loadSavedQuiz(${quiz.id}); App.showScreen('screen-admin'); event.stopPropagation();">
            ✏️ Modifier
          </button>
        </div>
      `;
      
      grid.appendChild(card);
    });
    
    // Gérer l'état vide
    const hasContent = state.questions.length > 0 || state.savedQuizzes.length > 0;
    grid.style.display = hasContent ? 'grid' : 'none';
    empty.style.display = hasContent ? 'none' : 'flex';
  }

  // ---- Initialiser quiz list au chargement ----
  function initQuizList() {
    renderQuizList();
  }

  return { state, AVATARS, PLAYER_COLORS, showScreen, joinGame, joinGameWithCode, goToJoinStep, initQuizList, renderQuizList, showToast, playSound, loadSavedQuizzes, persistSavedQuizzes, generateGameCode, updateTrackLength, init };
})();

// ============================================================
//  CANAL DE SYNCHRONISATION (BroadcastChannel même appareil/onglets)
// ============================================================
const syncChannel = new BroadcastChannel('kikabon_sync');

// ============================================================
//  LOBBY
// ============================================================
const Lobby = (() => {
  function getContainer() {
    return document.getElementById('lobby-players') || document.getElementById('players-list');
  }

  function addPlayer(player) {
    const container = getContainer();
    if (!container) return;
    const isAdmin = !!document.getElementById('lobby-players');
    const card = document.createElement('div');
    card.className = 'lobby-player-card';
    card.id = `lobby-player-${player.id}`;
    card.innerHTML = `
      <div class="lobby-player-avatar">${player.avatar}</div>
      <div class="lobby-player-name" style="color:${player.color}">${player.name}</div>
      ${isAdmin ? `<button class="lobby-player-delete" onclick="Lobby.removePlayer(${player.id})" title="Supprimer le joueur">🗑️</button>` : ''}
    `;
    container.appendChild(card);
  }

  function removePlayer(playerId) {
    const playerIndex = App.state.players.findIndex(p => p.id === playerId);
    if (playerIndex !== -1) App.state.players.splice(playerIndex, 1);
    const card = document.getElementById(`lobby-player-${playerId}`);
    if (card) card.remove();
    App.showToast('Joueur supprimé', 'success');
  }

  function refreshPlayers() {
    const container = getContainer();
    if (!container) return;
    container.innerHTML = '';
    App.state.players.forEach(player => addPlayer(player));
  }

  function clearPlayers() {
    const container = getContainer();
    if (container) container.innerHTML = '';
  }

  return { addPlayer, removePlayer, refreshPlayers, clearPlayers };
})();

// ============================================================
//  GESTION DES MESSAGES REÇUS (page joueur)
// ============================================================
syncChannel.onmessage = (e) => {
  const { type, payload } = e.data || {};

  // Joueur reçoit un autre joueur qui a rejoint → afficher dans le lobby
  if (type === 'playerJoin') {
    const p = payload;
    if (!document.getElementById(`lobby-player-${p.id}`)) {
      App.state.players.push(p);
      Lobby.addPlayer(p);
    }
    return;
  }

  // Admin reçoit la soumission d'un joueur
  if (type === 'playerAnswer') {
    const { playerId, answerIndex, answer } = payload;
    const player = App.state.players.find(p => p.id === playerId);
    if (player && !player.answeredCurrentQuestion) {
      player.answeredCurrentQuestion = true;
      player.lastAnswerIndex = answerIndex;
      player.lastAnswer = answer;
    }
    return;
  }

  // Page joueur uniquement — ne pas traiter si c'est la page admin
  if (document.getElementById('screen-home')) return;

  if (type === 'gameStart') {
    App.showScreen('screen-game');
    return;
  }

  if (type === 'question') {
    const { question, idx, total, timeLeft } = payload;
    App.showScreen('screen-game');
    PlayerGame.showQuestion(question, idx, total, timeLeft);
    return;
  }

  if (type === 'timerTick') {
    PlayerGame.updateTimer(payload.timeLeft);
    return;
  }

  if (type === 'questionEnd') {
    PlayerGame.showAnswer(payload.correctIndices, payload.correctAnswer);
    return;
  }

  if (type === 'gameEnd') {
    PlayerGame.showPodium(payload.players);
    return;
  }
};

// ============================================================
//  MOTEUR CÔTÉ JOUEUR (page /play uniquement)
// ============================================================
const PlayerGame = (() => {
  let answered = false;

  function showQuestion(q, idx, total, timeLeft) {
    answered = false;
    const qText = document.getElementById('question-text');
    const qCounter = document.getElementById('track-question-num') || document.getElementById('question-counter');
    const qCard = document.getElementById('question-card');
    const qResult = document.getElementById('question-result');
    const choicesGrid = document.getElementById('choices-grid') || document.getElementById('answers-grid');
    const openAnswer = document.getElementById('open-answer');
    const gameStatus = document.getElementById('game-status');

    if (!qText) return;
    if (qCounter) qCounter.textContent = `Q${idx + 1}/${total}`;
    if (qCard) qCard.style.display = 'flex';
    if (qResult) qResult.style.display = 'none';
    if (gameStatus) gameStatus.textContent = '';
    qText.textContent = q.text;

    if (q.type === 'qcm' && choicesGrid) {
      choicesGrid.style.display = 'grid';
      if (openAnswer) openAnswer.style.display = 'none';
      choicesGrid.innerHTML = '';
      const letters = ['A', 'B', 'C', 'D'];
      q.choices.forEach((choice, i) => {
        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.innerHTML = `<span class="choice-letter">${letters[i]}</span>${choice}`;
        btn.onclick = () => submitAnswer(i, null, btn, choicesGrid);
        choicesGrid.appendChild(btn);
      });
    } else if (q.type === 'open') {
      if (choicesGrid) choicesGrid.style.display = 'none';
      if (openAnswer) {
        openAnswer.style.display = 'flex';
        const input = document.getElementById('open-input');
        if (input) {
          input.value = '';
          input.disabled = false;
          input.onkeydown = e => { if (e.key === 'Enter') submitAnswer(null, input.value.trim(), null, null); };
        }
      }
    }
    updateTimer(timeLeft);
  }

  function submitAnswer(answerIndex, answerText, clickedBtn, grid) {
    if (answered) return;
    answered = true;
    const player = App.state.currentPlayer;
    if (!player) return;
    player.answeredCurrentQuestion = true;
    player.lastAnswerIndex = answerIndex;
    player.lastAnswer = answerText;

    // Désactiver les boutons
    if (grid) grid.querySelectorAll('.choice-btn').forEach(b => b.disabled = true);
    if (clickedBtn) clickedBtn.classList.add('selected');
    if (answerText === null && document.getElementById('open-input')) {
      document.getElementById('open-input').disabled = true;
    }

    // Informer l'admin
    syncChannel.postMessage({ type: 'playerAnswer', payload: { playerId: player.id, answerIndex, answer: answerText } });
    App.showToast('Réponse envoyée ! ✅', 'success');
  }

  function updateTimer(timeLeft) {
    const bar = document.getElementById('timer-bar');
    const text = document.getElementById('timer-text');
    const simpleTimer = document.getElementById('timer');
    if (bar) {
      bar.style.setProperty('--progress', (timeLeft / 60 * 100) + '%');
      bar.className = 'timer-bar' + (timeLeft <= 10 ? ' warning' : '');
    }
    if (text) text.textContent = timeLeft;
    if (simpleTimer) simpleTimer.textContent = timeLeft;
  }

  function showAnswer(correctIndices, correctAnswer) {
    const grid = document.getElementById('choices-grid') || document.getElementById('answers-grid');
    if (grid) {
      grid.querySelectorAll('.choice-btn').forEach((btn, i) => {
        btn.disabled = true;
        if (correctIndices && correctIndices.includes(i)) btn.classList.add('correct');
        else if (btn.classList.contains('selected')) btn.classList.add('wrong');
      });
    }
    const resultEl = document.getElementById('question-result');
    const iconEl = document.getElementById('result-icon');
    const textEl = document.getElementById('result-text');
    const ansEl = document.getElementById('result-answer');
    if (resultEl) {
      if (iconEl) iconEl.textContent = '💡';
      if (textEl) textEl.textContent = 'Résultat !';
      if (ansEl) ansEl.textContent = correctAnswer ? `Réponse : ${correctAnswer}` : '';
      resultEl.style.display = 'flex';
    }
    const qCard = document.getElementById('question-card');
    if (qCard) qCard.style.display = 'none';
  }

  function showPodium(players) {
    const standings = document.getElementById('podium-standings');
    if (!standings) return;
    const sorted = [...players].sort((a, b) => b.score - a.score);
    standings.innerHTML = sorted.map((p, i) => `
      <div class="podium-entry rank-${i + 1}">
        <span class="podium-rank">${['🥇','🥈','🥉'][i] || (i + 1)}</span>
        <span class="podium-avatar">${p.avatar}</span>
        <span class="podium-name" style="color:${p.color}">${p.name}</span>
        <span class="podium-score">${p.score} pts</span>
      </div>
    `).join('');
    App.showScreen('screen-podium');
  }

  return { showQuestion, updateTimer, showAnswer, showPodium, submitAnswer };
})();

document.addEventListener('DOMContentLoaded', App.init);

