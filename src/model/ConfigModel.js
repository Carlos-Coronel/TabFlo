import { PersistenceManager } from './PersistenceManager.js';

/**
 * ConfigModel.js
 * Configuración de la extensión (feature flags, preferencias de usuario).
 */
export class ConfigModel {
  static async getDebugFlag() {
    const v = await PersistenceManager.get('debug');
    return Boolean(v);
  }

  static async setDebugFlag(enabled) {
    await PersistenceManager.save('debug', Boolean(enabled));
    return Boolean(enabled);
  }

  // ===============================
  // Preferencias de usuario
  // Se almacenan bajo la clave "settings"
  // ===============================
  static async getSettings() {
    const s = (await PersistenceManager.get('settings')) || {};
    const normalized = {
      autoUngroupOnStartup: s.autoUngroupOnStartup !== undefined ? Boolean(s.autoUngroupOnStartup) : true,
      suspendExclusions: Array.isArray(s.suspendExclusions) ? s.suspendExclusions : [],
      // Nuevo flag: auto agrupar por dominio/categoría (Dashboard y Popup pueden activarlo)
      autoGroupByDomainEnabled: s.autoGroupByDomainEnabled !== undefined ? Boolean(s.autoGroupByDomainEnabled) : true,
      autoGroupBySemanticEnabled: s.autoGroupBySemanticEnabled !== undefined ? Boolean(s.autoGroupBySemanticEnabled) : true,
      autoGroupSemanticNotifications: s.autoGroupSemanticNotifications !== undefined ? Boolean(s.autoGroupSemanticNotifications) : true,
      autoSuspendBySemanticCluster: s.autoSuspendBySemanticCluster !== undefined ? Boolean(s.autoSuspendBySemanticCluster) : false,
      // Proveedor de embeddings: 'auto' | 'local' | 'lexical'
      embeddingProvider: typeof s.embeddingProvider === 'string' ? s.embeddingProvider : 'auto',

      // Estabilidad de auto-agrupación semántica
      semanticDeferNewTabUntilCommitted: s.semanticDeferNewTabUntilCommitted !== undefined ? Boolean(s.semanticDeferNewTabUntilCommitted) : true,
      semanticStickinessEnabled: s.semanticStickinessEnabled !== undefined ? Boolean(s.semanticStickinessEnabled) : true,
      semanticStickinessConsecutiveRequired: Number.isInteger(s.semanticStickinessConsecutiveRequired) ? s.semanticStickinessConsecutiveRequired : 2,
      semanticMinDwellMsBeforeReassign: Number.isFinite(s.semanticMinDwellMsBeforeReassign) ? s.semanticMinDwellMsBeforeReassign : 30000,
      semanticIncrementalApply: s.semanticIncrementalApply !== undefined ? Boolean(s.semanticIncrementalApply) : true,

      // UI: evitar expandir grupos ante cambios automáticos
      uiPreventAutoExpandOnAutoChanges: s.uiPreventAutoExpandOnAutoChanges !== undefined ? Boolean(s.uiPreventAutoExpandOnAutoChanges) : true,
      uiExpandAutoGroupOnCreate: s.uiExpandAutoGroupOnCreate !== undefined ? Boolean(s.uiExpandAutoGroupOnCreate) : false
    };
    return normalized;
  }

  static async setSettingsPartial(partial) {
    const current = (await PersistenceManager.get('settings')) || {};
    let next = { ...current, ...partial };
    if (Array.isArray(next.suspendExclusions)) {
      // Normalizar: strings en minúsculas, únicos, sin espacios
      const norm = next.suspendExclusions
        .map(x => String(x || '').trim().toLowerCase())
        .filter(x => x.length > 0);
      next.suspendExclusions = Array.from(new Set(norm));
    }
    await PersistenceManager.save('settings', next);
    return await this.getSettings();
  }

  static async getAutoUngroupOnStartup() {
    const s = await this.getSettings();
    return Boolean(s.autoUngroupOnStartup);
  }

  static async setAutoUngroupOnStartup(value) {
    const v = Boolean(value);
    const s = await this.setSettingsPartial({ autoUngroupOnStartup: v });
    return s.autoUngroupOnStartup;
  }

  static async getSuspendExclusions() {
    const s = await this.getSettings();
    return Array.isArray(s.suspendExclusions) ? s.suspendExclusions : [];
  }

  static async addSuspendExclusion(domain) {
    const d = String(domain || '').trim().toLowerCase();
    if (!d) return await this.getSuspendExclusions();
    const list = await this.getSuspendExclusions();
    if (!list.includes(d)) list.push(d);
    const s = await this.setSettingsPartial({ suspendExclusions: list });
    return s.suspendExclusions;
  }

  static async removeSuspendExclusion(domain) {
    const d = String(domain || '').trim().toLowerCase();
    const list = (await this.getSuspendExclusions()).filter(x => x !== d);
    const s = await this.setSettingsPartial({ suspendExclusions: list });
    return s.suspendExclusions;
  }

  // ===============================
  // Auto agrupar por dominio/categoría
  // ===============================
  static async getAutoGroupByDomainEnabled() {
    const s = await this.getSettings();
    return Boolean(s.autoGroupByDomainEnabled);
  }

  static async setAutoGroupByDomainEnabled(value) {
    const v = Boolean(value);
    const s = await this.setSettingsPartial({ autoGroupByDomainEnabled: v });
    return s.autoGroupByDomainEnabled;
  }

  // ===============================
  // Auto agrupar por semántica
  // ===============================
  static async getAutoGroupBySemanticEnabled() {
    const s = await this.getSettings();
    return Boolean(s.autoGroupBySemanticEnabled);
  }

  static async setAutoGroupBySemanticEnabled(value) {
    const v = Boolean(value);
    const s = await this.setSettingsPartial({ autoGroupBySemanticEnabled: v });
    return s.autoGroupBySemanticEnabled;
  }

  static async getAutoGroupSemanticNotifications() {
    const s = await this.getSettings();
    return Boolean(s.autoGroupSemanticNotifications);
  }

  static async setAutoGroupSemanticNotifications(value) {
    const v = Boolean(value);
    const s = await this.setSettingsPartial({ autoGroupSemanticNotifications: v });
    return s.autoGroupSemanticNotifications;
  }

  static async getAutoSuspendBySemanticCluster() {
    const s = await this.getSettings();
    return Boolean(s.autoSuspendBySemanticCluster);
  }

  static async setAutoSuspendBySemanticCluster(value) {
    const v = Boolean(value);
    const s = await this.setSettingsPartial({ autoSuspendBySemanticCluster: v });
    return s.autoSuspendBySemanticCluster;
  }

  // ===============================
  // Proveedor de embeddings (avanzado)
  // ===============================
  static async getEmbeddingProvider() {
    const s = await this.getSettings();
    const val = s.embeddingProvider;
    return ['auto', 'local', 'lexical'].includes(val) ? val : 'auto';
  }

  static async setEmbeddingProvider(value) {
    const allowed = ['auto', 'local', 'lexical'];
    const v = allowed.includes(value) ? value : 'auto';
    const s = await this.setSettingsPartial({ embeddingProvider: v });
    return s.embeddingProvider;
  }

  // ===============================
  // Preferencias de estabilidad (getters/setters rápidos)
  // ===============================
  static async getSemanticDeferNewTabUntilCommitted() {
    const s = await this.getSettings();
    return Boolean(s.semanticDeferNewTabUntilCommitted);
  }

  static async setSemanticDeferNewTabUntilCommitted(value) {
    const s = await this.setSettingsPartial({ semanticDeferNewTabUntilCommitted: Boolean(value) });
    return s.semanticDeferNewTabUntilCommitted;
  }

  static async getUiPreventAutoExpandOnAutoChanges() {
    const s = await this.getSettings();
    return Boolean(s.uiPreventAutoExpandOnAutoChanges);
  }

  static async setUiPreventAutoExpandOnAutoChanges(value) {
    const s = await this.setSettingsPartial({ uiPreventAutoExpandOnAutoChanges: Boolean(value) });
    return s.uiPreventAutoExpandOnAutoChanges;
  }

  static async getUiExpandAutoGroupOnCreate() {
    const s = await this.getSettings();
    return Boolean(s.uiExpandAutoGroupOnCreate);
  }

  static async setUiExpandAutoGroupOnCreate(value) {
    const s = await this.setSettingsPartial({ uiExpandAutoGroupOnCreate: Boolean(value) });
    return s.uiExpandAutoGroupOnCreate;
  }
}
