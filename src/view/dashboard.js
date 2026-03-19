// Vista (Dashboard): se comunica exclusivamente con el Controlador mediante mensajes.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

// Utilidad simple: debounce para evitar refrescos excesivos
function debounce(fn, wait = 120) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// Forzar reflow/repaint para asegurar actualización visual inmediata
function forceReflow(node) {
  if (!node) return;
  void node.offsetWidth; // lectura de layout
  const prev = node.style.transform;
  node.style.transform = 'translateZ(0)';
  setTimeout(() => { node.style.transform = prev || ''; }, 0);
}

const state = {
  tabs: [],
  groups: [],
  sessions: {},
  history: [],
  rules: [],
  windows: [],
  // Árbol de historial/pestañas
  tree: { recentlyClosed: [], windows: [] },
  currentTreeTab: 'date',
  filter: '',
  groupFilter: '',
  treeFilter: '',
  debug: false,
  compactMode: false,
  verticalMode: new URLSearchParams(window.location.search).get('mode') === 'vertical',
  collapsedGroups: {},
  knownTabCounts: {},
  selectedTabs: new Set(),
  lastSelectedIndex: -1,
  settings: {
    autoUngroupOnStartup: true,
    suspendExclusions: [],
    autoGroupByDomainEnabled: false,
    autoGroupBySemanticEnabled: true,
    autoSuspendBySemanticCluster: false,
    autoGroupSemanticNotifications: true
  },
  // Filtros rápidos para productividad
  filterFlags: { currentWindow: false, pinned: false, audible: false, discarded: false },
  currentWindowId: null
};

// ============================================
// MENSAJERÍA
// ============================================
async function send(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (res) => resolve(res));
  });
}

// ============================================
// UTILIDADES
// ============================================
function favicon(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return `${u.protocol}//${u.hostname}/favicon.ico`;
    }
    return '';
  } catch { return ''; }
}

function sanitizeIconUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const allowed = ['http:', 'https:', 'chrome-extension:', 'data:', 'blob:'];
    return allowed.includes(u.protocol) ? url : '';
  } catch {
    const s = String(url || '');
    if (s.startsWith('data:') || s.startsWith('blob:')) return s;
    return '';
  }
}

function getDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname || 'otros';
  } catch { return 'otros'; }
}

function truncateUrl(url, maxLen = 40) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    const str = u.hostname + path;
    return str.length > maxLen ? str.substring(0, maxLen) + '…' : str;
  } catch { return url || ''; }
}

// ======================
// FORMATO DE FECHAS
// ======================
function toDateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDate(dayKey) {
  const now = new Date();
  const today = toDateKey(now.getTime());
  const yesterday = toDateKey(now.getTime() - 86400000);
  
  if (dayKey === today) return 'Hoy';
  if (dayKey === yesterday) return 'Ayer';
  
  // Convertir YYYY-MM-DD a DD/MM/YYYY
  const parts = dayKey.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dayKey;
}

function humanTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Fuzzy matching con distancia Levenshtein simplificada
function fuzzyMatch(text, query) {
  if (!query) return true;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t.includes(q)) return true;
  // Subsequence match
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function matchesFilter(tab) {
  if (!state.filter) return true;
  return fuzzyMatch(tab.title || '', state.filter) || fuzzyMatch(tab.url || '', state.filter);
}

function matchesTabFlags(tab) {
  const f = state.filterFlags || {};
  // Ventana actual
  if (f.currentWindow && state.currentWindowId != null && tab.windowId !== state.currentWindowId) return false;
  // Fijadas
  if (f.pinned && !tab.pinned) return false;
  // Con audio
  if (f.audible && !tab.audible) return false;
  // Suspendidas (discarded)
  if (f.discarded && !tab.discarded) return false;
  return true;
}

function matchesGroupFilter(group) {
  if (!state.groupFilter) return true;
  const q = state.groupFilter.toLowerCase();
  if ((group.title || '').toLowerCase().includes(q)) return true;
  const groupTabs = state.tabs.filter(t => t.groupId === group.id);
  return groupTabs.some(t => fuzzyMatch(t.title || '', q) || fuzzyMatch(t.url || '', q));
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message, type = 'info') {
  const container = $('#toastContainer');
  if (!container) return;
  const icons = { success: '✓', error: '✗', info: 'ℹ', warning: '⚠' };
  const toast = el('div', `toast ${type}`);
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============================================
// STATE PERSISTENCE
// ============================================
async function loadPersistedState() {
  try {
    const data = await chrome.storage.local.get(['dashboardState']);
    const saved = data.dashboardState || {};
    if (saved.collapsedGroups) state.collapsedGroups = saved.collapsedGroups;
    if (saved.compactMode) {
      state.compactMode = saved.compactMode;
      document.body.classList.toggle('compact-mode', state.compactMode);
      updateCompactButton();
    }
    if (saved.knownTabCounts) state.knownTabCounts = saved.knownTabCounts;
  } catch { /* silenciar */ }
}

async function persistState() {
  try {
    await chrome.storage.local.set({
      dashboardState: {
        collapsedGroups: state.collapsedGroups,
        compactMode: state.compactMode,
        knownTabCounts: state.knownTabCounts
      }
    });
  } catch { /* silenciar */ }
}

// ============================================
// MULTI-SELECCIÓN
// ============================================
function updateMultiSelectBar() {
  const bar = $('#multiSelectBar');
  if (!bar) return;
  const count = state.selectedTabs.size;
  if (count > 0) {
    bar.classList.remove('hidden');
    $('#selectedCount').textContent = `${count} seleccionada${count !== 1 ? 's' : ''}`;
  } else {
    bar.classList.add('hidden');
  }
}

function toggleTabSelection(tabId, shiftKey = false, ctrlKey = false) {
  const visibleTabs = state.tabs.filter(matchesFilter);
  const currentIdx = visibleTabs.findIndex(t => t.id === tabId);

  if (shiftKey && state.lastSelectedIndex >= 0 && currentIdx >= 0) {
    const start = Math.min(state.lastSelectedIndex, currentIdx);
    const end = Math.max(state.lastSelectedIndex, currentIdx);
    for (let i = start; i <= end; i++) {
      state.selectedTabs.add(visibleTabs[i].id);
    }
  } else if (ctrlKey) {
    if (state.selectedTabs.has(tabId)) {
      state.selectedTabs.delete(tabId);
    } else {
      state.selectedTabs.add(tabId);
    }
  } else {
    if (state.selectedTabs.has(tabId) && state.selectedTabs.size === 1) {
      state.selectedTabs.clear();
    } else {
      state.selectedTabs.clear();
      state.selectedTabs.add(tabId);
    }
  }
  state.lastSelectedIndex = currentIdx;
  updateMultiSelectBar();
  renderTabs();
}

function selectAllTabs() {
  const visibleTabs = state.tabs.filter(matchesFilter);
  if (state.selectedTabs.size === visibleTabs.length) {
    state.selectedTabs.clear();
  } else {
    visibleTabs.forEach(t => state.selectedTabs.add(t.id));
  }
  updateMultiSelectBar();
  renderTabs();
}

// ============================================
// RENDER: PESTAÑAS
// ============================================
function renderTabs() {
  const cont = $('#tabsList');
  const countBadge = $('#tabCount');
  cont.innerHTML = '';

  const filtered = state.tabs.filter(t => matchesFilter(t) && matchesTabFlags(t));
  if (countBadge) countBadge.textContent = `${filtered.length} Pestañas`;

  if (filtered.length === 0) {
    const empty = el('div', 'empty-state');
    empty.innerHTML = '<span class="empty-icon">📭</span><span>No hay pestañas abiertas</span>';
    cont.appendChild(empty);
    return;
  }

  filtered.forEach(tab => {
    const card = el('div', 'preview-card');
    if (tab.active) card.classList.add('tab-active');
    if (state.selectedTabs.has(tab.id)) card.classList.add('tab-selected');
    card.draggable = true;
    card.dataset.tabId = tab.id;

    // Check if tab belongs to a group
    let group = null;
    if (tab.groupId && tab.groupId !== -1) {
      group = state.groups.find(g => g.id === tab.groupId);
      if (group && group.color) {
        card.style.borderTopColor = group.color;
      }
    }

    // Click para selección
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
      toggleTabSelection(tab.id, e.shiftKey, e.ctrlKey || e.metaKey);
    });

    // Header tipo mini-ventana
    const header = el('div', 'preview-header');
    const dots = el('div', 'window-dots');
    dots.innerHTML = '<span class="dot-close"></span><span class="dot-min"></span><span class="dot-max"></span>';
    header.appendChild(dots);

    const icon = el('img', 'preview-favicon');
    icon.src = sanitizeIconUrl(tab.favIconUrl) || favicon(tab.url);
    icon.onerror = () => { icon.style.display = 'none'; };
    header.appendChild(icon);

    const title = el('div', 'preview-title');
    title.textContent = tab.title || 'Sin título';
    header.appendChild(title);

    if (group) {
      const groupBadge = el('span', 'tab-group-badge');
      groupBadge.style.backgroundColor = group.color || 'grey';
      groupBadge.style.color = '#fff';
      groupBadge.style.fontSize = '0.65rem';
      groupBadge.style.padding = '2px 6px';
      groupBadge.style.borderRadius = '8px';
      groupBadge.style.marginLeft = '4px';
      groupBadge.textContent = group.title || 'Grupo';
      header.appendChild(groupBadge);
    }

    if (tab.active) {
      const indicator = el('span', 'tab-active-indicator');
      header.appendChild(indicator);
    }

    if (tab.discarded) {
      const memorySaver = el('span', 'tab-memory-saver');
      memorySaver.innerHTML = '🍃';
      memorySaver.title = 'Pestaña suspendida (Ahorro de memoria)';
      header.appendChild(memorySaver);
      card.classList.add('tab-discarded');
    }

    card.appendChild(header);

    // Content – URL preview
    const content = el('div', 'preview-content');
    const urlText = el('div', 'preview-url');
    urlText.textContent = truncateUrl(tab.url, 60);
    content.appendChild(urlText);
    card.appendChild(content);

    // Actions
    const actions = el('div', 'preview-actions');

    const goBtn = el('button', 'btn-primary');
    goBtn.textContent = 'Ir';
    goBtn.onclick = (e) => { e.stopPropagation(); chrome.tabs.update(tab.id, { active: true }); showToast('Navegando a pestaña', 'info'); };

    const tempBtn = el('button', 'btn-ghost');
    tempBtn.textContent = '⏲';
    tempBtn.title = 'Temporal';
    tempBtn.onclick = async (e) => {
      e.stopPropagation();
      const minutes = parseFloat(prompt('Minutos hasta cerrar automáticamente:', '10'));
      if (!isNaN(minutes) && minutes > 0) {
        const res = await send('SET_TEMP_TAB', { tabId: tab.id, minutes });
        showToast(res?.success ? `Pestaña expirará en ${minutes}m` : 'Error al configurar', res?.success ? 'success' : 'error');
      }
    };

    const closeBtn = el('button', 'btn-ghost');
    closeBtn.textContent = '×';
    closeBtn.title = 'Cerrar';
    closeBtn.onclick = async (e) => {
      e.stopPropagation();
      await send('ADD_TO_HISTORY', { tab });
      chrome.tabs.remove(tab.id);
      showToast('Pestaña cerrada', 'success');
    };

    actions.appendChild(goBtn);
    actions.appendChild(tempBtn);
    actions.appendChild(closeBtn);
    card.appendChild(actions);

    setupDragEvents(card);
    cont.appendChild(card);
    // Forzar repaint tras actualizar textos/íconos para evitar glitch hasta colapsar/expandir
    forceReflow(card);
  });
  forceReflow(cont);
}

// ============================================
// RENDER: GRUPOS
// ============================================
function renderGroups() {
  const cont = $('#groupsList');
  const countBadge = $('#groupCount');
  cont.innerHTML = '';

  const filtered = state.groups.filter(matchesGroupFilter);
  if (countBadge) countBadge.textContent = `${filtered.length} Grupos`;

  if (filtered.length === 0) {
    const empty = el('div', 'empty-state');
    empty.innerHTML = '<span class="empty-icon">📁</span><span>No hay grupos de pestañas</span>';
    cont.appendChild(empty);
    return;
  }

  filtered.forEach(g => {
    const groupTabs = state.tabs.filter(t => t.groupId === g.id);
    const isCollapsed = state.collapsedGroups[g.id] ?? g.collapsed;
    const prevCount = state.knownTabCounts[g.id];
    const hasUpdates = prevCount !== undefined && groupTabs.length !== prevCount;

    const card = el('div', 'preview-card group-card');
    if (isCollapsed) card.classList.add('collapsed-group');
    if (hasUpdates) card.classList.add('has-updates');
    card.style.borderTopColor = g.color || 'var(--accent-primary)';
    card.draggable = true;
    card.dataset.groupId = g.id;

    const header = el('div', 'preview-header');
    const indicator = el('span', 'group-indicator');
    indicator.style.backgroundColor = g.color || 'grey';
    indicator.style.color = g.color || 'grey';
    const name = el('div', 'preview-title');
    name.textContent = g.title || `Grupo ${g.id}`;
    const tabCountSpan = el('span', 'group-tab-count');
    tabCountSpan.textContent = `${groupTabs.length}`;
    header.appendChild(indicator);
    header.appendChild(name);
    header.appendChild(tabCountSpan);
    card.appendChild(header);

    const preview = el('div', 'group-tabs-preview');
    groupTabs.forEach(t => {
      const item = el('div', 'group-tab-item');
      const img = el('img');
      img.src = sanitizeIconUrl(t.favIconUrl) || favicon(t.url);
      img.onerror = () => { img.style.display = 'none'; };
      const span = el('span');
      span.textContent = t.title || 'Sin título';
      item.appendChild(img);
      item.appendChild(span);
      item.onclick = () => { chrome.tabs.update(t.id, { active: true }); showToast('Navegando a pestaña', 'info'); };
      preview.appendChild(item);
    });
    card.appendChild(preview);

    const actions = el('div', 'preview-actions');
    actions.style.opacity = '1';
    actions.style.transform = 'none';
    actions.style.position = 'static';
    actions.style.background = 'rgba(255,255,255,0.02)';
    actions.style.borderTop = '1px solid rgba(255,255,255,0.08)';

    const toggleBtn = el('button', `btn-toggle ${isCollapsed ? '' : 'active'}`);
    toggleBtn.innerHTML = `<span class="icon">${isCollapsed ? '▶' : '▼'}</span> ${isCollapsed ? 'Expandir' : 'Colapsar'}`;
    toggleBtn.onclick = async () => {
      const newCollapsed = !isCollapsed;
      try { await chrome.tabGroups.update(g.id, { collapsed: newCollapsed }); } catch {}
      state.collapsedGroups[g.id] = newCollapsed;
      await persistState();
      renderGroups();
      showToast(newCollapsed ? 'Grupo colapsado' : 'Grupo expandido', 'info');
    };

    const colorSelect = el('select', 'btn-ghost');
    ['grey','blue','red','yellow','green','pink','purple','cyan','orange'].forEach(c => {
      const o = el('option');
      o.value = c; o.textContent = c;
      if (c === g.color) o.selected = true;
      colorSelect.appendChild(o);
    });
    colorSelect.onchange = async () => {
      try { await chrome.tabGroups.update(g.id, { color: colorSelect.value }); showToast(`Color cambiado a ${colorSelect.value}`, 'success'); }
      catch { showToast('Error al cambiar color', 'error'); }
    };

    actions.appendChild(toggleBtn);
    actions.appendChild(colorSelect);
    card.appendChild(actions);

    state.knownTabCounts[g.id] = groupTabs.length;
    setupDragEvents(card);
    cont.appendChild(card);
  });

  persistState();
}

// ============================================
// RENDER: SESIONES
// ============================================
function renderSessions() {
  const cont = $('#sessionsList');
  cont.innerHTML = '';
  const sessions = Object.values(state.sessions);

  if (sessions.length === 0) {
    const empty = el('div', 'empty-state');
    empty.innerHTML = '<span class="empty-icon">💾</span><span>Sin sesiones guardadas</span>';
    cont.appendChild(empty);
    return;
  }

  sessions.forEach(s => {
    const item = el('div', 'list-item');
    const info = el('div', 'list-item-info');
    const projectTag = s.project ? ` · 📂 ${s.project}` : '';
    info.innerHTML = `<div class="list-item-title">${s.name}</div><div class="list-item-meta">${s.tabs?.length || 0} pestañas · ${new Date(s.createdAt).toLocaleString()}${projectTag}</div>`;

    const actions = el('div', 'controls');
    const restoreBtn = el('button', 'btn-icon');
    restoreBtn.textContent = '⟲';
    restoreBtn.title = 'Restaurar';
    restoreBtn.onclick = async () => {
      for (const t of s.tabs) await chrome.tabs.create({ url: t.url, active: false });
      showToast(`Sesión "${s.name}" restaurada`, 'success');
    };

    const delBtn = el('button', 'btn-icon');
    delBtn.textContent = '🗑';
    delBtn.title = 'Eliminar';
    delBtn.onclick = async () => {
      await send('DELETE_SESSION', { id: s.id });
      showToast(`Sesión "${s.name}" eliminada`, 'success');
      await loadData();
    };

    actions.appendChild(restoreBtn);
    actions.appendChild(delBtn);
    item.appendChild(info);
    item.appendChild(actions);
    cont.appendChild(item);
  });
}

// ============================================
// RENDER: REGLAS DE AUTO-AGRUPACIÓN
// ============================================
function renderRules() {
  const cont = $('#rulesList');
  if (!cont) return;
  cont.innerHTML = '';

  if (state.rules.length === 0) {
    const empty = el('div', 'empty-state');
    empty.innerHTML = '<span class="empty-icon">📝</span><span>Sin reglas configuradas</span>';
    cont.appendChild(empty);
    return;
  }

  state.rules.forEach(r => {
    const item = el('div', 'list-item rule-item');
    const colorDot = el('span', 'rule-color-dot');
    colorDot.style.backgroundColor = r.color || 'grey';

    const info = el('div', 'list-item-info');
    const patterns = Array.isArray(r.pattern) ? r.pattern.join(', ') : r.pattern;
    info.innerHTML = `<div class="list-item-title">${r.groupName}</div><div class="list-item-meta">${patterns}</div>`;

    const actions = el('div', 'controls');
    const editBtn = el('button', 'btn-icon');
    editBtn.textContent = '✏️';
    editBtn.title = 'Editar';
    editBtn.onclick = () => openRuleModal(r);

    const delBtn = el('button', 'btn-icon');
    delBtn.textContent = '🗑';
    delBtn.title = 'Eliminar';
    delBtn.onclick = async () => {
      await send('DELETE_AUTO_GROUP_RULE', { ruleId: r.id });
      showToast(`Regla "${r.groupName}" eliminada`, 'success');
      await loadRules();
    };

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    item.appendChild(colorDot);
    item.appendChild(info);
    item.appendChild(actions);
    cont.appendChild(item);
  });
}

function openRuleModal(rule = null) {
  const modal = $('#ruleModal');
  modal.classList.remove('hidden');
  if (rule) {
    $('#ruleModalTitle').textContent = 'Editar Regla';
    $('#ruleGroupName').value = rule.groupName;
    $('#rulePatterns').value = Array.isArray(rule.pattern) ? rule.pattern.join(', ') : rule.pattern;
    $('#ruleColor').value = rule.color || 'grey';
    $('#ruleEditId').value = rule.id;
  } else {
    $('#ruleModalTitle').textContent = 'Nueva Regla';
    $('#ruleGroupName').value = '';
    $('#rulePatterns').value = '';
    $('#ruleColor').value = 'grey';
    $('#ruleEditId').value = '';
  }
}

function closeRuleModal() {
  $('#ruleModal').classList.add('hidden');
}

async function saveRule() {
  const groupName = $('#ruleGroupName').value.trim();
  const patterns = $('#rulePatterns').value.split(',').map(p => p.trim()).filter(Boolean);
  const color = $('#ruleColor').value;
  const editId = $('#ruleEditId').value;

  if (!groupName || patterns.length === 0) {
    showToast('Nombre y patrones son obligatorios', 'error');
    return;
  }

  if (editId) {
    await send('UPDATE_AUTO_GROUP_RULE', { ruleId: parseInt(editId), updates: { groupName, pattern: patterns, color } });
    showToast('Regla actualizada', 'success');
  } else {
    await send('ADD_AUTO_GROUP_RULE', { rule: { groupName, pattern: patterns, color } });
    showToast('Regla creada', 'success');
  }

  closeRuleModal();
  await loadRules();
}

async function loadRules() {
  const res = await send('GET_AUTO_GROUP_RULES');
  state.rules = res?.data || [];
  renderRules();
}

// ============================================
// RENDER: VENTANAS
// ============================================
function renderWindows() {
  const cont = $('#windowsList');
  const badge = $('#windowCount');
  if (!cont) return;
  cont.innerHTML = '';

  if (badge) badge.textContent = `${state.windows.length} Ventanas`;

  state.windows.forEach((w, idx) => {
    const item = el('div', 'window-item');
    const header = el('div', 'window-item-header');
    header.innerHTML = `<span class="window-icon">🪟</span> <strong>Ventana ${idx + 1}</strong> <span class="window-tab-count">${w.tabs?.length || 0} pestañas</span>`;
    if (w.focused) header.innerHTML += ' <span class="window-focused-badge">Activa</span>';
    item.appendChild(header);

    const tabList = el('div', 'window-tabs-list');
    (w.tabs || []).slice(0, 5).forEach(t => {
      const tabItem = el('div', 'window-tab-item');
      const img = el('img');
      img.src = sanitizeIconUrl(t.favIconUrl) || favicon(t.url);
      img.onerror = () => { img.style.display = 'none'; };
      const span = el('span');
      span.textContent = t.title || 'Sin título';
      tabItem.appendChild(img);
      tabItem.appendChild(span);
      tabItem.onclick = () => { chrome.tabs.update(t.id, { active: true }); chrome.windows.update(w.id, { focused: true }); };
      tabList.appendChild(tabItem);
    });
    if ((w.tabs || []).length > 5) {
      const more = el('div', 'window-tab-more');
      more.textContent = `+${w.tabs.length - 5} más…`;
      tabList.appendChild(more);
    }
    item.appendChild(tabList);
    cont.appendChild(item);
  });
}

// ============================================
// MEMORY STATS
// ============================================
let memoryInterval = null;

async function updateMemoryStats() {
  const info = $('#memoryInfo');
  try {
    const res = await send('GET_MEMORY_INFO');
    if (!res?.success) throw new Error(res?.error || 'Error al obtener info de memoria');

    const { memory, tabCount, chromeMemory } = res.data || {};

    // Si la API del sistema no está disponible, usar una capacidad por defecto (8 GB)
    const capacity = memory?.capacity || (8 * 1024 ** 3);
    const available = memory?.availableCapacity;

    // Sistema (si está disponible)
    const totalGB = (capacity / (1024 ** 3)).toFixed(2);
    const sysUsedGB = memory ? ((capacity - (available || 0)) / (1024 ** 3)).toFixed(2) : '–';
    const sysUsedPct = memory ? ((((capacity - (available || 0)) / capacity) * 100).toFixed(1)) : '–';

    // Chrome (nativo o estimado)
    const chromeBytes = chromeMemory || 0;
    const chromeGB = (chromeBytes / (1024 ** 3)).toFixed(2);
    const chromePct = ((chromeBytes / capacity) * 100).toFixed(1);

    // Panel informativo
    if (info) {
      const sysLine = memory
        ? `Sistema total: ${sysUsedGB} GB / ${totalGB} GB (${sysUsedPct}%)`
        : `Info del sistema no disponible · escala basada en ${totalGB} GB`;
      info.innerHTML = `
        <div style="margin-bottom: 4px; color: var(--accent-neon);">Chrome RAM: <strong>${chromeGB} GB</strong> (${chromePct}%)</div>
        <div style="font-size: 0.75rem; color: var(--text-dim); margin-bottom: 8px;">${sysLine}</div>
        <div>Pestañas abiertas: <strong>${tabCount || 0}</strong></div>
      `;
    }
  } catch (err) {
    if (info) info.innerHTML = `<div style="color:var(--danger)">${err.message}</div>`;
    console.error('[TabFlo][MEM]', err);
  }
}

// ============================================
// DRAG & DROP
// ============================================
let draggedElement = null;

function setupDragEvents(card) {
  card.addEventListener('dragstart', (e) => {
    draggedElement = card;
    card.classList.add('dragging');
    card.closest('.preview-grid')?.classList.add('drag-active');
    e.dataTransfer.effectAllowed = 'move';
    const tabId = card.dataset.tabId || '';
    // Si hay multi-selección, pasar todos los IDs
    if (state.selectedTabs.size > 0 && tabId && state.selectedTabs.has(parseInt(tabId))) {
      e.dataTransfer.setData('text/plain', JSON.stringify([...state.selectedTabs]));
    } else {
      e.dataTransfer.setData('text/plain', tabId || card.dataset.groupId || '');
    }
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    card.closest('.preview-grid')?.classList.remove('drag-active');
    $$('.drag-over').forEach(el => el.classList.remove('drag-over'));
    draggedElement = null;
  });

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('drag-over');
  });

  card.addEventListener('dragleave', () => { card.classList.remove('drag-over'); });

  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    if (!draggedElement || draggedElement === card) return;

    const parent = card.parentNode;
    const cards = [...parent.children];
    const fromIdx = cards.indexOf(draggedElement);
    const toIdx = cards.indexOf(card);

    if (fromIdx < toIdx) {
      parent.insertBefore(draggedElement, card.nextSibling);
    } else {
      parent.insertBefore(draggedElement, card);
    }
    showToast('Elemento reorganizado', 'info');
  });
}

// ============================================
// DEBUG / DIAGNOSTICS
// ============================================
async function loadDebug() {
  const res = await send('GET_DEBUG');
  state.debug = !!res?.data?.debug;
  const toggle = document.getElementById('debugToggle');
  if (toggle) toggle.checked = state.debug;
}

function printDiagnostics(report) {
  const summary = document.getElementById('diagnostics-summary');
  if (summary) summary.textContent = report ? (report.ok ? 'Diagnóstico: OK ✅' : 'Diagnóstico: FALLO ❌') : '';
  if (state.debug && report) console.log('[TabFlo][DIAG]', report);
}

// ============================================
// COMPACT MODE
// ============================================
function updateCompactButton() {
  const btn = $('#compactModeBtn');
  if (!btn) return;
  btn.classList.toggle('active', state.compactMode);
  btn.querySelector('span:last-child').textContent = state.compactMode ? 'Expandido' : 'Compacto';
}

function toggleCompactMode() {
  state.compactMode = !state.compactMode;
  document.body.classList.toggle('compact-mode', state.compactMode);
  updateCompactButton();
  persistState();
  showToast(state.compactMode ? 'Modo compacto activado' : 'Modo expandido activado', 'info');
}

// ============================================
// VERTICAL MODE
// ============================================
function applyVerticalMode() {
  if (state.verticalMode) {
    document.body.classList.add('vertical-mode');
    // Auto-enfocar búsqueda para rapidez en vertical
    setTimeout(() => { $('#searchInput')?.focus(); }, 150);
  }
}

// ============================================
// KEYBOARD SHORTCUTS (corregidos: usan Alt en vez de Ctrl)
// ============================================
function toggleShortcutsPanel() {
  const panel = $('#shortcutsPanel');
  if (panel) panel.classList.toggle('visible');
}

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
      if (e.key === 'Escape') e.target.blur();
      if (!e.altKey) return;
    }

    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      e.preventDefault();
      toggleShortcutsPanel();
    }

    // Alt+F - Buscar
    if (e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('#searchInput')?.focus();
    }

    // Alt+V - Vista vertical
    if (e.altKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      const availH = (screen?.availHeight || 800);
      const height = Math.max(500, Math.min(availH - 40, availH));
      const top = Math.max(0, Math.round((availH - height) / 2));
      const width = 360;
      chrome.windows.create({
        url: chrome.runtime.getURL('src/view/dashboard.html') + '?mode=vertical',
        type: 'popup',
        width,
        height,
        left: 0,
        top
      });
    }

    // Alt+M - Modo compacto
    if (e.altKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      toggleCompactMode();
    }

    // Alt+S - Guardar sesión (soporta Alt+S y Alt+Shift+S)
    if (e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      $('#saveSessionBtn')?.click();
    }

    // Alt+R - Recargar
    if (e.altKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      loadData();
      showToast('Datos recargados', 'info');
    }

    // Alt+A - Seleccionar todo
    if (e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAllTabs();
    }

    // Escape - Cerrar paneles
    if (e.key === 'Escape') {
      const settingsDropdown = $('#settingsDropdown');
      if (settingsDropdown && !settingsDropdown.classList.contains('hidden')) {
        settingsDropdown.classList.add('hidden');
        $('#settingsBtn')?.classList.remove('active');
      }

      const panel = $('#shortcutsPanel');
      if (panel?.classList.contains('visible')) panel.classList.remove('visible');
      const ruleModal = $('#ruleModal');
      if (!ruleModal.classList.contains('hidden')) closeRuleModal();
      const windowModal = $('#windowModal');
      if (!windowModal.classList.contains('hidden')) windowModal.classList.add('hidden');
      // Cerrar menú lateral (vertical)
      if (document.body.classList.contains('sidebar-open')) {
        document.body.classList.remove('sidebar-open');
      }
      if (state.selectedTabs.size > 0) {
        state.selectedTabs.clear();
        updateMultiSelectBar();
        renderTabs();
      }
    }

    // Delete - Cerrar seleccionadas
    if (e.key === 'Delete' && state.selectedTabs.size > 0) {
      e.preventDefault();
      send('CLOSE_TABS', { tabIds: [...state.selectedTabs] }).then(() => {
        showToast(`${state.selectedTabs.size} pestañas cerradas`, 'success');
        state.selectedTabs.clear();
        updateMultiSelectBar();
        loadData();
      });
    }
  });
}

// ============================================
// FILE DOWNLOAD/UPLOAD HELPERS
// ============================================
function downloadJSON(data, filename) {
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

// ============================================
// DATA LOADING
// ============================================
async function loadData() {
  const [tabsRes, groupsRes, historyRes, windowsRes] = await Promise.all([
    send('GET_TABS'),
    send('GET_GROUPS'),
    send('GET_HISTORY'),
    send('GET_WINDOWS')
  ]);
  state.tabs = tabsRes?.data || [];
  state.groups = groupsRes?.data || [];
  state.history = historyRes?.data || [];
  state.windows = windowsRes?.data || [];
  state.bookmarks = (await chrome.bookmarks.getTree())[0]?.children || [];
  state.sessions = (await chrome.storage.local.get(['sessions'])).sessions || {};
  // Ventana actual para filtros rápidos
  const focused = state.windows.find(w => w.focused);
  state.currentWindowId = focused?.id ?? (state.windows[0]?.id ?? null);

  await loadDebug();
  await loadRules();
  await loadSettings();
  renderGroups();
  renderTabs();
  renderSessions();
  renderWindows();
  renderBookmarks();
  await loadTreeData();
  renderTree();
  updateMultiSelectBar();
}

// ============================================
// UI BINDINGS
// ============================================
function bindUI() {
  // Header controls
  const settingsBtn = $('#settingsBtn');
  const settingsDropdown = $('#settingsDropdown');
  if (settingsBtn && settingsDropdown) {
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settingsDropdown.classList.toggle('hidden');
      settingsBtn.classList.toggle('active');
    });

    // Cerrar al hacer clic fuera
    document.addEventListener('click', (e) => {
      if (!settingsDropdown.classList.contains('hidden') && !settingsDropdown.contains(e.target) && e.target !== settingsBtn) {
        settingsDropdown.classList.add('hidden');
        settingsBtn.classList.remove('active');
      }
    });
  }

  $('#searchInput').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderTabs();
  });

  const selectAllBtn = $('#selectAllBtn');
  if (selectAllBtn) selectAllBtn.addEventListener('click', selectAllTabs);

  const groupByDomainBtn = $('#groupByDomainBtn');
  if (groupByDomainBtn) {
    groupByDomainBtn.addEventListener('click', async () => {
      showToast('Agrupando por dominio...', 'info');
      const res = await send('GROUP_BY_DOMAIN');
      if (res?.success) { showToast('Pestañas agrupadas por dominio', 'success'); await loadData(); }
      else showToast('Error al agrupar', 'error');
    });
  }

  const clearAllGroupsBtn = $('#clearAllGroupsBtn');
  const clearAllGroupsBtnHeader = $('#clearAllGroupsBtnHeader');
  const handleClearGroups = async () => {
    if (confirm('¿Desagrupar todas las pestañas de todas las ventanas?')) {
      showToast('Desagrupando...', 'info');
      const res = await send('UNGROUP_ALL');
      if (res?.success) { showToast('Pestañas desagrupadas', 'success'); await loadData(); }
      else showToast('Error al desagrupar', 'error');
    }
  };
  if (clearAllGroupsBtn) clearAllGroupsBtn.addEventListener('click', handleClearGroups);
  if (clearAllGroupsBtnHeader) clearAllGroupsBtnHeader.addEventListener('click', handleClearGroups);

  const closeDuplicatesBtn = $('#closeDuplicatesBtn');
  if (closeDuplicatesBtn) {
    closeDuplicatesBtn.addEventListener('click', async () => {
      showToast('Buscando duplicadas...', 'info');
      const res = await send('CLOSE_DUPLICATES');
      if (res?.success) { showToast(`${res.data.closed} duplicadas cerradas`, 'success'); await loadData(); }
      else showToast('Error al cerrar duplicadas', 'error');
    });
  }

  const suspendInactiveBtn = $('#suspendInactiveBtn');
  if (suspendInactiveBtn) {
    suspendInactiveBtn.addEventListener('click', async () => {
      showToast('Suspendiendo pestañas inactivas...', 'info');
      const res = await send('SUSPEND_INACTIVE');
      if (res?.success) { showToast(`${res.data.suspended} pestañas suspendidas`, 'success'); await loadData(); }
      else showToast('Error al suspender pestañas', 'error');
    });
  }

  const muteOthersBtn = $('#muteOthersBtn');
  if (muteOthersBtn) {
    muteOthersBtn.addEventListener('click', async () => {
      const res = await send('MUTE_OTHERS');
      if (res?.success) showToast(`Silenciadas ${res.data.muted} pestañas en esta ventana`, 'success');
    });
  }

  // Bookmarks
  const bookmarksRefreshBtn = $('#bookmarksRefreshBtn');
  if (bookmarksRefreshBtn) {
    bookmarksRefreshBtn.addEventListener('click', async () => {
      showToast('Actualizando marcadores...', 'info');
      await loadData();
    });
  }

  const bookmarksSortBtn = $('#bookmarksSortBtn');
  if (bookmarksSortBtn) {
    bookmarksSortBtn.addEventListener('click', async () => {
      if (confirm('¿Quieres auto-ordenar todos tus marcadores alfabéticamente? (Carpetas primero, luego archivos)')) {
        showToast('Ordenando marcadores...', 'info');
        await sortBookmarksRecursive('0');
        showToast('Marcadores ordenados', 'success');
        await loadData();
      }
    });
  }

  const bookmarksGroupBtn = $('#bookmarksGroupBtn');
  if (bookmarksGroupBtn) {
    bookmarksGroupBtn.addEventListener('click', async () => {
      if (confirm('¿Quieres agrupar tus marcadores automáticamente por tema y dominio? Se crearán carpetas nuevas.')) {
        showToast('Analizando y agrupando marcadores...', 'info');
        const res = await send('AUTO_GROUP_BOOKMARKS');
        if (res?.success) {
          showToast('Marcadores agrupados con éxito', 'success');
          await loadData();
        } else {
          showToast('Error: ' + (res?.error || 'Fallo desconocido'), 'error');
        }
      }
    });
  }

  const groupSearch = $('#groupSearchInput');
  if (groupSearch) groupSearch.addEventListener('input', (e) => { state.groupFilter = e.target.value; renderGroups(); });

  // Guardar sesión con proyecto
  $('#saveSessionBtn').addEventListener('click', async () => {
    const name = prompt('Nombre de la sesión:', `Sesión ${new Date().toLocaleString()}`);
    if (!name) return;
    const project = prompt('Proyecto (opcional):', '');
    const tabs = state.tabs.map(t => ({ url: t.url, title: t.title, favIconUrl: t.favIconUrl, windowId: t.windowId, groupId: t.groupId }));
    const res = await send('SAVE_SESSION', { name, tabs, project: project || '' });
    if (res?.success) { showToast(`Sesión "${name}" guardada`, 'success'); await loadData(); }
    else showToast('Error al guardar sesión', 'error');
  });

  // Export/Import sesiones
  $('#exportSessionsBtn')?.addEventListener('click', async () => {
    const res = await send('EXPORT_SESSIONS');
    if (res?.success) { downloadJSON(res.data, `sesiones_backup_${new Date().toISOString().slice(0,10)}.json`); showToast('Sesiones exportadas', 'success'); }
  });

  $('#importSessionsBtn')?.addEventListener('click', () => $('#importSessionsFile').click());
  $('#importSessionsFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      await send('IMPORT_SESSIONS', { json: text });
      showToast('Sesiones importadas', 'success');
      await loadData();
    } catch (err) { showToast('Error al importar: ' + err.message, 'error'); }
    e.target.value = '';
  });

  // Reglas CRUD
  $('#addRuleBtn')?.addEventListener('click', () => openRuleModal());
  $('#ruleModalSave')?.addEventListener('click', saveRule);
  $('#ruleModalCancel')?.addEventListener('click', closeRuleModal);

  // Export/Import/Reset reglas
  $('#exportRulesBtn')?.addEventListener('click', async () => {
    const res = await send('EXPORT_RULES');
    if (res?.success) { downloadJSON(res.data, `reglas_autogroup_${new Date().toISOString().slice(0,10)}.json`); showToast('Reglas exportadas', 'success'); }
  });

  $('#importRulesBtn')?.addEventListener('click', () => $('#importRulesFile').click());
  $('#importRulesFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      await send('IMPORT_RULES', { json: text });
      showToast('Reglas importadas', 'success');
      await loadRules();
    } catch (err) { showToast('Error al importar: ' + err.message, 'error'); }
    e.target.value = '';
  });

  $('#resetRulesBtn')?.addEventListener('click', async () => {
    if (confirm('¿Restaurar reglas por defecto? Se perderán las reglas actuales.')) {
      await send('RESET_RULES');
      showToast('Reglas restauradas a valores por defecto', 'success');
      await loadRules();
    }
  });

  // Compacto y shortcuts
  $('#compactModeBtn')?.addEventListener('click', toggleCompactMode);
  $('#shortcutsBtn')?.addEventListener('click', toggleShortcutsPanel);

  // Vista vertical
  $('#verticalViewBtn')?.addEventListener('click', () => {
    const availH = (screen?.availHeight || 800);
    const height = Math.max(500, Math.min(availH - 40, availH));
    const top = Math.max(0, Math.round((availH - height) / 2));
    const width = 360;
    chrome.windows.create({
      url: chrome.runtime.getURL('src/view/dashboard.html') + '?mode=vertical',
      type: 'popup',
      width,
      height,
      left: 0,
      top
    });
  });

  // Multi-selección acciones
  $('#multiMoveBtn')?.addEventListener('click', openWindowModal);
  $('#multiNewWindowBtn')?.addEventListener('click', async () => {
    if (state.selectedTabs.size === 0) return;
    await send('MOVE_TABS_TO_NEW_WINDOW', { tabIds: [...state.selectedTabs] });
    state.selectedTabs.clear();
    updateMultiSelectBar();
    showToast('Pestañas movidas a nueva ventana', 'success');
    await loadData();
  });
  $('#multiGroupBtn')?.addEventListener('click', async () => {
    if (state.selectedTabs.size === 0) return;
    const name = prompt('Nombre del grupo:', 'Nuevo Grupo');
    if (!name) return;
    await send('GROUP_TABS', { tabIds: [...state.selectedTabs], groupName: name, color: 'blue' });
    state.selectedTabs.clear();
    updateMultiSelectBar();
    showToast('Pestañas agrupadas', 'success');
    await loadData();
  });
  $('#multiPinBtn')?.addEventListener('click', async () => {
    if (state.selectedTabs.size === 0) return;
    const res = await send('PIN_TABS', { tabIds: [...state.selectedTabs] });
    showToast(`${res?.data?.pinned || 0} pestañas fijadas`, res?.success ? 'success' : 'error');
    state.selectedTabs.clear();
    updateMultiSelectBar();
    await loadData();
  });
  $('#multiUnpinBtn')?.addEventListener('click', async () => {
    if (state.selectedTabs.size === 0) return;
    const res = await send('UNPIN_TABS', { tabIds: [...state.selectedTabs] });
    showToast(`${res?.data?.unpinned || 0} pestañas desfijadas`, res?.success ? 'success' : 'error');
    state.selectedTabs.clear();
    updateMultiSelectBar();
    await loadData();
  });
  $('#multiCloseBtn')?.addEventListener('click', async () => {
    if (state.selectedTabs.size === 0) return;
    await send('CLOSE_TABS', { tabIds: [...state.selectedTabs] });
    showToast(`${state.selectedTabs.size} pestañas cerradas`, 'success');
    state.selectedTabs.clear();
    updateMultiSelectBar();
    await loadData();
  });
  $('#multiClearBtn')?.addEventListener('click', () => {
    state.selectedTabs.clear();
    updateMultiSelectBar();
    renderTabs();
  });

  // Window modal
  $('#windowModalCancel')?.addEventListener('click', () => $('#windowModal').classList.add('hidden'));

  // Debug
  const debugToggle = document.getElementById('debugToggle');
  if (debugToggle) {
    debugToggle.addEventListener('change', async () => {
      const res = await send('SET_DEBUG', { enabled: debugToggle.checked });
      state.debug = !!res?.data?.debug;
      showToast(state.debug ? 'Modo DEBUG activado' : 'Modo DEBUG desactivado', state.debug ? 'warning' : 'info');
    });
  }

  const diagBtn = document.getElementById('runDiagnostics');
  if (diagBtn) {
    diagBtn.addEventListener('click', async () => {
      showToast('Ejecutando diagnósticos…', 'info');
      const res = await send('RUN_DIAGNOSTICS');
      printDiagnostics(res?.data);
      showToast(res?.data?.ok ? 'Diagnósticos: OK ✅' : 'Diagnósticos: FALLO ❌', res?.data?.ok ? 'success' : 'error');
    });
  }

  // Settings: Auto desagrupar al iniciar
  const autoUngroupToggle = document.getElementById('autoUngroupToggle');
  if (autoUngroupToggle) {
    autoUngroupToggle.addEventListener('change', async () => {
      const updated = await send('SET_SETTINGS_PARTIAL', { partial: { autoUngroupOnStartup: autoUngroupToggle.checked } });
      state.settings = updated?.data || state.settings;
      showToast(state.settings.autoUngroupOnStartup ? 'Se eliminarán los grupos al iniciar' : 'Se conservarán los grupos al iniciar', 'info');
    });
  }

  // Settings: Auto agrupar por dominio/categoría
  const autoGroupDomainToggle = document.getElementById('autoGroupDomainToggle');
  if (autoGroupDomainToggle) {
    autoGroupDomainToggle.addEventListener('change', async () => {
      const updated = await send('SET_SETTINGS_PARTIAL', { partial: { autoGroupByDomainEnabled: autoGroupDomainToggle.checked } });
      state.settings = updated?.data || state.settings;
      showToast(state.settings.autoGroupByDomainEnabled ? 'Auto-agrupación por dominio activada' : 'Auto-agrupación por dominio desactivada', 'info');
    });
  }

  // Settings: Auto agrupar por tema/proyecto
  const autoGroupSemanticToggle = document.getElementById('autoGroupSemanticToggle');
  if (autoGroupSemanticToggle) {
    autoGroupSemanticToggle.addEventListener('change', async () => {
      const updated = await send('SET_SETTINGS_PARTIAL', { partial: { autoGroupBySemanticEnabled: autoGroupSemanticToggle.checked } });
      state.settings = updated?.data || state.settings;
      showToast(state.settings.autoGroupBySemanticEnabled ? 'Auto-agrupación semántica activada' : 'Auto-agrupación semántica desactivada', 'info');
      if (autoGroupSemanticToggle.checked) {
        await send('AUTO_GROUP_SEMANTIC_NOW');
      }
    });
  }

  // Settings: Suspender por cluster
  const autoSuspendSemanticToggle = document.getElementById('autoSuspendSemanticToggle');
  if (autoSuspendSemanticToggle) {
    autoSuspendSemanticToggle.addEventListener('change', async () => {
      const updated = await send('SET_SETTINGS_PARTIAL', { partial: { autoSuspendBySemanticCluster: autoSuspendSemanticToggle.checked } });
      state.settings = updated?.data || state.settings;
      showToast(state.settings.autoSuspendBySemanticCluster ? 'Suspensión por clusters activada' : 'Suspensión por clusters desactivada', 'info');
    });
  }

  // Settings: Notificaciones autoagrupación
  const autoGroupSemanticNotifyToggle = document.getElementById('autoGroupSemanticNotifyToggle');
  if (autoGroupSemanticNotifyToggle) {
    autoGroupSemanticNotifyToggle.addEventListener('change', async () => {
      const updated = await send('SET_SETTINGS_PARTIAL', { partial: { autoGroupSemanticNotifications: autoGroupSemanticNotifyToggle.checked } });
      state.settings = updated?.data || state.settings;
      showToast(state.settings.autoGroupSemanticNotifications ? 'Notificaciones activadas' : 'Notificaciones desactivadas', 'info');
    });
  }

  // Settings: Exclusiones de suspensión
  const addExclBtn = document.getElementById('addSuspendExclBtn');
  const exclInput = document.getElementById('suspendExclInput');
  if (addExclBtn && exclInput) {
    addExclBtn.addEventListener('click', async () => {
      const raw = (exclInput.value || '').trim().toLowerCase();
      if (!raw) return;
      try {
        const u = raw.includes('://') ? new URL(raw) : new URL('https://' + raw);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        const list = Array.from(new Set([...(state.settings.suspendExclusions || []), host]));
        const updated = await send('SET_SETTINGS_PARTIAL', { partial: { suspendExclusions: list } });
        state.settings = updated?.data || state.settings;
        renderSuspendExclusions();
        exclInput.value = '';
        showToast(`Añadido a exclusiones: ${host}`, 'success');
      } catch {
        showToast('Dominio inválido', 'error');
      }
    });
  }

  // Sidebar toggle (modo vertical)
  const sidebarToggleBtn = $('#sidebarToggleBtn');
  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', () => {
      if (!state.verticalMode) return;
      document.body.classList.toggle('sidebar-open');
    });
  }

  // Chips de filtros rápidos
  $$('#filterChips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const flag = chip.dataset.flag;
      if (!flag) return;
      state.filterFlags[flag] = !state.filterFlags[flag];
      chip.classList.toggle('active', state.filterFlags[flag]);
      renderTabs();
    });
  });

  // ===== Árbol: pestañas =====
  const treeSearchInput = $('#treeSearchInput');
  if (treeSearchInput) {
    treeSearchInput.addEventListener('input', debounce((e) => {
      state.treeFilter = e.target.value;
      renderTree();
    }, 150));
  }

  const treeRefreshBtn = $('#treeRefreshBtn');
  if (treeRefreshBtn) treeRefreshBtn.addEventListener('click', async () => { await loadTreeData(); renderTree(true); showToast('Árbol actualizado', 'success'); });
  const treeExpandAllBtn = $('#treeExpandAllBtn');
  if (treeExpandAllBtn) treeExpandAllBtn.addEventListener('click', () => toggleAllTree(true));
  const treeCollapseAllBtn = $('#treeCollapseAllBtn');
  if (treeCollapseAllBtn) treeCollapseAllBtn.addEventListener('click', () => toggleAllTree(false));
  const treeClearLocalBtn = $('#treeClearLocalBtn');
  if (treeClearLocalBtn) treeClearLocalBtn.addEventListener('click', async () => {
    if (confirm('¿Limpiar todo el historial local? (El historial de sesiones de Chrome se mantendrá)')) {
      const res = await send('CLEAR_HISTORY');
      if (res?.success) { 
        showToast('Historial local limpiado', 'success'); 
        await loadData(); 
      }
      else showToast('No se pudo limpiar historial local', 'error');
    }
  });

  const treeClearChromeBtn = $('#treeClearChromeBtn');
  if (treeClearChromeBtn) treeClearChromeBtn.addEventListener('click', async () => {
    if (confirm('¿Limpiar todo el historial de navegación de Chrome? Esta acción NO se puede deshacer.')) {
      const res = await send('CLEAR_CHROME_HISTORY');
      if (res?.success) {
        showToast('Historial de Chrome limpiado', 'success');
        await loadData();
      } else {
        showToast('No se pudo limpiar el historial de Chrome', 'error');
      }
    }
  });
}

// ============================================
// TREE DATA LOADING & RENDER
// ============================================
async function loadTreeData() {
  const recentRes = await send('GET_RECENTLY_CLOSED', { maxResults: 300 });
  state.tree.recentlyClosed = recentRes?.data || [];
}

function makeGroup(title, metaText = '', open = false) {
  const group = el('div', 'tree-group');
  if (open) group.classList.add('open');
  const header = el('div', 'tree-header');
  const toggle = el('div', 'tree-toggle'); toggle.textContent = '▶';
  const h = el('div', 'tree-title'); h.textContent = title;
  const meta = el('div', 'tree-meta'); meta.textContent = metaText;
  header.appendChild(toggle); header.appendChild(h); header.appendChild(meta);
  const children = el('div', 'tree-children');
  const inner = el('div', 'tree-children-inner');
  children.appendChild(inner);
  group.appendChild(header); group.appendChild(children);
  header.addEventListener('click', () => {
    group.classList.toggle('open');
  });
  return { group, inner };
}

// ============================================
// BOOKMARKS RENDERER (ESTILO WINDOWS)
// ============================================
function renderBookmarks() {
  const cont = $('#bookmarksList');
  if (!cont) return;
  cont.innerHTML = '';

  if (!state.bookmarks || state.bookmarks.length === 0) {
    cont.innerHTML = '<div class="tree-empty">No se encontraron marcadores.</div>';
    return;
  }

  // Las raíces suelen ser "Barra de marcadores", "Otros marcadores", etc.
  state.bookmarks.forEach(rootNode => {
    cont.appendChild(createBookmarkNode(rootNode));
  });
}

function createBookmarkNode(node) {
  const isFolder = !!node.children;
  const itemEl = el('div', 'bookmark-item');
  const rowEl = el('div', 'bookmark-row');
  
  // Flecha expansión
  if (isFolder) {
    const arrow = el('span', 'bookmark-arrow');
    arrow.textContent = '▶';
    rowEl.appendChild(arrow);
  } else {
    const spacer = el('span', 'bookmark-arrow');
    rowEl.appendChild(spacer);
  }

  // Icono (Carpeta o Favicon)
  if (isFolder) {
    const folderIcon = el('span', 'bookmark-folder-icon');
    folderIcon.textContent = '📁';
    rowEl.appendChild(folderIcon);
  } else {
    const fileIcon = el('img', 'bookmark-file-icon');
    fileIcon.src = sanitizeIconUrl(node.favIconUrl) || favicon(node.url) || 'chrome://favicon/' + node.url;
    fileIcon.onerror = () => { 
      fileIcon.onerror = null; 
      fileIcon.src = chrome.runtime.getURL('icons/icon48.png'); 
    };
    rowEl.appendChild(fileIcon);
  }

  // Título
  const title = el('span', 'bookmark-title');
  title.textContent = node.title || (isFolder ? 'Carpeta sin título' : 'Marcador sin título');
  title.title = node.url || '';
  rowEl.appendChild(title);

  // Acciones (Abrir)
  const actions = el('div', 'bookmark-actions');

  if (isFolder) {
    const groupFolderBtn = el('button', 'bookmark-btn');
    groupFolderBtn.textContent = '🪄';
    groupFolderBtn.title = 'Auto-agrupar contenido de esta carpeta';
    groupFolderBtn.onclick = async (e) => {
      e.stopPropagation();
      if (confirm(`¿Quieres agrupar automáticamente los marcadores dentro de "${node.title}"?`)) {
        showToast('Analizando y agrupando marcadores...', 'info');
        const res = await send('AUTO_GROUP_BOOKMARKS', { folderId: node.id });
        if (res?.success) {
          showToast('Marcadores agrupados con éxito', 'success');
          await loadData();
        } else {
          showToast('Error: ' + (res?.error || 'Fallo desconocido'), 'error');
        }
      }
    };
    actions.appendChild(groupFolderBtn);
  }

  const openBtn = el('button', 'bookmark-btn');
  openBtn.textContent = '↗';
  openBtn.title = isFolder ? 'Abrir todos' : 'Abrir';
  openBtn.onclick = (e) => {
    e.stopPropagation();
    if (isFolder) {
      openBookmarksRecursive(node);
    } else {
      window.open(node.url, '_blank');
    }
  };
  actions.appendChild(openBtn);
  rowEl.appendChild(actions);

  itemEl.appendChild(rowEl);

  // Hijos si es carpeta
  if (isFolder) {
    const childrenCont = el('div', 'bookmark-children');
    node.children.forEach(child => {
      childrenCont.appendChild(createBookmarkNode(child));
    });
    itemEl.appendChild(childrenCont);

    // Toggle expansion
    rowEl.onclick = () => {
      itemEl.classList.toggle('open');
      const arrow = rowEl.querySelector('.bookmark-arrow');
      if (arrow) arrow.textContent = itemEl.classList.contains('open') ? '▼' : '▶';
    };
  } else {
    rowEl.onclick = () => window.open(node.url, '_blank');
  }

  return itemEl;
}

function openBookmarksRecursive(node) {
  if (node.url) {
    window.open(node.url, '_blank');
  }
  if (node.children) {
    node.children.forEach(openBookmarksRecursive);
  }
}

/**
 * Ordena marcadores recursivamente: primero carpetas, luego archivos, ambos alfabéticamente.
 */
async function sortBookmarksRecursive(folderId) {
  const children = await chrome.bookmarks.getChildren(folderId);
  if (!children || children.length === 0) return;

  // Separar y ordenar
  const folders = children.filter(n => !n.url).sort((a, b) => a.title.localeCompare(b.title));
  const files = children.filter(n => !!n.url).sort((a, b) => a.title.localeCompare(b.title));
  const sorted = [...folders, ...files];

  // Mover en la API de Chrome (Mover solo si es necesario)
  for (let i = 0; i < sorted.length; i++) {
    // Si la posición ha cambiado, movemos
    // Nota: Mover puede disparar eventos BOOKMARK_CHANGED, cuidado con recursión infinita
    await chrome.bookmarks.move(sorted[i].id, { parentId: folderId, index: i });
  }

  // Recursión para subcarpetas
  for (const f of folders) {
    await sortBookmarksRecursive(f.id);
  }
}

function renderTree() {
  renderTreeByDate();
}

function renderTreeByDate() {
  const cont = $('#treeByDate');
  if (!cont) return;
  cont.innerHTML = '';

  const recentlyClosed = state.tree.recentlyClosed || [];
  const localHistory = state.history || [];

  if (recentlyClosed.length === 0 && localHistory.length === 0) {
    cont.innerHTML = '<div class="tree-empty">Sin datos recientes todavía.<br><small style="color:var(--text-dim); font-size: 0.75rem;">(Solo se muestran cierres locales e historial de Chrome)</small></div>';
    return;
  }

  // buckets[day][domain] = { url: entry }
  const buckets = {};

  const addEntry = (ts, entry) => {
    // Filtrado
    if (state.treeFilter) {
      const match = fuzzyMatch(entry.title || '', state.treeFilter) ||
                    fuzzyMatch(entry.url || '', state.treeFilter) ||
                    fuzzyMatch(getDomain(entry.url) || '', state.treeFilter);
      if (!match) return;
    }

    const day = toDateKey(ts);
    const domain = getDomain(entry.url);
    if (!buckets[day]) buckets[day] = {};
    if (!buckets[day][domain]) buckets[day][domain] = {}; // Usar objeto para deduplicar

    // Deduplicar por URL dentro del mismo día y dominio.
    // Conservamos la entrada más reciente pero sumamos ocurrencias.
    const urlKey = entry.url || 'no-url';
    const existing = buckets[day][domain][urlKey];
    if (!existing) {
      buckets[day][domain][urlKey] = { ...entry, time: ts, count: 1 };
    } else {
      existing.count++;
      if (ts > existing.time) {
        const currentCount = existing.count;
        buckets[day][domain][urlKey] = { ...entry, time: ts, count: currentCount };
      }
    }
  };

  recentlyClosed.forEach(it => {
    let ts = it.lastModified || Date.now();
    // Validar escala (ms vs s) para chrome.sessions
    if (ts < 10000000000) ts *= 1000;

    if (it.type === 'tab' && it.tab) {
      addEntry(ts, { kind: 'tab_chrome', ...it.tab });
    } else if (it.type === 'window' && it.window) {
      (it.window.tabs || []).forEach(t => addEntry(ts, { kind: 'tab_chrome', ...t }));
    }
  });

  localHistory.forEach(h => {
    // Asegurar que ts sea un número válido de milisegundos. 
    // Si h.id es un timestamp de Date.now(), Number(h.id) debería funcionar.
    // Si h.closedAt existe, Date.parse(h.closedAt) es lo ideal.
    let ts = h.closedAt ? Date.parse(h.closedAt) : (Number(h.id) || Date.now());
    
    // Validar que el año no sea 1970 por un timestamp en segundos en lugar de milisegundos
    if (ts < 10000000000) { // Menos de ~4 meses después de 1970 si son ms, pero > 2020 si son segundos
       ts *= 1000;
    }
    
    addEntry(ts, { kind: 'tab_local', ...h });
  });

  const days = Object.keys(buckets).sort((a, b) => b.localeCompare(a));
  if (days.length === 0 && state.treeFilter) {
    cont.innerHTML = '<div class="tree-empty">No hay resultados para la búsqueda.</div>';
    return;
  }

  days.forEach((dayKey, dIdx) => {
    const domainsObj = buckets[dayKey];
    const domainNames = Object.keys(domainsObj).sort();

    let totalItems = 0;
    domainNames.forEach(d => totalItems += Object.keys(domainsObj[d]).length);

    const { group: dayGroup, inner: dayInner } = makeGroup(formatDate(dayKey), `${totalItems} elementos`, dIdx < 2);

    domainNames.forEach((domain) => {
      // Convertir el objeto de items de nuevo a array y ordenar por tiempo descendente
      const itemsMap = domainsObj[domain];
      const items = Object.values(itemsMap).sort((a, b) => b.time - a.time);
      const { group: domGroup, inner: domInner } = makeGroup(domain, `${items.length} pestañas`, false);

      // Añadir botón "Abrir todos" al header del dominio
      const domHeader = domGroup.querySelector('.tree-header');
      if (domHeader) {
        const restoreBtn = el('div', 'tree-badge');
        restoreBtn.textContent = 'abrir todos';
        restoreBtn.style.marginRight = '8px';
        restoreBtn.title = 'Abrir todas las pestañas de este dominio';
        restoreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          items.forEach(t => window.open(t.url, '_blank'));
          showToast(`Abriendo ${items.length} pestañas`, 'success');
        });
        // Insertar antes del meta (que tiene margin-left: auto)
        const meta = domHeader.querySelector('.tree-meta');
        domHeader.insertBefore(restoreBtn, meta);
      }

      items.forEach(t => {
        domInner.appendChild(treeTabNode(t));
      });
      dayInner.appendChild(domGroup);
    });

    cont.appendChild(dayGroup);
  });
}

function treeTabNode(t) {
  const node = el('div', 'tree-node');
  const img = el('img', 'tree-favicon');
  img.src = sanitizeIconUrl(t.favIconUrl) || favicon(t.url);
  img.onerror = () => { img.style.display = 'none'; };
  const title = el('div');
  title.textContent = (t.count > 1) ? `${t.title || 'Sin título'} (${t.count})` : (t.title || 'Sin título');
  title.style.fontWeight = '500';
  const url = el('div', 'tree-url'); url.textContent = truncateUrl(t.url || '');

  const content = el('div');
  content.style.flex = '1';
  content.style.minWidth = '0';
  content.appendChild(title);
  content.appendChild(url);

  const right = el('div', 'tree-badge'); right.textContent = 'abrir';
  right.title = 'Abrir en nueva pestaña';
  right.addEventListener('click', (e) => { e.stopPropagation(); window.open(t.url, '_blank'); });

  node.appendChild(img);
  node.appendChild(content);
  node.appendChild(right);

  if (t.kind === 'tab_local') {
    const del = el('div', 'tree-badge');
    del.innerHTML = '🗑';
    del.style.color = '#ef4444';
    del.title = 'Eliminar del historial (Solo local)';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('¿Eliminar esta entrada del historial local?')) {
        const res = await send('DELETE_HISTORY_ITEM', { id: t.id });
        if (res?.success) {
          showToast('Elemento local eliminado', 'success');
          await loadData();
        } else {
          showToast('Error al eliminar', 'error');
        }
      }
    });
    node.appendChild(del);
  } else if (t.kind === 'tab_chrome') {
    const del = el('div', 'tree-badge');
    del.innerHTML = '🗑';
    del.style.color = '#ef4444';
    del.title = 'Eliminar de Chrome (Historial)';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('¿Eliminar esta URL del historial de navegación de Chrome?')) {
        const res = await send('DELETE_CHROME_HISTORY_ITEM', { url: t.url });
        if (res?.success) {
          showToast('URL eliminada de Chrome', 'success');
          await loadData();
        } else {
          showToast('Error al eliminar de Chrome', 'error');
        }
      }
    });
    node.appendChild(del);
    
    const badge = el('div', 'tree-badge');
    badge.textContent = 'Chrome';
    badge.title = 'Historial de sesiones de Chrome';
    badge.style.opacity = '0.6';
    badge.style.fontSize = '0.65rem';
    node.appendChild(badge);
  }

  return node;
}

function toggleAllTree(open) {
  const groups = $$('#tree-container .tree-group');
  groups.forEach(g => { g.classList.toggle('open', open); });
}

// ============================================
// SETTINGS RENDER/LOAD
// ============================================
async function loadSettings() {
  const res = await send('GET_SETTINGS');
  state.settings = res?.data || state.settings;
  // Toggle auto-ungroup
  const t = document.getElementById('autoUngroupToggle');
  if (t) t.checked = !!state.settings.autoUngroupOnStartup;
  // Toggle auto group domain
  const tg = document.getElementById('autoGroupDomainToggle');
  if (tg) tg.checked = !!state.settings.autoGroupByDomainEnabled;
  // Toggle auto group semantic
  const ts = document.getElementById('autoGroupSemanticToggle');
  if (ts) ts.checked = !!state.settings.autoGroupBySemanticEnabled;
  // Toggle auto suspend semantic cluster
  const tss = document.getElementById('autoSuspendSemanticToggle');
  if (tss) tss.checked = !!state.settings.autoSuspendBySemanticCluster;
  // Toggle notify semantic grouping
  const tn = document.getElementById('autoGroupSemanticNotifyToggle');
  if (tn) tn.checked = !!state.settings.autoGroupSemanticNotifications;
  renderSuspendExclusions();
}

function renderSuspendExclusions() {
  const listEl = document.getElementById('suspendExclList');
  if (!listEl) return;
  listEl.innerHTML = '';
  const items = state.settings.suspendExclusions || [];
  if (items.length === 0) {
    const empty = el('div', 'empty-state');
    empty.innerHTML = '<span class="empty-icon">🤫</span><span>Sin exclusiones</span>';
    listEl.appendChild(empty);
    return;
  }
  items.forEach(host => {
    const li = el('li', 'list-item');
    const info = el('div', 'list-item-info');
    info.innerHTML = `<div class="list-item-title">${host}</div>`;
    const actions = el('div', 'controls');
    const delBtn = el('button', 'btn-icon');
    delBtn.textContent = '🗑';
    delBtn.title = 'Eliminar';
    delBtn.onclick = async () => {
      const next = (state.settings.suspendExclusions || []).filter(x => x !== host);
      const updated = await send('SET_SETTINGS_PARTIAL', { partial: { suspendExclusions: next } });
      state.settings = updated?.data || state.settings;
      renderSuspendExclusions();
      showToast(`Eliminado: ${host}`, 'success');
    };
    actions.appendChild(delBtn);
    li.appendChild(info);
    li.appendChild(actions);
    listEl.appendChild(li);
  });
}

// ============================================
// WINDOW MODAL
// ============================================
async function openWindowModal() {
  if (state.selectedTabs.size === 0) return;
  const modal = $('#windowModal');
  const list = $('#windowModalList');
  list.innerHTML = '';

  state.windows.forEach((w, idx) => {
    const btn = el('button', 'btn-ghost full-width window-modal-btn');
    btn.innerHTML = `<span class="window-icon">🪟</span> Ventana ${idx + 1} (${w.tabs?.length || 0} pestañas)${w.focused ? ' ★' : ''}`;
    btn.onclick = async () => {
      await send('MOVE_TABS_TO_WINDOW', { tabIds: [...state.selectedTabs], windowId: w.id });
      state.selectedTabs.clear();
      updateMultiSelectBar();
      modal.classList.add('hidden');
      showToast('Pestañas movidas', 'success');
      await loadData();
    };
    list.appendChild(btn);
  });

  modal.classList.remove('hidden');
}

// ============================================
// INIT
// ============================================
(async () => {
  applyVerticalMode();
  await loadPersistedState();
  bindUI();
  bindKeyboardShortcuts();
  await loadData();

  // Memory stats interval
  await updateMemoryStats();
  memoryInterval = setInterval(updateMemoryStats, 10000);
})();

// Escuchar cambios para refrescar UI
chrome.tabs.onCreated.addListener(loadData);
chrome.tabs.onRemoved.addListener(loadData);
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete') loadData(); });
chrome.tabGroups?.onUpdated?.addListener(loadData);

// También escuchar broadcasts del background (MV3 service worker)
const scheduleFullReload = debounce(() => loadData(), 120);
chrome.runtime.onMessage.addListener((msg) => {
  const a = msg?.action || '';
  if (a.startsWith('TAB_')) return scheduleFullReload();
  if (a.startsWith('TABGROUP_')) return scheduleFullReload();
  if (a.startsWith('BOOKMARK_')) return scheduleFullReload();
  if (a === 'REPAINT_HINT') return scheduleFullReload();
  if (a === 'SETTINGS_CHANGED' || a === 'RULES_CHANGED' || a === 'SESSIONS_CHANGED' || a === 'HISTORY_CHANGED') {
    return scheduleFullReload();
  }
});
