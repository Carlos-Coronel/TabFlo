import { PersistenceManager } from './PersistenceManager.js';

/**
 * TabModel.js
 * Representa el modelo de datos para una pestaña y gestiona sesiones guardadas.
 */
export class TabModel {
  /**
   * Obtiene todas las pestañas abiertas actualmente en el navegador.
   * @returns {Promise<chrome.tabs.Tab[]>}
   */
  static async getAllOpenTabs() {
    return await chrome.tabs.query({});
  }

  /**
   * Guarda una sesión de pestañas.
   * @param {string} sessionName - Nombre para la sesión.
   * @param {chrome.tabs.Tab[]} tabs - Lista de pestañas a guardar.
   * @param {string} [project] - Nombre del proyecto (opcional).
   */
  static async saveSession(sessionName, tabs, project = '') {
    const sessions = (await PersistenceManager.get('sessions')) || {};
    const sessionData = tabs.map(tab => ({
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl,
      windowId: tab.windowId,
      groupId: tab.groupId
    }));
    
    sessions[sessionName] = {
      id: Date.now(),
      name: sessionName,
      project: project,
      tabs: sessionData,
      createdAt: new Date().toISOString()
    };
    
    await PersistenceManager.save('sessions', sessions);
    return sessions[sessionName];
  }

  /**
   * Recupera todas las sesiones guardadas.
   */
  static async getSessions() {
    return (await PersistenceManager.get('sessions')) || {};
  }

  /**
   * Elimina una sesión.
   */
  static async deleteSession(sessionId) {
    const sessions = await this.getSessions();
    const newSessions = {};
    for (const key in sessions) {
      if (sessions[key].id !== sessionId) {
        newSessions[key] = sessions[key];
      }
    }
    await PersistenceManager.save('sessions', newSessions);
  }

  /**
   * Exporta sesiones como JSON string para backup.
   */
  static async exportSessions() {
    const sessions = await this.getSessions();
    return JSON.stringify(sessions, null, 2);
  }

  /**
   * Importa sesiones desde JSON string.
   */
  static async importSessions(jsonStr) {
    const imported = JSON.parse(jsonStr);
    const current = await this.getSessions();
    const merged = { ...current, ...imported };
    await PersistenceManager.save('sessions', merged);
    return merged;
  }

  /**
   * Historial de pestañas (Históricos).
   */
  static async getHistory() {
    return (await PersistenceManager.get('history')) || [];
  }

  static async addToHistory(tab) {
    const history = await this.getHistory();
    const entry = {
      id: Date.now(),
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl,
      windowId: tab.windowId ?? null,
      groupId: tab.groupId ?? null,
      closedAt: new Date().toISOString()
    };
    const newHistory = [entry, ...history].slice(0, 200);
    await PersistenceManager.save('history', newHistory);
  }

  static async clearHistory() {
    await PersistenceManager.remove('history');
  }
}

/**
 * Reglas de agrupación automática por defecto (JSON).
 * Se usan solo cuando el usuario no ha guardado reglas personalizadas.
 */
const DEFAULT_AUTO_GROUP_RULES = [
  { id: 1, pattern: ['google.com', 'google.es'], groupName: 'Google', color: 'blue' },
  { id: 2, pattern: ['github.com', 'stackoverflow.com', 'gitlab.com', 'bitbucket.org'], groupName: 'Desarrollo', color: 'purple' },
  { id: 3, pattern: ['youtube.com', 'netflix.com', 'twitch.tv', 'spotify.com'], groupName: 'Media', color: 'red' },
  { id: 4, pattern: ['facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com', 'reddit.com'], groupName: 'Social', color: 'yellow' },
  { id: 5, pattern: ['chatgpt.com', 'openai.com', 'anthropic.com', 'claude.ai'], groupName: 'IA', color: 'cyan' },
  { id: 6, pattern: ['slack.com', 'zoom.us', 'microsoft.com', 'trello.com', 'notion.so', 'meet.google.com'], groupName: 'Trabajo', color: 'orange' },
  { id: 7, pattern: ['amazon.com', 'ebay.com', 'aliexpress.com', 'mercadolibre'], groupName: 'Compras', color: 'green' },
  { id: 8, pattern: ['wikipedia.org', 'medium.com', 'dev.to', 'coursera.org', 'udemy.com'], groupName: 'Educación', color: 'grey' }
];

/**
 * GroupModel.js
 * Maneja la lógica de datos de los grupos de pestañas.
 * Las reglas de auto-agrupación se almacenan en JSON persistente,
 * permitiendo al usuario crear/editar/eliminar reglas desde el dashboard.
 */
export class GroupModel {
  /**
   * Obtiene todos los grupos de pestañas existentes en el navegador.
   */
  static async getAllGroups() {
    return await chrome.tabGroups.query({});
  }

  /**
   * Define reglas de agrupación automática (persistencia JSON).
   */
  static async saveAutoGroupRules(rules) {
    await PersistenceManager.save('autoGroupRules', rules);
  }

  /**
   * Obtiene las reglas de agrupación automática.
   * Si no hay reglas guardadas, devuelve las reglas por defecto y las persiste.
   */
  static async getAutoGroupRules() {
    const saved = await PersistenceManager.get('autoGroupRules');
    if (saved && Array.isArray(saved) && saved.length > 0) {
      return saved;
    }
    await PersistenceManager.save('autoGroupRules', DEFAULT_AUTO_GROUP_RULES);
    return DEFAULT_AUTO_GROUP_RULES;
  }

  /**
   * Añade una nueva regla de agrupación automática.
   */
  static async addAutoGroupRule(rule) {
    const rules = await this.getAutoGroupRules();
    const newId = rules.length > 0 ? Math.max(...rules.map(r => r.id)) + 1 : 1;
    const newRule = { id: newId, ...rule };
    rules.push(newRule);
    await this.saveAutoGroupRules(rules);
    return newRule;
  }

  /**
   * Actualiza una regla existente por su ID.
   */
  static async updateAutoGroupRule(ruleId, updates) {
    const rules = await this.getAutoGroupRules();
    const idx = rules.findIndex(r => r.id === ruleId);
    if (idx === -1) throw new Error('Regla no encontrada');
    rules[idx] = { ...rules[idx], ...updates };
    await this.saveAutoGroupRules(rules);
    return rules[idx];
  }

  /**
   * Elimina una regla por su ID.
   */
  static async deleteAutoGroupRule(ruleId) {
    const rules = await this.getAutoGroupRules();
    const filtered = rules.filter(r => r.id !== ruleId);
    await this.saveAutoGroupRules(filtered);
    return filtered;
  }

  /**
   * Exporta las reglas como JSON string.
   */
  static async exportRules() {
    const rules = await this.getAutoGroupRules();
    return JSON.stringify(rules, null, 2);
  }

  /**
   * Importa reglas desde JSON string.
   */
  static async importRules(jsonStr) {
    const imported = JSON.parse(jsonStr);
    if (!Array.isArray(imported)) throw new Error('El JSON debe ser un array de reglas');
    await this.saveAutoGroupRules(imported);
    return imported;
  }

  /**
   * Restaura las reglas por defecto.
   */
  static async resetToDefaults() {
    await this.saveAutoGroupRules(DEFAULT_AUTO_GROUP_RULES);
    return DEFAULT_AUTO_GROUP_RULES;
  }
}
