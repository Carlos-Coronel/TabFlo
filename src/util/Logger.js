/**
 * Logger.js
 * Utilidad simple de logging con niveles y bandera de DEBUG persistente.
 */
import { ConfigModel } from '../model/ConfigModel.js';

function safeStringify(obj) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(
      obj,
      (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        if (value instanceof ArrayBuffer) {
          return `{ArrayBuffer byteLength=${value.byteLength}}`;
        }
        if (ArrayBuffer.isView(value)) {
          return `{${value.constructor.name} byteLength=${value.byteLength}}`;
        }
        return value;
      },
      2
    );
  } catch (_) {
    try {
      return String(obj);
    } catch {
      return '[Unserializable]';
    }
  }
}

function formatArg(arg) {
  if (arg instanceof Error) {
    return {
      name: arg.name,
      message: arg.message,
      stack: arg.stack
    };
  }
  // Minimal resumen para objetos de Fetch API
  if (typeof Response !== 'undefined' && arg instanceof Response) {
    return { type: 'Response', ok: arg.ok, status: arg.status, url: arg.url, redirected: arg.redirected }; 
  }
  if (typeof Request !== 'undefined' && arg instanceof Request) {
    return { type: 'Request', method: arg.method, url: arg.url, mode: arg.mode, cache: arg.cache };
  }
  if (typeof arg === 'object' && arg !== null) {
    return safeStringify(arg);
  }
  return arg;
}

export class Logger {
  static async debug(...args) {
    try {
      // Permitir forzar DEBUG sin depender de chrome.storage en contextos limitados (offscreen, early init)
      const forced = globalThis && globalThis.__TABFLO_FORCE_DEBUG === true;
      let enabled = forced;
      if (!forced && typeof chrome !== 'undefined' && chrome?.storage?.local) {
        enabled = await ConfigModel.getDebugFlag();
      } else if (!forced) {
        // Si no hay storage disponible, por diagnóstico dejamos DEBUG activo temporalmente
        enabled = true;
      }
      if (enabled) {
        console.debug('[TabFlo][DEBUG]', ...args.map(formatArg));
      }
    } catch (_) {
      console.debug('[TabFlo][DEBUG]', ...args.map(formatArg));
    }
  }
  static info(...args) {
    console.info('[TabFlo][INFO]', ...args.map(formatArg));
  }
  static warn(...args) {
    console.warn('[TabFlo][WARN]', ...args.map(formatArg));
  }
  static error(...args) {
    console.error('[TabFlo][ERROR]', ...args.map(formatArg));
  }
}
