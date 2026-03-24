// ============================================================
//  GAME.JS — Moteur de jeu, timer, piste, podium
// ============================================================

const Game = (() => {
  let currentQuestionIdx = 0;
  let timer = null;
  let timeLeft = 0;
  let questionActive = false;
  let finishRankCounter = 0;
  let gamePaused = false;
  let waitingForNextLaunch = false;
  let questionStatsHistory = [];

  function normalizeAnswerText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeIndexArray(values) {
    if (!Array.isArray(values)) return [];
    const unique = [...new Set(values.filter(v => Number.isInteger(v) && v >= 0))];
    return unique.sort((a, b) => a - b);
  }

  function areSameIndexSets(a, b) {
    if (a.length !== b.length) return false;
    return a.every((value, idx) => value === b[idx]);
  }

  // ---- Diffuser un événement aux joueurs via l'API ----
  function adminBroadcast(type, payload) {
    const code  = App.state.gameCode;
    const token = App.state.adminToken;
    if (!code || !token) return;
    fetch(`/api/admin/${code}/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminToken: token, type, payload: payload || {} }),
    }).catch(() => {});
  }

  // ---- Démarrer la partie ----
  function start() {
    const players = App.state.players;
    const questions = App.state.questions;
    if (players.length === 0) {
      App.showToast('Attendez que des joueurs rejoignent !', 'error');
      return;
    }
    if (questions.length === 0) {
      App.showToast('Aucune question !', 'error');
      return;
    }

    // Reset
    currentQuestionIdx = 0;
    finishRankCounter = 0;
    gamePaused = false;
    waitingForNextLaunch = false;
    questionStatsHistory = [];
    players.forEach(p => {
      p.score = 0;
      p.position = 0;
      p.finished = false;
      p.finishRank = null;
      p.answeredCurrentQuestion = false;
    });

    App.showScreen('screen-game');
    App.playSound('start');
    buildTrack();
    // Afficher le bouton "Afficher la question" au lieu de la montrer automatiquement
    document.getElementById('btn-launch-question').style.display = 'block';
    document.getElementById('btn-stop-timer').style.display = 'none';
    document.getElementById('btn-pause-game').style.display = 'none';
    document.getElementById('btn-resume-game').style.display = 'none';
    document.getElementById('btn-launch-question').textContent = '▶️ Lancer la question';
    document.getElementById('question-card').style.display = 'none';
    document.getElementById('question-result').style.display = 'none';

    // Informer les joueurs
    adminBroadcast('gameStart');
  }

  // ---- Lancer une question par l'admin ----
  function launchQuestion() {
    const questions = App.state.questions;
    if (waitingForNextLaunch) {
      currentQuestionIdx++;
      waitingForNextLaunch = false;
    }
    if (currentQuestionIdx >= questions.length) {
      endGame(); return;
    }

    const q = questions[currentQuestionIdx];
    const total = questions.length;

    // Reset answeredCurrentQuestion
    App.state.players.forEach(p => p.answeredCurrentQuestion = false);
    questionActive = true;
    gamePaused = false;

    // Header
    document.getElementById('track-question-num').textContent = `Q${currentQuestionIdx + 1}/${total}`;
    document.getElementById('question-category').textContent = q.category || 'Question';
    document.getElementById('question-text').textContent = q.text;

    // Afficher la question dans le panneau de contrôle admin
    const ctrlTitle = document.getElementById('admin-controls-title');
    if (ctrlTitle) { ctrlTitle.textContent = q.text; ctrlTitle.classList.add('has-question'); }
    const adminChrono = document.getElementById('admin-panel-chrono');
    if (adminChrono) adminChrono.style.display = 'flex';

    // Résultat précédent masqué
    document.getElementById('question-result').style.display = 'none';
    document.getElementById('question-card').style.display = 'flex';
    document.getElementById('game-status').textContent = '';

    // Masquer le bouton "Afficher la question"
    document.getElementById('btn-launch-question').style.display = 'none';
    document.getElementById('btn-stop-timer').style.display = 'block';
    document.getElementById('btn-pause-game').style.display = 'block';
    document.getElementById('btn-resume-game').style.display = 'none';

    // Choix QCM
    const choicesGrid = document.getElementById('choices-grid');
    const openAnswer = document.getElementById('open-answer');
    const letters = ['A', 'B', 'C', 'D'];

    choicesGrid.style.display = 'none';
    openAnswer.style.display = 'none';
    choicesGrid.innerHTML = '';

    // Timer
    startTimer();

    // Diffuser la question aux joueurs
    adminBroadcast('question', { question: q, idx: currentQuestionIdx, total, timeLeft: getQuestionTime() });
  }

  function getCorrectAnswerText() {
    const q = App.state.questions[currentQuestionIdx];
    const correctIndices = q.type === 'qcm' ? (q.correctIndices || [q.correct]) : [];

    if (q.type === 'qcm') {
      if (correctIndices.length === 1) {
        return q.choices[correctIndices[0]];
      } else {
        const letters = ['A', 'B', 'C', 'D'];
        const answers = correctIndices.map(i => `${letters[i]}: ${q.choices[i]}`).join(', ');
        return `Réponses correctes: ${answers}`;
      }
    }
    return q.answer;
  }

  function completeQuestion(statusText) {
    if (!questionActive) return;
    questionActive = false;
    stopTimer();

    const q = App.state.questions[currentQuestionIdx];
    const correctIndices = q.type === 'qcm' ? (q.correctIndices || [q.correct]) : [];
    const correctAnswerText = getCorrectAnswerText();

    showCorrectAnswer(correctAnswerText);

    const results = processResults();

    // Statistiques de réussite par question et globales
    const qCorrect = results.filter(r => r.isCorrect).length;
    const qTotal = App.state.players.length;
    const qPct = qTotal > 0 ? Math.round(qCorrect / qTotal * 100) : 0;
    questionStatsHistory.push({ correct: qCorrect, total: qTotal, pct: qPct });
    const allCorrect = questionStatsHistory.reduce((s, q) => s + q.correct, 0);
    const allTotal   = questionStatsHistory.reduce((s, q) => s + q.total, 0);
    const overallPct = allTotal > 0 ? Math.round(allCorrect / allTotal * 100) : 0;
    updateAdminStats(qPct, overallPct);

    adminBroadcast('questionEnd', {
      correctIndices,
      correctAnswer: correctAnswerText,
      results,
    });

    document.getElementById('btn-stop-timer').style.display = 'none';
    document.getElementById('btn-pause-game').style.display = 'none';
    document.getElementById('btn-resume-game').style.display = 'none';
    document.getElementById('btn-launch-question').style.display = 'block';
    document.getElementById('btn-launch-question').textContent =
      currentQuestionIdx >= App.state.questions.length - 1 ? '🏁 Voir les résultats' : '▶️ Lancer la question suivante';
    document.getElementById('game-status').textContent = statusText;
    // Remettre le titre par défaut et masquer le chrono
    const ctrlTitle = document.getElementById('admin-controls-title');
    if (ctrlTitle) { ctrlTitle.textContent = '🎓 Contrôles Prof'; ctrlTitle.classList.remove('has-question'); }
    const adminChronoDiv = document.getElementById('admin-panel-chrono');
    if (adminChronoDiv) adminChronoDiv.style.display = 'none';
    waitingForNextLaunch = true;
  }

  // ---- Arrêter le chrono manuellement et traiter les résultats ----
  function stopTimerManually() {
    completeQuestion('✋ Réponse affichée. Lancez la suite quand vous êtes prêt.');
  }

  // ---- Traiter les résultats et avancer les joueurs ----
  function processResults() {
    const q = App.state.questions[currentQuestionIdx];
    const results = [];
    
    // Pour chaque joueur, vérifier sa réponse
    App.state.players.forEach(player => {
      const scoreBefore = player.score || 0;
      let isCorrect = false;

      if (player.answeredCurrentQuestion) {
        if (q.type === 'qcm') {
          const correctAnswers = normalizeIndexArray(q.correctIndices || [q.correct]);
          const playerAnswers = normalizeIndexArray(
            Array.isArray(player.lastAnswerIndices)
              ? player.lastAnswerIndices
              : (typeof player.lastAnswerIndex === 'number' ? [player.lastAnswerIndex] : [])
          );
          isCorrect = areSameIndexSets(playerAnswers, correctAnswers);
        } else {
          const playerAnswer = normalizeAnswerText(player.lastAnswer);
          const keywords = String(q.answer || '')
            .split(',')
            .map(k => normalizeAnswerText(k))
            .filter(Boolean);
          isCorrect = keywords.some(kw => playerAnswer.includes(kw));
        }
      }

      // Avancer si correct
      if (isCorrect) {
        advance(player);
      }

      results.push({
        playerId: player.id,
        isCorrect,
        score: player.score || 0,
        scoreDelta: (player.score || 0) - scoreBefore,
      });
    });

    return results;
  }

  // ---- Construction de la piste ----
  function buildTrack() {
    const lanes = document.getElementById('track-lanes');
    lanes.innerHTML = '';
    App.state.players.forEach(player => {
      const lane = document.createElement('div');
      lane.className = 'track-lane';
      lane.id = `lane-${player.id}`;
      lane.innerHTML = `
        <span class="lane-avatar">${player.avatar}</span>
        <span class="lane-name" style="color:${player.color}">${player.name}</span>
        <div class="lane-track">
          <div class="lane-progress" id="progress-${player.id}" style="width:0%;background:${player.color}"></div>
        </div>
        <span class="lane-car" id="car-${player.id}">🏎️</span>
      `;
      lanes.appendChild(lane);
    });
  }

  // ---- Déterminer le temps pour une question ----
  function getQuestionTime() {
    const q = App.state.questions[currentQuestionIdx];
    if (!q) return App.state.settings.timePerQuestion;
    
    if (q.type === 'open') {
      return 60; // Questions ouvertes: 60 secondes
    } else if (q.type === 'qcm') {
      // QCM: 45 pour unique, 60 pour multiples
      return (q.multipleAnswers || q.correctIndices?.length > 1) ? 60 : 45;
    }
    return App.state.settings.timePerQuestion;
  }

  // ---- Timer ----
  function startTimer(resume = false) {
    clearInterval(timer);
    if (!resume) {
      timeLeft = getQuestionTime();
    }
    const bar = document.getElementById('timer-bar');
    const text = document.getElementById('timer-text');
    const adminChronoEl = document.getElementById('admin-panel-chrono-value');
    const totalTime = getQuestionTime();
    const pct = (timeLeft / totalTime) * 100;
    bar.style.setProperty('--progress', pct + '%');
    bar.className = 'timer-bar';
    if (adminChronoEl) adminChronoEl.textContent = timeLeft;

    timer = setInterval(() => {
      timeLeft--;
      const pct = (timeLeft / getQuestionTime()) * 100;
      bar.style.setProperty('--progress', pct + '%');
      text.textContent = timeLeft;
      if (adminChronoEl) adminChronoEl.textContent = timeLeft;
      if (timeLeft <= 10) bar.className = 'timer-bar warning';
      if (timeLeft <= 0) {
        clearInterval(timer);
        timeExpired();
      }
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timer);
  }

  // ---- Pause/Reprise ----
  function pauseGame() {
    if (!questionActive || gamePaused) return;
    gamePaused = true;
    clearInterval(timer);
    showPauseOverlay();
    document.getElementById('btn-pause-game').style.display = 'none';
    document.getElementById('btn-resume-game').style.display = 'block';
    App.showToast('Jeu en pause', 'info');
  }

  function resumeGame() {
    if (!questionActive || !gamePaused) return;
    gamePaused = false;
    hidePauseOverlay();
    startTimer(true); // Resume with current timeLeft
    document.getElementById('btn-pause-game').style.display = 'block';
    document.getElementById('btn-resume-game').style.display = 'none';
    App.showToast('Jeu repris', 'success');
  }

  function showPauseOverlay() {
    let overlay = document.getElementById('pause-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'pause-overlay';
      overlay.className = 'pause-overlay';
      overlay.innerHTML = `
        <div class="pause-content">
          <div class="pause-icon">⏸️</div>
          <div class="pause-text">JEU EN PAUSE</div>
          <div class="pause-subtitle">Le professeur contrôle la partie</div>
        </div>
      `;
      document.getElementById('screen-game').appendChild(overlay);
    }
    overlay.style.display = 'flex';
  }

  function hidePauseOverlay() {
    const overlay = document.getElementById('pause-overlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
  }

  function timeExpired() {
    completeQuestion('⏰ Temps écoulé. Lancez la question suivante.');
  }

  // ---- Réponse QCM ----
  function handleQCMAnswer(choiceIdx) {
    if (!questionActive) return;
    const currentPlayer = App.state.currentPlayer;
    if (currentPlayer && currentPlayer.answeredCurrentQuestion) return;

    const q = App.state.questions[currentQuestionIdx];
    const correctIndices = q.correctIndices || [q.correct];

    // Marquer ce joueur et stocker sa réponse
    if (currentPlayer) {
      currentPlayer.answeredCurrentQuestion = true;
      currentPlayer.lastAnswerIndex = choiceIdx;
    }

    // Highlight les boutons
    const btns = document.querySelectorAll('.choice-btn');
    btns.forEach((btn, i) => {
      btn.disabled = true;
      if (correctIndices.includes(i)) {
        btn.classList.add('correct');
      } else if (i === choiceIdx && !correctIndices.includes(i)) {
        btn.classList.add('wrong');
      }
    });

    // En mode admin manuel, ne pas avancer le joueur maintenant
    // L'avancement se fera lors du stopTimerManually()
  }

  // ---- Réponse ouverte ----
  function submitOpenAnswer() {
    if (!questionActive) return;
    const input = document.getElementById('open-input');
    const userAnswer = input.value.trim().toLowerCase();
    if (!userAnswer) return;

    const currentPlayer = App.state.currentPlayer;
    if (currentPlayer && currentPlayer.answeredCurrentQuestion) return;

    input.disabled = true;
    if (currentPlayer) {
      currentPlayer.answeredCurrentQuestion = true;
      currentPlayer.lastAnswer = userAnswer;
    }

    // En mode admin manuel, ne pas avancer le joueur maintenant
    // L'avancement se fera lors du stopTimerManually()
    // const q = App.state.questions[currentQuestionIdx];
    // const keywords = q.answer.split(',').map(k => k.trim().toLowerCase());
    // const isCorrect = keywords.some(kw => userAnswer.includes(kw));
    // stopTimer();
    // questionActive = false;
    // showAnswerFeedback(isCorrect, q.answer);
    // setTimeout(() => nextQuestion(), 3000);
  }

  // ---- Afficher la bonne réponse ----
  function showCorrectAnswer(correctAnswer) {
    document.getElementById('result-icon').textContent = '💡';
    document.getElementById('result-text').textContent = 'Bonne réponse';
    document.getElementById('result-answer').textContent = `Réponse : ${correctAnswer}`;
    document.getElementById('question-result').style.display = 'flex';
    document.getElementById('question-card').style.display = 'flex';
  }

  // ---- Statistiques admin ----
  function updateAdminStats(questPct, overallPct) {
    const bar = document.getElementById('admin-stats-bar');
    const statCurrent = document.getElementById('stat-current');
    const statOverall = document.getElementById('stat-overall');
    if (bar) bar.style.display = 'flex';
    if (statCurrent) statCurrent.textContent = questPct + '%';
    if (statOverall) statOverall.textContent = overallPct + '%';
  }

  // ---- Avancer un joueur ----
  function advance(player) {
    const trackLen = App.state.settings.trackLength;
    player.score += 100;
    player.position = Math.min(player.position + App.state.settings.advancePerCorrect, trackLen);
    updateTrackUI(player);

    if (player.position >= trackLen && !player.finished) {
      player.finished = true;
      player.finishRank = ++finishRankCounter;
      App.playSound('finish');
      document.getElementById('game-status').textContent =
        `🏆 ${player.name} termine ${ordinal(player.finishRank)} !`;
    }
  }

  function ordinal(n) {
    if (n === 1) return '1er';
    return `${n}ème`;
  }

  // ---- Mise à jour visuelle de la piste ----
  function updateTrackUI(player) {
    const trackLen = App.state.settings.trackLength;
    const pct = (player.position / trackLen) * 100;
    const bar = document.getElementById(`progress-${player.id}`);
    if (bar) bar.style.width = pct + '%';

    // Animation petite voiture
    const car = document.getElementById(`car-${player.id}`);
    if (car) {
      car.style.transform = 'scale(1.4)';
      setTimeout(() => { if (car) car.style.transform = ''; }, 400);
    }
  }

  // ---- Fin de partie ----
  function endGame() {
    stopTimer();
    App.showScreen('screen-podium');
    showPodium();
    // Informer les joueurs de la fin de partie
    adminBroadcast('gameEnd', { players: App.state.players });
  }

  // ---- Podium ----
  function showPodium() {
    const players = [...App.state.players].sort((a, b) => {
      if (b.position !== a.position) return b.position - a.position;
      return b.score - a.score;
    });

    // Confettis
    launchConfetti();

    // Podium des 3 premiers
    const podiumEl = document.getElementById('podium-stage');
    podiumEl.innerHTML = '';
    const podiumOrder = [1, 0, 2]; // 2ème, 1er, 3ème pour l'affichage
    const classes = ['second', 'first', 'third'];
    const medals = ['🥈', '🥇', '🥉'];
    const heights = ['90px', '120px', '70px'];

    podiumOrder.forEach((rank, displayPos) => {
      const p = players[rank];
      if (!p) return;
      const div = document.createElement('div');
      div.className = `podium-place ${classes[displayPos]}`;
      div.style.animationDelay = `${displayPos * 0.15}s`;
      div.innerHTML = `
        ${displayPos === 1 ? '<div class="podium-crown">👑</div>' : ''}
        <div class="podium-avatar">${p.avatar}</div>
        <div class="podium-player-name" style="color:${p.color}">${p.name}</div>
        <div class="podium-score">${p.score} pts</div>
        <div class="podium-block" style="height:${heights[displayPos]}">${medals[displayPos]}</div>
      `;
      podiumEl.appendChild(div);
    });

    // Tous les scores
    const scoresEl = document.getElementById('all-scores');
    scoresEl.innerHTML = '';
    const maxScore = players[0]?.score || 1;
    players.forEach((p, i) => {
      const row = document.createElement('div');
      const isMe = App.state.currentPlayer && p.id === App.state.currentPlayer.id;
      row.className = `score-row${isMe ? ' is-me' : ''}`;
      row.innerHTML = `
        <span class="score-rank">${i + 1}</span>
        <span class="score-avatar">${p.avatar}</span>
        <span class="score-name" style="color:${p.color}">${p.name}${isMe ? ' (vous)' : ''}</span>
        <div class="score-bar-wrap">
          <div class="score-bar" style="width:${(p.score / maxScore) * 100}%"></div>
        </div>
        <span class="score-val">${p.score}</span>
      `;
      scoresEl.appendChild(row);
    });

    // Message personnalisé pour le joueur courant
    const msgEl = document.getElementById('player-message');
    const me = App.state.currentPlayer;
    if (me) {
      const rank = players.findIndex(p => p.id === me.id) + 1;
      msgEl.style.display = 'block';
      if (rank === 1) msgEl.textContent = `🥇 Félicitations ${me.name} ! Tu es le champion de ce quiz ! 🎉`;
      else if (rank === 2) msgEl.textContent = `🥈 Bravo ${me.name} ! Magnifique 2ème place ! 👏`;
      else if (rank === 3) msgEl.textContent = `🥉 Bien joué ${me.name} ! Tu arrives sur le podium ! 🌟`;
      else if (rank <= Math.ceil(players.length / 2)) msgEl.textContent = `👍 Pas mal ${me.name} ! Tu es dans la première moitié, continue !`;
      else msgEl.textContent = `💪 ${me.name}, tu sais ce qu'il te reste à réviser ! La prochaine fois sera la bonne !`;
    } else {
      msgEl.style.display = 'none';
    }
  }

  // ---- Confettis ----
  function launchConfetti() {
    const container = document.getElementById('confetti-container');
    container.innerHTML = '';
    const colors = ['#f7c948', '#4fa3ff', '#4ecb71', '#ff6b6b', '#a78bfa', '#ff9f43'];
    for (let i = 0; i < 80; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.cssText = `
        left: ${Math.random() * 100}%;
        background: ${colors[Math.floor(Math.random() * colors.length)]};
        width: ${6 + Math.random() * 8}px;
        height: ${6 + Math.random() * 8}px;
        animation: fall ${2 + Math.random() * 3}s ${Math.random() * 2}s linear forwards;
        border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
      `;
      container.appendChild(piece);
    }
  }

  // ---- Rejouer ----
  function playAgain() {
    // Reset game state
    currentQuestionIdx = 0;
    finishRankCounter = 0;
    App.state.players.forEach(p => {
      p.score = 0; p.position = 0;
      p.finished = false; p.finishRank = null;
      p.answeredCurrentQuestion = false;
    });
    App.showScreen('screen-admin');
    Admin.showTab('tab-questions');
    App.showToast('Modifiez les questions et relancez !', '');
  }

  return { start, submitOpenAnswer, playAgain, launchQuestion, stopTimerManually, pauseGame, resumeGame };
})();
