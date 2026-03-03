/**
 * PersistenceManager.js
 * Capa de persistencia para la extensión TabFlo.
 * Utiliza chrome.storage.local para sincronización básica y persistencia de configuraciones.
 */
export class PersistenceManager {
  /**
   * Guarda datos en el almacenamiento local.
   * @param {string} key - Clave del dato.
   * @param {any} value - Valor a guardar.
   * @returns {Promise<void>}
   */
  static async save(key, value) {
    try {
      if (typeof chrome === 'undefined' || !chrome?.storage?.local) return; // evitar errores en contextos sin storage
      await chrome.storage.local.set({ [key]: value });
    } catch (error) {
      console.error(`Error guardando ${key}:`, error);
      throw new Error('Fallo en la persistencia de datos.');
    }
  }

  /**
   * Recupera datos del almacenamiento local.
   * @param {string} key - Clave del dato.
   * @returns {Promise<any>}
   */
  static async get(key) {
    try {
      if (typeof chrome === 'undefined' || !chrome?.storage?.local) return null;
      const result = await chrome.storage.local.get([key]);
      return result[key];
    } catch (error) {
      console.error(`Error recuperando ${key}:`, error);
      return null;
    }
  }

  /**
   * Elimina datos del almacenamiento local.
   * @param {string} key - Clave del dato.
   * @returns {Promise<void>}
   */
  static async remove(key) {
    try {
      if (typeof chrome === 'undefined' || !chrome?.storage?.local) return;
      await chrome.storage.local.remove(key);
    } catch (error) {
      console.error(`Error eliminando ${key}:`, error);
    }
  }
}
