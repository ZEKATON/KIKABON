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
  const fillBuilderState = {
    tokens: [],
    selectedWordIndexes: new Set(),
    bindingsReady: false,
  };

  function getQuestionTypeDisplay(type, question) {
    if (type === 'qcm') return 'QCM';
    if (type === 'fill') {
      const level = Number(question && question.difficulty) === 2 ? 'N2' : 'N1';
      return `Texte a trous ${level}`;
    }
    return 'Ouverte';
  }

  function parseFillQuestion(rawText, difficulty) {
    const source = String(rawText || '').trim();
    if (!source) return null;
    const regex = /\[([^\]]+)\]/g;
    const segments = [];
    const holes = [];
    let cursor = 0;
    let match;
    while ((match = regex.exec(source)) !== null) {
      segments.push(source.slice(cursor, match.index));
      holes.push(String(match[1] || '').trim());
      cursor = regex.lastIndex;
    }
    segments.push(source.slice(cursor));

    const validHoles = holes.filter(Boolean);
    if (validHoles.length === 0) return null;

    const maskedText = segments.reduce((acc, part, idx) => {
      const gap = idx < validHoles.length ? ' _____ ' : '';
      return acc + part + gap;
    }, '').replace(/\s+/g, ' ').trim();

    return {
      type: 'fill',
      sourceText: source,
      text: maskedText,
      segments,
      holes: validHoles.map((word, index) => ({ id: index, word })),
      difficulty: Number(difficulty) === 2 ? 2 : 1,
    };
  }

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
    if (tabId === 'tab-fill-builder') {
      ensureFillBuilderBindings();
      renderFillBuilderPreview();
    }
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
        <span class="q-type-badge">${getQuestionTypeDisplay(q.type, q)}</span>
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
    document.getElementById('modal-title').textContent = type === 'open'
      ? 'Nouvelle question ouverte'
      : 'Nouvelle question QCM';
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
    document.getElementById('modal-qcm-section').style.display = !isOpen ? 'block' : 'none';
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

  function tokenizeFillSourceText(rawText) {
    const text = String(rawText || '');
    const regex = /[A-Za-zÀ-ÖØ-öø-ÿ0-9'-]+/g;
    const tokens = [];
    let cursor = 0;
    let wordIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > cursor) {
        tokens.push({ type: 'text', value: text.slice(cursor, match.index) });
      }
      tokens.push({
        type: 'word',
        value: match[0],
        start: match.index,
        end: regex.lastIndex,
        wordIndex,
      });
      wordIndex += 1;
      cursor = regex.lastIndex;
    }
    if (cursor < text.length) {
      tokens.push({ type: 'text', value: text.slice(cursor) });
    }
    return tokens;
  }

  function renderFillBuilderPreview() {
    const textarea = document.getElementById('fill-builder-text');
    const preview = document.getElementById('fill-builder-preview');
    const selectedInfo = document.getElementById('fill-builder-selected');
    if (!textarea || !preview || !selectedInfo) return;

    const tokens = tokenizeFillSourceText(textarea.value);
    fillBuilderState.tokens = tokens;

    const validIndexes = new Set(tokens.filter(t => t.type === 'word').map(t => t.wordIndex));
    fillBuilderState.selectedWordIndexes = new Set(
      [...fillBuilderState.selectedWordIndexes].filter(idx => validIndexes.has(idx))
    );

    preview.innerHTML = '';
    if (tokens.length === 0) {
      preview.textContent = 'Aucun aperçu pour le moment.';
    } else {
      tokens.forEach(token => {
        if (token.type === 'text') {
          preview.appendChild(document.createTextNode(token.value));
          return;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fill-builder-word';
        btn.classList.toggle('is-selected', fillBuilderState.selectedWordIndexes.has(token.wordIndex));
        btn.textContent = token.value;
        btn.onclick = () => toggleFillBuilderWord(token.wordIndex);
        preview.appendChild(btn);
      });
    }

    const count = fillBuilderState.selectedWordIndexes.size;
    selectedInfo.textContent = `${count} mot${count > 1 ? 's' : ''} sélectionné${count > 1 ? 's' : ''}`;
  }

  function ensureFillBuilderBindings() {
    if (fillBuilderState.bindingsReady) return;
    const textarea = document.getElementById('fill-builder-text');
    if (!textarea) return;

    const rerender = () => renderFillBuilderPreview();
    textarea.addEventListener('input', rerender);
    textarea.addEventListener('keyup', rerender);
    textarea.addEventListener('click', rerender);
    textarea.addEventListener('select', rerender);

    fillBuilderState.bindingsReady = true;
  }

  function toggleFillBuilderWord(wordIndex) {
    if (fillBuilderState.selectedWordIndexes.has(wordIndex)) {
      fillBuilderState.selectedWordIndexes.delete(wordIndex);
    } else {
      fillBuilderState.selectedWordIndexes.add(wordIndex);
    }
    renderFillBuilderPreview();
  }

  function addFillSelectionFromSource() {
    const textarea = document.getElementById('fill-builder-text');
    if (!textarea) return;

    const start = Number(textarea.selectionStart);
    const end = Number(textarea.selectionEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
      App.showToast('Sélectionnez un ou plusieurs mots dans le texte source', 'error');
      return;
    }

    const sourceText = String(textarea.value || '');
    const tokens = tokenizeFillSourceText(sourceText);
    let added = 0;
    tokens.forEach(token => {
      if (token.type !== 'word') return;
      // Add words that overlap the selected range.
      const overlaps = token.start < end && token.end > start;
      if (!overlaps) return;
      if (!fillBuilderState.selectedWordIndexes.has(token.wordIndex)) {
        fillBuilderState.selectedWordIndexes.add(token.wordIndex);
        added += 1;
      }
    });

    renderFillBuilderPreview();
    if (added > 0) {
      App.showToast(`${added} mot(s) ajouté(s) aux trous`, 'success');
    } else {
      App.showToast('Aucun mot valide trouvé dans la sélection', 'error');
    }
  }

  function clearFillSelection() {
    fillBuilderState.selectedWordIndexes.clear();
    renderFillBuilderPreview();
    App.showToast('Sélection des trous réinitialisée', 'success');
  }

  function buildBracketedFillSourceText() {
    const sourceText = String((document.getElementById('fill-builder-text') || {}).value || '');
    const tokens = tokenizeFillSourceText(sourceText);
    const selected = fillBuilderState.selectedWordIndexes;
    return tokens.map(token => {
      if (token.type !== 'word') return token.value;
      return selected.has(token.wordIndex) ? `[${token.value}]` : token.value;
    }).join('');
  }

  function buildFillActivityQuestionFromBuilder() {
    const bracketed = buildBracketedFillSourceText();
    const difficultyEl = document.getElementById('fill-builder-difficulty');
    const difficulty = Number(difficultyEl ? difficultyEl.value : 1);
    const parsed = parseFillQuestion(bracketed, difficulty);
    if (!parsed) return null;
    return {
      id: Date.now(),
      ...parsed,
      category: 'Texte a trous',
    };
  }

  function exportFillActivityJson() {
    const q = buildFillActivityQuestionFromBuilder();
    if (!q) {
      App.showToast('Ajoutez du texte puis selectionnez des mots', 'error');
      return;
    }
    const payload = {
      type: 'fill-activity',
      name: `Texte a trous ${new Date().toLocaleDateString('fr-FR')}`,
      createdAt: new Date().toISOString(),
      question: q,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `texte_a_trous_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    App.showToast('Activite exportee en JSON', 'success');
  }

  function useFillActivity() {
    const q = buildFillActivityQuestionFromBuilder();
    if (!q) {
      App.showToast('Ajoutez du texte puis selectionnez des mots', 'error');
      return;
    }
    App.state.questions = [q];
    App.state.currentQuiz = {
      id: Date.now(),
      name: `Activite Texte a trous ${new Date().toLocaleDateString('fr-FR')}`,
      questions: [q],
      date: new Date().toLocaleDateString('fr-FR'),
      count: 1,
      gameCode: generateUniqueSavedQuizCode(null),
      moduleId: UNCLASSIFIED_MODULE_ID,
      activityType: 'fill',
    };
    App.updateTrackLength();
    renderQuestions();
    App.showToast('Activite prête. Vous pouvez lancer le jeu.', 'success');
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
        if (typeof Game !== 'undefined' && typeof Game.refreshAdminDashboard === 'function') {
          Game.refreshAdminDashboard();
        }
      }
    });

    adminSSE.addEventListener('playerAnswer', e => {
      const { playerId, answerIndices, answerIndex, answer, fillAnswers } = JSON.parse(e.data);
      const player = App.state.players.find(p => p.id === playerId);
      if (player && !player.answeredCurrentQuestion) {
        player.answeredCurrentQuestion = true;
        player.lastAnswerIndices = Array.isArray(answerIndices)
          ? answerIndices.filter(i => typeof i === 'number')
          : (typeof answerIndex === 'number' ? [answerIndex] : []);
        player.lastAnswerIndex = player.lastAnswerIndices.length > 0 ? player.lastAnswerIndices[0] : null;
        player.lastAnswer = answer;
        player.lastFillAnswers = Array.isArray(fillAnswers) ? fillAnswers.map(v => String(v || '')) : [];
        // Indicateur vert : le joueur a répondu
        const ind = document.getElementById(`indicator-${playerId}`);
        if (ind) { ind.className = 'answer-indicator answered'; ind.title = 'A répondu'; }
        if (typeof Game !== 'undefined' && typeof Game.refreshAdminDashboard === 'function') {
          Game.refreshAdminDashboard({ phase: 'question' });
        }
      }
    });

    adminSSE.addEventListener('game_reset_force', e => {
      const data = JSON.parse(e.data || '{}');
      App.state.players = [];
      Lobby.clearPlayers();
      const reason = data.reason === 'ended' ? 'fin de partie' : 'nouvelle session';
      App.showToast(`Liste des joueurs remise a zero (${reason})`, 'success');
    });

    adminSSE.addEventListener('fillCorrectionStep', e => {
      const data = JSON.parse(e.data || '{}');
      const updates = Array.isArray(data.scoreUpdates) ? data.scoreUpdates : [];
      updates.forEach(update => {
        const player = App.state.players.find(p => p.id === update.playerId);
        if (player && Number.isFinite(Number(update.score))) {
          player.score = Number(update.score);
        }
      });
      if (typeof Game !== 'undefined' && typeof Game.refreshAdminDashboard === 'function') {
        Game.refreshAdminDashboard({ phase: 'fill' });
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
    } catch {
      App.showToast('Erreur de connexion au serveur', 'error');
    }
  }

  return {
    showTab, renderQuestions, renderSaved,
    addQuestion, editQuestion, deleteQuestion, moveQuestion,
    saveQuestion, closeModal, updateModalType, setCorrect, toggleCorrectFromRow,
    renderFillBuilderPreview, toggleFillBuilderWord, addFillSelectionFromSource, clearFillSelection, exportFillActivityJson, useFillActivity,
    importFromText, importFromFile, importFromFileObj,
    saveQuiz, loadSavedQuiz, loadAndLaunchQuiz, downloadSavedQuiz, deleteSavedQuiz,
    createModule, renameModule, deleteModule, renameSavedQuiz, changeQuizModule,
    startNewQuiz,
    launchGame,
  };
})();
