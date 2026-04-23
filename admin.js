// ============================================================
//  ADMIN.JS — Gestion des questions, import, sauvegarde
// ============================================================

const Admin = (() => {
  const MAX_IMPORTED_QUESTIONS = 20;
  const MODULES_STORAGE_KEY = 'quizrace_modules';
  const UNCLASSIFIED_MODULE_ID = 'uncategorized';
  const UNCLASSIFIED_MODULE_NAME = 'Non classes';
  let editingId = null;
  let correctIdx = 0;
  let correctIndices = [0]; // Pour les choix multiples
  let isMultipleChoice = false; // Mode choix unique ou multiples
  let adminSSE = null;
  let dragQuizId = null;
  let dragModuleId = null;

  function normalizeModuleName(name) {
    return String(name || '').trim();
  }

  function readModulesFromStorage() {
    try {
      const raw = localStorage.getItem(MODULES_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.log('[storage] failed to read modules', error);
      return [];
    }
  }

  function generateModuleId(existingModules) {
    const used = new Set((existingModules || []).map(m => String(m.id || '')));
    let id;
    do {
      id = `module_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    } while (used.has(id));
    return id;
  }

  function normalizeModules(modules) {
    let changed = false;
    const normalized = [];
    const usedIds = new Set();
    const source = Array.isArray(modules) ? modules : [];
    source.forEach(mod => {
      if (!mod || typeof mod !== 'object') return;
      const name = normalizeModuleName(mod.name);
      if (!name) return;
      let id = String(mod.id || '').trim();
      if (!id || usedIds.has(id)) {
        id = generateModuleId(normalized);
        changed = true;
      }
      if (id === UNCLASSIFIED_MODULE_ID && name !== UNCLASSIFIED_MODULE_NAME) {
        changed = true;
      }
      usedIds.add(id);
      normalized.push({ id, name: id === UNCLASSIFIED_MODULE_ID ? UNCLASSIFIED_MODULE_NAME : name });
    });

    if (!usedIds.has(UNCLASSIFIED_MODULE_ID)) {
      normalized.unshift({ id: UNCLASSIFIED_MODULE_ID, name: UNCLASSIFIED_MODULE_NAME });
      changed = true;
    } else {
      const idx = normalized.findIndex(m => m.id === UNCLASSIFIED_MODULE_ID);
      if (idx > 0) {
        const [unclassified] = normalized.splice(idx, 1);
        normalized.unshift({ id: UNCLASSIFIED_MODULE_ID, name: UNCLASSIFIED_MODULE_NAME || unclassified.name });
        changed = true;
      }
    }

    return { modules: normalized, changed };
  }

  function persistModules(modules) {
    const { modules: normalized } = normalizeModules(modules);
    try {
      localStorage.setItem(MODULES_STORAGE_KEY, JSON.stringify(normalized));
      return normalized;
    } catch (error) {
      console.log('[storage] failed to save modules', error);
      return normalized;
    }
  }

  function getModules() {
    const loaded = readModulesFromStorage();
    const { modules, changed } = normalizeModules(loaded);
    if (changed || loaded.length !== modules.length) {
      persistModules(modules);
    }
    return modules;
  }

  function getModuleIdSet(modules) {
    return new Set((modules || []).map(m => m.id));
  }

  function getModuleSelectOptions(currentModuleId, modules) {
    return (modules || [])
      .map(module => {
        const selected = module.id === currentModuleId ? 'selected' : '';
        return `<option value="${module.id}" ${selected}>${module.name}</option>`;
      })
      .join('');
  }

  function reorderModules(sourceModuleId, targetModuleId) {
    if (!sourceModuleId || !targetModuleId || sourceModuleId === targetModuleId) return;
    if (sourceModuleId === UNCLASSIFIED_MODULE_ID || targetModuleId === UNCLASSIFIED_MODULE_ID) return;
    const modules = getModules();
    const sourceIdx = modules.findIndex(m => m.id === sourceModuleId);
    const targetIdx = modules.findIndex(m => m.id === targetModuleId);
    if (sourceIdx < 0 || targetIdx < 0) return;
    const [moved] = modules.splice(sourceIdx, 1);
    modules.splice(targetIdx, 0, moved);
    persistModules(modules);
    renderSaved();
  }

  function ensureQuizModuleAssignments() {
    const modules = getModules();
    const validIds = getModuleIdSet(modules);
    let changed = false;
    App.state.savedQuizzes = (App.state.savedQuizzes || []).map(quiz => {
      if (!quiz || typeof quiz !== 'object') return quiz;
      const moduleId = String(quiz.moduleId || '').trim();
      const nextModuleId = validIds.has(moduleId) ? moduleId : UNCLASSIFIED_MODULE_ID;
      if (nextModuleId !== moduleId) {
        changed = true;
        return { ...quiz, moduleId: nextModuleId };
      }
      return quiz;
    });
    if (changed) {
      App.persistSavedQuizzes(App.state.savedQuizzes);
    }
    return modules;
  }

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
    try {
      localStorage.setItem('quizrace_questions', JSON.stringify(App.state.questions));
      console.log('[storage] questions saved successfully (' + App.state.questions.length + ')');
    } catch (error) {
      console.log('[storage] failed to save questions', error);
    }
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

    const normalizedQuestions = importedQuestions
      .map((q, idx) => normalizeImportedQuestion(q, idx))
      .filter(Boolean);

    if (normalizedQuestions.length === 0) {
      App.showToast('Import invalide: aucune question exploitable', 'error');
      return false;
    }

    const questions = normalizedQuestions.slice(0, MAX_IMPORTED_QUESTIONS);
    if (normalizedQuestions.length > MAX_IMPORTED_QUESTIONS) {
      App.showToast(`Import limite a ${MAX_IMPORTED_QUESTIONS} questions (sur ${normalizedQuestions.length})`, 'error');
    }

    const quiz = {
      id: Date.now(),
      name,
      questions,
      date: new Date().toLocaleDateString('fr-FR'),
      count: questions.length,
      gameCode: generateUniqueSavedQuizCode(null),
      moduleId: UNCLASSIFIED_MODULE_ID,
    };

    App.state.savedQuizzes.push(quiz);
    App.state.currentQuiz = quiz;
    App.state.questions = [...questions];
    App.updateTrackLength();
    App.persistSavedQuizzes();
    renderSaved();
    renderQuestions();
    showTab('tab-questions');
    App.showToast(`${questions.length} question(s) importee(s) dans "${name}" ✓`, 'success');
    return true;
  }

  function normalizeImportedQuestion(rawQuestion, index) {
    if (!rawQuestion || typeof rawQuestion !== 'object') return null;

    const q = { ...rawQuestion };
    const id = Date.now() + Math.random() + index;
    const text = String(q.text || q.question || q.title || '').trim();
    if (!text) return null;

    const category = String(q.category || q.theme || '').trim();
    const sourceType = String(q.type || '').trim().toLowerCase();
    const rawChoices = Array.isArray(q.choices)
      ? q.choices
      : (Array.isArray(q.options) ? q.options : (Array.isArray(q.propositions) ? q.propositions : []));

    const looksLikeQcm = sourceType === 'qcm' || sourceType === 'multiple' || sourceType === 'single' || rawChoices.length > 0;

    if (looksLikeQcm) {
      const choices = rawChoices.map(choice => String(choice || '').trim()).filter(Boolean);
      if (choices.length < 2) return null;

      let indices = [];
      if (Array.isArray(q.correctIndices)) {
        indices = q.correctIndices
          .map(v => Number(v))
          .filter(v => Number.isInteger(v) && v >= 0 && v < choices.length);
      } else if (Array.isArray(q.correctAnswers)) {
        indices = q.correctAnswers
          .map(v => Number(v))
          .filter(v => Number.isInteger(v) && v >= 0 && v < choices.length);
      } else if (Array.isArray(q.correct_answers)) {
        indices = q.correct_answers
          .map(v => Number(v))
          .filter(v => Number.isInteger(v) && v >= 0 && v < choices.length);
      } else if (Array.isArray(q.correct)) {
        indices = q.correct
          .map(v => Number(v))
          .filter(v => Number.isInteger(v) && v >= 0 && v < choices.length);
      } else if (typeof q.correct === 'number' && Number.isInteger(q.correct)) {
        if (q.correct >= 0 && q.correct < choices.length) indices = [q.correct];
      } else if (typeof q.correct === 'string') {
        const letter = q.correct.trim().toUpperCase();
        if (/^[A-Z]$/.test(letter)) {
          const idx = letter.charCodeAt(0) - 65;
          if (idx >= 0 && idx < choices.length) indices = [idx];
        } else {
          const asNumber = Number(letter);
          if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber < choices.length) indices = [asNumber];
        }
      }

      const uniqueIndices = [...new Set(indices)].sort((a, b) => a - b);
      if (uniqueIndices.length === 0) {
        uniqueIndices.push(0);
      }

      return {
        id,
        type: 'qcm',
        text,
        category,
        choices,
        correct: uniqueIndices[0],
        correctIndices: uniqueIndices,
        multipleAnswers: uniqueIndices.length > 1,
      };
    }

    const rawAnswer = Array.isArray(q.answer)
      ? q.answer.join(', ')
      : (q.answer ?? q.expectedAnswer ?? q.expected ?? q.reponse ?? q.solution ?? '');
    const answer = String(rawAnswer || '').trim();
    if (!answer) return null;

    return {
      id,
      type: 'open',
      text,
      answer,
      category,
    };
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

  function parseImportedChoiceLine(line) {
    const match =
      line.match(/^\s*([A-Z])\s*[:\)\-\.]\s*(.+?)\s*$/i) ||
      line.match(/^\s*([A-Z])\s+(.+?)\s*$/i) ||
      line.match(/^\s*(\d{1,2})\s*[:\)\-\.]\s*(.+?)\s*$/i) ||
      line.match(/^\s*[-•]\s+(.+?)\s*$/i);
    if (!match) return null;

    const rawChoice = match[2] ? match[2].trim() : match[1].trim();
    const isCorrect = /\*\s*$/.test(rawChoice);
    const choice = rawChoice.replace(/\*\s*$/, '').trim();
    return { choice, isCorrect };
  }

  function parseAnswerIndicesFromLine(answerLine, choices) {
    const payload = String(answerLine || '').trim();
    if (!payload || !Array.isArray(choices) || choices.length === 0) return [];
    const tokens = payload.split(/\s*,\s*|\s+et\s+|\s*\/\s*|\s*;\s*/i).map(t => t.trim()).filter(Boolean);
    const indices = [];
    tokens.forEach(token => {
      const letter = token.toUpperCase();
      if (/^[A-Z]$/.test(letter)) {
        const idx = letter.charCodeAt(0) - 65;
        if (idx >= 0 && idx < choices.length) indices.push(idx);
        return;
      }
      if (/^\d+$/.test(token)) {
        const n = Number(token);
        if (n >= 1 && n <= choices.length) indices.push(n - 1);
        else if (n >= 0 && n < choices.length) indices.push(n);
        return;
      }
      const foundIdx = choices.findIndex(choice => String(choice).toLowerCase() === token.toLowerCase());
      if (foundIdx >= 0) indices.push(foundIdx);
    });
    return [...new Set(indices)].sort((a, b) => a - b);
  }

  function parseImportedQcmBlock(firstLine, lines) {
    const questionText = firstLine
      .replace(/^(?:QCM|QUIZ|QUESTION)\s*(?:\d+\s*)?[:\)\-\.]?\s*/i, '')
      .trim();
    const choices = [];
    const correctIndices = [];
    let answerKeyLine = '';

    lines.slice(1).forEach(line => {
      const answerKeyMatch = line.match(/^R[ÉE]PONSE(?:S)?(?:\s+CORRECTE(?:S)?)?\s*:\s*(.+)/i);
      if (answerKeyMatch) {
        answerKeyLine = answerKeyMatch[1].trim();
        return;
      }
      const parsed = parseImportedChoiceLine(line);
      if (!parsed) return;
      choices.push(parsed.choice);
      if (parsed.isCorrect) {
        correctIndices.push(choices.length - 1);
      }
    });

    if (correctIndices.length === 0 && answerKeyLine) {
      const fromKey = parseAnswerIndicesFromLine(answerKeyLine, choices);
      fromKey.forEach(idx => correctIndices.push(idx));
    }

    if (!questionText || choices.length < 2 || correctIndices.length === 0) {
      return null;
    }

    return {
      id: Date.now() + Math.random(),
      type: 'qcm',
      text: questionText,
      choices,
      correct: correctIndices[0],
      correctIndices,
      multipleAnswers: correctIndices.length > 1,
      category: ''
    };
  }

  function parseTextImport(text) {
    const questions = [];
    const normalizedText = String(text || '').replace(/\r\n/g, '\n');
    const blocks = normalizedText
      .split(/\n\s*\n/)
      .map(b => b.trim())
      .filter(Boolean);

    // Fallback: si pas de paragraphes séparés, on segmente à chaque nouvelle entête de question.
    const effectiveBlocks = blocks.length <= 1
      ? normalizedText
          .split(/\n(?=(?:QCM|OUVERTE)\s*(?:\d+\s*)?:)/i)
          .map(b => b.trim())
          .filter(Boolean)
      : blocks;

    effectiveBlocks.forEach(block => {
      const lines = block.trim().split('\n').map(l => l.trim()).filter(l => l);
      if (lines.length === 0) return;
      const firstLine = lines[0];

      // QCM
      if (/^(?:QCM|QUIZ|QUESTION)\s*(?:\d+\s*)?[:\)\-\.]?/i.test(firstLine)) {
        const qcm = parseImportedQcmBlock(firstLine, lines);
        if (qcm) questions.push(qcm);
      }
      // Question ouverte
      else if (/^(?:OUVERTE|OPEN|QUESTION OUVERTE)\s*(?:\d+\s*)?[:\)\-\.]?/i.test(firstLine)) {
        const questionText = firstLine.replace(/^(?:OUVERTE|OPEN|QUESTION OUVERTE)\s*(?:\d+\s*)?[:\)\-\.]?\s*/i, '').trim();
        let answer = '';
        lines.slice(1).forEach(line => {
          const match = line.match(/^(?:R[ÉE]PONSE|ANSWER|SOLUTION|R[ÉE]PONSE ATTENDUE)\s*:\s*(.+)/i);
          if (match) answer = match[1].trim();
        });
        if (questionText && answer) {
          questions.push({ id: Date.now() + Math.random(), type: 'open', text: questionText, answer, category: '' });
        }
      } else {
        // Fallback: bloc non prefixe mais avec choices + reponse
        const qcm = parseImportedQcmBlock(firstLine, lines);
        if (qcm) questions.push(qcm);
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
        const candidateQuestions = Array.isArray(data)
          ? data
          : (Array.isArray(data.questions)
              ? data.questions
              : (Array.isArray(data.quiz && data.quiz.questions)
                  ? data.quiz.questions
                  : (Array.isArray(data.items) ? data.items : [])));

        if (candidateQuestions.length > 0) {
          createQuizFromImportedQuestions(candidateQuestions, data.name || file.name.replace(/\.json$/i, ''));
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

    App.loadSavedQuizzes();

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
      if (!App.persistSavedQuizzes(App.state.savedQuizzes)) {
        App.showToast('Erreur de sauvegarde locale', 'error');
        return;
      }
      renderSaved();
      console.log('[storage] quiz updated', quiz.name, quiz.id);
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
        moduleId: UNCLASSIFIED_MODULE_ID,
      };
      const currentSavedQuizzes = Array.isArray(App.state.savedQuizzes) ? [...App.state.savedQuizzes] : [];
      currentSavedQuizzes.push(quiz);
      App.state.savedQuizzes = currentSavedQuizzes;
      App.state.currentQuiz = quiz;
      if (!App.persistSavedQuizzes(currentSavedQuizzes)) {
        App.showToast('Erreur de sauvegarde locale', 'error');
        return;
      }
      renderSaved();
      console.log('[storage] quiz created', quiz.name, quiz.id);
      App.showToast(`Quiz "${name}" créé ✓`, 'success');
    }
  }

  // ---- Render saved quizzes ----
  function renderSaved() {
    const list = document.getElementById('saved-quizzes-list');
    const empty = document.getElementById('saved-empty');
    list.innerHTML = '';
    const saved = App.state.savedQuizzes || [];
    const modules = ensureQuizModuleAssignments();
    empty.style.display = saved.length === 0 ? 'flex' : 'none';
    modules.forEach(module => {
      const moduleWrap = document.createElement('section');
      moduleWrap.className = 'saved-module';
      moduleWrap.dataset.moduleId = module.id;
      moduleWrap.draggable = module.id !== UNCLASSIFIED_MODULE_ID;
      moduleWrap.addEventListener('dragstart', event => onModuleDragStart(event, module.id));
      moduleWrap.addEventListener('dragend', onModuleDragEnd);

      const header = document.createElement('div');
      header.className = 'saved-module-header';
      header.addEventListener('dragover', event => onModuleHeaderDragOver(event, module.id));
      header.addEventListener('dragleave', onModuleHeaderDragLeave);
      header.addEventListener('drop', event => onModuleHeaderDrop(event, module.id));
      const quizzesInModule = saved.filter(q => (q.moduleId || UNCLASSIFIED_MODULE_ID) === module.id).reverse();
      header.innerHTML = `
        <h3>${module.name} <span class="saved-module-count">${quizzesInModule.length}</span></h3>
        <div class="saved-module-actions">
          ${module.id === UNCLASSIFIED_MODULE_ID ? '' : '<span class="saved-module-grip" title="Glisser pour reordonner">↕</span>'}
          <button class="btn btn-ghost sm" onclick="Admin.renameModule('${module.id}')" title="Renommer le module">✏️</button>
          ${module.id === UNCLASSIFIED_MODULE_ID ? '' : `<button class="btn btn-ghost sm" onclick="Admin.deleteModule('${module.id}')" title="Supprimer le module" style="color:var(--accent2)">🗑️</button>`}
        </div>
      `;

      const body = document.createElement('div');
      body.className = 'saved-module-body';
      body.dataset.moduleId = module.id;
      body.addEventListener('dragover', event => onModuleDragOver(event, module.id));
      body.addEventListener('dragleave', onModuleDragLeave);
      body.addEventListener('drop', event => onModuleDrop(event, module.id));

      if (quizzesInModule.length === 0) {
        const emptyModule = document.createElement('div');
        emptyModule.className = 'saved-module-empty';
        emptyModule.textContent = 'Glissez un quiz ici';
        body.appendChild(emptyModule);
      } else {
        quizzesInModule.forEach(quiz => {
          const item = document.createElement('div');
          item.className = 'saved-item';
          item.draggable = true;
          item.dataset.quizId = String(quiz.id);
          item.addEventListener('dragstart', event => onQuizDragStart(event, quiz.id));
          item.addEventListener('dragend', onQuizDragEnd);
          item.innerHTML = `
            <div class="saved-info">
              <button class="saved-launch-btn" onclick="Admin.loadAndLaunchQuiz(${quiz.id})">▶️ ${quiz.name}</button>
              <p>${quiz.count} question(s) — ${quiz.date}</p>
            </div>
            <div class="saved-actions">
              <label class="saved-move-wrap" title="Deplacer ce quiz">
                <span>Vers</span>
                <select class="saved-move-select" onchange="Admin.changeQuizModule(${quiz.id}, this.value)">
                  ${getModuleSelectOptions(quiz.moduleId || UNCLASSIFIED_MODULE_ID, modules)}
                </select>
              </label>
              <button class="btn btn-ghost sm" onclick="Admin.renameSavedQuiz(${quiz.id})" title="Renommer le quiz">✏️ Nom</button>
              <button class="btn btn-secondary sm" onclick="Admin.loadSavedQuiz(${quiz.id})">✏️ Modifier</button>
              <button class="btn btn-ghost sm" onclick="Admin.downloadSavedQuiz(${quiz.id})">⬇️ JSON</button>
              <button class="btn btn-ghost sm" onclick="Admin.deleteSavedQuiz(${quiz.id})" style="color:var(--accent2)">🗑️</button>
            </div>
          `;
          body.appendChild(item);
        });
      }

      moduleWrap.appendChild(header);
      moduleWrap.appendChild(body);
      list.appendChild(moduleWrap);
    });
  }

  function createModule() {
    const name = prompt('Nom du module :');
    const trimmed = normalizeModuleName(name);
    if (!trimmed) return;
    const modules = getModules();
    if (modules.some(m => m.name.toLowerCase() === trimmed.toLowerCase())) {
      App.showToast('Un module avec ce nom existe deja', 'error');
      return;
    }
    modules.push({ id: generateModuleId(modules), name: trimmed });
    persistModules(modules);
    renderSaved();
    App.showToast(`Module "${trimmed}" cree`, 'success');
  }

  function renameModule(moduleId) {
    if (!moduleId || moduleId === UNCLASSIFIED_MODULE_ID) return;
    const modules = getModules();
    const module = modules.find(m => m.id === moduleId);
    if (!module) return;
    const nextName = prompt('Nouveau nom du module :', module.name);
    const trimmed = normalizeModuleName(nextName);
    if (!trimmed || trimmed === module.name) return;
    if (modules.some(m => m.id !== moduleId && m.name.toLowerCase() === trimmed.toLowerCase())) {
      App.showToast('Ce nom de module est deja utilise', 'error');
      return;
    }
    module.name = trimmed;
    persistModules(modules);
    renderSaved();
    App.showToast('Module renomme', 'success');
  }

  function deleteModule(moduleId) {
    if (!moduleId || moduleId === UNCLASSIFIED_MODULE_ID) return;
    const modules = getModules();
    const module = modules.find(m => m.id === moduleId);
    if (!module) return;
    if (!confirm(`Supprimer le module "${module.name}" ? Les quiz seront deplaces vers "${UNCLASSIFIED_MODULE_NAME}".`)) {
      return;
    }

    const nextModules = modules.filter(m => m.id !== moduleId);
    persistModules(nextModules);

    App.state.savedQuizzes = (App.state.savedQuizzes || []).map(quiz => {
      if ((quiz.moduleId || UNCLASSIFIED_MODULE_ID) !== moduleId) return quiz;
      return { ...quiz, moduleId: UNCLASSIFIED_MODULE_ID };
    });
    App.persistSavedQuizzes(App.state.savedQuizzes);
    renderSaved();
    App.showToast('Module supprime', 'success');
  }

  function renameSavedQuiz(id) {
    const quiz = App.state.savedQuizzes.find(q => q.id === id);
    if (!quiz) return;
    const nextName = prompt('Nouveau nom du quiz :', quiz.name);
    const trimmed = normalizeModuleName(nextName);
    if (!trimmed || trimmed === quiz.name) return;
    quiz.name = trimmed;
    App.persistSavedQuizzes(App.state.savedQuizzes);
    renderSaved();
    App.showToast('Quiz renomme', 'success');
  }

  function moveQuizToModule(quizId, moduleId) {
    const modules = getModules();
    const validIds = getModuleIdSet(modules);
    const targetModuleId = validIds.has(moduleId) ? moduleId : UNCLASSIFIED_MODULE_ID;
    const quiz = App.state.savedQuizzes.find(q => q.id === quizId);
    if (!quiz) return;
    if ((quiz.moduleId || UNCLASSIFIED_MODULE_ID) === targetModuleId) return;
    quiz.moduleId = targetModuleId;
    App.persistSavedQuizzes(App.state.savedQuizzes);
    renderSaved();
  }

  function changeQuizModule(quizId, moduleId) {
    moveQuizToModule(Number(quizId), String(moduleId || ''));
  }

  function onQuizDragStart(event, quizId) {
    if (dragModuleId) return;
    dragQuizId = Number(quizId);
    if (event && event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(quizId));
    }
  }

  function onQuizDragEnd() {
    dragQuizId = null;
    document.querySelectorAll('.saved-module-body.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  function onModuleDragStart(event, moduleId) {
    if (moduleId === UNCLASSIFIED_MODULE_ID) {
      if (event) event.preventDefault();
      return;
    }
    dragModuleId = String(moduleId);
    if (event && event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-module-id', dragModuleId);
    }
  }

  function onModuleDragEnd() {
    dragModuleId = null;
    document.querySelectorAll('.saved-module-header.module-drag-over').forEach(el => el.classList.remove('module-drag-over'));
  }

  function onModuleHeaderDragOver(event, moduleId) {
    if (!dragModuleId || moduleId === UNCLASSIFIED_MODULE_ID || dragModuleId === moduleId) return;
    event.preventDefault();
    event.currentTarget.classList.add('module-drag-over');
  }

  function onModuleHeaderDragLeave(event) {
    event.currentTarget.classList.remove('module-drag-over');
  }

  function onModuleHeaderDrop(event, moduleId) {
    if (!dragModuleId || moduleId === UNCLASSIFIED_MODULE_ID) return;
    event.preventDefault();
    event.currentTarget.classList.remove('module-drag-over');
    let source = dragModuleId;
    if (event.dataTransfer) {
      source = event.dataTransfer.getData('application/x-module-id') || source;
    }
    reorderModules(source, moduleId);
    dragModuleId = null;
  }

  function onModuleDragOver(event) {
    if (!dragQuizId) return;
    event.preventDefault();
    event.currentTarget.classList.add('drag-over');
  }

  function onModuleDragLeave(event) {
    event.currentTarget.classList.remove('drag-over');
  }

  function onModuleDrop(event, moduleId) {
    event.preventDefault();
    event.currentTarget.classList.remove('drag-over');
    let quizId = dragQuizId;
    if (!quizId && event.dataTransfer) {
      quizId = Number(event.dataTransfer.getData('text/plain'));
    }
    if (!quizId) return;
    moveQuizToModule(Number(quizId), moduleId);
    dragQuizId = null;
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
    App.persistSavedQuizzes(App.state.savedQuizzes);
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

    adminSSE.addEventListener('game_reset_force', e => {
      const data = JSON.parse(e.data || '{}');
      App.state.players = [];
      Lobby.clearPlayers();
      const reason = data.reason === 'ended' ? 'fin de partie' : 'nouvelle session';
      App.showToast(`Liste des joueurs remise a zero (${reason})`, 'success');
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
    createModule, renameModule, deleteModule, renameSavedQuiz, changeQuizModule,
    startNewQuiz,
    launchGame,
  };
})();

// ============================================================
//  FILL ACTIVITY — Textes à Trous (système séparé des quiz)
// ============================================================
const FillActivity = (() => {
  // ---- État du constructeur ----
  let _builderState = {
    tokens: [],      // [{word, isPunct, isBlank}]
    level: 1,
    name: '',
  };
  let _fillAdminSSE = null;
  let _fillTimerInterval = null;
  let _fillTimerSeconds = 300; // 5 minutes
  let _fillTimerTotal = 300;
  let _fillPlayerAnswers = {}; // { playerId: [{holeId, word}] }
  let _currentActivity = null; // activité en cours de jeu
  let _editingFillId = null;
  let _lastFillScores = null;
  let _lastFillCorrectionPayload = null;
  let _fillCorrectionValidated = false;
  let _fillGameStarted = false;
  let _savedFillSort = 'newest';
  let _savedFillQuery = '';

  function _refreshFillProgressCounter() {
    const counter = document.getElementById('fill-progress-counter');
    if (!counter) return;
    const rows = Array.from(document.querySelectorAll('#fill-player-list .fill-player-row'));
    const total = rows.length;
    const done = rows.filter(r => r.classList.contains('submitted')).length;
    counter.textContent = `${done} / ${total} terminé(s)`;
  }

  function _renderAdminFillTextPreview() {
    const box = document.getElementById('fill-admin-text-preview');
    if (!box || !_currentActivity) return;
    const { segments, holes } = _currentActivity;
    let html = '';
    segments.forEach((seg, i) => {
      html += escHtml(seg).replace(/\n/g, '<br>');
      if (i < holes.length) {
        html += `<span class="fill-admin-hole">[${i + 1}]</span>`;
      }
    });
    box.innerHTML = html;
  }

  function _renderAdminFinalScores() {
    const panel = document.getElementById('fill-admin-results-panel');
    const list = document.getElementById('fill-admin-results-list');
    if (!panel || !list) return;
    if (!_lastFillScores || !Array.isArray(_lastFillScores)) {
      panel.style.display = 'none';
      return;
    }
    const rows = Array.from(document.querySelectorAll('#fill-player-list .fill-player-row')).map(row => {
      const id = Number(row.getAttribute('data-player-id'));
      const name = row.querySelector('.fill-player-name') ? row.querySelector('.fill-player-name').textContent : 'Joueur';
      const avatar = row.querySelector('.fill-player-avatar') ? row.querySelector('.fill-player-avatar').textContent : '🙂';
      return { id, name, avatar };
    });
    const merged = _lastFillScores.map(score => {
      const profile = rows.find(r => r.id === score.playerId) || { name: 'Joueur', avatar: '🙂' };
      return {
        ...score,
        name: profile.name,
        avatar: profile.avatar,
      };
    }).sort((a, b) => (b.delta || 0) - (a.delta || 0));
    list.innerHTML = merged.map((r, idx) => `
      <div class="fill-admin-score-row">
        <span class="fill-admin-rank">${idx + 1}</span>
        <span class="fill-admin-avatar">${escHtml(r.avatar)}</span>
        <span class="fill-admin-name">${escHtml(r.name)}</span>
        <span class="fill-admin-points">${r.totalHoles > 0 ? Math.round((r.correctCount / r.totalHoles) * 100) : (r.delta || 0)}%</span>
      </div>
    `).join('');
    panel.style.display = '';
  }

  // ---- Onglets du constructeur ----
  function showBuilderTab(tabId) {
    document.querySelectorAll('#screen-fill-builder .admin-tab').forEach(t => t.classList.remove('active'));
    const target = document.getElementById(tabId);
    if (target) target.classList.add('active');
    document.querySelectorAll('#screen-fill-builder .sidebar-btn').forEach(b => b.classList.remove('active'));
    const map = { 'tab-fill-create': 'sidebar-fill-create', 'tab-fill-saved': 'sidebar-fill-saved' };
    const sideBtn = document.getElementById(map[tabId]);
    if (sideBtn) sideBtn.classList.add('active');
    if (tabId === 'tab-fill-saved') renderSavedFills();
  }

  // ---- Niveau ----
  function setLevel(n) {
    _builderState.level = n;
    const b1 = document.getElementById('fill-level-1');
    const b2 = document.getElementById('fill-level-2');
    if (b1) b1.classList.toggle('active', n === 1);
    if (b2) b2.classList.toggle('active', n === 2);
  }

  // ---- Parser le texte ----
  function parseText() {
    const nameInput = document.getElementById('fill-name-input');
    const textInput = document.getElementById('fill-text-input');
    const name = (nameInput ? nameInput.value.trim() : '') || 'Texte sans titre';
    const raw = textInput ? textInput.value.trim() : '';
    if (!raw) { App.showToast('Entrez d\'abord un texte.', 'error'); return; }
    _builderState.name = name;
    // Tokenize: sépare ponctuation et mots
    const regex = /([a-zA-ZÀ-ÿ0-9''\-]+|[^a-zA-ZÀ-ÿ0-9\s''\-]+|\s+)/g;
    const tokens = [];
    let m;
    while ((m = regex.exec(raw)) !== null) {
      const w = m[0];
      const isWord = /[a-zA-ZÀ-ÿ0-9]/.test(w);
      tokens.push({ word: w, isPunct: !isWord, isBlank: false });
    }
    _builderState.tokens = tokens;
    renderTokenList();
    const area = document.getElementById('fill-token-area');
    if (area) area.style.display = '';
  }

  function renderTokenList() {
    const container = document.getElementById('fill-token-list');
    if (!container) return;
    container.innerHTML = '';
    _builderState.tokens.forEach((tok, i) => {
      if (tok.isPunct) {
        const span = document.createElement('span');
        span.className = 'fill-build-punct';
        span.textContent = tok.word;
        container.appendChild(span);
        return;
      }
      const btn = document.createElement('button');
      btn.className = 'fill-build-word' + (tok.isBlank ? ' is-blank' : '');
      btn.textContent = tok.word;
      btn.title = tok.isBlank ? 'Cliquer pour retirer ce trou' : 'Cliquer pour faire un trou';
      btn.onclick = () => {
        tok.isBlank = !tok.isBlank;
        btn.classList.toggle('is-blank', tok.isBlank);
        btn.title = tok.isBlank ? 'Cliquer pour retirer ce trou' : 'Cliquer pour faire un trou';
        renderPreview();
      };
      container.appendChild(btn);
    });
    renderPreview();
  }

  function renderPreview() {
    const box = document.getElementById('fill-preview');
    if (!box) return;
    let holeCount = 0;
    const html = _builderState.tokens.map(tok => {
      if (tok.isPunct) return tok.word.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      if (tok.isBlank) {
        holeCount++;
        return `<span class="fill-preview-blank">[${holeCount}]</span>`;
      }
      return tok.word.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }).join('');
    box.innerHTML = html;
  }

  // ---- Convertir tokens en segments + holes ----
  function _buildActivityData() {
    const holes = [];
    const segments = [];
    let seg = '';
    let holeIdx = 0;
    _builderState.tokens.forEach(tok => {
      if (!tok.isPunct && tok.isBlank) {
        segments.push(seg);
        seg = '';
        holes.push({ id: holeIdx++, word: tok.word });
      } else {
        seg += tok.word;
      }
    });
    segments.push(seg);
    return { segments, holes };
  }

  function _tokenizeFillText(raw, isBlankWord = false) {
    const regex = /([a-zA-ZÀ-ÿ0-9''\-]+|[^a-zA-ZÀ-ÿ0-9\s''\-]+|\s+)/g;
    const tokens = [];
    let m;
    while ((m = regex.exec(String(raw || ''))) !== null) {
      const w = m[0];
      const isWord = /[a-zA-ZÀ-ÿ0-9]/.test(w);
      tokens.push({ word: w, isPunct: !isWord, isBlank: isWord ? !!isBlankWord : false });
    }
    return tokens;
  }

  function _activityToRawText(activity) {
    const segments = Array.isArray(activity && activity.segments) ? activity.segments : [];
    const holes = Array.isArray(activity && activity.holes) ? activity.holes : [];
    let text = '';
    segments.forEach((seg, i) => {
      text += String(seg || '');
      if (i < holes.length) text += String((holes[i] && holes[i].word) || '');
    });
    return text;
  }

  function editFillActivity(id) {
    const activity = (App.state.savedFillActivities || []).find(f => f.id === id);
    if (!activity) { App.showToast('Activité introuvable.', 'error'); return; }

    const tokens = [];
    const segments = Array.isArray(activity.segments) ? activity.segments : [];
    const holes = Array.isArray(activity.holes) ? activity.holes : [];
    segments.forEach((seg, i) => {
      tokens.push(..._tokenizeFillText(seg, false));
      if (i < holes.length) tokens.push(..._tokenizeFillText((holes[i] && holes[i].word) || '', true));
    });

    _editingFillId = id;
    _builderState.tokens = tokens;
    _builderState.name = activity.name || 'Texte sans titre';
    setLevel(activity.level || 1);

    const nameInput = document.getElementById('fill-name-input');
    const textInput = document.getElementById('fill-text-input');
    const area = document.getElementById('fill-token-area');
    if (nameInput) nameInput.value = _builderState.name;
    if (textInput) textInput.value = _activityToRawText(activity);
    if (area) area.style.display = '';
    renderTokenList();

    App.showScreen('screen-fill-builder');
    showBuilderTab('tab-fill-create');
    App.showToast('Modification du texte à trous.', '');
  }

  // ---- Sauvegarder ----
  function saveFillActivity() {
    const nameInput = document.getElementById('fill-name-input');
    const name = (nameInput ? nameInput.value.trim() : '') || _builderState.name || 'Texte sans titre';
    const holes = _builderState.tokens.filter(t => !t.isPunct && t.isBlank);
    if (holes.length === 0) { App.showToast('Sélectionnez au moins un mot comme trou.', 'error'); return; }
    const { segments, holes: holeList } = _buildActivityData();
    const existing = (App.state.savedFillActivities || []).find(f => f.id === _editingFillId);
    const activity = {
      id: _editingFillId || Date.now(),
      name,
      date: existing && existing.date ? existing.date : new Date().toLocaleDateString('fr-FR'),
      level: _builderState.level,
      segments,
      holes: holeList,
    };
    const list = Array.isArray(App.state.savedFillActivities) ? [...App.state.savedFillActivities] : [];
    const idx = list.findIndex(f => f.id === activity.id);
    if (idx >= 0) list[idx] = activity;
    else list.push(activity);
    App.persistSavedFillActivities(list);
    App.showToast(_editingFillId ? `Activité "${name}" modifiée ✓` : `Activité "${name}" sauvegardée ✓`, 'success');
    // Reset builder
    _builderState.tokens = [];
    _builderState.name = '';
    _editingFillId = null;
    if (nameInput) nameInput.value = '';
    const textInput = document.getElementById('fill-text-input');
    if (textInput) textInput.value = '';
    const area = document.getElementById('fill-token-area');
    if (area) area.style.display = 'none';
    showBuilderTab('tab-fill-saved');
  }

  // ---- Afficher les activités sauvegardées ----
  function renderSavedFills() {
    App.loadSavedFillActivities();
    const list = document.getElementById('fill-saved-list');
    if (!list) return;
    const sortEl = document.getElementById('fill-sort-select');
    if (sortEl) sortEl.value = _savedFillSort;
    const queryEl = document.getElementById('fill-search-input');
    if (queryEl && queryEl.value !== _savedFillQuery) queryEl.value = _savedFillQuery;

    const fills = (App.state.savedFillActivities || [])
      .filter(f => Array.isArray(f && f.segments) && Array.isArray(f && f.holes))
      .slice();
    fills.sort((a, b) => {
      const holesA = Array.isArray(a.holes) ? a.holes.length : 0;
      const holesB = Array.isArray(b.holes) ? b.holes.length : 0;
      const levelA = Number(a.level || 1);
      const levelB = Number(b.level || 1);
      const nameA = String(a.name || '');
      const nameB = String(b.name || '');

      switch (_savedFillSort) {
        case 'oldest':
          return (a.id || 0) - (b.id || 0);
        case 'holes-desc':
          return holesB - holesA;
        case 'holes-asc':
          return holesA - holesB;
        case 'level-asc':
          return levelA - levelB;
        case 'level-desc':
          return levelB - levelA;
        case 'name-asc':
          return nameA.localeCompare(nameB, 'fr');
        case 'newest':
        default:
          return (b.id || 0) - (a.id || 0);
      }
    });
    const query = String(_savedFillQuery || '').trim().toLowerCase();
    const visibleFills = query
      ? fills.filter(f => _buildFillSearchText(f).includes(query))
      : fills;
    if (visibleFills.length === 0) {
      list.innerHTML = query
        ? '<p class="empty-state">Aucun texte à trous ne correspond à votre recherche.</p>'
        : '<p class="empty-state">Aucun texte à trous sauvegardé.</p>';
      return;
    }
    list.innerHTML = visibleFills.map(f => `
      <div class="fill-saved-item">
        <div class="fill-card-top">
          <div class="fill-saved-title">📝 ${escHtml(f.name)}</div>
          <span class="fill-level-pill">Niveau ${f.level || 1}</span>
        </div>
        <div class="fill-saved-meta">
          <span>🧩 ${f.holes.length} trou${f.holes.length > 1 ? 's' : ''}</span>
          <span>📅 ${escHtml(f.date || '-')}</span>
        </div>
        <p class="fill-card-preview">${escHtml(_buildFillPreviewText(f))}</p>
        <div class="fill-saved-actions">
          <button class="btn btn-primary" onclick="FillActivity.launchFillActivity(${f.id})">▶️ Lancer</button>
          <button class="btn btn-ghost" onclick="FillActivity.editFillActivity(${f.id})">✏️ Modifier</button>
          <button class="btn btn-ghost" onclick="FillActivity.deleteFillActivity(${f.id})">🗑️ Supprimer</button>
        </div>
      </div>
    `).join('');
  }

  function setSavedFillSort(sortKey) {
    _savedFillSort = String(sortKey || 'newest');
    renderSavedFills();
  }

  function setSavedFillQuery(query) {
    _savedFillQuery = String(query || '');
    renderSavedFills();
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _buildFillPreviewText(activity, maxLen = 180) {
    const segments = Array.isArray(activity && activity.segments) ? activity.segments : [];
    const holes = Array.isArray(activity && activity.holes) ? activity.holes : [];
    let text = '';
    segments.forEach((seg, i) => {
      text += String(seg || '');
      if (i < holes.length) text += ' ____ ';
    });
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length > maxLen ? compact.slice(0, maxLen - 1) + '…' : compact;
  }

  function _buildFillSearchText(activity) {
    const name = String(activity && activity.name ? activity.name : '');
    const text = _buildFillPreviewText(activity, 2000);
    return (name + ' ' + text).toLowerCase();
  }

  function goToActivities() {
    App.renderQuizList();
    App.showScreen('screen-quiz-list');
  }

  function deleteFillActivity(id) {
    if (!confirm('Supprimer cette activité ?')) return;
    const next = (App.state.savedFillActivities || []).filter(f => f.id !== id);
    if (_editingFillId === id) _editingFillId = null;
    App.persistSavedFillActivities(next);
    renderSavedFills();
    App.showToast('Activité supprimée.', '');
  }

  // ---- Lancer une activité ----
  function launchFillActivity(id) {
    const activity = (App.state.savedFillActivities || []).find(f => f.id === id);
    if (!activity) { App.showToast('Activité introuvable.', 'error'); return; }
    _currentActivity = activity;
    _fillPlayerAnswers = {};
    // Créer session jeu via /api/host (questions factices pour compatibilité)
    fetch('/api/host', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: [{ text: '__fill__', type: 'fill' }] }),
    })
    .then(r => r.json())
    .then(data => {
      App.state.gameCode    = data.code;
      App.state.adminToken  = data.adminToken;
      // Connecter SSE admin
      _connectFillSSE(data.code);
      // Aller vers screen-fill-game
      const titleEl = document.getElementById('fill-game-title');
      if (titleEl) titleEl.textContent = activity.name;
      App.showScreen('screen-fill-game');
      _renderFillJoinQRCode();
      _lastFillScores = null;
      _lastFillCorrectionPayload = null;
      _fillCorrectionValidated = false;
      _fillGameStarted = false;
      const submissionsPanel = document.getElementById('fill-submissions-panel');
      if (submissionsPanel) submissionsPanel.style.display = '';
      const scoresPanel = document.getElementById('fill-admin-results-panel');
      if (scoresPanel) scoresPanel.style.display = 'none';
      const previewBox = document.getElementById('fill-admin-text-preview');
      if (previewBox) previewBox.innerHTML = '';
      renderFillPlayerList([]);
      _refreshFillProgressCounter();
      const launchBtn = document.getElementById('btn-fill-launch');
      const stopBtn = document.getElementById('btn-fill-stop');
      if (launchBtn) {
        launchBtn.disabled = false;
        launchBtn.textContent = '▶️ Lancer le jeu';
      }
      if (stopBtn) stopBtn.disabled = true;
      const timerText = document.getElementById('fill-timer-text');
      if (timerText) timerText.textContent = '5:00';
      const validateBtn = document.getElementById('btn-fill-validate');
      if (validateBtn) {
        validateBtn.disabled = false;
        validateBtn.textContent = '✅ Valider la correction';
      }
    })
    .catch(() => App.showToast('Erreur lors du lancement.', 'error'));
  }

  function startFillGame() {
    if (!_currentActivity || _fillGameStarted) return;
    _fillGameStarted = true;
    _fillCorrectionValidated = false;
    _lastFillScores = null;
    const launchBtn = document.getElementById('btn-fill-launch');
    const stopBtn = document.getElementById('btn-fill-stop');
    const addTimeBtn = document.getElementById('btn-fill-add-time');
    if (launchBtn) {
      launchBtn.disabled = true;
      launchBtn.textContent = '✅ Jeu lancé';
    }
    if (stopBtn) stopBtn.disabled = false;
    if (addTimeBtn) addTimeBtn.disabled = false;

    _renderAdminFillTextPreview();
    _broadcastFill('fillStart', {
      activityId: _currentActivity.id,
      name: _currentActivity.name,
      level: _currentActivity.level,
      segments: _currentActivity.segments,
      holes: _currentActivity.holes.map(h => ({ id: h.id, word: (_currentActivity.level === 1 ? h.word : null) })),
      timeLimit: 300,
    });
    startTimer();
    App.showToast('Jeu lancé: les joueurs peuvent répondre.', 'success');
  }

  // Pour le niveau 1 : les mots sont fournis (pour les joueurs les voir dans la bank)
  // Pour le niveau 2 : les mots ne sont pas fournis (joueurs tapent)

  function _broadcastFill(type, payload) {
    if (!App.state.gameCode || !App.state.adminToken) return;
    fetch(`/api/admin/${App.state.gameCode}/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminToken: App.state.adminToken, type, payload }),
    }).catch(() => {});
  }

  function _renderFillJoinQRCode() {
    const qrContainer = document.getElementById('fill-game-qrcode');
    if (!qrContainer) return;
    qrContainer.innerHTML = '';
    if (!App.state.gameCode || typeof QRCode !== 'function') return;
    const joinUrl = `${window.location.origin}/join-new-game?code=${encodeURIComponent(App.state.gameCode)}`;
    new QRCode(qrContainer, {
      text: joinUrl,
      width: 224,
      height: 224,
      colorDark: '#1a1a2e',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  function _connectFillSSE(code) {
    if (_fillAdminSSE) { _fillAdminSSE.close(); _fillAdminSSE = null; }
    const sse = new EventSource('/api/events/' + code);
    _fillAdminSSE = sse;
    sse.addEventListener('fillPlayerSubmit', function(e) {
      const data = JSON.parse(e.data);
      _fillPlayerAnswers[data.playerId] = data.answers || [];
      _updatePlayerSubmitted(data.playerId, data.playerName, data.playerAvatar);
    });
    sse.addEventListener('playerJoin', function(e) {
      const player = JSON.parse(e.data);
      _addPlayerRow(player.id, player.name, player.avatar, false);
    });
    sse.addEventListener('init', function(e) {
      const data = JSON.parse(e.data);
      (data.players || []).forEach(p => _addPlayerRow(p.id, p.name, p.avatar, p.fillSubmitted));
    });
    sse.onerror = function() {};
  }

  function _addPlayerRow(id, name, avatar, submitted) {
    const container = document.getElementById('fill-player-list');
    if (!container) return;
    const existing = container.querySelector(`[data-player-id="${id}"]`);
    if (existing) return;
    if (container.querySelector('.empty-state')) container.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'fill-player-row' + (submitted ? ' submitted' : '');
    row.setAttribute('data-player-id', id);
    row.innerHTML = `<span class="fill-player-avatar">${avatar}</span>
      <span class="fill-player-name">${escHtml(name)}</span>
      <span class="fill-player-status">${submitted ? '✅ Validé' : '⏳ En cours…'}</span>
      <button class="fill-player-delete" onclick="FillActivity.removePlayer(${id})" title="Supprimer le joueur">🗑️</button>`;
    container.appendChild(row);
    _refreshFillProgressCounter();
  }

  function _updatePlayerSubmitted(playerId, name, avatar) {
    const container = document.getElementById('fill-player-list');
    if (!container) return;
    const existing = container.querySelector(`[data-player-id="${playerId}"]`);
    if (existing) {
      existing.classList.add('submitted');
      const status = existing.querySelector('.fill-player-status');
      if (status) status.textContent = '✅ Validé';
    } else {
      _addPlayerRow(playerId, name, avatar, true);
    }
    _refreshFillProgressCounter();
  }

  function renderFillPlayerList(players) {
    const container = document.getElementById('fill-player-list');
    if (!container) return;
    container.innerHTML = '<p class="empty-state">En attente des joueurs…</p>';
    players.forEach(p => _addPlayerRow(p.id, p.name, p.avatar, p.fillSubmitted));
    _refreshFillProgressCounter();
  }

  function removePlayer(playerId) {
    // Supprimer de l'état des joueurs du fill
    if (_fillPlayerAnswers[playerId]) {
      delete _fillPlayerAnswers[playerId];
    }
    // Supprimer de l'interface
    const row = document.querySelector(`#fill-player-list [data-player-id="${playerId}"]`);
    if (row) row.remove();
    _refreshFillProgressCounter();
    App.showToast('Joueur supprimé du texte à trous', 'success');
  }

  // ---- Chrono ----
  function startTimer() {
    _fillTimerSeconds = 300;
    _fillTimerTotal = 300;
    _renderTimer();
    clearInterval(_fillTimerInterval);
    _fillTimerInterval = setInterval(() => {
      _fillTimerSeconds = Math.max(0, _fillTimerSeconds - 1);
      _renderTimer();
      if (_fillTimerSeconds === 0) {
        clearInterval(_fillTimerInterval);
        _timerEnded();
      }
    }, 1000);
  }

  function stopTimer() {
    clearInterval(_fillTimerInterval);
    _timerEnded();
  }

  function addTime() {
    if (!_fillGameStarted || _fillTimerSeconds <= 0) return;
    _fillTimerSeconds = Math.min(_fillTimerSeconds + 60, _fillTimerTotal + 60); // Max +1 min
    _fillTimerTotal = Math.max(_fillTimerTotal, _fillTimerSeconds);
    _renderTimer();
    App.showToast('+1 minute ajoutée', 'success');
  }

  function _renderTimer() {
    const bar = document.getElementById('fill-timer-bar');
    const text = document.getElementById('fill-timer-text');
    if (bar) bar.style.width = (_fillTimerSeconds / _fillTimerTotal * 100) + '%';
    if (text) {
      const m = Math.floor(_fillTimerSeconds / 60);
      const s = _fillTimerSeconds % 60;
      text.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }
  }

  function _timerEnded() {
    if (!_fillGameStarted) return;
    const stopBtn = document.getElementById('btn-fill-stop');
    const addTimeBtn = document.getElementById('btn-fill-add-time');
    if (stopBtn) stopBtn.disabled = true;
    if (addTimeBtn) addTimeBtn.disabled = true;
    // Broadcast timerEnd so players know time is up
    _broadcastFill('fillTimerEnd', {});
    // Ouvrir la modale de correction
    openCorrectionModal();
  }

  // ---- Modale correction ----
  function openCorrectionModal() {
    if (!_currentActivity) return;
    const modal = document.getElementById('fill-correction-modal');
    if (!modal) return;
    modal.style.display = '';
    _renderCorrectionText();
    _renderWordBank();
    _attachZoneClickEvents();
    const hint = document.getElementById('fill-correction-hint');
    if (hint) hint.textContent = _currentActivity.level === 1
      ? 'Cliquez sur un mot placé pour le remettre dans la liste.'
      : 'Saisissez les mots manquants dans les champs.';
    const btn = document.getElementById('btn-fill-validate');
    if (btn) {
      btn.disabled = false;
      btn.textContent = _fillCorrectionValidated
        ? '✅ Correction envoyée - cliquer pour renvoyer'
        : '✅ Valider la correction';
    }
  }

  function _attachZoneClickEvents() {
    if (_currentActivity.level !== 1) return; // Seulement pour le niveau 1 (drag & drop)
    document.querySelectorAll('#fill-correction-text .fill-drop-zone.filled').forEach(_makeZoneRemovable);
  }

  function _makeZoneRemovable(zone) {
    zone.style.cursor = 'pointer';
    zone.onclick = () => _removeWordFromZone(zone);
  }

  function _createFillWordChip(word, holeId) {
    const chip = document.createElement('span');
    chip.className = 'fill-word-chip';
    chip.setAttribute('data-word', word);
    if (holeId != null) {
      chip.setAttribute('data-hole-id', String(holeId));
    }
    chip.setAttribute('draggable', 'true');
    chip.setAttribute('ondragstart', `FillActivity.dragWordStart(event, '${word.replace(/'/g, "\\'")}')`);
    chip.setAttribute('ondblclick', `FillActivity.editWordChip(this)`);
    chip.textContent = word;
    return chip;
  }

  function _addWordChipToBank(word, holeId) {
    const bank = document.getElementById('fill-word-bank');
    if (!bank) return;
    bank.appendChild(_createFillWordChip(word, holeId));
  }

  function _removeWordFromZone(zone) {
    const word = zone.getAttribute('data-placed');
    if (!word) return;
    const holeId = Number(zone.getAttribute('data-hole-id'));
    _addWordChipToBank(word, holeId);

    zone.textContent = '_____';
    zone.classList.remove('filled');
    zone.removeAttribute('data-placed');
    zone.style.cursor = 'default';
    zone.onclick = null;

    _broadcastFill('fillWordRemoved', { holeId });
  }

  function closeCorrectionModal() {
    if (!_fillCorrectionValidated) {
      validateCorrection();
    }
    const modal = document.getElementById('fill-correction-modal');
    if (modal) modal.style.display = 'none';
    // Afficher les scores
    _showFillScores();
  }

  function _renderCorrectionText() {
    const container = document.getElementById('fill-correction-text');
    if (!container || !_currentActivity) return;
    const { segments, holes, level } = _currentActivity;
    let html = '';
    segments.forEach((seg, i) => {
      html += seg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
      if (i < holes.length) {
        const hole = holes[i];
        if (level === 1) {
          html += `<span class="fill-drop-zone" data-hole-id="${hole.id}" data-correct="${escHtml(hole.word)}"
            ondragover="event.preventDefault(); this.classList.add('over')"
            ondragleave="this.classList.remove('over')"
            ondrop="FillActivity.dropWord(event, ${hole.id})">${escHtml(hole.word.replace(/./g,'_'))}</span>`;
        } else {
          html += `<input type="text" class="fill-type-input" data-hole-id="${hole.id}"
            data-correct="${escHtml(hole.word)}"
            placeholder="${'_'.repeat(Math.min(hole.word.length, 8))}"
            oninput="FillActivity.typeWord(${hole.id}, this.value)">`;
        }
      }
    });
    container.innerHTML = html;
  }

  function _renderWordBank() {
    const bank = document.getElementById('fill-word-bank');
    if (!bank || !_currentActivity) return;
    if (_currentActivity.level !== 1) { bank.style.display = 'none'; return; }
    bank.style.display = '';
    // Mélanger les mots
    const words = [..._currentActivity.holes].sort(() => Math.random() - 0.5);
    bank.innerHTML = words.map(h =>
      `<span class="fill-word-chip" draggable="true" data-word="${escHtml(h.word)}" data-hole-id="${h.id}"
        ondragstart="FillActivity.dragWordStart(event, '${h.word.replace(/'/g,"\\'")}')"
        ondblclick="FillActivity.editWordChip(this)">
        ${escHtml(h.word)}
      </span>`
    ).join('');
  }

  function editWordChip(chip) {
    const holeId = Number(chip.getAttribute('data-hole-id'));
    const currentWord = chip.getAttribute('data-word');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentWord;
    input.className = 'fill-word-edit-input';
    input.style.width = Math.max(chip.offsetWidth, 50) + 'px';
    input.onblur = () => saveWordEdit(input, chip, holeId);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') saveWordEdit(input, chip, holeId);
      else if (e.key === 'Escape') cancelWordEdit(input, chip, currentWord);
    };
    chip.parentNode.replaceChild(input, chip);
    input.focus();
    input.select();
  }

  function saveWordEdit(input, originalChip, holeId) {
    const newWord = input.value.trim();
    if (!newWord) {
      cancelWordEdit(input, originalChip, originalChip.getAttribute('data-word'));
      return;
    }
    // Update the hole word
    const hole = _currentActivity.holes.find(h => h.id === holeId);
    if (hole) hole.word = newWord;
    // Update the chip
    originalChip.setAttribute('data-word', newWord);
    originalChip.setAttribute('ondragstart', `FillActivity.dragWordStart(event, '${newWord.replace(/'/g,"\\'")}')`);
    originalChip.textContent = newWord;
    // Replace back
    input.parentNode.replaceChild(originalChip, input);
    // Update any placed zone with this hole id
    const zone = document.querySelector(`#fill-correction-text .fill-drop-zone[data-hole-id="${holeId}"]`);
    if (zone && zone.classList.contains('filled')) {
      const placed = zone.getAttribute('data-placed');
      if (placed === originalChip.getAttribute('data-word')) {
        zone.setAttribute('data-placed', newWord);
        zone.textContent = newWord;
      }
    }
    zone.setAttribute('data-correct', newWord);
  }

  function cancelWordEdit(input, originalChip, originalWord) {
    input.parentNode.replaceChild(originalChip, input);
  }

  // ---- Drag & drop (niveau 1) ----
  function dragWordStart(event, word) {
    event.dataTransfer.setData('text/plain', word);
    event.dataTransfer.effectAllowed = 'move';
  }

  function dropWord(event, holeId) {
    event.preventDefault();
    const word = event.dataTransfer.getData('text/plain');
    const zone = event.currentTarget;
    if (!zone) return;
    zone.classList.remove('over');
    _placeWordInZone(holeId, word, zone);
    // Retirer le chip du bank
    const bank = document.getElementById('fill-word-bank');
    if (bank) {
      const chip = bank.querySelector(`[data-word="${escHtml(word)}"]`);
      if (chip) chip.remove();
    }
  }

  function _placeWordInZone(holeId, word, zone) {
    const previous = zone.getAttribute('data-placed');
    if (previous && previous !== word) {
      _addWordChipToBank(previous, holeId);
    }
    zone.textContent = word;
    zone.classList.add('filled');
    zone.setAttribute('data-placed', word);
    _makeZoneRemovable(zone);
    _broadcastFill('fillWordPlaced', { holeId, word });
  }

  // ---- Saisie (niveau 2) ----
  function typeWord(holeId, value) {
    _broadcastFill('fillWordTyped', { holeId, word: value });
  }

  // ---- Valider la correction ----
  function validateCorrection() {
    if (!_currentActivity) return;
    // Récupérer toutes les réponses placées par l'admin (les bonnes réponses)
    const correctAnswers = {}; // holeId -> word
    if (_currentActivity.level === 1) {
      document.querySelectorAll('#fill-correction-text .fill-drop-zone').forEach(zone => {
        const holeId = Number(zone.getAttribute('data-hole-id'));
        const placed = zone.getAttribute('data-placed') || '';
        correctAnswers[holeId] = placed;
      });
    } else {
      document.querySelectorAll('#fill-correction-text .fill-type-input').forEach(inp => {
        const holeId = Number(inp.getAttribute('data-hole-id'));
        correctAnswers[holeId] = inp.value.trim();
      });
    }
    // Calculer les scores de chaque joueur
    const scores = [];
    const allPlayers = document.querySelectorAll('#fill-player-list .fill-player-row');
    allPlayers.forEach(row => {
      const playerId = Number(row.getAttribute('data-player-id'));
      const playerAnswers = _fillPlayerAnswers[playerId] || [];
      const results = _currentActivity.holes.map(hole => {
        const playerAns = playerAnswers.find(a => a.holeId === hole.id);
        const playerWord = String(playerAns ? playerAns.word : '').trim().toLowerCase();
        const adminWord = String(correctAnswers[hole.id] || hole.word || '').trim().toLowerCase();
        return { holeId: hole.id, correct: playerWord === adminWord };
      });
      const correctCount = results.filter(r => r.correct).length;
      const totalHoles = _currentActivity.holes.length;
      const delta = correctCount * totalHoles > 0 ? Math.round(correctCount / totalHoles * 100) : 0;
      scores.push({ playerId, delta, correctCount, totalHoles, results });
    });
    const correctionPayload = {
      scores,
      correctAnswers,
      holes: _currentActivity.holes,
    };
    _broadcastFill('fillCorrectionEnd', correctionPayload);
    _lastFillCorrectionPayload = correctionPayload;
    _lastFillScores = scores;
    _fillCorrectionValidated = true;
    App.showToast('Correction envoyée aux joueurs ✓', 'success');
    const btn = document.getElementById('btn-fill-validate');
    if (btn) { btn.disabled = false; btn.textContent = '✅ Correction envoyée - cliquer pour renvoyer'; }
  }

  function _showFillScores() {
    if (_lastFillCorrectionPayload) {
      _broadcastFill('fillCorrectionEnd', _lastFillCorrectionPayload);
    }
    _renderAdminFinalScores();
    const submissionsPanel = document.getElementById('fill-submissions-panel');
    if (submissionsPanel) submissionsPanel.style.display = 'none';
    const scoresPanel = document.getElementById('fill-admin-results-panel');
    if (scoresPanel) scoresPanel.style.display = '';
    const stopBtn = document.getElementById('btn-fill-stop');
    const addTimeBtn = document.getElementById('btn-fill-add-time');
    if (stopBtn) stopBtn.disabled = true;
    if (addTimeBtn) addTimeBtn.disabled = true;
    if (!_lastFillScores) {
      App.showToast('Validez la correction pour afficher les scores.', 'error');
    }
  }

  function endFillGame() {
    clearInterval(_fillTimerInterval);
    if (_fillAdminSSE) { _fillAdminSSE.close(); _fillAdminSSE = null; }
    _fillGameStarted = false;
    App.state.gameCode = null;
    App.state.adminToken = null;
    _currentActivity = null;
    _fillPlayerAnswers = {};
    goToActivities();
  }

  return {
    showBuilderTab,
    setLevel,
    parseText,
    saveFillActivity,
    editFillActivity,
    setSavedFillSort,
    setSavedFillQuery,
    renderSavedFills,
    goToActivities,
    deleteFillActivity,
    launchFillActivity,
    startFillGame,
    stopTimer,
    addTime,
    openCorrectionModal,
    closeCorrectionModal,
    dragWordStart,
    dropWord,
    typeWord,
    validateCorrection,
    removePlayer,
    endFillGame,
  };
})();
