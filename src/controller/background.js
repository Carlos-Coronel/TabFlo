import { TabModel, GroupModel } from '../model/TabModel.js';
import { ConfigModel } from '../model/ConfigModel.js';
import { Logger } from '../util/Logger.js';
import { AutoGrouper } from './AutoGrouper.js';

/**
 * TabController.js
 * Orquestador de eventos de pestañas y lógica de negocio.
 */
export class TabController {
  constructor() {
    this.autoGrouper = new AutoGrouper({
      groupTabsBulk: this.groupTabsBulk.bind(this),
      broadcast: this.broadcastMessage.bind(this),
      notify: this.notify.bind(this)
    });
    this.autoGrouper.init().catch((e) => Logger.error('AutoGrouper init failed:', e));
    this.initListeners();
    ConfigModel.getSettings()
      .then((settings) => {
        if (settings.autoGroupBySemanticEnabled) {
          this.autoGrouper?.scheduleRecluster('startup');
        }
      })
      .catch(() => {});
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isTabEditTransientError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('tabs cannot be edited right now')
      || message.includes('dragging a tab')
      || message.includes('tab may be dragging');
  }

  async withTabEditRetry(actionName, operation, delaysMs = [120, 320, 700]) {
    let lastError = null;
    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      try {
        return await operation();
      } catch (e) {
        lastError = e;
        if (!this.isTabEditTransientError(e) || attempt === delaysMs.length) {
          throw e;
        }
        const waitMs = delaysMs[attempt];
        Logger.debug(`Reintentando ${actionName} por estado transitorio de tabs`, {
          attempt: attempt + 1,
          waitMs,
          error: e?.message || String(e)
        });
        await this.sleep(waitMs);
      }
    }
    throw lastError;
  }

  initListeners() {
    // Al iniciar el navegador: desagrupar si está habilitado en Configuración
    chrome.runtime.onStartup.addListener(async () => {
      try {
        const enabled = await ConfigModel.getAutoUngroupOnStartup();
        Logger.debug('Browser started. Auto ungroup on startup:', enabled);
        if (!enabled) return;
        const tabs = await chrome.tabs.query({});
        const groupedTabs = tabs.filter(t => t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE);
        if (groupedTabs.length > 0) {
          await chrome.tabs.ungroup(groupedTabs.map(t => t.id));
        }
      } catch (e) {
        Logger.error('Error ungrouping tabs on startup:', e);
      }
    });

    // Escucha cuando se crea/actualiza una pestaña
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      try {
        // Difundir cambios específicos para permitir repaints selectivos en UI
        if (Object.prototype.hasOwnProperty.call(changeInfo, 'title')) {
          this.broadcastMessage({ action: 'TAB_TITLE_CHANGED', tabId, title: changeInfo.title || '' });
        }
        if (Object.prototype.hasOwnProperty.call(changeInfo, 'favIconUrl')) {
          this.broadcastMessage({ action: 'TAB_FAVICON_CHANGED', tabId, favIconUrl: changeInfo.favIconUrl || '' });
        }

        if (changeInfo.status === 'complete' && tab?.url) {
          Logger.debug('Tab updated complete:', { tabId, url: tab.url });
          try {
            const settings = await ConfigModel.getSettings();
            if (settings.autoGroupByDomainEnabled) {
              await this.handleAutoGrouping(tab);
            }
            if (settings.autoGroupBySemanticEnabled) {
              this.autoGrouper?.scheduleRecluster('tab-updated');
            }
          } catch (e) {
            Logger.error('Auto-group (by domain) failed:', e);
          }
        }
      } catch (e) {
        Logger.debug('onUpdated handling error:', e);
      }
      // Notificar actualización genérica (para cargas/estadísticas)
      this.broadcastMessage({ action: 'TAB_UPDATED', tabId, changeInfo, tab });
    });

    chrome.tabs.onCreated.addListener((tab) => {
      Logger.debug('Tab created:', tab?.id);
      this.broadcastMessage({ action: 'TAB_CREATED', tab });
      // Evitar reclustering inmediato en pestañas nuevas si la preferencia está activa
      ConfigModel.getSettings()
        .then((settings) => {
          if (settings.autoGroupBySemanticEnabled && !settings.semanticDeferNewTabUntilCommitted) {
            this.autoGrouper?.scheduleRecluster('tab-created');
          }
        })
        .catch(() => {});
    });

    chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
      Logger.debug('Tab moved:', { tabId, moveInfo });
      this.broadcastMessage({ action: 'TAB_MOVED', tabId, moveInfo });
    });

    chrome.tabs.onActivated.addListener((activeInfo) => {
      this.broadcastMessage({ action: 'TAB_ACTIVATED', activeInfo });
    });

    chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
      Logger.debug('Tab removed:', tabId);
      this.broadcastMessage({ action: 'TAB_REMOVED', tabId, removeInfo });
      this.autoGrouper?.clearTabCache(tabId);
      this.autoGrouper?.scheduleRecluster('tab-removed');
      // Intentar registrar en historial (best-effort)
      try {
        // Recuperar última pestaña cerrada desde sessions para enriquecer datos
        const recents = await chrome.sessions.getRecentlyClosed({ maxResults: 1 });
        const top = recents?.[0];
        if (top?.tab) {
          const t = top.tab;
          await TabModel.addToHistory({
            url: t.url,
            title: t.title,
            favIconUrl: t.favIconUrl,
            windowId: t.windowId,
            groupId: t.groupId,
            closedAt: new Date(top.lastModified || Date.now()).toISOString()
          });
        }
      } catch (e) {
        Logger.debug('No se pudo registrar historial reciente:', e);
      }
    });

    chrome.tabs.onAttached?.addListener((tabId, attachInfo) => {
      Logger.debug('Tab attached:', { tabId, attachInfo });
      this.broadcastMessage({ action: 'TAB_ATTACHED', tabId, attachInfo });
    });

    chrome.tabs.onDetached?.addListener((tabId, detachInfo) => {
      Logger.debug('Tab detached:', { tabId, detachInfo });
      this.broadcastMessage({ action: 'TAB_DETACHED', tabId, detachInfo });
    });

    chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
      Logger.debug('Tab replaced:', { addedTabId, removedTabId });
      this.broadcastMessage({ action: 'TAB_REPLACED', addedTabId, removedTabId });
      this.autoGrouper?.clearTabCache(removedTabId);
      this.autoGrouper?.scheduleRecluster('tab-replaced');
    });

    // Escucha mensajes desde la Vista (Popup/Dashboard)
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      Logger.debug('Mensaje recibido:', request);
      this.handleMessages(request, sendResponse, sender);
      return true;
    });

    // Eventos de grupos de pestañas
    try {
      chrome.tabGroups.onCreated.addListener((group) => {
        Logger.debug('Group created:', group?.id, group?.title);
        this.broadcastMessage({ action: 'TABGROUP_CREATED', group });
      });
      chrome.tabGroups.onUpdated.addListener((group) => {
        Logger.debug('Group updated:', group?.id, group?.title);
        this.broadcastMessage({ action: 'TABGROUP_UPDATED', group });
      });
      chrome.tabGroups.onMoved.addListener((group) => {
        Logger.debug('Group moved:', group?.id);
        this.broadcastMessage({ action: 'TABGROUP_MOVED', group });
      });
      chrome.tabGroups.onRemoved.addListener((group) => {
        Logger.debug('Group removed:', group?.id);
        this.broadcastMessage({ action: 'TABGROUP_REMOVED', group });
      });
    } catch (e) {
      Logger.debug('tabGroups events not available:', e);
    }

    // Cambios en almacenamiento -> propagar a vistas
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      for (const key of Object.keys(changes || {})) {
        const newValue = changes[key]?.newValue;
        switch (key) {
          case 'settings':
            this.broadcastMessage({ action: 'SETTINGS_CHANGED', settings: newValue });
            break;
          case 'sessions':
            this.broadcastMessage({ action: 'SESSIONS_CHANGED', sessions: newValue });
            break;
          case 'autoGroupRules':
            this.broadcastMessage({ action: 'RULES_CHANGED', rules: newValue });
            break;
          case 'history':
            this.broadcastMessage({ action: 'HISTORY_CHANGED', history: newValue });
            break;
          case 'debug':
            this.broadcastMessage({ action: 'DEBUG_CHANGED', debug: Boolean(newValue) });
            break;
          default:
            this.broadcastMessage({ action: 'STORAGE_CHANGED', key, value: newValue });
        }
      }
    });

    // Alarmas para pestañas temporales
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name.startsWith('temp_tab_')) {
        const tabId = parseInt(alarm.name.replace('temp_tab_', ''));
        Logger.debug('Alarm fired for temp tab:', { tabId });
        chrome.tabs.remove(tabId);
        this.notify('Pestaña temporal cerrada', 'La pestaña ha expirado después del tiempo configurado.');
      }
    });

    // Atajos de teclado (commands) - corregidos y ampliados
    chrome.commands.onCommand.addListener(async (command) => {
      Logger.debug(`Command received: ${command}`);
      switch (command) {
        case 'open-dashboard':
          chrome.tabs.create({ url: chrome.runtime.getURL('src/view/dashboard.html') });
          break;
        case 'open-sidepanel':
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (tab) {
            chrome.sidePanel.open({ windowId: tab.windowId });
          }
          break;
        case 'clear-all-groups': {
          const tabs = await chrome.tabs.query({});
          const groupedTabs = tabs.filter(t => t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE);
          if (groupedTabs.length > 0) {
            await chrome.tabs.ungroup(groupedTabs.map(t => t.id));
            this.notify('Grupos limpiados', 'Se han desagrupado todas las pestañas abiertas.');
          }
          break;
        }
        case 'save-session': {
          const tabs = await TabModel.getAllOpenTabs();
          const name = `Sesión ${new Date().toLocaleString()}`;
          await TabModel.saveSession(name, tabs);
          this.notify('Sesión guardada', 'La sesión actual de pestañas ha sido guardada.');
          break;
        }
        case 'move-tab-left': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.index > 0) {
            await this.withTabEditRetry('move-tab-left', () => chrome.tabs.move(tab.id, { index: tab.index - 1 }));
          }
          break;
        }
        case 'move-tab-right': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab) {
            await this.withTabEditRetry('move-tab-right', () => chrome.tabs.move(tab.id, { index: tab.index + 1 }));
          }
          break;
        }
      }
    });

    // Eventos de marcadores: propagar para que las vistas puedan refrescar y forzar repaints
    try {
      chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
        Logger.debug('Bookmark changed:', { id, changeInfo });
        this.broadcastMessage({ action: 'BOOKMARK_CHANGED', id, changeInfo });
        // Pista de repintado para las vistas que rendericen barra de marcadores
        this.broadcastMessage({ action: 'REPAINT_HINT', target: 'bookmarks' });
      });
      chrome.bookmarks.onCreated.addListener((id, node) => {
        Logger.debug('Bookmark created:', { id, title: node?.title });
        this.broadcastMessage({ action: 'BOOKMARK_CREATED', id, node });
        this.broadcastMessage({ action: 'REPAINT_HINT', target: 'bookmarks' });
      });
      chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
        Logger.debug('Bookmark removed:', { id });
        this.broadcastMessage({ action: 'BOOKMARK_REMOVED', id, removeInfo });
        this.broadcastMessage({ action: 'REPAINT_HINT', target: 'bookmarks' });
      });
      chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
        Logger.debug('Bookmark moved:', { id });
        this.broadcastMessage({ action: 'BOOKMARK_MOVED', id, moveInfo });
        this.broadcastMessage({ action: 'REPAINT_HINT', target: 'bookmarks' });
      });
    } catch (e) {
      Logger.debug('bookmarks events not available:', e);
    }
  }

  broadcastMessage(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch(e) {}
  }

  /**
   * Maneja el agrupamiento automático basado en reglas.
   */
  async handleAutoGrouping(tab) {
    const rules = await GroupModel.getAutoGroupRules();
    const title = (tab.title || '').toLowerCase();
    const url = (tab.url || '').toLowerCase();

    let domain = '';
    try {
      domain = new URL(tab.url).hostname.replace(/^www\./, '');
    } catch(e) {}

    let matchedRule = null;

    for (const rule of rules) {
      const patterns = Array.isArray(rule.pattern) ? rule.pattern : [rule.pattern];
      const match = patterns.some(p => {
        const pattern = p.toLowerCase();
        return url.includes(pattern) || title.includes(pattern);
      });
      
      if (match) {
        matchedRule = rule;
        break;
      }
    }

    if (matchedRule) {
      // Agrupar todas las pestañas de la misma ventana que cumplan la regla
      const allTabs = await chrome.tabs.query({ windowId: tab.windowId });
      const toGroup = allTabs.filter(t => {
        const tTitle = (t.title || '').toLowerCase();
        const tUrl = (t.url || '').toLowerCase();
        const patterns = Array.isArray(matchedRule.pattern) ? matchedRule.pattern : [matchedRule.pattern];
        return patterns.some(p => {
          const pattern = String(p || '').toLowerCase();
          return tTitle.includes(pattern) || tUrl.includes(pattern);
        });
      }).map(t => t.id);

      if (toGroup.length > 0) {
        Logger.debug('Agrupando por regla (ventana actual):', { name: matchedRule.groupName, count: toGroup.length });
        await this.groupTabsBulk(toGroup, matchedRule.groupName, matchedRule.color || 'grey');
      }
    } else if (domain) {
      // Agrupar todas las pestañas del mismo dominio en la ventana actual
      const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
      const sameDomainTabs = tabsInWindow.filter(t => {
        try { return new URL(t.url).hostname.replace(/^www\./, '') === domain; }
        catch(e) { return false; }
      });
      if (sameDomainTabs.length > 1) {
        const root = domain.split('.')[0];
        const groupName = root.charAt(0).toUpperCase() + root.slice(1);
        const ids = sameDomainTabs.map(t => t.id);
        await this.groupTabsBulk(ids, groupName, 'grey');
      }
    }
  }

  async groupTab(tabId, groupName, color) {
    const groups = await chrome.tabGroups.query({ title: groupName });
    let groupId;

    // Si ya existe un grupo con ese nombre, sólo añade la pestaña a ese grupo
    if (groups.length > 0) {
      groupId = groups[0].id;
      await this.withTabEditRetry('groupTab.attach', () => chrome.tabs.group({ tabIds: tabId, groupId }));
      return;
    }

    // Crear grupo nuevo con la pestaña y aplicar título/color inmediatamente
    groupId = await this.withTabEditRetry('groupTab.create', () => chrome.tabs.group({ tabIds: tabId }));
    await this.withTabEditRetry('groupTab.update', () => chrome.tabGroups.update(groupId, {
      title: groupName,
      color: color,
      collapsed: false
    }));

    // Workaround: en algunos casos el título no aparece hasta que se fuerza un segundo update
    setTimeout(() => {
      this.withTabEditRetry('groupTab.update.deferred', () => chrome.tabGroups.update(groupId, { title: groupName, color: color }))
        .catch(() => {});
    }, 150);
  }

  /**
   * Agrupa múltiples pestañas en un único grupo y aplica título/color con refuerzo diferido.
   */
  async groupTabsBulk(tabIds, groupName, color = 'grey') {
    // Normalizar lista de pestañas
    if (!Array.isArray(tabIds)) return;
    const uniqueIds = [...new Set(tabIds.filter((id) => id != null))];
    if (uniqueIds.length === 0) return;

    // Verificar qué pestañas siguen vivas (pueden cerrarse entre el debounce y el agrupado)
    const aliveTabs = [];
    for (const id of uniqueIds) {
      try {
        const t = await chrome.tabs.get(id);
        if (t && t.id != null) aliveTabs.push(t);
      } catch (_) {
        // Ignorar: pestaña inexistente
      }
    }
    if (aliveTabs.length === 0) return;

    // Intentar reutilizar un grupo existente con el mismo título en la misma ventana
    let targetGroupId = null;
    try {
      const existing = await chrome.tabGroups.query({ title: groupName });
      if (existing && existing.length > 0) {
        const winId = aliveTabs[0].windowId;
        const sameWin = existing.find((g) => g.windowId === winId) || existing[0];
        targetGroupId = sameWin.id;
      }
    } catch (_) {
      // Continuar sin grupo objetivo si la consulta falla
    }

    // Ayudante: agrupar en bloque, y si falla por un ID inválido, intentar uno por uno
    const safeGroupMany = async (ids, presetGroupId = null) => {
      let groupId = presetGroupId;
      const groupedIds = [];
      const tryBatch = async () => {
        if (groupId != null) {
          await this.withTabEditRetry('groupTabsBulk.attach', () => chrome.tabs.group({ tabIds: ids, groupId }));
        } else {
          groupId = await this.withTabEditRetry('groupTabsBulk.create', () => chrome.tabs.group({ tabIds: ids }));
        }
        groupedIds.push(...ids);
      };

      try {
        await tryBatch();
      } catch (e) {
        // Posible error: "No tab with id". Intentar individualmente para salvar la mayoría.
        for (const id of ids) {
          try {
            // Verificar que siga existiendo justo antes de agrupar
            try { await chrome.tabs.get(id); } catch { continue; }
            if (groupId != null) {
              await this.withTabEditRetry('groupTabsBulk.attach.one', () => chrome.tabs.group({ tabIds: id, groupId }));
            } else {
              groupId = await this.withTabEditRetry('groupTabsBulk.create.one', () => chrome.tabs.group({ tabIds: id }));
            }
            groupedIds.push(id);
          } catch (_) {
            // Ignorar pestañas que fallen al agrupar individualmente
          }
        }
      }
      return { groupId, groupedIds };
    };

    const aliveIds = aliveTabs.map((t) => t.id);
    const { groupId } = await safeGroupMany(aliveIds, targetGroupId);
    if (groupId == null) return null;

    // Actualizar propiedades del grupo con refuerzo diferido
    try {
      const settings = await ConfigModel.getSettings();
      const shouldExpand = settings.uiPreventAutoExpandOnAutoChanges ? false : true;
      await this.withTabEditRetry('groupTabsBulk.update', () => chrome.tabGroups.update(groupId, { title: groupName, color, collapsed: !shouldExpand ? undefined : false }));
      setTimeout(() => {
        this.withTabEditRetry('groupTabsBulk.update.deferred', () => chrome.tabGroups.update(groupId, { title: groupName, color }))
          .catch(() => {});
      }, 150);
    } catch (_) {
      // Fallback sin preferencias cargadas
      await this.withTabEditRetry('groupTabsBulk.update', () => chrome.tabGroups.update(groupId, { title: groupName, color }));
    }
    return groupId;
  }

  /**
   * Router de mensajes internos.
   */
  async handleMessages(request, sendResponse, sender) {
    try {
      switch (request.action) {
        case 'GET_PROCESSES': {
          if (chrome.processes && chrome.processes.getProcessInfo) {
            chrome.processes.getProcessInfo([], true, async (procs) => {
              if (chrome.runtime.lastError || !procs || Object.keys(procs).length === 0) {
                 const mock = await this.generateEstimatedProcesses();
                 sendResponse({ success: true, data: mock });
              } else {
                 sendResponse({ success: true, data: procs });
              }
            });
          } else {
            this.generateEstimatedProcesses().then(mock => {
              sendResponse({ success: true, data: mock });
            });
          }
          return true; // async
        }
        case 'GET_EXTENSIONS': {
          if (!chrome.management) {
            sendResponse({ success: false, error: 'API chrome.management no disponible.' });
            break;
          }
          chrome.management.getAll((exts) => {
            sendResponse({ success: true, data: exts });
          });
          return true; // async
        }
        case 'DISCARD_TAB': {
          try {
            const discarded = await chrome.tabs.discard(request.tabId);
            sendResponse({ success: true, data: discarded });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
          break;
        }
        case 'DISABLE_EXTENSION': {
          try {
            await chrome.management.setEnabled(request.extId, false);
            sendResponse({ success: true });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
          break;
        }
        case 'TERMINATE_PROCESS': {
          if (chrome.processes && chrome.processes.terminate) {
            chrome.processes.terminate(request.pid, (success) => {
              if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
              } else {
                sendResponse({ success });
              }
            });
            return true; // async
          } else {
            sendResponse({ success: false, error: 'API de procesos no disponible (entorno no compatible)' });
          }
          break;
        }
        case 'GET_TABS': {
          const tabs = await TabModel.getAllOpenTabs();
          sendResponse({ success: true, data: tabs });
          break;
        }
        case 'GET_GROUPS': {
          const groups = await GroupModel.getAllGroups();
          sendResponse({ success: true, data: groups });
          break;
        }
        case 'AUTO_GROUP_SEMANTIC_NOW': {
          try {
            await this.autoGrouper?.runRecluster('manual');
            sendResponse({ success: true });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
          break;
        }
        case 'SAVE_SESSION': {
          const session = await TabModel.saveSession(request.name, request.tabs, request.project || '');
          sendResponse({ success: true, data: session });
          break;
        }
        case 'UNGROUP_ALL': {
          try {
            const tabs = await chrome.tabs.query({});
            const groupedTabs = tabs.filter(t => t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE);
            if (groupedTabs.length > 0) {
              await chrome.tabs.ungroup(groupedTabs.map(t => t.id));
            }
            sendResponse({ success: true });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
          break;
        }
        case 'AUTO_GROUP_BOOKMARKS': {
          this.autoGrouper?.groupBookmarks(null, request.folderId)
            .then(() => sendResponse({ success: true }))
            .catch(e => sendResponse({ success: false, error: e.message }));
          return true; // async
        }
        case 'DELETE_SESSION': {
          await TabModel.deleteSession(request.id);
          sendResponse({ success: true });
          break;
        }
        case 'EXPORT_SESSIONS': {
          const json = await TabModel.exportSessions();
          sendResponse({ success: true, data: json });
          break;
        }
        case 'IMPORT_SESSIONS': {
          const merged = await TabModel.importSessions(request.json);
          sendResponse({ success: true, data: merged });
          break;
        }
        case 'SET_TEMP_TAB': {
          this.setTemporaryTab(request.tabId, request.minutes);
          sendResponse({ success: true });
          break;
        }
        case 'GET_HISTORY': {
          const history = await TabModel.getHistory();
          sendResponse({ success: true, data: history });
          break;
        }
        case 'ADD_TO_HISTORY': {
          await TabModel.addToHistory(request.tab);
          sendResponse({ success: true });
          break;
        }
        case 'CLEAR_HISTORY': {
          await TabModel.clearHistory();
          this.broadcastMessage({ action: 'HISTORY_CHANGED', history: [] });
          sendResponse({ success: true });
          break;
        }
        case 'DELETE_HISTORY_ITEM': {
          await TabModel.deleteHistoryItem(request.id);
          sendResponse({ success: true });
          break;
        }
        case 'DELETE_CHROME_HISTORY_ITEM': {
          try {
            await chrome.history.deleteUrl({ url: request.url });
            sendResponse({ success: true });
          } catch (e) {
            Logger.error('DELETE_CHROME_HISTORY_ITEM error:', e);
            sendResponse({ success: false, error: String(e) });
          }
          break;
        }
        case 'CLEAR_CHROME_HISTORY': {
          try {
            await chrome.history.deleteAll();
            sendResponse({ success: true });
          } catch (e) {
            Logger.error('CLEAR_CHROME_HISTORY error:', e);
            sendResponse({ success: false, error: String(e) });
          }
          break;
        }
        case 'GET_DEBUG': {
          const enabled = await ConfigModel.getDebugFlag();
          sendResponse({ success: true, data: { debug: enabled } });
          break;
        }
        case 'SET_DEBUG': {
          const val = await ConfigModel.setDebugFlag(Boolean(request.enabled));
          Logger.debug('Debug flag set to', val);
          sendResponse({ success: true, data: { debug: val } });
          break;
        }
        case 'RUN_DIAGNOSTICS': {
          const report = await this.runDiagnostics();
          sendResponse({ success: true, data: report });
          break;
        }
        case 'RUN_OFFLINE_TESTS': {
          const tests = await this.runOfflineValidationTests();
          sendResponse({ success: true, data: tests });
          break;
        }
        // === Árbol/Historial avanzado ===
        case 'GET_RECENTLY_CLOSED': {
          try {
            const max = Math.min(25, Math.max(1, Number(request?.maxResults ?? 25) || 25));
            const items = await chrome.sessions.getRecentlyClosed({ maxResults: max });
            const mapped = items.map((it) => {
              if (it.tab) {
                const t = it.tab;
                return {
                  type: 'tab',
                  lastModified: it.lastModified || Date.now(),
                  tab: {
                    id: t.sessionId || null,
                    title: t.title,
                    url: t.url,
                    favIconUrl: t.favIconUrl,
                    windowId: t.windowId,
                    groupId: t.groupId
                  }
                };
              }
              if (it.window) {
                const w = it.window;
                return {
                  type: 'window',
                  lastModified: it.lastModified || Date.now(),
                  window: {
                    id: w.sessionId || null,
                    tabs: (w.tabs || []).map(t => ({
                      id: t.sessionId || null,
                      title: t.title,
                      url: t.url,
                      favIconUrl: t.favIconUrl,
                      windowId: t.windowId,
                      groupId: t.groupId
                    }))
                  }
                };
              }
              return { type: 'unknown', lastModified: it.lastModified || Date.now() };
            });
            sendResponse({ success: true, data: mapped });
          } catch (e) {
            Logger.error('GET_RECENTLY_CLOSED error:', e);
            sendResponse({ success: false, error: String(e) });
          }
          break;
        }
        case 'GET_WINDOWS_TABS': {
          try {
            const wins = await chrome.windows.getAll({ populate: true });
            const mapped = wins.map(w => ({
              id: w.id,
              focused: w.focused,
              incognito: w.incognito,
              type: w.type,
              tabs: (w.tabs || []).map(t => ({
                id: t.id,
                title: t.title,
                url: t.url,
                favIconUrl: t.favIconUrl,
                pinned: t.pinned,
                audible: t.audible,
                discarded: t.discarded,
                groupId: t.groupId
              }))
            }));
            sendResponse({ success: true, data: mapped });
          } catch (e) {
            Logger.error('GET_WINDOWS_TABS error:', e);
            sendResponse({ success: false, error: String(e) });
          }
          break;
        }
        // === Preferencias ===
        case 'GET_SETTINGS': {
          const settings = await ConfigModel.getSettings();
          sendResponse({ success: true, data: settings });
          break;
        }
        case 'SET_SETTINGS_PARTIAL': {
          const updated = await ConfigModel.setSettingsPartial(request.partial || {});
          sendResponse({ success: true, data: updated });
          break;
        }
        case 'GROUP_BY_DOMAIN': {
          await this.groupAllByDomain();
          sendResponse({ success: true });
          break;
        }
        case 'CLOSE_DUPLICATES': {
          const closedCount = await this.closeDuplicates();
          sendResponse({ success: true, data: { closed: closedCount } });
          break;
        }
        case 'SUSPEND_INACTIVE': {
          const suspendedCount = await this.suspendInactiveTabs();
          sendResponse({ success: true, data: { suspended: suspendedCount } });
          break;
        }
        // === Pinned ===
        case 'PIN_TABS': {
          const { tabIds } = request;
          const count = await this.pinTabs(tabIds || []);
          sendResponse({ success: true, data: { pinned: count } });
          break;
        }
        case 'UNPIN_TABS': {
          const { tabIds } = request;
          const count = await this.unpinTabs(tabIds || []);
          sendResponse({ success: true, data: { unpinned: count } });
          break;
        }
        // === Audio ===
        case 'MUTE_OTHERS': {
          const result = await this.muteOthers();
          sendResponse({ success: true, data: result });
          break;
        }
        // --- Reglas de auto-agrupación (CRUD) ---
        case 'GET_AUTO_GROUP_RULES': {
          const rules = await GroupModel.getAutoGroupRules();
          sendResponse({ success: true, data: rules });
          break;
        }
        case 'SAVE_AUTO_GROUP_RULES': {
          await GroupModel.saveAutoGroupRules(request.rules);
          sendResponse({ success: true });
          break;
        }
        case 'ADD_AUTO_GROUP_RULE': {
          const newRule = await GroupModel.addAutoGroupRule(request.rule);
          sendResponse({ success: true, data: newRule });
          break;
        }
        case 'UPDATE_AUTO_GROUP_RULE': {
          const updated = await GroupModel.updateAutoGroupRule(request.ruleId, request.updates);
          sendResponse({ success: true, data: updated });
          break;
        }
        case 'DELETE_AUTO_GROUP_RULE': {
          const remaining = await GroupModel.deleteAutoGroupRule(request.ruleId);
          sendResponse({ success: true, data: remaining });
          break;
        }
        case 'EXPORT_RULES': {
          const rulesJson = await GroupModel.exportRules();
          sendResponse({ success: true, data: rulesJson });
          break;
        }
        case 'IMPORT_RULES': {
          const imported = await GroupModel.importRules(request.json);
          sendResponse({ success: true, data: imported });
          break;
        }
        case 'RESET_RULES': {
          const defaults = await GroupModel.resetToDefaults();
          sendResponse({ success: true, data: defaults });
          break;
        }
        // --- Multi-selección: mover tabs en bloque ---
        case 'MOVE_TABS': {
          const { tabIds, windowId, index } = request;
          if (windowId !== undefined) {
            await this.withTabEditRetry('handleMessages.moveTabs.window', () => chrome.tabs.move(tabIds, { windowId, index: index || -1 }));
          } else {
            await this.withTabEditRetry('handleMessages.moveTabs', () => chrome.tabs.move(tabIds, { index: index || -1 }));
          }
          sendResponse({ success: true });
          break;
        }
        case 'CLOSE_TABS': {
          await chrome.tabs.remove(request.tabIds);
          sendResponse({ success: true });
          break;
        }
        case 'GROUP_TABS': {
          const gId = await this.withTabEditRetry('handleMessages.groupTabs.create', () => chrome.tabs.group({ tabIds: request.tabIds }));
          if (request.groupName) {
            await this.withTabEditRetry('handleMessages.groupTabs.update', () => chrome.tabGroups.update(gId, {
              title: request.groupName,
              color: request.color || 'grey'
            }));
          }
          sendResponse({ success: true, data: { groupId: gId } });
          break;
        }
        // --- Ventanas ---
        case 'GET_WINDOWS': {
          const windows = await chrome.windows.getAll({ populate: true });
          sendResponse({ success: true, data: windows });
          break;
        }
        case 'MOVE_TABS_TO_WINDOW': {
          await this.withTabEditRetry('handleMessages.moveTabsToWindow', () => chrome.tabs.move(request.tabIds, {
            windowId: request.windowId,
            index: -1
          }));
          sendResponse({ success: true });
          break;
        }
        case 'MOVE_TABS_TO_NEW_WINDOW': {
          const newWin = await chrome.windows.create({ tabId: request.tabIds[0] });
          if (request.tabIds.length > 1) {
            await this.withTabEditRetry('handleMessages.moveTabsToNewWindow', () => chrome.tabs.move(request.tabIds.slice(1), {
              windowId: newWin.id,
              index: -1
            }));
          }
          sendResponse({ success: true, data: { windowId: newWin.id } });
          break;
        }
        // --- Stats de memoria ---
        case 'GET_MEMORY_INFO': {
          try {
            const memInfo = await chrome.system.memory.getInfo();
            const tabs = await TabModel.getAllOpenTabs();
            
            const calcChromeRam = async () => {
              let total = 0;
              let procs = null;
              if (chrome.processes && chrome.processes.getProcessInfo) {
                procs = await new Promise(res => {
                  chrome.processes.getProcessInfo([], true, (p) => {
                    res((!chrome.runtime.lastError && p && Object.keys(p).length > 0) ? p : null);
                  });
                });
              }
              if (!procs) {
                procs = await this.generateEstimatedProcesses();
              }
              for (const key in procs) {
                total += procs[key].privateMemory || 0;
              }
              return total;
            };
            
            const chromeMemory = await calcChromeRam();
            sendResponse({ success: true, data: { memory: memInfo, tabCount: tabs.length, chromeMemory } });
          } catch (e) {
            sendResponse({ success: true, data: { memory: null, tabCount: 0, error: e.message } });
          }
          break;
        }
        default:
          sendResponse({ success: false, error: 'Acción no reconocida' });
      }
    } catch (error) {
      Logger.error('Error en handleMessages', error);
      sendResponse({ success: false, error: error.message });
    }
  }

  /**
   * Configura un temporizador para cerrar una pestaña.
   */
  setTemporaryTab(tabId, minutes) {
    chrome.alarms.create(`temp_tab_${tabId}`, { delayInMinutes: minutes });
  }

  async generateEstimatedProcesses() {
    const tabs = await TabModel.getAllOpenTabs();
    const exts = await new Promise(res => {
      if (chrome.management && chrome.management.getAll) chrome.management.getAll(res);
      else res([]);
    });
    
    const procs = {};
    let pid = 1000;
    
    procs[pid] = { id: pid++, type: 'browser', privateMemory: 180 * 1024 * 1024, cpu: 1.5, tasks: [] };
    procs[pid] = { id: pid++, type: 'gpu', privateMemory: 250 * 1024 * 1024, cpu: 5.0, tasks: [] };
    
    for (const tab of tabs) {
      let ramMB = tab.active ? 150 : 80;
      let cpu = tab.active ? 2.5 : 0.1;
      ramMB += Math.floor(Math.random() * 50);
      cpu += Math.random() * 0.5;
      
      procs[pid] = { 
        id: pid, 
        type: 'renderer', 
        privateMemory: ramMB * 1024 * 1024, 
        cpu: cpu, 
        tasks: [{ tabId: tab.id, title: tab.title }] 
      };
      pid++;
    }
    
    for (const ext of exts) {
      if (!ext.enabled) continue;
      let ramMB = 40 + Math.floor(Math.random() * 30);
      let cpu = 0.2 + Math.random() * 0.5;
      procs[pid] = {
        id: pid,
        type: 'extension',
        privateMemory: ramMB * 1024 * 1024,
        cpu: cpu,
        tasks: [{ title: `Extension: ${ext.name}` }]
      };
      pid++;
    }
    
    return procs;
  }

  async groupAllByDomain() {
    const tabs = await chrome.tabs.query({});
    const domainMap = {};
    
    for (const tab of tabs) {
      try {
        if (!tab.url) continue;
        const domain = new URL(tab.url).hostname.replace(/^www\./, '');
        if (!domain) continue;
        if (!domainMap[domain]) domainMap[domain] = [];
        domainMap[domain].push(tab);
      } catch(e) {}
    }

    for (const domain in domainMap) {
      const domainTabs = domainMap[domain];
      if (domainTabs.length > 1) {
        const groupName = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
        const tabIds = domainTabs.map(t => t.id);
        const groupId = await this.withTabEditRetry('groupAllByDomain.create', () => chrome.tabs.group({ tabIds }));
        await this.withTabEditRetry('groupAllByDomain.update', () => chrome.tabGroups.update(groupId, {
          title: groupName,
          color: 'grey'
        }));
      }
    }
  }

  async closeDuplicates() {
    const tabs = await chrome.tabs.query({});
    const seenUrls = new Set();
    const duplicateIds = [];
    
    for (const tab of tabs) {
      if (!tab.url) continue;
      let normUrl = tab.url.split('#')[0].replace(/\/$/, '');
      if (seenUrls.has(normUrl)) {
        duplicateIds.push(tab.id);
      } else {
        seenUrls.add(normUrl);
      }
    }
    
    if (duplicateIds.length > 0) {
      await chrome.tabs.remove(duplicateIds);
    }
    return duplicateIds.length;
  }

  async suspendInactiveTabs() {
    const tabs = await chrome.tabs.query({ active: false, discarded: false });
    const exclusions = await ConfigModel.getSuspendExclusions();
    let count = 0;
    for (const tab of tabs) {
      if (!tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://')) {
        // Respetar exclusiones por dominio
        try {
          const hostname = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase();
          if (exclusions.includes(hostname)) continue;
        } catch (e) {}
        try {
          await chrome.tabs.discard(tab.id);
          count++;
        } catch (e) {
          Logger.debug('Could not discard tab:', tab.id, e);
        }
      }
    }
    return count;
  }

  async pinTabs(tabIds) {
    if (!Array.isArray(tabIds) || tabIds.length === 0) return 0;
    let c = 0;
    for (const id of tabIds) {
      try {
        await this.withTabEditRetry('pinTabs', () => chrome.tabs.update(id, { pinned: true }));
        c++;
      } catch(e) {}
    }
    return c;
  }

  async unpinTabs(tabIds) {
    if (!Array.isArray(tabIds) || tabIds.length === 0) return 0;
    let c = 0;
    for (const id of tabIds) {
      try {
        await this.withTabEditRetry('unpinTabs', () => chrome.tabs.update(id, { pinned: false }));
        c++;
      } catch(e) {}
    }
    return c;
  }

  async muteOthers() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const all = await chrome.tabs.query({ currentWindow: true });
    let muted = 0;
    for (const t of all) {
      if (active && t.id === active.id) {
        try {
          await this.withTabEditRetry('muteOthers.active', () => chrome.tabs.update(t.id, { muted: false }));
        } catch(e) {}
        continue;
      }
      try {
        await this.withTabEditRetry('muteOthers.other', () => chrome.tabs.update(t.id, { muted: true }));
        muted++;
      } catch(e) {}
    }
    return { muted, windowId: active ? active.windowId : null };
  }

  async runDiagnostics() {
    const report = { ok: true, checks: [] };

    try {
      const key = `diag_${Date.now()}`;
      await chrome.storage.local.set({ [key]: 'ok' });
      const got = (await chrome.storage.local.get([key]))[key];
      await chrome.storage.local.remove([key]);
      report.checks.push({ name: 'Storage R/W', pass: got === 'ok' });
      if (got !== 'ok') report.ok = false;
    } catch (e) {
      report.ok = false; report.checks.push({ name: 'Storage R/W', pass: false, error: String(e) });
    }

    try {
      const tabs = await chrome.tabs.query({});
      report.checks.push({ name: 'Tabs query', pass: Array.isArray(tabs) });
      if (!Array.isArray(tabs)) report.ok = false;
    } catch (e) {
      report.ok = false; report.checks.push({ name: 'Tabs query', pass: false, error: String(e) });
    }

    try {
      const groups = await chrome.tabGroups.query({});
      report.checks.push({ name: 'TabGroups query', pass: Array.isArray(groups) });
      if (!Array.isArray(groups)) report.ok = false;
    } catch (e) {
      report.ok = false; report.checks.push({ name: 'TabGroups query', pass: false, error: String(e) });
    }

    try {
      const name = `diag_alarm_${Date.now()}`;
      await chrome.alarms.create(name, { delayInMinutes: 0.01 });
      await chrome.alarms.clear(name);
      report.checks.push({ name: 'Alarms create/clear', pass: true });
    } catch (e) {
      report.ok = false; report.checks.push({ name: 'Alarms create/clear', pass: false, error: String(e) });
    }

    try {
      const memInfo = await chrome.system.memory.getInfo();
      report.checks.push({ name: 'System Memory', pass: !!memInfo });
    } catch (e) {
      report.checks.push({ name: 'System Memory', pass: false, error: String(e) });
    }

    try {
      const offlineTests = await this.runOfflineValidationTests();
      const pass = offlineTests.every((t) => t.status === 'OK');
      report.checks.push({ name: 'Offline IA/Offscreen/Notificaciones', pass, details: offlineTests });
      if (!pass) report.ok = false;
    } catch (e) {
      report.ok = false;
      report.checks.push({ name: 'Offline IA/Offscreen/Notificaciones', pass: false, error: String(e) });
    }

    return report;
  }

  buildOfflineTestResult(test, ok, reason) {
    return {
      test,
      status: ok ? 'OK' : 'ERROR',
      reason: String(reason || (ok ? 'Sin detalles' : 'Fallo sin detalles'))
    };
  }

  async runOfflineValidationTests() {
    const results = [];

    try {
      const autoGrouperResults = await this.autoGrouper.runOfflineSelfTests();
      for (const item of autoGrouperResults) {
        results.push({
          test: item.test,
          status: item.status === 'OK' ? 'OK' : 'ERROR',
          reason: item.reason || 'Sin razón'
        });
      }
    } catch (e) {
      results.push(this.buildOfflineTestResult('autoGrouper.selfTests', false, e?.message || e));
    }

    try {
      const iconUrl = chrome.runtime.getURL('icons/icon48.png');
      const notificationId = await new Promise((resolve, reject) => {
        chrome.notifications.create({
          type: 'basic',
          iconUrl,
          title: 'TabFlo test',
          message: 'Prueba de icono de notificación'
        }, (id) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(err);
          resolve(id);
        });
      });

      results.push(this.buildOfflineTestResult('notifications.image', true, `Notificación creada correctamente (${notificationId})`));

      if (notificationId) {
        try { await chrome.notifications.clear(notificationId); } catch {}
      }
    } catch (e) {
      results.push(this.buildOfflineTestResult('notifications.image', false, e?.message || e));
    }

    return results;
  }

  async notify(title, message) {
    const iconUrl = chrome.runtime.getURL('icons/icon48.png');
    try {
      await new Promise((resolve) => {
        chrome.notifications.create({
          type: 'basic',
          iconUrl,
          title: String(title || ''),
          message: String(message || '')
        }, () => {
          const err = chrome.runtime.lastError;
          if (err) {
            Logger.debug('Notificación rechazada:', err.message || err);
          }
          resolve();
        });
      });
    } catch (e) {
      Logger.debug('No se pudo crear notificación (throw):', e);
    }
  }
}

// Instanciar controlador para el Background Script
new TabController();
