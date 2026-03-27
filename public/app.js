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
    savedFillActivities: [],
    // Pour la gestion des jeux
    gameCode: null,     // Code à 4 chiffres pour la session actuelle
    adminToken: null,   // Token d'authentification admin (retourné par /api/host)
    currentQuiz: null,  // Quiz en cours
    accessGranted: false, // accès admin verrouillé par défaut
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

  const QUIZ_STORAGE_KEY = 'quizrace_saved';
  const QUIZ_STORAGE_LEGACY_KEYS = ['quizzes'];
  const QUESTIONS_STORAGE_KEY = 'quizrace_questions';
  const SETTINGS_STORAGE_KEY = 'quizrace_settings';
  const FILL_STORAGE_KEY = 'quizrace_fill_activities';

  // ---- Garde admin ----
  const ADMIN_SCREENS = new Set(['screen-quiz-list', 'screen-admin', 'screen-lobby', 'screen-game', 'screen-fill-builder', 'screen-fill-game']);
  const ADMIN_PASSWORD = 'FORMA974';
  const ADMIN_SESSION_KEY = 'kikabon_admin_ok';

  // ---- Écrans ----
  function showScreen(id) {
    // Garde admin: intercepte si l'écran est réservé et l'accès n'est pas validé
    if (ADMIN_SCREENS.has(id) && !isAdminUnlocked()) {
      requestAdminAccess(id);
      return;
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
        updateAdminCurrentCodeBadge();
        
        // Screen-specific initialization
        if (id === 'screen-lobby') {
          Lobby.refreshPlayers();
          // Generate QR code pointing to player join page
          const qrContainer = document.getElementById('lobby-qrcode');
          if (qrContainer) {
            const joinUrl = state.gameCode
              ? `https://kikabon.onrender.com/join-new-game?code=${encodeURIComponent(state.gameCode)}`
              : 'https://kikabon.onrender.com/play';
            qrContainer.innerHTML = '';
            new QRCode(qrContainer, {
              text: joinUrl,
              width: 240,
              height: 240,
              colorDark: '#1a1a2e',
              colorLight: '#ffffff',
              correctLevel: QRCode.CorrectLevel.M
            });
          }
        }
      });
    }
  }

  function updateAdminCurrentCodeBadge() {
    const badge = document.getElementById('admin-current-code');
    const value = document.getElementById('admin-current-code-value');
    if (!badge || !value) return;
    if (state.gameCode) {
      value.textContent = state.gameCode;
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  }

  // ---- Écrans réservés à l'admin (nécessitent le mot de passe) ----
  function isAdminUnlocked() {
    try { return sessionStorage.getItem(ADMIN_SESSION_KEY) === '1'; } catch (e) { return false; }
  }

  function safeParseJson(rawValue, fallbackValue, label) {
    if (!rawValue) return fallbackValue;
    try {
      return JSON.parse(rawValue);
    } catch (error) {
      console.log('[storage] parse failed for ' + label, error);
      return fallbackValue;
    }
  }

  function safeStringifyJson(value, label) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      console.log('[storage] stringify failed for ' + label, error);
      return null;
    }
  }

  function readSavedQuizzesFromStorage() {
    const keys = [QUIZ_STORAGE_KEY, ...QUIZ_STORAGE_LEGACY_KEYS];
    for (const key of keys) {
      let rawValue = null;
      try {
        rawValue = localStorage.getItem(key);
      } catch (error) {
        console.log('[storage] read failed for ' + key, error);
        return [];
      }
      if (!rawValue) continue;
      const parsed = safeParseJson(rawValue, [], key);
      if (Array.isArray(parsed)) {
        console.log('[storage] loaded activities from ' + key + ' (' + parsed.length + ')');
        return parsed;
      }
      console.log('[storage] ignored non-array payload in ' + key);
    }
    console.log('[storage] no saved activities found');
    return [];
  }

  // ---- Stockage unifié : quizzes + textes à trous dans la même clé ----
  function _readAllActivities() {
    return readSavedQuizzesFromStorage();
  }

  function _writeAllActivities(quizzes, fills) {
    const tagged = [
      ...quizzes.map(q => ({ ...q, type: 'quiz' })),
      ...fills.map(f => ({ ...f, type: 'fill' })),
    ];
    const payload = safeStringifyJson(tagged, QUIZ_STORAGE_KEY);
    if (payload === null) return false;
    try { localStorage.setItem(QUIZ_STORAGE_KEY, payload); return true; } catch (e) { return false; }
  }

  function normalizeSavedQuizzes(quizzes) {
    let changed = false;
    const used = new Set();
    const normalized = (Array.isArray(quizzes) ? quizzes : []).map(quiz => {
      const clone = { ...quiz };
      const moduleId = String(clone.moduleId || '').trim();
      if (!moduleId) {
        clone.moduleId = 'uncategorized';
        changed = true;
      }
      let code = String(clone.gameCode || '').trim();
      const valid = /^\d{4}$/.test(code) && !used.has(code);
      if (!valid) {
        do {
          code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
        } while (used.has(code));
        clone.gameCode = code;
        changed = true;
      }
      used.add(code);
      return clone;
    });
    return { quizzes: normalized, changed };
  }

  function persistSavedQuizzes(nextQuizzes) {
    const source = Array.isArray(nextQuizzes) ? nextQuizzes : state.savedQuizzes;
    const { quizzes } = normalizeSavedQuizzes(source);
    const ok = _writeAllActivities(quizzes, state.savedFillActivities);
    if (!ok) {
      console.log('[storage] failed to save quizzes');
      return false;
    }
    state.savedQuizzes = quizzes;
    console.log('[storage] quizzes saved successfully (' + quizzes.length + ')');
    renderQuizList();
    return true;
  }

  function lockAdminScreens() {
    ADMIN_SCREENS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.visibility = 'hidden';
    });
  }

  function unlockAdminScreens() {
    ADMIN_SCREENS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.visibility = '';
    });
  }

  // Ouvre la modale et mémorise l'écran cible
  let _pendingAdminScreen = null;

  function _closeAuthModal(callback) {
    const overlay = document.getElementById('admin-auth-overlay');
    if (!overlay) { if (callback) callback(); return; }
    overlay.classList.remove('is-open');
    overlay.classList.add('is-closing');
    setTimeout(() => {
      overlay.classList.remove('is-closing');
      overlay.style.display = 'none';
      if (callback) callback();
    }, 220); // durée = transition CSS
  }

  function requestAdminAccess(targetScreen) {
    if (isAdminUnlocked()) {
      state.accessGranted = true;
      unlockAdminScreens();
      showScreen(targetScreen || 'screen-quiz-list');
      return;
    }
    _pendingAdminScreen = targetScreen || 'screen-quiz-list';
    const overlay = document.getElementById('admin-auth-overlay');
    const input   = document.getElementById('admin-auth-input');
    const err     = document.getElementById('admin-auth-error');
    if (!overlay) return;
    if (err) err.style.display = 'none';
    if (input) input.value = '';
    overlay.style.display = '';
    overlay.classList.remove('is-closing');
    // forcer reflow avant d'ajouter la classe pour rejouer l'animation
    void overlay.offsetWidth;
    overlay.classList.add('is-open');
    setTimeout(() => { if (input) input.focus(); }, 80);
  }

  function submitAdminPassword() {
    const input = document.getElementById('admin-auth-input');
    const err   = document.getElementById('admin-auth-error');
    const val   = input ? input.value : '';
    if (val === ADMIN_PASSWORD) {
      try { sessionStorage.setItem(ADMIN_SESSION_KEY, '1'); } catch (e) {}
      // Déblocage immédiat de l'interface, fermeture avec fondu
      state.accessGranted = true;
      unlockAdminScreens();
      const destScreen = _pendingAdminScreen || 'screen-quiz-list';
      _pendingAdminScreen = null;
      _closeAuthModal(() => showScreen(destScreen));
    } else {
      if (err) err.style.display = 'block';
      if (input) {
        input.value = '';
        input.classList.remove('shake');
        void input.offsetWidth;
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 400);
        input.focus();
      }
    }
  }

  function cancelAdminAccess() {
    _pendingAdminScreen = null;
    _closeAuthModal(() => showScreen('screen-home'));
  }

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
    const saved = safeParseJson(localStorage.getItem(SETTINGS_STORAGE_KEY), null, SETTINGS_STORAGE_KEY);
    if (saved && typeof saved === 'object') Object.assign(state.settings, saved);
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
    const payload = safeStringifyJson(state.settings, SETTINGS_STORAGE_KEY);
    if (payload !== null) {
      localStorage.setItem(SETTINGS_STORAGE_KEY, payload);
    }
  }

  // ---- Charger quiz sauvegardés ----
  function loadSavedQuizzes() {
    const all = _readAllActivities();
    const quizItems = all.filter(item => item.type !== 'fill');
      const fillItems  = all.filter(item => item.type === 'fill');
      const normalized = normalizeSavedQuizzes(quizItems);
    state.savedQuizzes = normalized.quizzes;
    if (normalized.changed) {
        _writeAllActivities(state.savedQuizzes, fillItems);
    }
  }

  function loadSavedFillActivities() {
    const all = _readAllActivities();
    state.savedFillActivities = all.filter(item => item.type === 'fill');
    // Migration depuis l'ancienne clé séparée
    try {
      const legacyRaw = localStorage.getItem(FILL_STORAGE_KEY);
      if (legacyRaw) {
        const legacyFills = JSON.parse(legacyRaw);
        if (Array.isArray(legacyFills) && legacyFills.length > 0) {
          const existingIds = new Set(state.savedFillActivities.map(f => f.id));
          const toMigrate = legacyFills.filter(f => !existingIds.has(f.id));
          if (toMigrate.length > 0) {
            state.savedFillActivities = [...state.savedFillActivities, ...toMigrate];
            _writeAllActivities(state.savedQuizzes, state.savedFillActivities);
          }
        }
        localStorage.removeItem(FILL_STORAGE_KEY);
      }
    } catch (e) {}
  }

  function persistSavedFillActivities(list) {
    const source = Array.isArray(list) ? list : state.savedFillActivities;
    const ok = _writeAllActivities(state.savedQuizzes, source);
    if (!ok) return false;
    state.savedFillActivities = source;
    renderQuizList();
    return true;
  }

  // ---- Sons ----
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;
  function startLobbyMusic() {}
  function stopLobbyMusic() {}

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
      const notes = [523, 659, 784, 988, 1175, 988, 784];
      notes.forEach((f, i) => {
        const o2 = audioCtx.createOscillator();
        const g2 = audioCtx.createGain();
        o2.connect(g2); g2.connect(audioCtx.destination);
        o2.frequency.value = f;
        g2.gain.setValueAtTime(0.18, now + i * 0.08);
        g2.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.22);
        o2.start(now + i * 0.08); o2.stop(now + i * 0.08 + 0.24);
      });
    } else if (type === 'question') {
      const notes = [659, 784, 988];
      notes.forEach((f, i) => {
        const o2 = audioCtx.createOscillator();
        const g2 = audioCtx.createGain();
        o2.type = 'triangle';
        o2.connect(g2); g2.connect(audioCtx.destination);
        o2.frequency.value = f;
        g2.gain.setValueAtTime(0.14, now + i * 0.06);
        g2.gain.exponentialRampToValueAtTime(0.001, now + i * 0.06 + 0.2);
        o2.start(now + i * 0.06); o2.stop(now + i * 0.06 + 0.22);
      });
    } else if (type === 'ui') {
      const o2 = audioCtx.createOscillator();
      const g2 = audioCtx.createGain();
      o2.type = 'sine';
      o2.connect(g2); g2.connect(audioCtx.destination);
      o2.frequency.setValueAtTime(740, now);
      g2.gain.setValueAtTime(0.1, now);
      g2.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      o2.start(now); o2.stop(now + 0.14);
    } else if (type === 'tada') {
      const notes = [784, 988, 1175, 1568];
      notes.forEach((f, i) => {
        const o2 = audioCtx.createOscillator();
        const g2 = audioCtx.createGain();
        o2.type = 'triangle';
        o2.connect(g2); g2.connect(audioCtx.destination);
        o2.frequency.value = f;
        g2.gain.setValueAtTime(0.22, now + i * 0.07);
        g2.gain.exponentialRampToValueAtTime(0.001, now + i * 0.07 + 0.25);
        o2.start(now + i * 0.07); o2.stop(now + i * 0.07 + 0.28);
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
    loadSavedFillActivities();

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
    if (!localStorage.getItem(QUESTIONS_STORAGE_KEY)) {
      state.questions = getDemoQuestions();
    } else {
      const savedQuestions = safeParseJson(localStorage.getItem(QUESTIONS_STORAGE_KEY), getDemoQuestions(), QUESTIONS_STORAGE_KEY);
      state.questions = Array.isArray(savedQuestions) ? savedQuestions : getDemoQuestions();
    }

    // Rendu admin uniquement si le module Admin est disponible
    if (typeof Admin !== 'undefined') {
      Admin.renderQuestions();
      Admin.renderSaved();
    }
    if (document.getElementById('quiz-grid')) {
      renderQuizList();
    }

    // Masquer les écrans admin dès le départ si pas encore déverrouillé
    if (!isAdminUnlocked()) {
      lockAdminScreens();
    } else {
      state.accessGranted = true;
      unlockAdminScreens();
    }

    // Routage initial: /admin ouvre directement les quiz sauvegardés
    if (document.getElementById('screen-home')) {
      const path = window.location.pathname;
      const isAdminPath =
        path === '/admin' ||
        path === '/admin/' ||
        path === '/admin/index.html' ||
        path.startsWith('/admin/');
      if (isAdminPath) {
        // Demande le mot de passe avant d'afficher l'interface admin
        showScreen('screen-home');
        requestAdminAccess('screen-quiz-list');
      } else {
        showScreen('screen-home');
      }
      updateAdminCurrentCodeBadge();
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

  // ---- Mettre à jour la longueur de la piste selon le nombre de questions ----
  function updateTrackLength() {
    state.settings.trackLength = Math.max(state.questions.length, 1);
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
      const currentTitle = state.currentQuiz ? `✏️ ${state.currentQuiz.name}` : '🆕 Nouveau quiz';
      
      currentCard.innerHTML = `
        <div class="quiz-card-title">${currentTitle}</div>
        <div class="quiz-card-stats">
          <div class="quiz-card-stat">❓ ${stats}</div>
        </div>
        <div class="quiz-card-actions">
          <button class="quiz-card-btn" onclick="Admin.startNewQuiz(); event.stopPropagation();">
            ➕ Nouveau
          </button>
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
          <div class="quiz-card-stat">🔢 Code: ${quiz.gameCode || '----'}</div>
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

    // Afficher les textes à trous dans la meme liste d'activites
    (state.savedFillActivities || []).forEach(activity => {
      const card = document.createElement('div');
      card.className = 'quiz-card saved-fill-activity';

      const previewText = (function buildPreviewText() {
        const segments = Array.isArray(activity.segments) ? activity.segments : [];
        const holes = Array.isArray(activity.holes) ? activity.holes : [];
        let text = '';
        segments.forEach((seg, i) => {
          text += String(seg || '');
          if (i < holes.length) text += ' ____ ';
        });
        const compact = text.replace(/\s+/g, ' ').trim();
        return compact.length > 160 ? compact.slice(0, 159) + '…' : compact;
      })();

      card.innerHTML = `
        <div class="fill-card-top">
          <div class="quiz-card-title">📝 ${activity.name}</div>
          <span class="fill-level-pill">Niveau ${activity.level || 1}</span>
        </div>
        <div class="quiz-card-stats">
          <div class="quiz-card-stat">🧩 ${activity.holes.length} trou${activity.holes.length > 1 ? 's' : ''}</div>
          <div class="quiz-card-stat">📅 ${activity.date || '-'}</div>
        </div>
        <p class="fill-card-preview">${previewText}</p>
        <div class="quiz-card-actions">
          <button class="quiz-card-btn" onclick="FillActivity.launchFillActivity(${activity.id}); event.stopPropagation();">
            ▶️ Lancer
          </button>
          <button class="quiz-card-btn secondary" onclick="FillActivity.editFillActivity(${activity.id}); event.stopPropagation();">
            ✏️ Modifier
          </button>
          <button class="quiz-card-btn secondary" onclick="FillActivity.deleteFillActivity(${activity.id}); event.stopPropagation();">
            🗑️ Supprimer
          </button>
        </div>
      `;

      grid.appendChild(card);
    });
    
    // Gérer l'état vide
    const hasContent = state.questions.length > 0 || state.savedQuizzes.length > 0 || (state.savedFillActivities || []).length > 0;
    grid.style.display = hasContent ? 'grid' : 'none';
    empty.style.display = hasContent ? 'none' : 'flex';
  }

  // ---- Initialiser quiz list au chargement ----
  function initQuizList() {
    renderQuizList();
  }

  return { state, AVATARS, PLAYER_COLORS, showScreen, requestAdminAccess, submitAdminPassword, cancelAdminAccess, joinGame, joinGameWithCode, goToJoinStep, initQuizList, renderQuizList, showToast, playSound, startLobbyMusic, stopLobbyMusic, loadSavedQuizzes, persistSavedQuizzes, loadSavedFillActivities, persistSavedFillActivities, updateTrackLength, updateAdminCurrentCodeBadge, init };
})();

// ============================================================
//  LOBBY
// ============================================================
const Lobby = (() => {
  function getContainer() {
    return document.getElementById('lobby-players') || document.getElementById('players-list');
  }

  function updatePlayerCount() {
    const counter = document.getElementById('lobby-player-count');
    const launchButton = document.getElementById('btn-launch-quiz-lobby');
    if (!counter) return;
    const count = Array.isArray(App.state.players) ? App.state.players.length : 0;
    if (count === 0) {
      counter.textContent = 'Aucun joueur connecté';
      if (launchButton) launchButton.textContent = '🚦 Lancer le quiz (0 joueur)';
      return;
    }
    counter.textContent = `${count} joueur${count > 1 ? 's' : ''} connecté${count > 1 ? 's' : ''}`;
    if (launchButton) launchButton.textContent = `🚦 Lancer le quiz (${count} joueur${count > 1 ? 's' : ''})`;
  }

  function addPlayer(player) {
    const container = getContainer();
    if (!container) return;
    const isAdmin = !!document.getElementById('lobby-players');
    if (document.getElementById(`lobby-player-${player.id}`)) {
      updatePlayerCount();
      return;
    }
    const card = document.createElement('div');
    card.className = 'lobby-player-card';
    card.id = `lobby-player-${player.id}`;
    card.innerHTML = `
      <div class="lobby-player-avatar">${player.avatar}</div>
      <div class="lobby-player-name" style="color:${player.color}">${player.name}</div>
      ${isAdmin ? `<button class="lobby-player-delete" onclick="Lobby.removePlayer(${player.id})" title="Supprimer le joueur">🗑️</button>` : ''}
    `;
    container.appendChild(card);
    updatePlayerCount();
  }

  function removePlayer(playerId) {
    const playerIndex = App.state.players.findIndex(p => p.id === playerId);
    if (playerIndex !== -1) App.state.players.splice(playerIndex, 1);
    const card = document.getElementById(`lobby-player-${playerId}`);
    if (card) card.remove();
    updatePlayerCount();
    App.showToast('Joueur supprimé', 'success');
  }

  function refreshPlayers() {
    const container = getContainer();
    if (!container) return;
    container.innerHTML = '';
    App.state.players.forEach(player => addPlayer(player));
    updatePlayerCount();
  }

  function clearPlayers() {
    const container = getContainer();
    if (container) container.innerHTML = '';
    updatePlayerCount();
  }

  return { addPlayer, removePlayer, refreshPlayers, clearPlayers, updatePlayerCount };
})();

document.addEventListener('DOMContentLoaded', App.init);


