// ============================================================
//  GAME.JS — Moteur de jeu, timer, piste, podium
// ============================================================

const Game = (() => {
  let currentQuestionIdx = 0;
  let timer = null;
  let timeLeft = 0;
  let questionActive = false;
  let finishRankCounter = 0;
  let waitingForNextLaunch = false;
  let questionStatsHistory = [];
  let _pendingOpenQuestion = null; // { statusText, correctAnswerText, correctIndices }
  let fillCorrectionState = null;

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

  function normalizeFillWord(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getFillPointsPerHole(question) {
    const holesCount = Array.isArray(question && question.holes) ? question.holes.length : 0;
    return holesCount > 0 ? Math.max(10, Math.round(100 / holesCount)) : 20;
  }

  function buildFillMarkup(question) {
    const sourceText = String(question && question.sourceText ? question.sourceText : '');
    const regex = /\[[^\]]+\]/g;
    let last = 0;
    let holeIdx = 0;
    const parts = [];
    let match;
    while ((match = regex.exec(sourceText)) !== null) {
      parts.push(sourceText.slice(last, match.index));
      parts.push(`<span class="fill-gap" data-hole-index="${holeIdx}">_____</span>`);
      holeIdx += 1;
      last = regex.lastIndex;
    }
    parts.push(sourceText.slice(last));
    return parts.join('');
  }

  function areSameIndexSets(a, b) {
    if (a.length !== b.length) return false;
    return a.every((value, idx) => value === b[idx]);
  }

  function getOpenAcceptedAnswers(rawAnswer) {
    return String(rawAnswer || '')
      .split(/\s*,\s*|\s+ou\s+/i)
      .map(k => normalizeAnswerText(k))
      .filter(Boolean);
  }

  function getQuestionTypeLabel(question) {
    if (!question || question.type === 'open') return 'Question ouverte';
    if (question.type === 'fill') {
      const level = Number(question.difficulty) === 2 ? 'Niveau 2' : 'Niveau 1';
      return `Texte a trous (${level})`;
    }
    const correctIndices = normalizeIndexArray(question.correctIndices || [question.correct]);
    const isMultipleChoice = question.multipleAnswers || correctIndices.length > 1;
    return isMultipleChoice ? 'QCM a choix multiples' : 'QCM a choix unique';
  }

  function formatQuestionMeta(question) {
    const typeLabel = getQuestionTypeLabel(question);
    const categoryLabel = String(question && question.category ? question.category : '').trim();
    return categoryLabel ? `${typeLabel} • ${categoryLabel}` : typeLabel;
  }

  function formatCorrectAnswerLabel(question, correctAnswer) {
    if (!correctAnswer) return '';
    if (question && question.type === 'fill') {
      return `Texte complet : ${String(correctAnswer).trim()}`;
    }
    if (!question || question.type === 'qcm') {
      const answerText = String(correctAnswer).replace(/^R[eé]ponses\s+correctes\s*:\s*/i, '').trim();
      const correctIndices = normalizeIndexArray(question && (question.correctIndices || [question.correct]));
      return correctIndices.length > 1
        ? `Bonnes réponses : ${answerText}`
        : `Bonne réponse : ${answerText}`;
    }
    const acceptedAnswers = String(correctAnswer)
      .split(/\s*,\s*|\s+ou\s+/i)
      .map(answer => answer.trim())
      .filter(Boolean);
    return acceptedAnswers.length > 1
      ? `Réponses acceptées : ${acceptedAnswers.join(', ')}`
      : `Réponse attendue : ${String(correctAnswer).trim()}`;
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
    if (typeof App.stopLobbyMusic === 'function') App.stopLobbyMusic();
    App.playSound('start');
    buildTrack();
    setAdminSummaryMode(false);
    // Afficher le bouton "Afficher la question" au lieu de la montrer automatiquement
    document.getElementById('btn-launch-question').style.display = 'block';
    document.getElementById('btn-stop-timer').style.display = 'none';
    document.getElementById('btn-add-time').style.display = 'none';
    const fillPanel = document.getElementById('fill-correction-panel');
    const fillOverlay = document.getElementById('fill-correction-overlay');
    if (fillPanel) fillPanel.style.display = 'none';
    if (fillOverlay) fillOverlay.style.display = 'none';
    renderAdminFillPreview(null);
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
    setAdminSummaryMode(false);

    // Reset answeredCurrentQuestion
    App.state.players.forEach(p => {
      p.answeredCurrentQuestion = false;
      // Réinitialiser l'indicateur de réponse (rouge)
      const ind = document.getElementById(`indicator-${p.id}`);
      if (ind) { ind.className = 'answer-indicator waiting'; ind.title = 'En attente...'; }
    });
    questionActive = true;

    // Header
    document.getElementById('track-question-num').textContent = `${currentQuestionIdx + 1}/${total}`;
    document.getElementById('question-category').textContent = formatQuestionMeta(q);
    const qTextEl = document.getElementById('question-text');
    if (qTextEl) {
      qTextEl.textContent = q.text;
      qTextEl.style.display = q.type === 'fill' ? 'none' : '';
    }

    // Afficher la question dans le panneau de contrôle admin
    const ctrlTitle = document.getElementById('admin-controls-title');
    if (ctrlTitle) {
      ctrlTitle.textContent = `${getQuestionTypeLabel(q)} - ${q.text}`;
      ctrlTitle.classList.add('has-question');
    }
    const adminChrono = document.getElementById('admin-panel-chrono');
    if (adminChrono) adminChrono.style.display = 'flex';

    // Résultat précédent masqué
    document.getElementById('question-result').style.display = 'none';
    const recap = document.getElementById('qcm-vote-recap');
    if (recap) {
      recap.style.display = 'none';
      recap.innerHTML = '';
    }
    closeAdminResultsModal();
    const fillOverlay = document.getElementById('fill-correction-overlay');
    const fillPanel = document.getElementById('fill-correction-panel');
    if (fillOverlay) fillOverlay.style.display = 'none';
    if (fillPanel) fillPanel.style.display = 'none';
    document.getElementById('question-card').style.display = 'flex';
    document.getElementById('game-status').textContent = '';

    // Masquer le bouton "Afficher la question"
    document.getElementById('btn-launch-question').style.display = 'none';
    document.getElementById('btn-stop-timer').style.display = 'block';
    document.getElementById('btn-add-time').style.display = 'block';

    // Choix QCM
    const choicesGrid = document.getElementById('choices-grid');
    const openAnswer = document.getElementById('open-answer');
    const fillSection = document.getElementById('fill-section');
    const fillText = document.getElementById('fill-text');
    const fillWordBank = document.getElementById('fill-word-bank');
    const letters = ['A', 'B', 'C', 'D'];

    choicesGrid.style.display = 'none';
    openAnswer.style.display = 'none';
    if (fillSection) fillSection.style.display = 'none';
    choicesGrid.innerHTML = '';
    if (fillWordBank) fillWordBank.innerHTML = '';

    if (q.type === 'qcm') {
      choicesGrid.style.display = 'grid';
      q.choices.forEach((choice, i) => {
        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.type = 'button';
        btn.disabled = true;
        btn.innerHTML = `<span class="choice-letter">${letters[i] || i + 1}</span>${choice}`;
        choicesGrid.appendChild(btn);
      });
    } else if (q.type === 'open') {
      openAnswer.style.display = 'flex';
      const input = document.getElementById('open-input');
      if (input) {
        input.value = '';
        input.disabled = true;
      }
    } else if (q.type === 'fill' && fillSection && fillText) {
      fillSection.style.display = 'flex';
      fillText.innerHTML = buildFillMarkup(q);
      if (fillWordBank) {
        fillWordBank.innerHTML = Array.isArray(q.holes)
          ? q.holes.map(h => `<span class="fill-word-chip">${h.word}</span>`).join('')
          : '';
      }
    }

    renderAdminFillPreview(q);

    // Timer
    startTimer();
    App.playSound('question');

    // Diffuser la question aux joueurs
    adminBroadcast('question', {
      question: q,
      idx: currentQuestionIdx,
      currentQuestionIndex: currentQuestionIdx,
      total,
      timeLeft: getQuestionTime()
    });
    adminBroadcast('update_state', {
      phase: 'question',
      currentQuestionIndex: currentQuestionIdx,
      question: q,
      total,
      timeLeft: getQuestionTime()
    });
  }

  function renderAdminFillPreview(question) {
    const previewText = document.getElementById('admin-fill-preview-text');
    const previewBank = document.getElementById('admin-fill-preview-bank');
    if (!previewText || !previewBank) return;

    if (question && question.type === 'fill') {
      previewText.innerHTML = buildFillMarkup(question);
      previewBank.innerHTML = Array.isArray(question.holes)
        ? question.holes.map(hole => `<span class="fill-word-chip">${String(hole.word || '')}</span>`).join('')
        : '';
      return;
    }

    const fallbackText = question && question.text
      ? String(question.text)
      : 'La zone affiche le texte a trous pendant les questions de ce type.';
    previewText.textContent = fallbackText;
    previewBank.innerHTML = '';
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
    if (q.type === 'fill') {
      return q.sourceText || q.text || '';
    }
    return q.answer;
  }

  function completeQuestion(statusText) {
    if (!questionActive) return;
    questionActive = false;
    stopTimer();
    App.playSound('tada');

    const q = App.state.questions[currentQuestionIdx];
    const correctIndices = q.type === 'qcm' ? (q.correctIndices || [q.correct]) : [];
    const correctAnswerText = getCorrectAnswerText();

    if (q.type === 'fill') {
      startFillCorrection(statusText);
      return;
    }

    // Pour les questions ouvertes, afficher le panneau de validation admin
    if (q.type === 'open') {
      _pendingOpenQuestion = { statusText, correctAnswerText, correctIndices };
      showOpenAnswerValidation(q);
      return;
    }

    _finishCompleteQuestion(statusText, correctAnswerText, correctIndices, null);
  }

  function startFillCorrection(statusText) {
    const q = App.state.questions[currentQuestionIdx];
    if (!q || q.type !== 'fill') return;

    const panel = document.getElementById('fill-correction-panel');
    const overlay = document.getElementById('fill-correction-overlay');
    const textWrap = document.getElementById('fill-correction-text');
    const bankWrap = document.getElementById('fill-correction-bank');
    const feedback = document.getElementById('fill-correction-feedback');
    const scorePanel = document.getElementById('fill-correction-scores');
    const closeBtn = document.getElementById('fill-correction-close-btn');
    if (!panel || !overlay || !textWrap || !bankWrap || !feedback) return;

    fillCorrectionState = {
      question: q,
      filled: new Array((q.holes || []).length).fill(null),
      pointsPerHole: getFillPointsPerHole(q),
      statusText,
    };

    textWrap.innerHTML = buildFillMarkup(q);
    bankWrap.innerHTML = '';
    feedback.className = 'fill-correction-feedback';
    feedback.textContent = 'Correction en cours...';
    if (scorePanel) {
      scorePanel.style.display = 'none';
      scorePanel.innerHTML = '';
    }
    if (closeBtn) closeBtn.disabled = true;

    (q.holes || []).forEach((hole, idx) => {
      const chip = document.createElement('span');
      chip.className = 'fill-word-chip admin';
      chip.draggable = true;
      chip.dataset.holeIndex = String(idx);
      chip.textContent = hole.word;
      chip.addEventListener('dragstart', event => {
        event.dataTransfer.setData('text/hole-index', String(idx));
      });
      bankWrap.appendChild(chip);
    });

    textWrap.querySelectorAll('.fill-gap').forEach(gap => {
      gap.addEventListener('dragover', event => {
        event.preventDefault();
        if (!gap.classList.contains('filled')) gap.classList.add('drag-over');
      });
      gap.addEventListener('dragleave', () => gap.classList.remove('drag-over'));
      gap.addEventListener('drop', event => {
        event.preventDefault();
        gap.classList.remove('drag-over');
        const wordIndex = Number(event.dataTransfer.getData('text/hole-index'));
        const holeIndex = Number(gap.dataset.holeIndex);
        if (!Number.isInteger(wordIndex) || !Number.isInteger(holeIndex)) return;
        applyFillCorrectionWord(holeIndex, wordIndex, gap);
      });
    });

    overlay.style.display = 'flex';
    panel.style.display = 'flex';
    document.getElementById('question-result').style.display = 'none';
    document.getElementById('btn-stop-timer').style.display = 'none';
    document.getElementById('btn-add-time').style.display = 'none';
    document.getElementById('btn-launch-question').style.display = 'none';
    waitingForNextLaunch = false;

    adminBroadcast('fillCorrectionStart', {
      currentQuestionIndex: currentQuestionIdx,
      total: (q.holes || []).length,
    });
    adminBroadcast('update_state', {
      phase: 'correction_fill',
      currentQuestionIndex: currentQuestionIdx,
      total: App.state.questions.length,
    });
  }

  function applyFillCorrectionWord(holeIndex, wordIndex, gapEl) {
    if (!fillCorrectionState) return;
    if (fillCorrectionState.filled[holeIndex]) return;
    const question = fillCorrectionState.question;
    const holes = Array.isArray(question.holes) ? question.holes : [];
    const hole = holes[holeIndex];
    const draggedHole = holes[wordIndex];
    if (!hole || !draggedHole) return;

    const expectedWord = String(hole.word || '');
    const droppedWord = String(draggedHole.word || '');

    if (normalizeFillWord(droppedWord) !== normalizeFillWord(expectedWord)) {
      const feedbackWrong = document.getElementById('fill-correction-feedback');
      if (feedbackWrong) {
        feedbackWrong.className = 'fill-correction-feedback';
        feedbackWrong.textContent = `Mot incorrect pour le trou ${holeIndex + 1}. Attendu: ${expectedWord}`;
      }
      return;
    }

    gapEl.classList.add('filled');
    gapEl.textContent = droppedWord;
    fillCorrectionState.filled[holeIndex] = droppedWord;

    const chip = document.querySelector(`.fill-correction-bank .fill-word-chip[data-hole-index="${wordIndex}"]`);
    if (chip) {
      chip.classList.add('used');
      chip.draggable = false;
    }

    const expectedNorm = normalizeFillWord(expectedWord);
    const winners = [];
    const scoreUpdates = [];
    App.state.players.forEach(player => {
      const answers = Array.isArray(player.lastFillAnswers) ? player.lastFillAnswers : [];
      const playerWord = normalizeFillWord(answers[holeIndex]);
      if (playerWord && playerWord === expectedNorm) {
        player.score = (Number(player.score) || 0) + fillCorrectionState.pointsPerHole;
        winners.push(player.name);
        scoreUpdates.push({ playerId: player.id, score: player.score });
      }
    });

    const feedback = document.getElementById('fill-correction-feedback');
    if (feedback) {
      feedback.className = 'fill-correction-feedback ok';
      if (winners.length > 0) {
        feedback.textContent = `Trou ${holeIndex + 1}: ${expectedWord} - Correct: ${winners.join(', ')}`;
      } else {
        feedback.textContent = `Trou ${holeIndex + 1}: ${expectedWord} - Aucun joueur juste`;
      }
    }

    adminBroadcast('fillCorrectionStep', {
      holeIndex,
      expectedWord,
      droppedWord,
      pointsPerHole: fillCorrectionState.pointsPerHole,
      correctPlayers: winners,
      scoreUpdates,
    });

    const done = fillCorrectionState.filled.filter(Boolean).length;
    if (done >= holes.length) {
      finishFillCorrection();
    }
  }

  function finishFillCorrection() {
    if (!fillCorrectionState) return;
    const q = fillCorrectionState.question;
    const panel = document.getElementById('fill-correction-panel');
    const overlay = document.getElementById('fill-correction-overlay');
    const scorePanel = document.getElementById('fill-correction-scores');
    const closeBtn = document.getElementById('fill-correction-close-btn');
    if (overlay) overlay.style.display = 'flex';
    if (panel) panel.style.display = 'flex';

    const finalResults = App.state.players.map(player => {
      const answers = Array.isArray(player.lastFillAnswers) ? player.lastFillAnswers : [];
      const allCorrect = (q.holes || []).every((hole, idx) => normalizeFillWord(answers[idx]) === normalizeFillWord(hole.word));
      return {
        playerId: player.id,
        playerName: player.name,
        isCorrect: allCorrect,
        score: Number(player.score) || 0,
        scoreDelta: 0,
      };
    });

    adminBroadcast('fillCorrectionEnd', {
      results: finalResults,
      correctAnswer: q.sourceText,
    });
    adminBroadcast('questionEnd', {
      correctIndices: [],
      correctAnswer: q.sourceText,
      results: finalResults,
    });

    const totalQuestions = Math.max(App.state.questions.length, 1);
    const isLastQuestion = currentQuestionIdx >= totalQuestions - 1;
    adminBroadcast('update_state', {
      phase: isLastQuestion ? 'finished' : 'between',
      currentQuestionIndex: isLastQuestion ? totalQuestions : currentQuestionIdx,
      total: totalQuestions,
    });

    document.getElementById('btn-launch-question').style.display = 'block';
    document.getElementById('btn-launch-question').textContent = isLastQuestion ? '🏁 Voir les resultats' : '▶️ Lancer la question suivante';
    document.getElementById('game-status').textContent = fillCorrectionState.statusText;
    if (scorePanel) {
      const sorted = [...App.state.players].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
      scorePanel.innerHTML = `<h4>Scores des joueurs</h4>${sorted.map((p, idx) => {
        const safeName = String(p.name || 'Joueur');
        const safeScore = Number(p.score) || 0;
        return `<div class="fill-correction-score-row"><span>${idx + 1}. ${safeName}</span><strong>${safeScore} pts</strong></div>`;
      }).join('')}`;
      scorePanel.style.display = 'block';
    }
    const feedback = document.getElementById('fill-correction-feedback');
    if (feedback) {
      feedback.className = 'fill-correction-feedback ok';
      feedback.textContent = 'Tous les mots sont places. Cliquez sur "Fermer et voir le classement".';
    }
    if (closeBtn) closeBtn.disabled = false;
    waitingForNextLaunch = true;
    fillCorrectionState = null;
  }

  function closeFillCorrectionModal() {
    if (fillCorrectionState) {
      App.showToast('Terminez la correction avant de fermer la fenetre.', 'error');
      return;
    }
    const panel = document.getElementById('fill-correction-panel');
    const overlay = document.getElementById('fill-correction-overlay');
    if (panel) panel.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
    showFillAdminRanking();
  }

  function showFillAdminRanking() {
    const resultBox = document.getElementById('question-result');
    const iconEl = document.getElementById('result-icon');
    const textEl = document.getElementById('result-text');
    const answerEl = document.getElementById('result-answer');
    if (!resultBox || !iconEl || !textEl || !answerEl) return;

    const sorted = [...App.state.players].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    iconEl.textContent = '🏆';
    textEl.textContent = 'Classement des joueurs';
    answerEl.innerHTML = `<div class="fill-admin-ranking">${sorted.map((player, idx) => {
      const safeName = String(player.name || 'Joueur');
      const safeScore = Number(player.score) || 0;
      return `<div class="fill-admin-ranking-row"><span>${idx + 1}. ${safeName}</span><strong>${safeScore} pts</strong></div>`;
    }).join('')}</div>`;
    setAdminSummaryMode(true);
    resultBox.style.display = 'flex';
  }

  function _finishCompleteQuestion(statusText, correctAnswerText, correctIndices, validatedPlayerIds) {
    const q = App.state.questions[currentQuestionIdx];
    setAdminSummaryMode(q.type === 'open');
    showCorrectAnswer(correctAnswerText);
    renderQcmVoteRecap(q, correctIndices);

    const results = processResults(validatedPlayerIds);

    // Statistiques de réussite par question et globales
    const qCorrect = results.filter(r => r.isCorrect).length;
    const qTotal = App.state.players.length;
    const qPct = qTotal > 0 ? Math.round(qCorrect / qTotal * 100) : 0;
    questionStatsHistory.push({ correct: qCorrect, total: qTotal, pct: qPct });
    const allCorrect = questionStatsHistory.reduce((s, q) => s + q.correct, 0);
    const allTotal   = questionStatsHistory.reduce((s, q) => s + q.total, 0);
    const overallPct = allTotal > 0 ? Math.round(allCorrect / allTotal * 100) : 0;
    updateAdminStats(qPct, overallPct);
    showAdminResultsModal(q, correctAnswerText, correctIndices, results, qPct, overallPct);

    adminBroadcast('questionEnd', {
      correctIndices,
      correctAnswer: correctAnswerText,
      results,
    });
    const totalQuestions = Math.max(App.state.questions.length, 1);
    const isLastQuestion = currentQuestionIdx >= totalQuestions - 1;
    const useResultsModal = q.type === 'qcm';

    adminBroadcast('update_state', {
      phase: isLastQuestion ? 'finished' : 'between',
      currentQuestionIndex: isLastQuestion ? totalQuestions : currentQuestionIdx,
      total: totalQuestions,
    });

    document.getElementById('btn-stop-timer').style.display = 'none';
    document.getElementById('btn-add-time').style.display = 'none';
    document.getElementById('btn-launch-question').style.display = useResultsModal ? 'none' : 'block';
    document.getElementById('btn-launch-question').textContent = isLastQuestion ? '🏁 Voir les resultats' : '▶️ Lancer la question suivante';
    document.getElementById('game-status').textContent = statusText;
    // Remettre le titre par défaut et masquer le chrono
    const ctrlTitle = document.getElementById('admin-controls-title');
    if (ctrlTitle) {
      ctrlTitle.textContent = 'En attente de la prochaine question';
      ctrlTitle.classList.remove('has-question');
    }
    const adminChronoDiv = document.getElementById('admin-panel-chrono');
    if (adminChronoDiv) adminChronoDiv.style.display = 'none';
    waitingForNextLaunch = true;
  }

  function showAdminResultsModal(question, correctAnswerText, correctIndices, results, questionRate, overallRate) {
    const modal = document.getElementById('admin-results-modal');
    const correctEl = document.getElementById('admin-results-correct');
    const listEl = document.getElementById('admin-results-list');
    const questionRateEl = document.getElementById('admin-results-question-rate');
    const overallRateEl = document.getElementById('admin-results-overall-rate');
    const nextBtn = document.getElementById('admin-results-next-btn');
    if (!modal || !correctEl || !listEl || !questionRateEl || !overallRateEl || !nextBtn) return;

    if (!question || question.type !== 'qcm' || !Array.isArray(question.choices)) {
      closeAdminResultsModal();
      return;
    }

    const isLastQuestion = currentQuestionIdx >= Math.max(App.state.questions.length, 1) - 1;
    questionRateEl.textContent = `${Number.isFinite(questionRate) ? questionRate : 0}%`;
    overallRateEl.textContent = `${Number.isFinite(overallRate) ? overallRate : 0}%`;
    correctEl.textContent = formatCorrectAnswerLabel(question, correctAnswerText);
    listEl.innerHTML = '';
    nextBtn.textContent = isLastQuestion ? 'Voir les resultats finaux' : 'Lancer la question suivante';

    const counts = question.choices.map(() => 0);
    App.state.players.forEach(player => {
      const answers = normalizeIndexArray(
        Array.isArray(player.lastAnswerIndices)
          ? player.lastAnswerIndices
          : (typeof player.lastAnswerIndex === 'number' ? [player.lastAnswerIndex] : [])
      );
      answers.forEach(idx => {
        if (idx >= 0 && idx < counts.length) counts[idx] += 1;
      });
    });
    const totalPlayers = Math.max(App.state.players.length, 1);
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const safeCorrect = normalizeIndexArray(correctIndices || []);
    question.choices.forEach((choice, idx) => {
      const votes = counts[idx] || 0;
      const pct = Math.round((votes / totalPlayers) * 100);
      const row = document.createElement('div');
      row.className = 'admin-results-row' + (safeCorrect.includes(idx) ? ' is-correct' : '');
      row.innerHTML = `
        <div class="admin-results-label">${letters[idx] || idx + 1}. ${choice}</div>
        <div class="admin-results-value">${votes} vote(s) - ${pct}%</div>
        <span class="admin-results-pill ${safeCorrect.includes(idx) ? '' : 'bad'}">${safeCorrect.includes(idx) ? 'Correct' : 'Choix'}</span>
      `;
      listEl.appendChild(row);
    });

    modal.style.display = 'flex';
  }

  function closeAdminResultsModal() {
    const modal = document.getElementById('admin-results-modal');
    if (modal) modal.style.display = 'none';
    setAdminSummaryMode(false);
  }

  function goToNextFromResultsModal() {
    closeAdminResultsModal();
    launchQuestion();
  }

  function setAdminSummaryMode(active) {
    const screen = document.getElementById('screen-game');
    if (!screen) return;
    screen.classList.toggle('is-summary-view', !!active);
  }

  // ---- Panneau de validation des réponses ouvertes ----
  function showOpenAnswerValidation(q) {
    const overlay = document.getElementById('open-validation-overlay');
    const pendingEl = document.getElementById('pending-cards');
    const correctEl = document.getElementById('correct-cards');
    pendingEl.innerHTML = '';
    correctEl.innerHTML = '';

    // Pré-classement : réponses correspondant aux mots-clés → zone correcte
    const acceptedAnswers = getOpenAcceptedAnswers(q.answer);

    App.state.players.forEach(player => {
      if (!player.answeredCurrentQuestion) {
        pendingEl.appendChild(_buildAnswerCard(player, true));
        return;
      }
      const norm = normalizeAnswerText(player.lastAnswer);
      const autoOk = acceptedAnswers.length > 0 && acceptedAnswers.includes(norm);
      const card = _buildAnswerCard(player, false);
      (autoOk ? correctEl : pendingEl).appendChild(card);
    });

    // Zones de dépôt drag-and-drop
    _setupDropZone(document.getElementById('open-val-pending'), pendingEl);
    _setupDropZone(document.getElementById('open-val-correct'), correctEl);

    overlay.style.display = 'flex';
  }

  function _buildAnswerCard(player, noAnswer) {
    const card = document.createElement('div');
    card.className = 'answer-card' + (noAnswer ? ' no-answer' : '');
    card.draggable = !noAnswer;
    card.dataset.playerId = String(player.id);
    card.style.borderColor = player.color;
    card.innerHTML = `
      <span class="card-avatar">${player.avatar}</span>
      <span class="card-player-name" style="color:${player.color}">${player.name}</span>
      <span class="card-answer-text">${noAnswer ? '<em>—</em>' : player.lastAnswer}</span>
    `;
    if (!noAnswer) {
      card.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', String(player.id));
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      // Clic pour basculer entre les zones
      card.addEventListener('click', () => {
        const inCorrect = card.closest('#correct-cards');
        if (inCorrect) {
          document.getElementById('pending-cards').appendChild(card);
        } else {
          document.getElementById('correct-cards').appendChild(card);
        }
      });
    }
    return card;
  }

  function _setupDropZone(zoneEl, cardsEl) {
    zoneEl.ondragover = e => {
      e.preventDefault();
      zoneEl.classList.add('drag-over');
    };
    zoneEl.ondragleave = () => zoneEl.classList.remove('drag-over');
    zoneEl.ondrop = e => {
      e.preventDefault();
      zoneEl.classList.remove('drag-over');
      const playerId = e.dataTransfer.getData('text/plain');
      const card = document.querySelector(`.answer-card[data-player-id="${playerId}"]`);
      if (card) cardsEl.appendChild(card);
    };
  }

  function validateOpenAnswers() {
    const correctEl = document.getElementById('correct-cards');
    const pendingEl = document.getElementById('pending-cards');
    const validatedIds = new Set(
      [...correctEl.querySelectorAll('.answer-card')].map(c => Number(c.dataset.playerId))
    );

    // Animation : les mauvaises réponses tombent
    pendingEl.querySelectorAll('.answer-card:not(.no-answer)').forEach(card => {
      card.classList.add('card-fall');
    });

    setTimeout(() => {
      document.getElementById('open-validation-overlay').style.display = 'none';
      if (_pendingOpenQuestion) {
        const { statusText, correctAnswerText, correctIndices } = _pendingOpenQuestion;
        _pendingOpenQuestion = null;
        _finishCompleteQuestion(statusText, correctAnswerText, correctIndices, validatedIds);
      }
    }, 700);
  }

  // ---- Arrêter le chrono manuellement et traiter les résultats ----
  function stopTimerManually() {
    completeQuestion('✋ Réponse affichée. Lancez la suite quand vous êtes prêt.');
  }

  // ---- Ajouter 10 secondes au chrono ----
  function addTime() {
    if (!questionActive) return;
    timeLeft += 10;
    const text = document.getElementById('timer-text');
    const adminChronoEl = document.getElementById('admin-panel-chrono-value');
    if (text) text.textContent = timeLeft;
    if (adminChronoEl) adminChronoEl.textContent = timeLeft;
    // Retirer l'effet d'urgence si on a ajouté du temps
    const bar = document.getElementById('timer-bar');
    if (bar && timeLeft > 10) bar.classList.remove('warning');
    App.playSound('ui');
    App.showToast('+10 secondes', 'success');
  }

  // ---- Traiter les résultats et avancer les joueurs ----
  // validatedPlayerIds : Set d'IDs validés par l'admin (questions ouvertes), ou null pour auto
  function processResults(validatedPlayerIds) {
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
          // Question ouverte : validation admin si disponible, sinon mots-clés
          if (validatedPlayerIds != null) {
            isCorrect = validatedPlayerIds.has(player.id);
          } else {
            const playerAnswer = normalizeAnswerText(player.lastAnswer);
            const acceptedAnswers = getOpenAcceptedAnswers(q.answer);
            isCorrect = acceptedAnswers.includes(playerAnswer);
          }
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
        <span class="answer-indicator" id="indicator-${player.id}" title="En attente..."></span>
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
    } else if (q.type === 'fill') {
      return 300;
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
    const currentQuestion = App.state.questions[currentQuestionIdx] || null;
    document.getElementById('result-icon').textContent = '💡';
    document.getElementById('result-text').textContent = 'Correction';
    document.getElementById('result-answer').textContent = formatCorrectAnswerLabel(currentQuestion, correctAnswer);
    document.getElementById('question-result').style.display = 'flex';
    document.getElementById('question-card').style.display = 'flex';
  }

  function renderQcmVoteRecap(question, correctIndices) {
    const recap = document.getElementById('qcm-vote-recap');
    if (!recap) return;
    recap.innerHTML = '';

    if (!question || question.type !== 'qcm' || !Array.isArray(question.choices)) {
      recap.style.display = 'none';
      return;
    }

    const counts = question.choices.map(() => 0);
    const participants = App.state.players.length;
    App.state.players.forEach(player => {
      const answers = normalizeIndexArray(
        Array.isArray(player.lastAnswerIndices)
          ? player.lastAnswerIndices
          : (typeof player.lastAnswerIndex === 'number' ? [player.lastAnswerIndex] : [])
      );
      answers.forEach(idx => {
        if (Number.isInteger(idx) && idx >= 0 && idx < counts.length) counts[idx] += 1;
      });
    });

    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const safeCorrect = normalizeIndexArray(correctIndices || []);
    const title = document.createElement('div');
    title.className = 'qcm-recap-title';
    title.textContent = 'Repartition des reponses';
    recap.appendChild(title);

    question.choices.forEach((choice, idx) => {
      const votes = counts[idx] || 0;
      const pct = participants > 0 ? Math.round((votes / participants) * 100) : 0;
      const row = document.createElement('div');
      row.className = 'qcm-recap-row' + (safeCorrect.includes(idx) ? ' is-correct' : '');
      row.innerHTML = `
        <div class="qcm-recap-label">${letters[idx] || idx + 1}. ${choice}</div>
        <div class="qcm-recap-bar-wrap"><div class="qcm-recap-bar" style="width:${pct}%"></div></div>
        <div class="qcm-recap-value">${votes} (${pct}%)</div>
      `;
      recap.appendChild(row);
    });

    recap.style.display = 'grid';
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
    const trackLen = Math.max(App.state.questions.length, 1);
    App.state.settings.trackLength = trackLen;
    const currentScore = Number.isFinite(Number(player.score)) ? Number(player.score) : 0;
    const currentPosition = Number.isFinite(Number(player.position)) ? Number(player.position) : 0;
    const step = Number.isFinite(Number(App.state.settings.advancePerCorrect)) ? Number(App.state.settings.advancePerCorrect) : 1;
    player.score = currentScore + 100;
    player.position = Math.min(currentPosition + step, trackLen);
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
    const trackLen = Math.max(App.state.questions.length, 1);
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
    renderAdminFillPreview(null);
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

  return { start, submitOpenAnswer, playAgain, launchQuestion, stopTimerManually, addTime, validateOpenAnswers, closeAdminResultsModal, goToNextFromResultsModal, closeFillCorrectionModal };
})();
