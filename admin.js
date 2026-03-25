// ============================================================
//  ADMIN.JS — Gestion des questions, import, sauvegarde
// ============================================================

const Admin = (() => {
  let editingId = null;
  let correctIdx = 0;
  let correctIndices = [0]; // Pour les choix multiples
  let isMultipleChoice = false; // Mode choix unique ou multiples
  let adminSSE = null;

  function generateUniqueSavedQuizCode(excludeQuizId = null) {
    const used = new Set(
      (App.state.savedQuizzes || [])
        .filter(q => q && q.id !== excludeQuizId && /^\d{4}$/.test(String(q.gameCode || '')))
        .map(q => String(q.gameCode))
    );
    let code;
    do {
      code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    } while (used.has(code));
    return code;
  }

  function startNewQuiz() {
    const hasQuestions = App.state.questions.length > 0;
    if (hasQuestions && !confirm('Créer un nouveau quiz et effacer le quiz en cours ?')) {
      return;
    }
    App.state.currentQuiz = null;
    App.state.questions = [];
    renderQuestions();
    App.showScreen('screen-admin');
      showTab('tab-saved');
  }

  // ---- Navigation tabs ----
  function showTab(tabId) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    const navId = 'nav-' + tabId.replace('tab-', '');
    const navEl = document.getElementById(navId);
    if (navEl) navEl.classList.add('active');
  }

  // ---- Render questions list ----
  function renderQuestions() {
    const list = document.getElementById('questions-list');
    const empty = document.getElementById('questions-empty');
    const qs = App.state.questions;
    list.innerHTML = '';
    empty.style.display = qs.length === 0 ? 'flex' : 'none';
    qs.forEach((q, idx) => {
      const item = document.createElement('div');
      item.className = 'question-item';
      const preview = q.text.length > 80 ? q.text.substring(0, 80) + '…' : q.text;
      item.innerHTML = `
        <span class="q-number">${idx + 1}</span>
        <span class="q-type-badge">${q.type === 'qcm' ? 'QCM' : 'Ouverte'}</span>
        <span class="q-text">${preview}</span>
        <div class="q-actions">
          <button class="q-action-btn" onclick="Admin.editQuestion(${q.id})" title="Modifier">✏️</button>
          <button class="q-action-btn" onclick="Admin.moveQuestion(${q.id}, -1)" title="Monter">↑</button>
          <button class="q-action-btn" onclick="Admin.moveQuestion(${q.id}, 1)" title="Descendre">↓</button>
          <button class="q-action-btn delete" onclick="Admin.deleteQuestion(${q.id})" title="Supprimer">🗑️</button>
        </div>
      `;
      list.appendChild(item);
    });
    persistQuestions();
    if (typeof App.renderQuizList === 'function') {
      App.renderQuizList();
    }
  }

  function persistQuestions() {
    localStorage.setItem('quizrace_questions', JSON.stringify(App.state.questions));
  }

  // ---- Add new question ----
  function addQuestion(type) {
    editingId = null;
    correctIdx = 0;
    resetModal(type);
    document.getElementById('modal-title').textContent = type === 'open' ? 'Nouvelle question ouverte' : 'Nouvelle question QCM';
    openModal();
  }

  // ---- Edit question ----
  function editQuestion(id) {
    const q = App.state.questions.find(q => q.id === id);
    if (!q) return;
    editingId = id;
    const normalizedCorrectIndices = q.type === 'qcm'
      ? (Array.isArray(q.correctIndices) && q.correctIndices.length > 0
          ? [...new Set(q.correctIndices.filter(i => Number.isInteger(i) && i >= 0))]
          : [q.correct || 0])
      : [0];
    correctIdx = q.type === 'qcm' ? normalizedCorrectIndices[0] : 0;
    isMultipleChoice = q.type === 'qcm' ? (normalizedCorrectIndices.length > 1 || q.multipleAnswers || false) : false;
    correctIndices = normalizedCorrectIndices;
    
    document.getElementById('modal-title').textContent = 'Modifier la question';
    document.getElementById('modal-type').value = q.type === 'open'
      ? 'open'
      : (q.multipleAnswers ? 'multiple' : 'single');
    document.getElementById('modal-question-text').value = q.text;
    document.getElementById('modal-category').value = q.category || '';
    updateModalType();
    updateCorrectDisplay();
    
    if (q.type === 'qcm') {
      const inputs = document.querySelectorAll('.choice-input');
      q.choices.forEach((c, i) => { if (inputs[i]) inputs[i].value = c; });
    } else {
      document.getElementById('modal-open-answer').value = q.answer || '';
    }
    openModal();
  }

  // ---- Save question from modal ----
  function saveQuestion() {
    const mode = document.getElementById('modal-type').value;
    const type = mode === 'open' ? 'open' : 'qcm';
    const text = document.getElementById('modal-question-text').value.trim();
    const category = document.getElementById('modal-category').value.trim();
    if (!text) { App.showToast('Saisissez la question !', 'error'); return; }

    let qData = { type, text, category };

    if (type === 'qcm') {
      const inputs = document.querySelectorAll('.choice-input');
      const choices = Array.from(inputs).map(i => i.value.trim()).filter(v => v);
      if (choices.length < 2) { App.showToast('Ajoutez au moins 2 choix !', 'error'); return; }
      qData.choices = choices;
      
      // Déterminer le type de réponse
      isMultipleChoice = mode === 'multiple';
      qData.multipleAnswers = isMultipleChoice;
      if (isMultipleChoice) {
        if (correctIndices.length === 0) {
          App.showToast('Cochez au moins une bonne réponse', 'error');
          return;
        }
        qData.correctIndices = correctIndices;
        // Pour la compatibilité, garder le premier correcte
        qData.correct = correctIndices.length > 0 ? correctIndices[0] : 0;
      } else {
        if (correctIndices.length !== 1) {
          App.showToast('En choix unique, cochez une seule bonne réponse', 'error');
          return;
        }
        correctIdx = correctIndices[0];
        qData.correct = correctIdx;
        qData.correctIndices = [correctIdx];
      }
    } else {
      const ans = document.getElementById('modal-open-answer').value.trim();
      if (!ans) { App.showToast('Saisissez la réponse attendue !', 'error'); return; }
      qData.answer = ans;
    }

    if (editingId) {
      const idx = App.state.questions.findIndex(q => q.id === editingId);
      if (idx !== -1) App.state.questions[idx] = { ...App.state.questions[idx], ...qData };
    } else {
      qData.id = Date.now();
      App.state.questions.push(qData);
    }

    renderQuestions();
    closeModal();
    App.showToast(editingId ? 'Question modifiée ✓' : 'Question ajoutée ✓', 'success');
  }

  // ---- Delete ----
  function deleteQuestion(id) {
    App.state.questions = App.state.questions.filter(q => q.id !== id);
    renderQuestions();
    App.showToast('Question supprimée', '');
  }

  // ---- Move ----
  function moveQuestion(id, dir) {
    const qs = App.state.questions;
    const idx = qs.findIndex(q => q.id === id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= qs.length) return;
    [qs[idx], qs[newIdx]] = [qs[newIdx], qs[idx]];
    renderQuestions();
  }

  // ---- Modal helpers ----
  function openModal() {
    document.getElementById('modal-question').style.display = 'flex';
  }
  function closeModal() {
    document.getElementById('modal-question').style.display = 'none';
  }
  function resetModal(type) {
    document.getElementById('modal-type').value = type === 'open' ? 'open' : 'single';
    document.getElementById('modal-question-text').value = '';
    document.getElementById('modal-category').value = '';
    document.querySelectorAll('.choice-input').forEach(i => i.value = '');
    document.getElementById('modal-open-answer').value = '';
    
    isMultipleChoice = false;
    correctIdx = 0;
    correctIndices = [0];
    
    setCorrect(0);
    updateModalType();
  }
  function updateModalType() {
    const mode = document.getElementById('modal-type').value;
    const isOpen = mode === 'open';
    isMultipleChoice = mode === 'multiple';
    document.getElementById('modal-qcm-section').style.display = isOpen ? 'none' : 'block';
    document.getElementById('modal-open-section').style.display = isOpen ? 'block' : 'none';
    
    // Si on passe en choix uniques et il y a plusieurs réponses, garder seulement la première
    if (!isMultipleChoice && correctIndices.length > 1) {
      correctIdx = correctIndices[0];
      correctIndices = [correctIdx];
      updateCorrectDisplay();
    }
  }

  function toggleCorrectFromRow(event, idx) {
    if (event && event.target && event.target.classList && event.target.classList.contains('choice-input')) {
      return;
    }
    toggleCorrect(idx);
  }

  function toggleCorrect(idx, event) {
    if (event && typeof event.stopPropagation === 'function') {
      event.stopPropagation();
    }
    if (isMultipleChoice) {
      // Mode choix multiples: toggle
      if (correctIndices.includes(idx)) {
        correctIndices = correctIndices.filter(i => i !== idx);
      } else {
        correctIndices.push(idx);
      }
    } else {
      // Mode choix unique: toggle d'un seul choix
      if (correctIndices.includes(idx)) {
        correctIdx = 0;
        correctIndices = [];
      } else {
        correctIdx = idx;
        correctIndices = [idx];
      }
    }
    updateCorrectDisplay();
  }

  function updateCorrectDisplay() {
    document.querySelectorAll('.choice-correct').forEach((btn, i) => {
      btn.classList.toggle('active', correctIndices.includes(i));
    });
  }

  function setCorrect(idx) {
    correctIdx = idx;
    correctIndices = [idx];
    isMultipleChoice = false;
    updateCorrectDisplay();
  }

  function createQuizFromImportedQuestions(importedQuestions, suggestedName) {
    if (!Array.isArray(importedQuestions) || importedQuestions.length === 0) return false;
    const defaultName = suggestedName || `Quiz ${new Date().toLocaleDateString('fr-FR')}`;
    const name = prompt('Nom du quiz importé :', defaultName);
    if (!name) {
      App.showToast('Import annulé : nom du quiz requis', 'error');
      return false;
    }

    const questions = importedQuestions.map(q => {
      const normalized = { ...q, id: Date.now() + Math.random() };

      // Regle d'import: 1 '*' => choix unique, plusieurs '*' => choix multiple
      if (normalized.type === 'qcm') {
        const indices = Array.isArray(normalized.correctIndices) && normalized.correctIndices.length > 0
          ? [...new Set(normalized.correctIndices.filter(i => Number.isInteger(i) && i >= 0))]
          : (Number.isInteger(normalized.correct) ? [normalized.correct] : [0]);
        normalized.correctIndices = indices.sort((a, b) => a - b);
        normalized.correct = indices[0];
        normalized.multipleAnswers = indices.length > 1;
      }

      return normalized;
    });
    const quiz = {
      id: Date.now(),
      name,
      questions,
      date: new Date().toLocaleDateString('fr-FR'),
      count: questions.length,
      gameCode: generateUniqueSavedQuizCode(null),
    };

    App.state.savedQuizzes.push(quiz);
    App.state.currentQuiz = quiz;
    App.state.questions = [...questions];
    App.persistSavedQuizzes();
    renderSaved();
    renderQuestions();
    showTab('tab-questions');
    App.showToast(`Quiz "${name}" créé depuis import ✓`, 'success');
    return true;
  }

  // ---- Import from text ----
  function importFromText() {
    const text = document.getElementById('import-text').value.trim();
    if (!text) { App.showToast('Collez du texte à importer !', 'error'); return; }
    const questions = parseTextImport(text);
    if (questions.length === 0) {
      App.showToast('Aucune question valide: marquez les bonnes reponses avec *', 'error');
      return;
    }
    const created = createQuizFromImportedQuestions(questions);
    if (!created) return;
    document.getElementById('import-text').value = '';
  }

  function parseTextImport(text) {
    const questions = [];
    const blocks = text.split(/\n\s*\n/).filter(b => b.trim());
    blocks.forEach(block => {
      const lines = block.trim().split('\n').map(l => l.trim()).filter(l => l);
      if (lines.length === 0) return;
      const firstLine = lines[0];

      // QCM
      if (/^QCM\s*:/i.test(firstLine)) {
        const questionText = firstLine.replace(/^QCM\s*:\s*/i, '').trim();
        const choices = [];
        const detectedCorrectIndices = [];
        lines.slice(1).forEach(line => {
          const match =
            line.match(/^\*?\s*([A-D])\s*[:\)\-\.]\s*(.+)/i) ||
            line.match(/^\*?\s*([A-D])\s+(.+)/i);
          if (match) {
            let choice = match[2].trim();
            const isCorrect = /\*/.test(line);
            choice = choice.replace(/\*/g, '').trim();
            choices.push(choice);
            if (isCorrect) {
              detectedCorrectIndices.push(choices.length - 1);
            }
          }
        });
        if (questionText && choices.length >= 2) {
          // Un QCM doit definir ses bonnes reponses via '*'
          if (detectedCorrectIndices.length === 0) {
            return;
          }
          const safeCorrectIndices = detectedCorrectIndices;
          questions.push({ 
            id: Date.now() + Math.random(), 
            type: 'qcm', 
            text: questionText, 
            choices, 
            correct: safeCorrectIndices[0], 
            correctIndices: safeCorrectIndices,
            multipleAnswers: safeCorrectIndices.length > 1,
            category: '' 
          });
        }
      }
      // Question ouverte
      else if (/^OUVERTE\s*:/i.test(firstLine)) {
        const questionText = firstLine.replace(/^OUVERTE\s*:\s*/i, '').trim();
        let answer = '';
        lines.slice(1).forEach(line => {
          const match = line.match(/^R[ÉE]PONSE\s*:\s*(.+)/i);
          if (match) answer = match[1].trim();
        });
        if (questionText && answer) {
          questions.push({ id: Date.now() + Math.random(), type: 'open', text: questionText, answer, category: '' });
        }
      }
    });
    return questions;
  }

  // ---- Import from file ----
  function importFromFile(event) {
    const file = event.target.files[0];
    if (file) importFromFileObj(file);
    event.target.value = '';
  }

  function importFromFileObj(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        if (Array.isArray(data.questions)) {
          createQuizFromImportedQuestions(data.questions, data.name || file.name.replace(/\.json$/i, ''));
        } else {
          App.showToast('Format JSON invalide', 'error');
        }
      } catch {
        App.showToast('Fichier JSON invalide', 'error');
      }
    };
    reader.readAsText(file);
  }

  // ---- Save quiz ----
  function saveQuiz() {
    const qs = App.state.questions;
    if (qs.length === 0) { App.showToast('Aucune question à sauvegarder !', 'error'); return; }

    const existingQuiz = App.state.currentQuiz && App.state.savedQuizzes.find(q => q.id === App.state.currentQuiz.id);

    if (existingQuiz) {
      // Mise à jour du quiz existant — pas de prompt, pas de téléchargement
      const quiz = {
        ...existingQuiz,
        questions: [...qs],
        date: new Date().toLocaleDateString('fr-FR'),
        count: qs.length,
      };
      const index = App.state.savedQuizzes.findIndex(q => q.id === existingQuiz.id);
      App.state.savedQuizzes[index] = quiz;
      App.state.currentQuiz = quiz;
      App.persistSavedQuizzes();
      renderSaved();
      App.showToast(`Quiz "${quiz.name}" mis à jour ✓`, 'success');
    } else {
      // Nouveau quiz — demande un nom
      const name = prompt('Nom du quiz :', `Quiz ${new Date().toLocaleDateString('fr-FR')}`);
      if (!name) return;
      const gameCode = generateUniqueSavedQuizCode(null);
      const quiz = {
        id: Date.now(),
        name,
        questions: [...qs],
        date: new Date().toLocaleDateString('fr-FR'),
        count: qs.length,
        gameCode,
      };
      App.state.savedQuizzes.push(quiz);
      App.state.currentQuiz = quiz;
      App.persistSavedQuizzes();
      renderSaved();
      App.showToast(`Quiz "${name}" créé ✓`, 'success');
    }
  }

  // ---- Render saved quizzes ----
  function renderSaved() {
    const list = document.getElementById('saved-quizzes-list');
    const empty = document.getElementById('saved-empty');
    list.innerHTML = '';
    const saved = App.state.savedQuizzes;
    empty.style.display = saved.length === 0 ? 'flex' : 'none';
    [...saved].reverse().forEach(quiz => {
      const item = document.createElement('div');
      item.className = 'saved-item';
      item.innerHTML = `
        <div class="saved-info">
           <button class="saved-launch-btn" onclick="Admin.loadAndLaunchQuiz(${quiz.id})">▶️ ${quiz.name}</button>
          <p>🔢 Code jeu : <strong>${quiz.gameCode || '----'}</strong></p>
          <p>${quiz.count} question(s) — ${quiz.date}</p>
        </div>
        <div class="saved-actions">
          <button class="btn btn-secondary sm" onclick="Admin.loadSavedQuiz(${quiz.id})">✏️ Modifier</button>
          <button class="btn btn-ghost sm" onclick="Admin.downloadSavedQuiz(${quiz.id})">⬇️ JSON</button>
          <button class="btn btn-ghost sm" onclick="Admin.deleteSavedQuiz(${quiz.id})" style="color:var(--accent2)">🗑️</button>
        </div>
      `;
      list.appendChild(item);
    });
  }

  function loadSavedQuiz(id) {
    const quiz = App.state.savedQuizzes.find(q => q.id === id);
    if (!quiz) return;
    if (!confirm(`Modifier "${quiz.name}" ? (remplace les questions actuelles)`)) return;
    App.state.questions = [...quiz.questions];
    if (!quiz.gameCode) quiz.gameCode = generateUniqueSavedQuizCode(quiz.id);
    App.state.currentQuiz = quiz;
    renderQuestions();
    // Ouvrir directement l'editeur des questions pour visualiser/modifier/ajouter
    showTab('tab-questions');
    App.showScreen('screen-admin');
    App.persistSavedQuizzes();
    App.showToast(`Quiz "${quiz.name}" prêt à modifier ✓`, 'success');
  }

  function loadAndLaunchQuiz(id) {
    const quiz = App.state.savedQuizzes.find(q => q.id === id);
    if (!quiz) return;
    if (!quiz.gameCode) {
      quiz.gameCode = generateUniqueSavedQuizCode(quiz.id);
      App.persistSavedQuizzes();
    }
    App.state.questions = [...quiz.questions];
    App.state.currentQuiz = quiz;
    renderQuestions();
    launchGame();
    App.showToast(`Quiz "${quiz.name}" lancé ✓`, 'success');
  }

  function downloadSavedQuiz(id) {
    const quiz = App.state.savedQuizzes.find(q => q.id === id);
    if (!quiz) return;
    const blob = new Blob([JSON.stringify({ name: quiz.name, questions: quiz.questions }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `${quiz.name.replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  function deleteSavedQuiz(id) {
    App.state.savedQuizzes = App.state.savedQuizzes.filter(q => q.id !== id);
    App.persistSavedQuizzes();
    renderSaved();
  }

  function connectAdminSSE(code) {
    if (adminSSE) { adminSSE.close(); adminSSE = null; }
    adminSSE = new EventSource(`/api/events/${code}`);

    adminSSE.addEventListener('playerJoin', e => {
      const player = JSON.parse(e.data);
      if (!App.state.players.find(p => p.id === player.id)) {
        App.state.players.push(player);
        Lobby.addPlayer(player);
      }
    });

    adminSSE.addEventListener('playerAnswer', e => {
      const { playerId, answerIndices, answerIndex, answer } = JSON.parse(e.data);
      const player = App.state.players.find(p => p.id === playerId);
      if (player && !player.answeredCurrentQuestion) {
        player.answeredCurrentQuestion = true;
        player.lastAnswerIndices = Array.isArray(answerIndices)
          ? answerIndices.filter(i => typeof i === 'number')
          : (typeof answerIndex === 'number' ? [answerIndex] : []);
        player.lastAnswerIndex = player.lastAnswerIndices.length > 0 ? player.lastAnswerIndices[0] : null;
        player.lastAnswer = answer;
        // Indicateur vert : le joueur a répondu
        const ind = document.getElementById(`indicator-${playerId}`);
        if (ind) { ind.className = 'answer-indicator answered'; ind.title = 'A répondu'; }
      }
    });
  }

  async function launchGame() {
    if (App.state.questions.length === 0) {
      App.showToast('Ajoutez au moins une question !', 'error');
      return;
    }
    try {
      const res = await fetch('/api/host', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questions: App.state.questions,
          code: App.state.currentQuiz?.gameCode || null,
        }),
      });
      if (!res.ok) throw new Error('server error');
      const { code, adminToken } = await res.json();

      App.state.players = [];
      App.state.currentPlayer = null;
      App.state.gameCode = code;
      App.state.adminToken = adminToken;
      if (typeof App.updateAdminCurrentCodeBadge === 'function') {
        App.updateAdminCurrentCodeBadge();
      }
      Lobby.clearPlayers();
      App.updateTrackLength();

      // Se connecter au flux SSE pour recevoir les joueurs
      connectAdminSSE(code);

      App.showScreen('screen-lobby');
      const codeDisplay = document.getElementById('lobby-code');
      if (codeDisplay) codeDisplay.textContent = code;
    } catch {
      App.showToast('Erreur de connexion au serveur', 'error');
    }
  }

  return {
    showTab, renderQuestions, renderSaved,
    addQuestion, editQuestion, deleteQuestion, moveQuestion,
    saveQuestion, closeModal, updateModalType, setCorrect, toggleCorrectFromRow,
    importFromText, importFromFile, importFromFileObj,
    saveQuiz, loadSavedQuiz, loadAndLaunchQuiz, downloadSavedQuiz, deleteSavedQuiz,
    startNewQuiz,
    launchGame,
  };
})();
