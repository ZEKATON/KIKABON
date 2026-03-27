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
  let fillSummaryState = null;

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
      return '';
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

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function truncateText(value, maxLength = 180) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    return text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
  }

  function getCurrentQuestion() {
    return App.state.questions[currentQuestionIdx] || null;
  }

  function getAnsweredCount() {
    return App.state.players.filter(player => player.answeredCurrentQuestion).length;
  }

  function getLeaderboard() {
    return [...App.state.players].sort((a, b) => {
      const posDiff = (Number(b.position) || 0) - (Number(a.position) || 0);
      if (posDiff !== 0) return posDiff;
      return (Number(b.score) || 0) - (Number(a.score) || 0);
    });
  }

  function getQcmLeaderText(question) {
    if (!question || question.type !== 'qcm' || !Array.isArray(question.choices) || question.choices.length === 0) {
      return '—';
    }
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
    const bestCount = Math.max(...counts, 0);
    if (bestCount <= 0) return 'Aucun vote';
    const bestIndex = counts.findIndex(count => count === bestCount);
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    return `${letters[bestIndex] || bestIndex + 1} · ${bestCount} vote(s)`;
  }

  function appendAdminFeed(message, tone = 'neutral') {
    const feed = document.getElementById('admin-live-feed');
    if (!feed || !message) return;
    const empty = feed.querySelector('.admin-live-feed-empty');
    if (empty) empty.remove();
    const item = document.createElement('div');
    item.className = `admin-feed-item is-${tone}`;
    item.textContent = message;
    feed.prepend(item);
    while (feed.children.length > 6) {
      feed.removeChild(feed.lastElementChild);
    }
  }

  function updateTrackRanks() {
    const lanes = document.getElementById('track-lanes');
    if (!lanes) return;
    const ranking = getLeaderboard();
    ranking.forEach((player, index) => {
      const lane = document.getElementById(`lane-${player.id}`);
      if (!lane) return;
      lane.classList.toggle('is-top-three', index < 3);
      lane.classList.toggle('is-first', index === 0);
      lane.dataset.rank = String(index + 1);
      const rankEl = document.getElementById(`rank-${player.id}`);
      if (rankEl) rankEl.textContent = String(index + 1);
      lanes.appendChild(lane);
    });
  }

  function refreshOpenValidationSummary(question) {
    const pendingEl = document.getElementById('pending-cards');
    const correctEl = document.getElementById('correct-cards');
    if (!pendingEl || !correctEl) return;
    const pendingCount = pendingEl.querySelectorAll('.answer-card:not(.no-answer)').length;
    const correctCount = correctEl.querySelectorAll('.answer-card:not(.no-answer)').length;
    const missingCount = document.querySelectorAll('.answer-card.no-answer').length;
    const pendingCountEl = document.getElementById('open-val-pending-count');
    const correctCountEl = document.getElementById('open-val-correct-count');
    const missingCountEl = document.getElementById('open-val-missing-count');
    const answerKeyEl = document.getElementById('open-val-answer-key');
    if (pendingCountEl) pendingCountEl.textContent = String(pendingCount);
    if (correctCountEl) correctCountEl.textContent = String(correctCount);
    if (missingCountEl) missingCountEl.textContent = String(missingCount);
    if (answerKeyEl) answerKeyEl.textContent = formatCorrectAnswerLabel(question, question && question.answer ? question.answer : '') || 'Validez les formulations acceptables.';
  }

  function updateFillCorrectionStats() {
    const doneEl = document.getElementById('fill-correction-done');
    const remainingEl = document.getElementById('fill-correction-remaining');
    const pointsEl = document.getElementById('fill-correction-points');
    const total = fillCorrectionState && fillCorrectionState.question && Array.isArray(fillCorrectionState.question.holes)
      ? fillCorrectionState.question.holes.length
      : 0;
    const done = fillCorrectionState ? fillCorrectionState.filled.filter(Boolean).length : total;
    const remaining = Math.max(total - done, 0);
    if (doneEl) doneEl.textContent = String(done);
    if (remainingEl) remainingEl.textContent = String(remaining);
    if (pointsEl) pointsEl.textContent = String(fillCorrectionState ? fillCorrectionState.pointsPerHole : 0);
  }

  function appendFillCorrectionLog(message, tone = 'neutral') {
    const log = document.getElementById('fill-correction-log');
    if (!log || !message) return;
    const item = document.createElement('div');
    item.className = `fill-correction-log-item is-${tone}`;
    item.textContent = message;
    log.prepend(item);
    while (log.children.length > 6) {
      log.removeChild(log.lastElementChild);
    }
  }

  function recordQuestionStats(results) {
    const qCorrect = results.filter(r => r.isCorrect).length;
    const qTotal = App.state.players.length;
    const qPct = qTotal > 0 ? Math.round(qCorrect / qTotal * 100) : 0;
    questionStatsHistory.push({ correct: qCorrect, total: qTotal, pct: qPct });
    const allCorrect = questionStatsHistory.reduce((sum, entry) => sum + entry.correct, 0);
    const allTotal = questionStatsHistory.reduce((sum, entry) => sum + entry.total, 0);
    const overallPct = allTotal > 0 ? Math.round(allCorrect / allTotal * 100) : 0;
    updateAdminStats(qPct, overallPct);
    return { qPct, overallPct };
  }

  function refreshAdminDashboard(options = {}) {
    const question = options.question || getCurrentQuestion();
    const totalQuestions = Math.max(App.state.questions.length, 1);
    const totalPlayers = App.state.players.length;
    const answered = getAnsweredCount();
    const pending = Math.max(totalPlayers - answered, 0);
    const chip = document.getElementById('admin-stage-chip');
    const title = document.getElementById('admin-controls-title');
    const counter = document.getElementById('admin-round-question-counter');
    const type = document.getElementById('admin-round-type');
    const questionEl = document.getElementById('admin-round-question');
    const helperEl = document.getElementById('admin-round-helper');
    const totalEl = document.getElementById('admin-live-total');
    const answeredEl = document.getElementById('admin-live-answered');
    const focusLabelEl = document.getElementById('admin-live-focus-label');
    const focusValueEl = document.getElementById('admin-live-focus-value');
    const leaderLabelEl = document.getElementById('admin-live-leader-label');
    const leaderValueEl = document.getElementById('admin-live-leader-value');
    const currentDisplayIndex = question ? Math.min(currentQuestionIdx + 1, totalQuestions) : 0;
    const phase = options.phase || (fillCorrectionState
      ? 'fill'
      : (_pendingOpenQuestion ? 'review' : (questionActive ? 'question' : (waitingForNextLaunch ? 'between' : 'idle'))));

    const phaseMap = {
      idle: { chip: 'Salle prête', title: 'En attente du lancement', helper: 'Lancez une question quand la classe est prête.' },
      question: { chip: 'Question affichée', title: 'Question en cours', helper: 'Surveillez les réponses puis coupez ou laissez finir le chrono.' },
      review: { chip: 'Validation ouverte', title: 'Réponses à valider', helper: 'Glissez les bonnes réponses à droite, puis validez.' },
      fill: { chip: 'Correction guidée', title: 'Texte à trous en correction', helper: 'Glissez les mots corrects et commentez les points accordés.' },
      between: { chip: 'Transition', title: 'Prêt pour la suite', helper: 'Consultez le récapitulatif puis lancez la question suivante.' },
    };
    const phaseConfig = phaseMap[phase] || phaseMap.idle;
    if (chip) {
      chip.textContent = phaseConfig.chip;
      chip.className = `admin-stage-chip is-${phase}`;
    }
    if (title) {
      title.textContent = phaseConfig.title;
      title.classList.toggle('has-question', !!question);
    }
    if (counter) counter.textContent = question ? `Question ${currentDisplayIndex}/${totalQuestions}` : 'Question —';
    if (type) type.textContent = question ? formatQuestionMeta(question) : 'Aucune question active';
    if (questionEl) {
      const source = question
        ? (question.type === 'fill' ? (question.sourceText || question.text || '') : (question.text || ''))
        : 'Lancez une question pour afficher les consignes et le contexte de jeu.';
      questionEl.textContent = truncateText(source, 220);
    }
    if (helperEl) helperEl.textContent = options.helperText || phaseConfig.helper;
    if (totalEl) totalEl.textContent = String(totalPlayers);
    if (answeredEl) answeredEl.textContent = `${answered}/${totalPlayers}`;

    let focusLabel = 'En attente';
    let focusValue = String(pending);
    if (phase === 'review') {
      const pendingCards = document.querySelectorAll('#pending-cards .answer-card:not(.no-answer)').length;
      focusLabel = 'À juger';
      focusValue = String(pendingCards);
    } else if (phase === 'fill') {
      const totalHoles = fillCorrectionState && fillCorrectionState.question && Array.isArray(fillCorrectionState.question.holes)
        ? fillCorrectionState.question.holes.length
        : 0;
      const doneHoles = fillCorrectionState ? fillCorrectionState.filled.filter(Boolean).length : 0;
      focusLabel = 'Trous restants';
      focusValue = `${Math.max(totalHoles - doneHoles, 0)}/${totalHoles}`;
    } else if (question && question.type === 'qcm' && phase === 'question') {
      focusLabel = 'Choix dominant';
      focusValue = getQcmLeaderText(question);
    } else if (question && question.type === 'fill' && phase === 'question') {
      focusLabel = 'Trous à corriger';
      focusValue = String(Array.isArray(question.holes) ? question.holes.length : 0);
    } else if (phase === 'between') {
      focusLabel = 'Étape';
      focusValue = 'Question suivante';
    }

    if (focusLabelEl) focusLabelEl.textContent = focusLabel;
    if (focusValueEl) focusValueEl.textContent = focusValue;
    const leader = getLeaderboard()[0];
    if (leaderLabelEl) leaderLabelEl.textContent = phase === 'question' ? 'Tête de course' : 'Meilleur score';
    if (leaderValueEl) {
      leaderValueEl.textContent = leader
        ? `${leader.avatar || '🏎️'} ${leader.name} · ${Number(leader.score) || 0} pts`
        : '—';
    }

    updateTrackRanks();
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
    fillSummaryState = null;
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
    const feed = document.getElementById('admin-live-feed');
    if (feed) {
      feed.innerHTML = '<div class="admin-live-feed-empty">Les événements récents de la classe apparaîtront ici.</div>';
    }
    refreshAdminDashboard({ phase: 'idle' });
    appendAdminFeed('La course est prête. Attendez la classe puis lancez la première question.', 'neutral');

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
    fillSummaryState = null;

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
      ctrlTitle.textContent = 'Question en cours';
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
    refreshAdminDashboard({ phase: 'question', question: q });
    appendAdminFeed(`Question ${currentQuestionIdx + 1} affichée : ${truncateText(q.type === 'fill' ? (q.sourceText || q.text) : q.text, 120)}`, 'neutral');
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
    const log = document.getElementById('fill-correction-log');
    if (log) log.innerHTML = '';
    if (scorePanel) {
      scorePanel.style.display = 'none';
      scorePanel.innerHTML = '';
    }
    if (closeBtn) closeBtn.disabled = true;
    updateFillCorrectionStats();

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
    refreshAdminDashboard({ phase: 'fill', question: q });
    appendAdminFeed(`Correction texte à trous démarrée : ${Array.isArray(q.holes) ? q.holes.length : 0} trou(s) à corriger.`, 'accent');
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
      appendFillCorrectionLog(`Trou ${holeIndex + 1} : "${droppedWord}" refusé. Mot attendu : ${expectedWord}.`, 'bad');
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
    updateTrackRanks();

    const feedback = document.getElementById('fill-correction-feedback');
    if (feedback) {
      feedback.className = 'fill-correction-feedback ok';
      if (winners.length > 0) {
        feedback.textContent = `Trou ${holeIndex + 1}: ${expectedWord} - Correct: ${winners.join(', ')}`;
      } else {
        feedback.textContent = `Trou ${holeIndex + 1}: ${expectedWord} - Aucun joueur juste`;
      }
    }
    updateFillCorrectionStats();
    appendFillCorrectionLog(
      winners.length > 0
        ? `Trou ${holeIndex + 1} validé : ${expectedWord}. Points pour ${winners.join(', ')}.`
        : `Trou ${holeIndex + 1} validé : ${expectedWord}. Aucun élève n'avait juste.`,
      winners.length > 0 ? 'good' : 'neutral'
    );
    refreshAdminDashboard({ phase: 'fill', question });

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
      const holesCorrectCount = (q.holes || []).filter((hole, idx) => normalizeFillWord(answers[idx]) === normalizeFillWord(hole.word)).length;
      const allCorrect = holesCorrectCount === (q.holes || []).length;
      return {
        playerId: player.id,
        playerName: player.name,
        playerName: player.name,
        isCorrect: allCorrect,
        score: Number(player.score) || 0,
        scoreDelta: 0,
        holesCorrectCount,
      };
    });

    const { qPct, overallPct } = recordQuestionStats(finalResults);
    fillSummaryState = {
      question: q,
      results: finalResults,
      questionRate: qPct,
      overallRate: overallPct,
    };

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
      feedback.textContent = 'Tous les mots sont places. Ouvrez le récapitulatif pour annoncer les résultats.';
    }
    if (closeBtn) closeBtn.disabled = false;
    waitingForNextLaunch = true;
    refreshAdminDashboard({ phase: 'between', question: q });
    appendAdminFeed('Correction texte à trous terminée. Le récapitulatif est prêt.', 'good');
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
    if (fillSummaryState) {
      showAdminResultsModal(
        fillSummaryState.question,
        fillSummaryState.question.sourceText || fillSummaryState.question.text || '',
        [],
        fillSummaryState.results,
        fillSummaryState.questionRate,
        fillSummaryState.overallRate
      );
    }
    broadcastLiveScoreboard();
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
    setAdminSummaryMode(false);
    showCorrectAnswer(correctAnswerText);
    renderQcmVoteRecap(q, correctIndices);

    const results = processResults(validatedPlayerIds);
    const { qPct, overallPct } = recordQuestionStats(results);

    showAdminResultsModal(q, correctAnswerText, correctIndices, results, qPct, overallPct);

    adminBroadcast('questionEnd', {
      correctIndices,
      correctAnswer: correctAnswerText,
      results,
    });
    const totalQuestions = Math.max(App.state.questions.length, 1);
    const isLastQuestion = currentQuestionIdx >= totalQuestions - 1;
    const useResultsModal = q.type === 'qcm' || q.type === 'open';

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
      ctrlTitle.textContent = 'Prêt pour la suite';
      ctrlTitle.classList.remove('has-question');
    }
    const adminChronoDiv = document.getElementById('admin-panel-chrono');
    if (adminChronoDiv) adminChronoDiv.style.display = 'none';
    waitingForNextLaunch = true;
    refreshAdminDashboard({ phase: 'between', question: q, helperText: statusText });
    appendAdminFeed(`Correction terminée : ${results.filter(r => r.isCorrect).length}/${results.length} bonne(s) réponse(s).`, 'good');
  }

  function showAdminResultsModal(question, correctAnswerText, correctIndices, results, questionRate, overallRate) {
    const modal = document.getElementById('admin-results-modal');
    const heading = modal ? modal.querySelector('.admin-results-head h3') : null;
    const correctEl = document.getElementById('admin-results-correct');
    const listEl = document.getElementById('admin-results-list');
    const questionRateEl = document.getElementById('admin-results-question-rate');
    const overallRateEl = document.getElementById('admin-results-overall-rate');
    const nextBtn = document.getElementById('admin-results-next-btn');
    if (!modal || !correctEl || !listEl || !questionRateEl || !overallRateEl || !nextBtn) return;
    if (!question) {
      closeAdminResultsModal();
      return;
    }

    const isLastQuestion = currentQuestionIdx >= Math.max(App.state.questions.length, 1) - 1;
    questionRateEl.textContent = `${Number.isFinite(questionRate) ? questionRate : 0}%`;
    overallRateEl.textContent = `${Number.isFinite(overallRate) ? overallRate : 0}%`;
    if (heading) heading.textContent = question.type === 'fill'
      ? 'Récapitulatif du texte à trous'
      : (question.type === 'open' ? 'Résultats de la question ouverte' : 'Résultats de la question');
    const answerLabel = formatCorrectAnswerLabel(question, correctAnswerText);
    correctEl.textContent = answerLabel || (question.type === 'fill' ? 'Correction effectuée trou par trou pendant l’activité.' : '');
    correctEl.style.display = correctEl.textContent ? 'block' : 'none';
    listEl.innerHTML = '';
    nextBtn.textContent = isLastQuestion ? 'Voir les resultats finaux' : 'Lancer la question suivante';

    if (question.type === 'qcm' && Array.isArray(question.choices)) {
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
          <div class="admin-results-label">${letters[idx] || idx + 1}. ${escapeHtml(choice)}</div>
          <div class="admin-results-value">${votes} vote(s) - ${pct}%</div>
          <span class="admin-results-pill ${safeCorrect.includes(idx) ? '' : 'bad'}">${safeCorrect.includes(idx) ? 'Correct' : 'Choix'}</span>
        `;
        listEl.appendChild(row);
      });
    } else if (question.type === 'open') {
      [...results]
        .sort((a, b) => Number(b.isCorrect) - Number(a.isCorrect))
        .forEach(result => {
          const answerText = result.answerText ? truncateText(result.answerText, 120) : 'Aucune réponse';
          const row = document.createElement('div');
          row.className = 'admin-results-row' + (result.isCorrect ? ' is-correct' : '');
          row.innerHTML = `
            <div class="admin-results-label">${escapeHtml(result.playerName || 'Joueur')}</div>
            <div class="admin-results-value">${escapeHtml(answerText)}</div>
            <span class="admin-results-pill ${result.isCorrect ? '' : 'bad'}">${result.isCorrect ? 'Validée' : (result.answerText ? 'Non retenue' : 'Absente')}</span>
          `;
          listEl.appendChild(row);
        });
    } else if (question.type === 'fill') {
      const totalHoles = Array.isArray(question.holes) ? question.holes.length : 0;
      [...results]
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
        .forEach(result => {
          const row = document.createElement('div');
          row.className = 'admin-results-row' + (result.isCorrect ? ' is-correct' : '');
          row.innerHTML = `
            <div class="admin-results-label">${escapeHtml(result.playerName || 'Joueur')}</div>
            <div class="admin-results-value">${Number(result.holesCorrectCount) || 0}/${totalHoles} trou(s) correct(s) - ${Number(result.score) || 0} pts</div>
            <span class="admin-results-pill ${result.isCorrect ? '' : 'bad'}">${result.isCorrect ? 'Tout juste' : 'Partiel'}</span>
          `;
          listEl.appendChild(row);
        });
    }

    modal.style.display = 'flex';
  }

  function broadcastLiveScoreboard() {
    adminBroadcast('scoreboard', { players: App.state.players });
  }

  function closeAdminResultsModal(showScoreboard = true) {
    const modal = document.getElementById('admin-results-modal');
    if (modal) modal.style.display = 'none';
    setAdminSummaryMode(false);
    if (showScoreboard) broadcastLiveScoreboard();
    refreshAdminDashboard();
  }

  function goToNextFromResultsModal() {
    closeAdminResultsModal(false);
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
    refreshOpenValidationSummary(q);
    refreshAdminDashboard({ phase: 'review', question: q });
    appendAdminFeed(`Validation ouverte : ${getAnsweredCount()} réponse(s) reçue(s), ${App.state.players.length - getAnsweredCount()} sans réponse.`, 'accent');
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
        refreshOpenValidationSummary(getCurrentQuestion());
        refreshAdminDashboard({ phase: 'review', question: getCurrentQuestion() });
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
      refreshOpenValidationSummary(getCurrentQuestion());
      refreshAdminDashboard({ phase: 'review', question: getCurrentQuestion() });
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
    const q = App.state.questions[currentQuestionIdx];
    const statusText = q && q.type === 'fill'
      ? '🧠 Correction en cours.'
      : '✋ Réponse affichée. Lancez la suite quand vous êtes prêt.';
    completeQuestion(statusText);
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
    refreshAdminDashboard({ phase: 'question' });
    appendAdminFeed('10 secondes ajoutées au chrono.', 'accent');
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
        playerName: player.name,
        isCorrect,
        score: player.score || 0,
        scoreDelta: (player.score || 0) - scoreBefore,
        answerText: player.lastAnswer || '',
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
        <span class="lane-rank" id="rank-${player.id}">1</span>
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
    updateTrackRanks();
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
      refreshAdminDashboard();
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
    updateTrackRanks();
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

  return { start, submitOpenAnswer, playAgain, launchQuestion, stopTimerManually, addTime, validateOpenAnswers, closeAdminResultsModal, goToNextFromResultsModal, closeFillCorrectionModal, refreshAdminDashboard };
})();
