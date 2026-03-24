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
    if (id !== 'screen-login' && !state.accessGranted) {
      id = 'screen-login';
    }

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

    // Vérifier le code
    if (code !== state.gameCode) {
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
    Lobby.addPlayer(player);
    showToast(`Bienvenue ${name} ! 🎉`, 'success');
  }

  // ---- Toast ----
  function showToast(msg, type = '') {
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
    document.getElementById('setting-time').value = state.settings.timePerQuestion;
    document.getElementById('setting-advance').value = state.settings.advancePerCorrect;
    document.getElementById('setting-track').value = state.settings.trackLength;
    document.getElementById('setting-sound').checked = state.settings.soundEnabled;
  }

  function saveSettings() {
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

    // Sauvegarde auto des paramètres
    ['setting-time','setting-advance','setting-track','setting-sound'].forEach(id => {
      document.getElementById(id).addEventListener('change', saveSettings);
    });

    // Drag & drop fichier import
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
    Admin.renderQuestions();
    Admin.renderSaved();
    renderQuizList(); // Afficher la liste des quiz

    // Forcer l'écran login si pas encore authentifié
    showScreen('screen-login');
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
      if (code !== state.gameCode) {
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
    return state.gameCode;
  }

  // ---- Mettre à jour la longueur de la piste selon le nombre de questions ----
  function updateTrackLength() {
    state.settings.trackLength = Math.max(state.questions.length, 5);
  }

  // ---- Rejoindre la partie avec code ----
  function joinGameWithCode(code) {
    const name = document.getElementById('join-name').value.trim();
    const avatar = document.querySelector('.avatar-btn.selected')?.textContent || '🐼';
    if (!name) { showToast('Entrez votre prénom !', 'error'); return; }

    // Vérifier le code
    if (code !== state.gameCode) {
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
    Lobby.addPlayer(player);
    showToast(`Bienvenue ${name} ! 🎉`, 'success');
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
//  LOBBY
// ============================================================
const Lobby = (() => {
  function addPlayer(player) {
    const container = document.getElementById('lobby-players');
    const card = document.createElement('div');
    card.className = 'lobby-player-card';
    card.id = `lobby-player-${player.id}`;
    card.innerHTML = `
      <div class="lobby-player-avatar">${player.avatar}</div>
      <div class="lobby-player-name" style="color:${player.color}">${player.name}</div>
      <button class="lobby-player-delete" onclick="Lobby.removePlayer(${player.id})" title="Supprimer le joueur">🗑️</button>
    `;
    container.appendChild(card);
  }

  function removePlayer(playerId) {
    // Remove from state
    const playerIndex = App.state.players.findIndex(p => p.id === playerId);
    if (playerIndex !== -1) {
      App.state.players.splice(playerIndex, 1);
    }
    
    // Remove from UI
    const card = document.getElementById(`lobby-player-${playerId}`);
    if (card) {
      card.remove();
    }
    
    App.showToast('Joueur supprimé', 'success');
  }

  function refreshPlayers() {
    const container = document.getElementById('lobby-players');
    container.innerHTML = '';
    App.state.players.forEach(player => addPlayer(player));
  }

  function clearPlayers() {
    document.getElementById('lobby-players').innerHTML = '';
  }

  return { addPlayer, removePlayer, refreshPlayers, clearPlayers };
})();

document.addEventListener('DOMContentLoaded', App.init);
