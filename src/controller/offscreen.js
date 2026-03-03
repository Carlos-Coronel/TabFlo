import { Logger } from '../util/Logger.js';
// Usamos el bundle local de Transformers.js (100% offline)
import { env, pipeline } from '../vendor/transformers/transformers.min.js';

const DEFAULT_MODEL = 'all-MiniLM-L6-v2';
const MODEL_ROOT_RELATIVE = 'src/assets/models/';
// Usaremos por defecto los binarios WASM empacados con la misma versión que el bundle de Transformers
// (colócalos en src/vendor/transformers/dist/). Esto evita desajustes de versión.
const WASM_ROOT_RELATIVE = 'src/vendor/transformers/dist/';

let _pipeline = null;
let _initInFlight = null;
let _readyNotified = false;

// Anunciar que el documento offscreen está cargado y listo para recibir mensajes
try {
  chrome.runtime?.sendMessage?.({ type: 'OFFSCREEN_READY' });
  _readyNotified = true;
} catch (_) {
  // Ignorar: el SW puede no estar listo aún; responderemos a OFFSCREEN_PING igualmente
}

function withTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

function buildWasmPaths(baseUrl) {
  const base = withTrailingSlash(baseUrl);
  return {
    'ort-wasm.wasm': `${base}ort-wasm.wasm`,
    'ort-wasm-simd.wasm': `${base}ort-wasm-simd.wasm`,
    'ort-wasm-threaded.wasm': `${base}ort-wasm-threaded.wasm`,
    'ort-wasm-simd-threaded.wasm': `${base}ort-wasm-simd-threaded.wasm`
  };
}

function ensureOnnxWasmBackendConfig() {
  if (!env.backends || typeof env.backends !== 'object') {
    env.backends = {};
  }
  // No mezclar con globalThis.ort: usar el backend incluido por Transformers internamente
  if (!env.backends.onnx || typeof env.backends.onnx !== 'object') {
    env.backends.onnx = {};
  }
  if (!env.backends.onnx.wasm || typeof env.backends.onnx.wasm !== 'object') {
    env.backends.onnx.wasm = {};
  }
  return env.backends.onnx.wasm;
}

function logRuntimeState(stage) {
  try {
    const hasOrtGlobal = !!globalThis.ort;
    const onnx = env?.backends?.onnx;
    const hasInference = !!onnx?.InferenceSession;
    const hasWasmCfg = !!onnx?.env?.wasm || !!onnx?.wasm;
    const wasmCfg = (onnx?.env?.wasm) || (onnx?.wasm) || {};
    Logger.warn(`ORT state [${stage}]`, {
      hasOrtGlobal,
      hasInference,
      hasWasmCfg,
      simd: wasmCfg.simd,
      numThreads: wasmCfg.numThreads,
      proxy: wasmCfg.proxy,
      initTimeout: wasmCfg.initTimeout,
      wasmPaths: wasmCfg.wasmPaths,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      webAssembly: typeof WebAssembly === 'object',
      ua: (globalThis.navigator && navigator.userAgent) || 'n/a'
    });
  } catch (_) {}
}

async function traceWasmFetchDuring(fn) {
  const originalFetch = globalThis.fetch;
  const traces = [];
  globalThis.fetch = async (input, init) => {
    const url = getInputUrl(input);
    const isWasm = typeof url === 'string' && /ort-wasm.*\.wasm$/i.test(url);
    try {
      const resp = await originalFetch(input, init);
      if (isWasm) {
        let size = -1;
        try {
          const clone = resp.clone();
          const buf = await clone.arrayBuffer();
          size = buf?.byteLength ?? -1;
        } catch (_) { /* ignore */ }
        traces.push({ url, ok: resp.ok, status: resp.status, size });
        Logger.warn('WASM fetch trace', { url, ok: resp.ok, status: resp.status, size });
      }
      return resp;
    } catch (e) {
      if (isWasm) {
        traces.push({ url, ok: false, status: 0, error: String(e?.message || e) });
        Logger.error('WASM fetch error', { url, error: String(e?.message || e) });
      }
      throw e;
    }
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    if (traces.length === 0) {
      Logger.warn('WASM fetch trace', { note: 'no .wasm requests observed' });
    }
  }
}

function applyWasmConfig(wasmRoot) {
  const wasmConfig = ensureOnnxWasmBackendConfig();
  // Preferir ruta base simple (mayor compatibilidad entre versiones de ORT web)
  const basePath = withTrailingSlash(wasmRoot);
  wasmConfig.wasmPaths = basePath;
  wasmConfig.numThreads = 1; // sin hilos => no requiere SharedArrayBuffer en offscreen
  wasmConfig.proxy = false;  // desactivar proxy/worker
  wasmConfig.simd = false;   // compatibilidad máxima; evitamos variantes SIMD que han fallado en tu entorno
  // Aumentar margen por si la carga del WASM es lenta en equipos con disco/IO lento
  wasmConfig.initTimeout = 20000;

  // No hacer suposiciones sobre globales; el bundle gestionará el registro.

  return wasmConfig;
}

function getModelAssetUrls(modelName) {
  const modelBase = withTrailingSlash(chrome.runtime.getURL(`${MODEL_ROOT_RELATIVE}${modelName}/`));
  return {
    tokenizer: `${modelBase}tokenizer.json`,
    tokenizerConfig: `${modelBase}tokenizer_config.json`,
    config: `${modelBase}config.json`,
    onnxModel: `${modelBase}onnx/model.onnx`,
    onnxModelQuantized: `${modelBase}onnx/model_quantized.onnx`
  };
}

function getInputUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

function isRemoteHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

async function checkLocalAsset(url) {
  try {
    const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (head.ok) return { ok: true, status: head.status, url };
  } catch {}

  try {
    const get = await fetch(url, { cache: 'no-store' });
    return { ok: get.ok, status: get.status, url };
  } catch (e) {
    return { ok: false, status: 0, url, error: String(e?.message || e) };
  }
}

async function runLocalAssetsCheck(modelName) {
  const wasmUrls = Object.values(buildWasmPaths(chrome.runtime.getURL(WASM_ROOT_RELATIVE)));
  const modelUrls = Object.values(getModelAssetUrls(modelName));
  const urls = [...wasmUrls, ...modelUrls];

  const checks = [];
  for (const url of urls) {
    checks.push(await checkLocalAsset(url));
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    return {
      status: 'ERROR',
      reason: `Assets inaccesibles: ${failed.map((f) => f.url).join(', ')}`,
      checks
    };
  }

  return { status: 'OK', reason: 'Todos los assets locales están accesibles', checks };
}

async function ensureInitialized(modelName) {
  if (_pipeline) return _pipeline;
  if (_initInFlight) return _initInFlight;

  _initInFlight = (async () => {
    try {
      const selectedModel = String(modelName || DEFAULT_MODEL);
      const modelRoot = withTrailingSlash(chrome.runtime.getURL(MODEL_ROOT_RELATIVE));
      const wasmRoot = withTrailingSlash(chrome.runtime.getURL(WASM_ROOT_RELATIVE));
      const wasmAssetUrls = buildWasmPaths(wasmRoot);

      logRuntimeState('before-init');

      // Configuración offline estricta
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.localModelPath = modelRoot;
      env.useBrowserCache = false;
      env.useCustomCache = false;
      env.customCache = null;

      // Preverificar accesibilidad de assets locales (modelos y WASM)
      const precheck = await runLocalAssetsCheck(selectedModel);
      if (precheck.status !== 'OK') {
        Logger.error('offscreen assets precheck failed', precheck);
      } else {
        Logger.warn('offscreen assets precheck OK');
      }

      // Configuración ONNX WASM local (mapeo explícito para evitar rutas erróneas)
      const wasmConfig = applyWasmConfig(wasmRoot);
      // Si el objeto ONNX del bundle no expone env/wasm, intentar sincronizar con el global
      try {
        const onnx = env?.backends?.onnx;
        if (onnx && !onnx.env && globalThis.ort?.env) {
          onnx.env = globalThis.ort.env;
        }
      } catch (_) {}

      logRuntimeState('after-applyWasmConfig');
      Logger.warn('offscreen WASM config', { wasmPaths: wasmConfig.wasmPaths, numThreads: wasmConfig.numThreads, simd: wasmConfig.simd, proxy: wasmConfig.proxy });

      // Importante: pasar SOLO el ID relativo del modelo.
      // Si se pasa una URL absoluta aquí, Transformers.js puede duplicar prefijos.
      try {
        _pipeline = await traceWasmFetchDuring(() => pipeline('feature-extraction', selectedModel, { local_files_only: true }));
      } catch (e1) {
        // Segundo intento: desactivar SIMD por compatibilidad (algunas CPUs/navegadores fallan con SIMD WASM)
        try {
          const wasmCfg = ensureOnnxWasmBackendConfig();
          wasmCfg.simd = false;
          if (globalThis.ort?.env?.wasm) {
            try { globalThis.ort.env.wasm.simd = false; } catch {}
          }
          Logger.warn('Retrying pipeline init with simd=false');
          _pipeline = await traceWasmFetchDuring(() => pipeline('feature-extraction', selectedModel, { local_files_only: true }));
        } catch (e2) {
          Logger.error('offscreen init failed (simd=false retry also failed)', { first: String(e1?.message || e1), second: String(e2?.message || e2), stack1: String(e1?.stack || ''), stack2: String(e2?.stack || '') });
          throw e2;
        }
      }
      Logger.debug('offscreen pipeline listo en modo offline', {
        model: selectedModel,
        localModelPath: env.localModelPath,
        wasmPaths: wasmConfig.wasmPaths,
        wasmAssetUrls
      });

      return _pipeline;
    } catch (e) {
      Logger.error('offscreen init failed:', e);
      throw e;
    } finally {
      _initInFlight = null;
    }
  })();

  return _initInFlight;
}

async function runPipelineOfflineLoadCheck(modelName) {
  const selectedModel = String(modelName || DEFAULT_MODEL);
  const originalFetch = globalThis.fetch.bind(globalThis);
  const remoteRequests = [];

  _pipeline = null;
  _initInFlight = null;

  globalThis.fetch = async (input, init) => {
    const url = getInputUrl(input);
    if (isRemoteHttpUrl(url)) {
      remoteRequests.push(url);
    }
    return originalFetch(input, init);
  };

  try {
    await ensureInitialized(selectedModel);
  } catch (e) {
    return { status: 'ERROR', reason: `pipeline failed: ${String(e?.message || e)}` };
  } finally {
    globalThis.fetch = originalFetch;
  }

  if (remoteRequests.length > 0) {
    return {
      status: 'ERROR',
      reason: `Se detectaron descargas remotas: ${remoteRequests.join(', ')}`
    };
  }

  return { status: 'OK', reason: 'Pipeline cargado en offline sin solicitudes remotas' };
}

async function runOffscreenSelfTests(modelName) {
  const selectedModel = String(modelName || DEFAULT_MODEL);
  const results = [];

  try {
    await ensureInitialized(selectedModel);
    const localEnabled = env.allowLocalModels === true;
    const remoteDisabled = env.allowRemoteModels === false;
    if (localEnabled && remoteDisabled) {
      results.push({ test: 'offscreen.env.offline', status: 'OK', reason: 'allowLocalModels=true y allowRemoteModels=false' });
    } else {
      results.push({
        test: 'offscreen.env.offline',
        status: 'ERROR',
        reason: `Flags inválidas: allowLocalModels=${String(env.allowLocalModels)}, allowRemoteModels=${String(env.allowRemoteModels)}`
      });
    }
  } catch (e) {
    results.push({ test: 'offscreen.env.offline', status: 'ERROR', reason: `Inicialización falló: ${String(e?.message || e)}` });
  }

  const assets = await runLocalAssetsCheck(selectedModel);
  results.push({ test: 'offscreen.local.assets', status: assets.status, reason: assets.reason });

  const pipelineCheck = await runPipelineOfflineLoadCheck(selectedModel);
  results.push({ test: 'offscreen.pipeline.offline', status: pipelineCheck.status, reason: pipelineCheck.reason });

  return results;
}

async function embedTexts(texts) {
  const pl = await ensureInitialized(self.__TABFLO_MODEL || DEFAULT_MODEL);
  const output = await pl(texts, { pooling: 'mean', normalize: true });
  // Normalizar salida a number[][] de forma robusta (Tensor | TypedArray | Array<TypedArray>)
  if (Array.isArray(output)) {
    return output.map((t) => ArrayBuffer.isView(t) ? Array.from(t) : (t?.data ? Array.from(t.data) : []));
  }
  if (output?.data && Array.isArray(output.dims)) {
    const data = ArrayBuffer.isView(output.data) ? output.data : new Float32Array(output.data ?? []);
    if (output.dims.length === 2) {
      const [rows, cols] = output.dims;
      const vectors = [];
      for (let r = 0; r < rows; r++) {
        const start = r * cols;
        vectors.push(Array.from(data.slice(start, start + cols)));
      }
      return vectors;
    }
    if (output.dims.length === 1) {
      return [Array.from(data)];
    }
  }
  return texts.map(() => []);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'OFFSCREEN_PING') {
      try {
        if (!_readyNotified) {
          try { chrome.runtime?.sendMessage?.({ type: 'OFFSCREEN_READY' }); } catch {}
          _readyNotified = true;
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
      return;
    }
    if (msg?.type === 'OFFSCREEN_INIT') {
      try {
        self.__TABFLO_MODEL = msg.modelName || DEFAULT_MODEL;
        // Responder inmediatamente para no mantener el canal abierto
        sendResponse({ ok: true, started: true });
        // Inicializar en segundo plano y notificar al SW cuando termine
        ensureInitialized(self.__TABFLO_MODEL)
          .then(() => {
            try { chrome.runtime?.sendMessage?.({ type: 'OFFSCREEN_INIT_DONE', ok: true }); } catch {}
          })
          .catch((e) => {
            try { chrome.runtime?.sendMessage?.({ type: 'OFFSCREEN_INIT_DONE', ok: false, error: String(e?.message || e) }); } catch {}
          });
      } catch (e) {
        try { sendResponse({ ok: false, error: String(e?.message || e) }); } catch {}
      }
      return;
    }
    if (msg?.type === 'OFFSCREEN_RUN_TESTS') {
      try {
        self.__TABFLO_MODEL = msg.modelName || DEFAULT_MODEL;
        const results = await runOffscreenSelfTests(self.__TABFLO_MODEL);
        sendResponse({ ok: true, results });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
      return;
    }
    if (msg?.type === 'OFFSCREEN_EMBED') {
      try {
        const vectors = await embedTexts(Array.isArray(msg.texts) ? msg.texts : []);
        sendResponse({ ok: true, vectors });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
      return;
    }
  })();
  return true; // Indica respuesta asíncrona
});

// Seguridad mínima: cerrar si el SW solicita
window.addEventListener('unload', () => {
  try { _pipeline = null; } catch {}
});
