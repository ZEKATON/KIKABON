// ============================================================
//  GAME.JS — Moteur de jeu, timer, piste, podium
// ============================================================

const Game = (() => {
  let currentQuestionIdx = 0;
  let timer = null;
  let timeLeft = 0;
  let questionActive = false;
  let finishRankCounter = 0;
  let questionLaunchedByAdmin = false;
  let gamePaused = false;

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
    questionLaunchedByAdmin = false;
    gamePaused = false;
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
    document.getElementById('question-card').style.display = 'none';
    document.getElementById('question-result').style.display = 'none';

    // Informer les onglets joueurs
    if (typeof syncChannel !== 'undefined') {
      syncChannel.postMessage({ type: 'gameStart', payload: {} });
    }
  }

  // ---- Lancer une question par l'admin ----
  function launchQuestion() {
    const questions = App.state.questions;
    if (currentQuestionIdx >= questions.length) {
      endGame(); return;
    }

    const q = questions[currentQuestionIdx];
    const total = questions.length;

    // Reset answeredCurrentQuestion
    App.state.players.forEach(p => p.answeredCurrentQuestion = false);
    questionLaunchedByAdmin = true;
    questionActive = true;

    // Header
    document.getElementById('track-question-num').textContent = `Q${currentQuestionIdx + 1}/${total}`;
    document.getElementById('question-category').textContent = q.category || 'Question';
    document.getElementById('question-text').textContent = q.text;

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

    if (q.type === 'qcm') {
      choicesGrid.style.display = 'grid';
      openAnswer.style.display = 'none';
      choicesGrid.innerHTML = '';
      q.choices.forEach((choice, i) => {
        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.innerHTML = `<span class="choice-letter">${letters[i]}</span>${choice}`;
        btn.onclick = () => handleQCMAnswer(i);
        choicesGrid.appendChild(btn);
      });
    } else {
      choicesGrid.style.display = 'none';
      openAnswer.style.display = 'flex';
      const input = document.getElementById('open-input');
      input.value = '';
      input.disabled = false;
      input.focus();
      input.onkeydown = e => { if (e.key === 'Enter') submitOpenAnswer(); };
    }

    // Timer
    startTimer();

    // Diffuser la question aux onglets joueurs
    if (typeof syncChannel !== 'undefined') {
      syncChannel.postMessage({ type: 'question', payload: { question: q, idx: currentQuestionIdx, total, timeLeft: getQuestionTime() } });
    }
  }

  // ---- Afficher une question ----
  function showQuestion() {
    launchQuestion();
  }

  // ---- Arrêter le chrono manuellement et traiter les résultats ----
  function stopTimerManually() {
    if (!questionActive) return;
    questionActive = false;
    stopTimer();
    
    // Afficher la(les) bonne(s) réponse(s)
    const q = App.state.questions[currentQuestionIdx];
    let correctAnswerText;
    const correctIndices = q.type === 'qcm' ? (q.correctIndices || [q.correct]) : [];
    
    if (q.type === 'qcm') {
      if (correctIndices.length === 1) {
        correctAnswerText = q.choices[correctIndices[0]];
      } else {
        // Plusieurs bonnes réponses
        const letters = ['A', 'B', 'C', 'D'];
        const answers = correctIndices.map(i => `${letters[i]}: ${q.choices[i]}`).join(', ');
        correctAnswerText = `Réponses correctes: ${answers}`;
      }
    } else {
      correctAnswerText = q.answer;
    }
    
    // Marquer les bonnes réponses dans l'UI
    const btns = document.querySelectorAll('.choice-btn');
    btns.forEach((btn, i) => {
      btn.disabled = true;
      if (q.type === 'qcm' && correctIndices.includes(i)) {
        btn.classList.add('correct');
      }
    });
    
    showCorrectAnswer(false, correctAnswerText);

    // Informer les onglets joueurs de la fin de question
    if (typeof syncChannel !== 'undefined') {
      syncChannel.postMessage({ type: 'questionEnd', payload: { correctIndices, correctAnswer: correctAnswerText } });
    }

    // Traiter les résultats et avancer les joueurs qui ont bien répondu
    processResults();

    // Masquer le bouton "Arrêter le chrono"
    document.getElementById('btn-stop-timer').style.display = 'none';
    document.getElementById('btn-pause-game').style.display = 'none';
    document.getElementById('btn-resume-game').style.display = 'none';

    document.getElementById('game-status').textContent = '✋ Chrono arrêté par le prof';
    setTimeout(() => nextQuestion(), 3000);
  }

  // ---- Traiter les résultats et avancer les joueurs ----
  function processResults() {
    const q = App.state.questions[currentQuestionIdx];
    
    // Pour chaque joueur, vérifier sa réponse
    App.state.players.forEach(player => {
      if (!player.answeredCurrentQuestion) return; // Non répondu

      let isCorrect = false;
      
      if (q.type === 'qcm') {
        // Récupérer l'index de la réponse donnée
        const playerAnswer = player.lastAnswerIndex;
        
        // Déterminer si c'est un QCM avec choix multiples
        const correctAnswers = q.correctIndices || [q.correct];
        isCorrect = correctAnswers.includes(playerAnswer);
      } else {
        // Pour les réponses ouvertes, check les mots-clés
        const playerAnswer = player.lastAnswer?.toLowerCase() || '';
        const keywords = q.answer.split(',').map(k => k.trim().toLowerCase());
        isCorrect = keywords.some(kw => playerAnswer.includes(kw));
      }

      // Avancer si correct
      if (isCorrect) {
        advance(player);
      }
    });
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

  // ---- Afficher une question ----
  function showQuestion() {
    const questions = App.state.questions;
    if (currentQuestionIdx >= questions.length) {
      endGame(); return;
    }

    const q = questions[currentQuestionIdx];
    const total = questions.length;

    // Reset answeredCurrentQuestion
    App.state.players.forEach(p => p.answeredCurrentQuestion = false);
    questionActive = true;

    // Header
    document.getElementById('track-question-num').textContent = `Q${currentQuestionIdx + 1}/${total}`;
    document.getElementById('question-category').textContent = q.category || 'Question';
    document.getElementById('question-text').textContent = q.text;

    // Résultat précédent masqué
    document.getElementById('question-result').style.display = 'none';
    document.getElementById('question-card').style.display = 'flex';
    document.getElementById('game-status').textContent = '';

    // Choix QCM
    const choicesGrid = document.getElementById('choices-grid');
    const openAnswer = document.getElementById('open-answer');
    const letters = ['A', 'B', 'C', 'D'];

    if (q.type === 'qcm') {
      choicesGrid.style.display = 'grid';
      openAnswer.style.display = 'none';
      choicesGrid.innerHTML = '';
      q.choices.forEach((choice, i) => {
        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.innerHTML = `<span class="choice-letter">${letters[i]}</span>${choice}`;
        btn.onclick = () => handleQCMAnswer(i);
        choicesGrid.appendChild(btn);
      });
    } else {
      choicesGrid.style.display = 'none';
      openAnswer.style.display = 'flex';
      const input = document.getElementById('open-input');
      input.value = '';
      input.disabled = false;
      input.focus();
      input.onkeydown = e => { if (e.key === 'Enter') submitOpenAnswer(); };
    }

    // Timer
    startTimer();
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
    const totalTime = getQuestionTime();
    const pct = (timeLeft / totalTime) * 100;
    bar.style.setProperty('--progress', pct + '%');
    bar.className = 'timer-bar';
    bar.className = 'timer-bar';

    timer = setInterval(() => {
      timeLeft--;
      const pct = (timeLeft / getQuestionTime()) * 100;
      bar.style.setProperty('--progress', pct + '%');
      text.textContent = timeLeft;
      if (timeLeft <= 10) bar.className = 'timer-bar warning';
      if (timeLeft <= 0) {
        clearInterval(timer);
        timeExpired();
      }
      // Diffuser le chrono aux joueurs (toutes les 5 secondes pour économiser)
      if (typeof syncChannel !== 'undefined' && timeLeft % 5 === 0) {
        syncChannel.postMessage({ type: 'timerTick', payload: { timeLeft } });
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
    if (!questionActive) return;
    questionActive = false;
    showCorrectAnswer(false, null);
    document.getElementById('game-status').textContent = '⏰ Temps écoulé !';
    setTimeout(() => nextQuestion(), 3000);
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
  function showCorrectAnswer(wasCorrect, correctAnswer) {
    const q = App.state.questions[currentQuestionIdx];
    const ans = correctAnswer || (q.type === 'qcm' ? q.choices[q.correct] : q.answer);
    document.getElementById('result-icon').textContent = wasCorrect ? '✅' : '❌';
    document.getElementById('result-text').textContent = wasCorrect ? 'Bonne réponse !' : 'Mauvaise réponse...';
    document.getElementById('result-answer').textContent = `Réponse : ${ans}`;
    document.getElementById('question-result').style.display = 'flex';
    document.getElementById('question-card').style.display = 'none';
  }

  function showAnswerFeedback(isCorrect, correctAnswer) {
    App.playSound(isCorrect ? 'correct' : 'wrong');
    showCorrectAnswer(isCorrect, correctAnswer);
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

  // ---- Passer à la question suivante ----
  function nextQuestion() {
    currentQuestionIdx++;
    showQuestion();
  }

  // ---- Fin de partie ----
  function endGame() {
    stopTimer();
    App.showScreen('screen-podium');
    showPodium();
    // Informer les onglets joueurs
    if (typeof syncChannel !== 'undefined') {
      syncChannel.postMessage({ type: 'gameEnd', payload: { players: App.state.players } });
    }
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
