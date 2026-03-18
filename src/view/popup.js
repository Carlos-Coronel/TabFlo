const $ = (s) => document.querySelector(s);

// Utilidad simple: debounce
function debounce(fn, wait = 120) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// Forzar reflow/repaint del nodo para que Chrome actualice el DOM visualmente
function forceReflow(node) {
  if (!node) return;
  // Lectura forzada de layout + pequeño nudge para repintar
  void node.offsetWidth; // eslint-disable-line no-unused-expressions
  const prev = node.style.transform;
  node.style.transform = 'translateZ(0)';
  // Restaurar en el siguiente ciclo
  setTimeout(() => { node.style.transform = prev || ''; }, 0);
}

// Feature-detect: API de procesos (no disponible en canal estable)
const HAS_PROCESS_API = !!(chrome?.processes && chrome?.processes?.terminate);

// Devuelve un favicon solo para URLs http/https; evita chrome://, edge://, file://, etc.
function favicon(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return `${u.protocol}//${u.hostname}/favicon.ico`;
    }
    return '';
  } catch { return ''; }
}

// Asegura que una URL de imagen sea de un esquema permitido en páginas de extensión
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

async function send(action, payload = {}) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ action, ...payload }, (res) => resolve(res)));
}

let state = {
  processes: {},
  tabs: [],
  extensions: [],
  sortBy: 'ram', // 'ram' o 'cpu'
  query: '',
  historyRam: [],
  settings: { autoGroupByDomainEnabled: false, autoGroupBySemanticEnabled: true, autoSuspendBySemanticCluster: false }
};

// Limitar cantidad renderizada para rendimiento (virtualización básica)
const RENDER_LIMIT = 30;

function fuzzyMatch(text, query) {
  if (!query) return true;
  const t = (text || '').toLowerCase();
  const q = query.toLowerCase();
  if (t.includes(q)) return true;
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

async function fetchData() {
  const [procRes, tabsRes, extRes, settingsRes] = await Promise.all([
    send('GET_PROCESSES'),
    send('GET_TABS'),
    send('GET_EXTENSIONS'),
    send('GET_SETTINGS')
  ]);
  
  if (procRes?.success) state.processes = procRes.data;
  if (tabsRes?.success) state.tabs = tabsRes.data;
  if (extRes?.success) state.extensions = extRes.data;
  if (settingsRes?.success) state.settings = settingsRes.data || state.settings;

  updateMemoryChart();
  renderResults();

  // Sincronizar estado del toggle si existe en el DOM
  const t = document.getElementById('autoGroupDomainTogglePopup');
  if (t) t.checked = !!state.settings.autoGroupByDomainEnabled;
  const semantic = document.getElementById('autoGroupSemanticTogglePopup');
  if (semantic) semantic.checked = !!state.settings.autoGroupBySemanticEnabled;
  const autoSuspend = document.getElementById('autoSuspendSemanticTogglePopup');
  if (autoSuspend) autoSuspend.checked = !!state.settings.autoSuspendBySemanticCluster;
}

function getProcessTypeLabel(type) {
  const map = {
    'browser': 'Navegador',
    'renderer': 'Pestaña',
    'extension': 'Extensión',
    'gpu': 'GPU',
    'utility': 'Utilidad',
    'worker': 'Worker'
  };
  return map[type] || type;
}

function processData() {
  const list = [];
  
  // Crear mapas para búsqueda rápida
  const tabsById = new Map(state.tabs.map(t => [t.id, t]));
  const extByName = new Map(state.extensions.map(e => [e.name, e]));

  for (const pid in state.processes) {
    const proc = state.processes[pid];
    const item = {
      pid: proc.id,
      type: proc.type,
      typeLabel: getProcessTypeLabel(proc.type),
      ram: proc.privateMemory || 0,
      cpu: proc.cpu || 0,
      title: 'Proceso de ' + proc.type,
      subtitle: `PID: ${proc.id}`,
      icon: '',
      actions: [],
      relatedTabId: null,
      relatedExtId: null,
      isDiscarded: false
    };

    // Intentar asociar con pestaña o extensión basada en las tareas (tasks)
    if (proc.tasks && proc.tasks.length > 0) {
      for (const task of proc.tasks) {
        if (task.tabId && tabsById.has(task.tabId)) {
          const tab = tabsById.get(task.tabId);
          item.title = tab.title || item.title;
          item.subtitle = tab.url || item.subtitle;
          item.icon = sanitizeIconUrl(tab.favIconUrl) || favicon(tab.url);
          item.relatedTabId = tab.id;
          item.isDiscarded = !!tab.discarded;
          item.actions = ['go', 'discard', 'close'];
          break; // Tomar la primera pestaña principal
        }
        
        // Asociar con extensión (generalmente el título de la tarea empieza con "Extension:")
        if (proc.type === 'extension' || task.title.includes('Extension:')) {
          const extName = task.title.replace('Extension:', '').trim();
          if (extByName.has(extName)) {
            const ext = extByName.get(extName);
            item.title = ext.name;
            item.subtitle = 'Extensión activa';
            const extIcon = (ext.icons && ext.icons.length > 0) ? ext.icons[ext.icons.length - 1].url : '';
            item.icon = sanitizeIconUrl(extIcon);
            item.relatedExtId = ext.id;
            item.actions = ['disable'];
          } else {
            item.title = extName || task.title;
          }
        }
      }
    }
    
    // Si no tiene ícono, poner algo genérico según tipo
    if (!item.icon) {
      if (item.type === 'gpu') item.icon = "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='gray'%3E%3Crect width='16' height='16'/%3E%3C/svg%3E";
      else item.icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO4B3EwAAAAASUVORK5CYII=';
    }

    if (item.actions.length === 0 && HAS_PROCESS_API) {
      item.actions.push('terminate');
    }

    // Filtrar
    if (fuzzyMatch(item.title, state.query) || fuzzyMatch(item.subtitle, state.query)) {
      list.push(item);
    }
  }

  // Ordenar
  list.sort((a, b) => {
    if (state.sortBy === 'ram') return b.ram - a.ram;
    return b.cpu - a.cpu;
  });

  return list;
}

function renderResults() {
  const items = processData();
  const cont = $('#results');
  cont.innerHTML = '';

  const badge = $('#tabCountBadge');
  if (badge) badge.textContent = `${state.tabs.length} pestaña${state.tabs.length !== 1 ? 's' : ''}`;

  if (items.length === 0) {
    cont.innerHTML = `<div class="empty-state"><span class="empty-icon">🔍</span><span>Sin procesos encontrados</span></div>`;
    forceReflow(cont);
    return;
  }

  // Renderizar sólo los primeros RENDER_LIMIT para no saturar DOM
  const visibleItems = items.slice(0, RENDER_LIMIT);

  // DocumentFragment para mejor performance
  const fragment = document.createDocumentFragment();

  visibleItems.forEach(item => {
    const row = document.createElement('div');
    row.className = 'proc-item';

    const ramMB = (item.ram / 1024 / 1024).toFixed(1);
    const cpuStr = item.cpu.toFixed(1);

    const isHighRam = item.ram > 300 * 1024 * 1024; // > 300MB
    const ramClass = isHighRam ? 'stat-badge warning-high' : 'stat-badge';

    // Icono
    const imgEl = document.createElement('img');
    imgEl.className = 'proc-icon';
    const safeIcon = sanitizeIconUrl(item.icon);
    imgEl.src = safeIcon || '';
    imgEl.onerror = () => { imgEl.style.opacity = '0.3'; };
    row.appendChild(imgEl);

    // Info contenedor
    const info = document.createElement('div');
    info.className = 'proc-info';
    row.appendChild(info);

    const titleEl = document.createElement('div');
    titleEl.className = 'proc-title';
    titleEl.title = item.title || '';
    titleEl.textContent = item.title || '';
    if (item.isDiscarded) {
      const leaf = document.createElement('span');
      leaf.innerHTML = ' 🍃';
      leaf.title = 'Suspendida';
      leaf.style.fontSize = '0.75rem';
      titleEl.appendChild(leaf);
      row.style.opacity = '0.6';
    }
    info.appendChild(titleEl);

    const subEl = document.createElement('div');
    subEl.className = 'proc-subtitle';
    subEl.title = item.subtitle || '';
    subEl.textContent = `${item.typeLabel} • ${item.subtitle || ''}`;
    info.appendChild(subEl);

    const stats = document.createElement('div');
    stats.className = 'proc-stats';
    const ramBadge = document.createElement('span');
    ramBadge.className = ramClass;
    ramBadge.textContent = `${ramMB} MB`;
    const cpuBadge = document.createElement('span');
    cpuBadge.className = 'stat-badge';
    cpuBadge.textContent = `${cpuStr}% CPU`;
    stats.appendChild(ramBadge);
    stats.appendChild(cpuBadge);
    info.appendChild(stats);

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'proc-actions';
    row.appendChild(actionsContainer);
    
    if (item.actions.includes('go')) {
      const btn = document.createElement('button');
      btn.className = 'btn-action';
      btn.title = 'Ir a la pestaña';
      btn.innerHTML = '🔗';
      btn.onclick = () => chrome.tabs.update(item.relatedTabId, { active: true });
      actionsContainer.appendChild(btn);
    }
    
    if (item.actions.includes('discard')) {
      const btn = document.createElement('button');
      btn.className = 'btn-action';
      btn.title = 'Suspender (Liberar RAM)';
      btn.innerHTML = '💤';
      btn.onclick = async () => {
        if (confirm(`¿Suspender "${item.title}" para liberar RAM?`)) {
          await send('DISCARD_TAB', { tabId: item.relatedTabId });
          fetchData();
        }
      };
      actionsContainer.appendChild(btn);
    }
    
    if (item.actions.includes('close')) {
      const btn = document.createElement('button');
      btn.className = 'btn-action close';
      btn.title = 'Cerrar pestaña';
      btn.innerHTML = '✖';
      btn.onclick = async () => {
        await chrome.tabs.remove(item.relatedTabId);
        fetchData();
      };
      actionsContainer.appendChild(btn);
    }

    if (item.actions.includes('disable')) {
      const btn = document.createElement('button');
      btn.className = 'btn-action close';
      btn.title = 'Desactivar Extensión';
      btn.innerHTML = '⏹';
      btn.onclick = async () => {
        if (confirm(`¿Desactivar la extensión "${item.title}"?`)) {
          await send('DISABLE_EXTENSION', { extId: item.relatedExtId });
          fetchData();
        }
      };
      actionsContainer.appendChild(btn);
    }

    if (item.actions.includes('terminate')) {
      const btn = document.createElement('button');
      btn.className = 'btn-action close';
      btn.title = 'Finalizar proceso';
      btn.innerHTML = '✖';
      btn.onclick = async () => {
        if (confirm(`¿Finalizar el proceso "${item.title}" (PID: ${item.pid})?`)) {
          const res = await send('TERMINATE_PROCESS', { pid: item.pid });
          if (res && !res.success) {
            alert('No se pudo finalizar el proceso: ' + (res.error || 'Desconocido'));
          } else {
            fetchData();
          }
        }
      };
      actionsContainer.appendChild(btn);
    }

    fragment.appendChild(row);
    // Forzar repaint después de actualizar textos para evitar glitches visuales
    forceReflow(row);
  });

  cont.appendChild(fragment);
  forceReflow(cont);

  // Limpiar memoria
  items.length = 0;
}

function updateMemoryChart() {
  let totalRam = 0;
  for (const pid in state.processes) {
    totalRam += state.processes[pid].privateMemory || 0;
  }
  
  const ramMB = totalRam / 1024 / 1024;
  const badge = $('#memoryBadge');
  if (badge) badge.textContent = `RAM Usada: ${ramMB.toFixed(0)}MB`;
  
  state.historyRam.push(ramMB);
  if (state.historyRam.length > 20) state.historyRam.shift();
  
  drawChart();
}

function drawChart() {
  const canvas = $('#ramChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  
  ctx.clearRect(0, 0, w, h);
  
  if (state.historyRam.length === 0) return;
  
  const data = state.historyRam.length === 1 ? [state.historyRam[0], state.historyRam[0]] : state.historyRam;
  const max = Math.max(...data, 500); // Mínimo 500MB de escala
  const min = 0;
  
  const step = w / 19; // Máximo 20 puntos
  
  // Dibujar línea principal
  ctx.beginPath();
  data.forEach((val, i) => {
    const x = i * step;
    const y = h - ((val - min) / (max - min)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#8b5cf6';
  ctx.lineWidth = 2;
  ctx.stroke();
  
  // Dibujar relleno (gradiente)
  ctx.lineTo((data.length - 1) * step, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, 'rgba(139, 92, 246, 0.5)');
  gradient.addColorStop(1, 'rgba(139, 92, 246, 0.0)');
  ctx.fillStyle = gradient;
  ctx.fill();
}

function bindUI() {
  $('#openDashboard').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  $('#openSidepanel').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    }
  });

  $('#clearAllGroups')?.addEventListener('click', async () => {
    if (confirm('¿Desagrupar todas las pestañas de todas las ventanas?')) {
      const res = await send('UNGROUP_ALL');
      if (res?.success) {
        fetchData();
      }
    }
  });

  $('#q').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderResults();
  });
  
  $('#sortRam').addEventListener('click', (e) => {
    state.sortBy = 'ram';
    $('.btn-sort.active')?.classList.remove('active');
    e.target.classList.add('active');
    renderResults();
  });
  
  $('#sortCpu').addEventListener('click', (e) => {
    state.sortBy = 'cpu';
    $('.btn-sort.active')?.classList.remove('active');
    e.target.classList.add('active');
    renderResults();
  });

  $('#q').focus();

  // Toggle: Auto agrupar por dominio desde el popup
  const autoToggle = document.getElementById('autoGroupDomainTogglePopup');
  if (autoToggle) {
    autoToggle.addEventListener('change', async () => {
      const updated = await send('SET_SETTINGS_PARTIAL', { partial: { autoGroupByDomainEnabled: autoToggle.checked } });
      if (updated?.success) {
        state.settings = updated.data || state.settings;
      }
    });
  }

  // Toggle: Auto agrupar por tema (semántico)
  const semanticToggle = document.getElementById('autoGroupSemanticTogglePopup');
  if (semanticToggle) {
    semanticToggle.addEventListener('change', async () => {
      const updated = await send('SET_SETTINGS_PARTIAL', { partial: { autoGroupBySemanticEnabled: semanticToggle.checked } });
      if (updated?.success) {
        state.settings = updated.data || state.settings;
        if (semanticToggle.checked) {
          await send('AUTO_GROUP_SEMANTIC_NOW');
        }
      }
    });
  }

  // Toggle: Suspender por cluster
  const suspendToggle = document.getElementById('autoSuspendSemanticTogglePopup');
  if (suspendToggle) {
    suspendToggle.addEventListener('change', async () => {
      const updated = await send('SET_SETTINGS_PARTIAL', { partial: { autoSuspendBySemanticCluster: suspendToggle.checked } });
      if (updated?.success) {
        state.settings = updated.data || state.settings;
      }
    });
  }

  // Escuchar eventos de background para mantener datos actualizados (con debounce)
  const scheduleRefresh = debounce(() => fetchData(), 120);
  chrome.runtime.onMessage.addListener((msg) => {
    const a = msg?.action || '';
    // Eventos de pestañas que afectan el listado/estadísticas
    if (a.startsWith('TAB_')) return scheduleRefresh();
    // Eventos de grupos (renombres/movimientos/creación/eliminación)
    if (a.startsWith('TABGROUP_')) return scheduleRefresh();
    // Eventos de marcadores (por si la UI evoluciona a mostrarlos)
    if (a.startsWith('BOOKMARK_')) return scheduleRefresh();
    if (a === 'REPAINT_HINT') return scheduleRefresh();
    // Cambios de configuración, reglas, sesiones e historial
    if (a === 'SETTINGS_CHANGED' || a === 'RULES_CHANGED' || a === 'SESSIONS_CHANGED' || a === 'HISTORY_CHANGED') {
      return scheduleRefresh();
    }
  });
}

// Inicialización
bindUI();
fetchData();

// Actualizar gráfico de memoria en tiempo real cada 2 segundos sin re-renderizar lista completa
setInterval(async () => {
  const procRes = await send('GET_PROCESSES');
  if (procRes?.success) {
    state.processes = procRes.data;
    updateMemoryChart();
  }
}, 2000);

// Opcional: limpiar variables al cerrar (aunque el GC del popup lo hace)
window.addEventListener('unload', () => {
  state.processes = null;
  state.tabs = null;
  state.extensions = null;
  state.historyRam = null;
});
