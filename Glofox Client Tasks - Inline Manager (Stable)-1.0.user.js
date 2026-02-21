// ==UserScript==
// @name         Glofox Client Tasks - Inline Manager (Stable)
// @namespace    https://glofox.com/
// @version      1.1.0
// @description  Dodaje przycisk Edytuj na kafelkach zadań klienta i otwiera modal do edycji (realny odczyt + mock zapisu)
// @author       You
// @match        *://*.glofox.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const SELECTORS = {
    list: '[data-testid="tasks-member-profile-list"]',
    card: '[data-testid^="tasks-member-list-element-"]',
    titleStrong: '[class*="taskTitle"] strong',
    details: '[class*="taskDetails"]',
    dueDateLabel: '[class*="dueDateFormat"]',
  };

  const LABELS = {
    edit: 'Edytuj',
    modalTitle: 'Edytuj zadanie',
    name: 'Nazwa zadania',
    notes: 'Notatka (uwagi zadania)',
    assignmentDate: 'Data przypisania zadania',
    cancel: 'Anuluj',
    save: 'Zapisz',
    saved: 'Zapisano (mock)',
    fallbackDom: 'Użyto danych lokalnych (brak rekordu API)',
  };

  const TASKS_PATH_RE = /^\/task-management-api\/v1\/locations\/([^/]+)\/tasks$/i;
  const TASKS_TEST_ID_PREFIX = 'tasks-member-list-element-';

  // Store trzyma WYŁĄCZNIE lokalne nadpisania z modala (mock zapisu).
  const localOverrides = new Map();
  const cardRuntimeIndex = new WeakMap();

  let nextCardIndex = 1;
  let observeTimer = null;
  let observer = null;

  let overlay;
  let form;
  let inputName;
  let inputNotes;
  let inputDate;
  let activeCtx = null;
  let restoreFocusEl = null;

  let apiContext = null;
  let tasksById = new Map();
  let tasksFetchInFlight = null;
  let lastFetchError = null;
  let apiRequestHeaders = {};

  function init() {
    installNetworkInterceptors();
    injectStyles();
    ensureModal();
    scanAndBind();
    startObserver();
  }

  function injectStyles() {
    if (document.getElementById('gcti-style')) return;

    const style = document.createElement('style');
    style.id = 'gcti-style';
    style.textContent = `
      .gcti-edit-btn-wrap { margin-top: 8px; }
      .gcti-edit-btn {
        border: 1px solid #4a3fcf;
        color: #4a3fcf;
        background: #fff;
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .gcti-edit-btn:hover { background: #f3f2ff; }

      .gcti-overlay {
        position: fixed;
        inset: 0;
        background: rgba(10, 14, 28, 0.45);
        z-index: 999999;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .gcti-overlay.gcti-open { display: flex; }

      .gcti-modal {
        width: min(560px, 96vw);
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 14px 34px rgba(0,0,0,0.24);
        padding: 16px;
      }
      .gcti-modal h3 { margin: 0 0 12px; font-size: 20px; }

      .gcti-field { margin: 0 0 12px; }
      .gcti-field label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; }
      .gcti-field input, .gcti-field textarea {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #c9ccda;
        border-radius: 8px;
        font-size: 14px;
        padding: 9px 10px;
      }
      .gcti-field textarea { resize: vertical; min-height: 96px; }
      .gcti-invalid { border-color: #e14545 !important; }

      .gcti-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
      .gcti-btn {
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
      }
      .gcti-btn-cancel { border: 1px solid #c9ccda; background: #fff; color: #2e325c; }
      .gcti-btn-save { border: 1px solid #4a3fcf; background: #4a3fcf; color: #fff; }

      body.gcti-modal-open { overflow: hidden; }

      .gcti-toast {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 999999;
        background: #1f2240;
        color: #fff;
        border-radius: 8px;
        padding: 9px 12px;
        font-size: 12px;
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 160ms ease, transform 160ms ease;
        pointer-events: none;
      }
      .gcti-toast.gcti-open { opacity: 1; transform: translateY(0); }
    `;

    document.head.appendChild(style);
  }

  function ensureModal() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.className = 'gcti-overlay';

    const modal = document.createElement('div');
    modal.className = 'gcti-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', LABELS.modalTitle);

    form = document.createElement('form');
    form.noValidate = true;

    const title = document.createElement('h3');
    title.textContent = LABELS.modalTitle;

    const nameField = createField(LABELS.name, 'text');
    inputName = nameField.input;
    inputName.required = true;

    const notesField = createField(LABELS.notes, 'textarea');
    inputNotes = notesField.input;

    const dateField = createField(LABELS.assignmentDate, 'date');
    inputDate = dateField.input;
    inputDate.required = true;

    const actions = document.createElement('div');
    actions.className = 'gcti-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'gcti-btn gcti-btn-cancel';
    cancelBtn.textContent = LABELS.cancel;

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'gcti-btn gcti-btn-save';
    saveBtn.textContent = LABELS.save;

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    form.appendChild(title);
    form.appendChild(nameField.wrapper);
    form.appendChild(notesField.wrapper);
    form.appendChild(dateField.wrapper);
    form.appendChild(actions);

    modal.appendChild(form);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) closeModal();
    });

    cancelBtn.addEventListener('click', closeModal);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && overlay.classList.contains('gcti-open')) closeModal();
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      saveFromModal();
    });
  }

  function createField(labelText, kind) {
    const wrapper = document.createElement('div');
    wrapper.className = 'gcti-field';

    const label = document.createElement('label');
    label.textContent = labelText;

    let input;
    if (kind === 'textarea') {
      input = document.createElement('textarea');
    } else {
      input = document.createElement('input');
      input.type = kind;
    }

    wrapper.appendChild(label);
    wrapper.appendChild(input);

    return { wrapper, input };
  }

  function installNetworkInterceptors() {
    installFetchInterceptor();
    installXhrInterceptor();
  }

  function installFetchInterceptor() {
    if (!window.fetch || window.fetch.__gctiPatched) return;

    const originalFetch = window.fetch;

    function patchedFetch(input, init) {
      const url = getFetchUrl(input);
      const method = getFetchMethod(input, init);
      let parsed = null;

      if (url) {
        parsed = parseTaskApiContext(url);
        if (parsed) {
          applyApiContext(parsed);
          if (method === 'GET') {
            mergeApiRequestHeaders(extractFetchHeaders(input, init));
          }
        }
      }

      const responsePromise = originalFetch.call(this, input, init);

      if (parsed && method === 'GET') {
        responsePromise
          .then(function (response) {
            if (!response || !response.ok) return;
            return response.clone().json().then(function (payload) {
              ingestTasksPayload(payload, parsed.contextKey);
            }).catch(function () {
              return null;
            });
          })
          .catch(function () {
            return null;
          });
      }

      return responsePromise;
    }

    patchedFetch.__gctiPatched = true;
    window.fetch = patchedFetch;
  }

  function installXhrInterceptor() {
    if (!window.XMLHttpRequest || window.XMLHttpRequest.__gctiPatched) return;

    const originalOpen = window.XMLHttpRequest.prototype.open;
    const originalSend = window.XMLHttpRequest.prototype.send;
    const originalSetRequestHeader = window.XMLHttpRequest.prototype.setRequestHeader;

    window.XMLHttpRequest.prototype.open = function (method, url) {
      this.__gctiMethod = String(method || 'GET').toUpperCase();
      this.__gctiApiMeta = typeof url === 'string' ? parseTaskApiContext(url) : null;

      if (this.__gctiApiMeta) {
        applyApiContext(this.__gctiApiMeta);
      }

      return originalOpen.apply(this, arguments);
    };

    window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (this.__gctiApiMeta && this.__gctiMethod === 'GET' && typeof name === 'string') {
        const key = name.toLowerCase();
        if (isReplaySafeHeader(key)) {
          apiRequestHeaders[key] = String(value || '');
        }
      }

      return originalSetRequestHeader.apply(this, arguments);
    };

    window.XMLHttpRequest.prototype.send = function () {
      if (this.__gctiApiMeta && this.__gctiMethod === 'GET') {
        const meta = this.__gctiApiMeta;
        this.addEventListener('loadend', function () {
          if (this.status < 200 || this.status >= 300) return;
          const body = this.responseType === '' || this.responseType === 'text'
            ? this.responseText
            : null;
          if (!body) return;

          try {
            const payload = JSON.parse(body);
            ingestTasksPayload(payload, meta.contextKey);
          } catch (error) {
            return;
          }
        });
      }

      return originalSend.apply(this, arguments);
    };

    window.XMLHttpRequest.__gctiPatched = true;
  }

  function getFetchUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return null;
  }

  function captureApiContextFromUrl(rawUrl) {
    const parsed = parseTaskApiContext(rawUrl);
    if (!parsed) return;
    applyApiContext(parsed);
  }

  function applyApiContext(parsed) {
    const currentKey = apiContext ? apiContext.contextKey : '';
    if (currentKey === parsed.contextKey) return;

    apiContext = parsed;
    tasksById = new Map();
    tasksFetchInFlight = null;
    lastFetchError = null;
    apiRequestHeaders = {};
  }

  function parseTaskApiContext(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, window.location.origin);
    } catch (error) {
      return null;
    }

    const pathMatch = url.pathname.match(TASKS_PATH_RE);
    if (!pathMatch) return null;

    const locationId = pathMatch[1];
    const customerId = url.searchParams.get('customer-id');
    if (!locationId || !customerId) return null;

    const endpointUrl = new URL(url.pathname, url.origin);
    endpointUrl.searchParams.set('customer-id', customerId);

    return {
      locationId,
      customerId,
      endpointUrl: endpointUrl.toString(),
      contextKey: locationId + '|' + customerId,
    };
  }

  function startObserver() {
    if (observer || !document.body) return;

    observer = new MutationObserver(function () {
      if (observeTimer) window.clearTimeout(observeTimer);
      observeTimer = window.setTimeout(scanAndBind, 150);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function scanAndBind() {
    const list = document.querySelector(SELECTORS.list);
    if (!list) return;

    const cards = Array.from(list.querySelectorAll(SELECTORS.card));
    cards.forEach(bindCard);
  }

  function bindCard(card) {
    if (!(card instanceof HTMLElement)) return;
    if (card.dataset.gctiBound === '1') return;

    const parts = extractCardParts(card);
    if (!parts.title || !parts.titleEl) return;

    const taskId = parseTaskIdFromCard(card);
    const key = taskId || buildTaskKey(parts, getRuntimeIndex(card));

    card.dataset.gctiBound = '1';
    card.dataset.gctiTaskKey = key;
    if (taskId) card.dataset.gctiTaskId = taskId;

    const wrap = document.createElement('div');
    wrap.className = 'gcti-edit-btn-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gcti-edit-btn';
    btn.textContent = LABELS.edit;

    btn.addEventListener('click', async function () {
      const currentParts = extractCardParts(card);
      const resolved = await resolveModalTaskData({ key, taskId, domParts: currentParts });

      activeCtx = {
        key,
        taskId,
        card,
        parts: currentParts,
      };

      openModal(resolved.task);

      if (resolved.usedFallback && resolved.reason !== 'no-api-context') {
        toast(LABELS.fallbackDom);
      }
    });

    wrap.appendChild(btn);
    const body = card.querySelector('.ant-card-body') || card;
    body.appendChild(wrap);
  }

  async function resolveModalTaskData(context) {
    const domData = {
      title: context.domParts.title || '',
      notes: context.domParts.notes || '',
      dueDate: context.domParts.dueDateIso || '',
      taskType: context.domParts.taskType || 'Zadanie - Do zrobienia',
    };

    let apiData = null;
    let reason = null;

    if (context.taskId) {
      const result = await getApiTaskById(context.taskId);
      reason = result.reason;
      apiData = result.task;
    } else {
      reason = 'no-task-id';
    }

    const fromApi = apiData ? mapApiTaskToModalData(apiData, domData) : null;
    const base = fromApi || domData;
    const override = localOverrides.get(context.key) || null;

    return {
      task: override ? Object.assign({}, base, override) : base,
      usedFallback: !fromApi,
      reason,
    };
  }

  async function getApiTaskById(taskId) {
    if (!taskId) return { task: null, reason: 'no-task-id' };
    if (!apiContext) return { task: null, reason: 'no-api-context' };
    if (tasksById.has(taskId)) return { task: tasksById.get(taskId), reason: null };

    const ok = await fetchTasksForCurrentContext();
    if (!ok) return { task: null, reason: 'fetch-error' };

    const task = tasksById.get(taskId) || null;
    if (!task) return { task: null, reason: 'not-found' };

    return { task, reason: null };
  }

  async function fetchTasksForCurrentContext(force) {
    if (!apiContext) return false;

    if (!force && tasksById.size > 0) return true;
    if (tasksFetchInFlight) return tasksFetchInFlight;

    tasksFetchInFlight = (async function () {
      try {
        const response = await window.fetch(apiContext.endpointUrl, {
          method: 'GET',
          credentials: 'include',
          headers: buildReplayHeaders(),
        });

        if (!response.ok) {
          lastFetchError = 'status-' + response.status;
          return false;
        }

        const payload = await response.json();
        ingestTasksPayload(payload, apiContext.contextKey);

        lastFetchError = null;
        return true;
      } catch (error) {
        lastFetchError = 'network-error';
        return false;
      } finally {
        tasksFetchInFlight = null;
      }
    })();

    return tasksFetchInFlight;
  }

  function mapApiTaskToModalData(apiTask, domFallback) {
    const dueDate = unixSecondsToIso(apiTask && apiTask.due_date);

    return {
      title: normalize((apiTask && apiTask.name) || domFallback.title || ''),
      notes: normalize((apiTask && apiTask.notes) || domFallback.notes || ''),
      dueDate: dueDate || domFallback.dueDate || '',
      taskType: normalize((apiTask && apiTask.type) || domFallback.taskType || ''),
    };
  }

  function parseTaskIdFromCard(card) {
    const testId = card.getAttribute('data-testid') || '';
    if (!testId.startsWith(TASKS_TEST_ID_PREFIX)) return null;

    const id = testId.slice(TASKS_TEST_ID_PREFIX.length).trim();
    return id || null;
  }

  function extractCardParts(card) {
    const titleEl = card.querySelector(SELECTORS.titleStrong);
    const title = normalize(titleEl ? titleEl.textContent : '');

    const detailsRoot = card.querySelector(SELECTORS.details) || card;
    const taskType = findTaskType(detailsRoot);
    const due = findDueDateParts(detailsRoot);

    return {
      title,
      titleEl,
      taskType,
      dueDateIso: due.iso,
      dueDateDisplay: due.display,
      dueNode: due.node,
      dueMatchedText: due.match,
      notes: '',
    };
  }

  function findTaskType(root) {
    const lines = Array.from(root.querySelectorAll('span.ant-typography, strong, div'));
    for (const el of lines) {
      const text = normalize(el.textContent);
      if (/^zadanie\s*-\s*/i.test(text)) return text;
    }
    return 'Zadanie - Do zrobienia';
  }

  function findDueDateParts(root) {
    const dueLabel = root.querySelector(SELECTORS.dueDateLabel);
    if (dueLabel) {
      const container = dueLabel.closest('.well--body, div') || dueLabel.parentElement || root;
      const strong = container.querySelector('strong');
      const raw = normalize(strong ? strong.textContent : '');
      if (raw) {
        return { iso: toIso(raw), display: raw, node: strong || container, match: raw };
      }
    }

    const strongFallback = root.querySelector('strong');
    const fallbackText = normalize(strongFallback ? strongFallback.textContent : '');
    if (fallbackText && /\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2}/.test(fallbackText)) {
      return { iso: toIso(fallbackText), display: fallbackText, node: strongFallback, match: fallbackText };
    }

    return { iso: '', display: '', node: null, match: '' };
  }

  function openModal(task) {
    restoreFocusEl = document.activeElement;

    inputName.value = task.title || '';
    inputNotes.value = task.notes || '';
    inputDate.value = task.dueDate || '';

    clearValidation();
    overlay.classList.add('gcti-open');
    document.body.classList.add('gcti-modal-open');

    window.setTimeout(function () {
      inputName.focus();
      inputName.select();
    }, 0);
  }

  function closeModal() {
    overlay.classList.remove('gcti-open');
    document.body.classList.remove('gcti-modal-open');
    activeCtx = null;

    if (restoreFocusEl && typeof restoreFocusEl.focus === 'function') {
      restoreFocusEl.focus();
    }
  }

  function saveFromModal() {
    if (!activeCtx) return;

    clearValidation();

    const title = inputName.value.trim();
    const notes = inputNotes.value.trim();
    const dueDate = inputDate.value;

    let invalid = false;
    if (!title) {
      inputName.classList.add('gcti-invalid');
      invalid = true;
    }
    if (!dueDate) {
      inputDate.classList.add('gcti-invalid');
      invalid = true;
    }
    if (invalid) return;

    const existing = localOverrides.get(activeCtx.key) || {};
    const updated = {
      title,
      notes,
      dueDate,
      taskType: existing.taskType || activeCtx.parts.taskType || 'Zadanie - Do zrobienia',
    };

    localOverrides.set(activeCtx.key, updated);
    applyToCard(activeCtx.card, updated, activeCtx.parts);

    closeModal();
    toast(LABELS.saved);
  }

  function applyToCard(card, task, knownParts) {
    const parts = knownParts || extractCardParts(card);

    if (parts.titleEl) {
      parts.titleEl.textContent = task.title;
    }

    const display = fromIso(task.dueDate);
    if (parts.dueNode) {
      const current = parts.dueNode.textContent || '';
      if (parts.dueMatchedText && current.includes(parts.dueMatchedText)) {
        parts.dueNode.textContent = current.replace(parts.dueMatchedText, display);
      } else {
        parts.dueNode.textContent = display;
      }
    }
  }

  function clearValidation() {
    inputName.classList.remove('gcti-invalid');
    inputDate.classList.remove('gcti-invalid');
  }

  function toast(message) {
    let node = document.getElementById('gcti-toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'gcti-toast';
      node.className = 'gcti-toast';
      document.body.appendChild(node);
    }

    node.textContent = message;
    node.classList.add('gcti-open');

    window.setTimeout(function () {
      node.classList.remove('gcti-open');
    }, 1600);
  }

  function buildTaskKey(parts, index) {
    return [parts.title, parts.taskType, parts.dueDateIso, index]
      .map(function (x) { return String(x || '').trim().toLowerCase(); })
      .join('|');
  }

  function getRuntimeIndex(card) {
    if (!cardRuntimeIndex.has(card)) {
      cardRuntimeIndex.set(card, nextCardIndex);
      nextCardIndex += 1;
    }
    return cardRuntimeIndex.get(card);
  }

  function toIso(text) {
    if (!text) return '';
    const value = text.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

    const m = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (!m) return '';

    const dd = String(parseInt(m[1], 10)).padStart(2, '0');
    const mm = String(parseInt(m[2], 10)).padStart(2, '0');
    let yyyy = m[3];
    if (yyyy.length === 2) yyyy = '20' + yyyy;

    return yyyy + '-' + mm + '-' + dd;
  }

  function fromIso(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
    const parts = iso.split('-');
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }

  function unixSecondsToIso(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
    const date = new Date(value * 1000);

    const yyyy = String(date.getUTCFullYear());
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');

    return yyyy + '-' + mm + '-' + dd;
  }

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function getFetchMethod(input, init) {
    if (init && typeof init.method === 'string') return init.method.toUpperCase();
    if (input && typeof input.method === 'string') return input.method.toUpperCase();
    return 'GET';
  }

  function extractFetchHeaders(input, init) {
    const merged = {};
    copyHeadersInto(merged, input && input.headers);
    copyHeadersInto(merged, init && init.headers);
    return merged;
  }

  function copyHeadersInto(target, headers) {
    if (!headers) return;
    if (headers instanceof Headers) {
      headers.forEach(function (value, key) {
        if (isReplaySafeHeader(key)) target[key.toLowerCase()] = String(value || '');
      });
      return;
    }
    if (Array.isArray(headers)) {
      headers.forEach(function (pair) {
        if (!pair || pair.length < 2) return;
        const key = String(pair[0] || '').toLowerCase();
        if (isReplaySafeHeader(key)) target[key] = String(pair[1] || '');
      });
      return;
    }
    if (typeof headers === 'object') {
      Object.keys(headers).forEach(function (rawKey) {
        const key = String(rawKey || '').toLowerCase();
        if (isReplaySafeHeader(key)) target[key] = String(headers[rawKey] || '');
      });
    }
  }

  function mergeApiRequestHeaders(nextHeaders) {
    Object.keys(nextHeaders || {}).forEach(function (key) {
      if (isReplaySafeHeader(key)) {
        apiRequestHeaders[key.toLowerCase()] = String(nextHeaders[key] || '');
      }
    });
  }

  function buildReplayHeaders() {
    const headers = { accept: 'application/json' };
    Object.keys(apiRequestHeaders || {}).forEach(function (key) {
      if (isReplaySafeHeader(key) && apiRequestHeaders[key]) {
        headers[key] = apiRequestHeaders[key];
      }
    });
    return headers;
  }

  function isReplaySafeHeader(name) {
    if (!name) return false;
    const key = String(name).toLowerCase();
    if (key === 'authorization' || key === 'accept-language') return true;
    if (key === 'content-type' || key === 'x-api-key') return true;
    return key.indexOf('x-') === 0;
  }

  function ingestTasksPayload(payload, contextKey) {
    if (!apiContext || apiContext.contextKey !== contextKey) return;

    const list = Array.isArray(payload && payload.data) ? payload.data : [];
    const next = new Map();
    list.forEach(function (task) {
      if (task && typeof task._id === 'string') {
        next.set(task._id, task);
      }
    });

    if (next.size > 0) {
      tasksById = next;
      lastFetchError = null;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
