import fs from 'fs';
import path from 'path';

const projectRoot = process.cwd();

function ok(name, reason) {
  console.log(`OK - ${name}: ${reason}`);
  return { name, status: 'OK', reason };
}

function error(name, reason) {
  console.error(`ERROR - ${name}: ${reason}`);
  return { name, status: 'ERROR', reason };
}

function readUtf8(relativePath) {
  const full = path.join(projectRoot, relativePath);
  return fs.readFileSync(full, 'utf8');
}

function testRuntimeSelfTestHooks() {
  const name = 'self-test hooks (offscreen/autogrouper/background)';
  try {
    const autoGrouper = readUtf8(path.join('src', 'controller', 'AutoGrouper.js'));
    const offscreen = readUtf8(path.join('src', 'controller', 'offscreen.js'));
    const background = readUtf8(path.join('src', 'controller', 'background.js'));

    const hasAutoGrouperHook = autoGrouper.includes('async runOfflineSelfTests()');
    const hasOffscreenHook = offscreen.includes("msg?.type === 'OFFSCREEN_RUN_TESTS'");
    const hasBackgroundHook = background.includes("case 'RUN_OFFLINE_TESTS'");

    if (!hasAutoGrouperHook || !hasOffscreenHook || !hasBackgroundHook) {
      const missing = [
        !hasAutoGrouperHook ? 'AutoGrouper.runOfflineSelfTests' : null,
        !hasOffscreenHook ? 'OFFSCREEN_RUN_TESTS handler en offscreen' : null,
        !hasBackgroundHook ? 'RUN_OFFLINE_TESTS handler en background' : null
      ].filter(Boolean).join(', ');
      return error(name, `Hooks faltantes: ${missing}`);
    }

    return ok(name, 'Hooks de pruebas automáticas presentes');
  } catch (e) {
    return error(name, e.message || String(e));
  }
}

function testLocalAssetsExist() {
  const name = 'local assets exist';
  const required = [
    path.join('src', 'assets', 'models', 'all-MiniLM-L6-v2', 'config.json'),
    path.join('src', 'assets', 'models', 'all-MiniLM-L6-v2', 'tokenizer.json'),
    path.join('src', 'assets', 'models', 'all-MiniLM-L6-v2', 'tokenizer_config.json'),
    path.join('src', 'assets', 'models', 'all-MiniLM-L6-v2', 'onnx', 'model.onnx'),
    path.join('src', 'assets', 'models', 'all-MiniLM-L6-v2', 'onnx', 'model_quantized.onnx'),
    path.join('src', 'vendor', 'onnxruntime', 'ort-wasm.wasm'),
    path.join('src', 'vendor', 'onnxruntime', 'ort-wasm-simd.wasm'),
    path.join('src', 'vendor', 'onnxruntime', 'ort-wasm-threaded.wasm'),
    path.join('src', 'vendor', 'onnxruntime', 'ort-wasm-simd-threaded.wasm'),
    path.join('icons', 'icon48.png')
  ];

  const missing = required.filter((relativePath) => !fs.existsSync(path.join(projectRoot, relativePath)));
  if (missing.length > 0) {
    return error(name, `Faltan archivos: ${missing.join(', ')}`);
  }
  return ok(name, 'Todos los assets locales requeridos existen');
}

function testManifestCoverage() {
  const name = 'manifest web_accessible_resources coverage';
  try {
    const manifest = JSON.parse(readUtf8('manifest.json'));
    const resources = manifest.web_accessible_resources?.[0]?.resources || [];
    const requiredEntries = [
      'src/assets/models/all-MiniLM-L6-v2/config.json',
      'src/assets/models/all-MiniLM-L6-v2/tokenizer.json',
      'src/assets/models/all-MiniLM-L6-v2/tokenizer_config.json',
      'src/assets/models/all-MiniLM-L6-v2/onnx/*',
      'src/vendor/onnxruntime/ort-wasm.wasm',
      'src/vendor/onnxruntime/ort-wasm-simd.wasm',
      'src/vendor/onnxruntime/ort-wasm-threaded.wasm',
      'src/vendor/onnxruntime/ort-wasm-simd-threaded.wasm',
      'src/controller/offscreen.html',
      'src/controller/offscreen.js',
      'icons/*'
    ];

    const missing = requiredEntries.filter((entry) => !resources.includes(entry));
    if (missing.length > 0) {
      return error(name, `Entradas faltantes en manifest: ${missing.join(', ')}`);
    }

    return ok(name, 'Manifest cubre recursos críticos para pipeline offline');
  } catch (e) {
    return error(name, e.message || String(e));
  }
}

function testPipelineOfflineConfiguration() {
  const name = 'pipeline offline configuration';
  try {
    const offscreen = readUtf8(path.join('src', 'controller', 'offscreen.js'));

    const hasLocalEnabled = offscreen.includes('env.allowLocalModels = true');
    const hasRemoteDisabled = offscreen.includes('env.allowRemoteModels = false');
    const usesSingleModelIdentifier = offscreen.includes("pipeline('feature-extraction', selectedModel");

    if (!hasLocalEnabled || !hasRemoteDisabled || !usesSingleModelIdentifier) {
      const missing = [
        !hasLocalEnabled ? 'allowLocalModels=true' : null,
        !hasRemoteDisabled ? 'allowRemoteModels=false' : null,
        !usesSingleModelIdentifier ? 'pipeline con ID de modelo relativo' : null
      ].filter(Boolean).join(', ');
      return error(name, `Configuración incompleta: ${missing}`);
    }

    return ok(name, 'Pipeline configurado para carga local estricta');
  } catch (e) {
    return error(name, e.message || String(e));
  }
}

function testNotificationImageConfiguration() {
  const name = 'notifications image configuration';
  try {
    const background = readUtf8(path.join('src', 'controller', 'background.js'));
    const hasRuntimeIconUrl = background.includes("chrome.runtime.getURL('icons/icon48.png')");
    const hasNotificationCreate = background.includes('chrome.notifications.create({');

    if (!hasRuntimeIconUrl || !hasNotificationCreate) {
      const missing = [
        !hasRuntimeIconUrl ? 'chrome.runtime.getURL(icons/icon48.png)' : null,
        !hasNotificationCreate ? 'chrome.notifications.create' : null
      ].filter(Boolean).join(', ');
      return error(name, `Configuración faltante: ${missing}`);
    }

    return ok(name, 'Notificaciones configuradas con icono local');
  } catch (e) {
    return error(name, e.message || String(e));
  }
}

function testTabsRetrySafeguards() {
  const name = 'tabs retry safeguards';
  try {
    const background = readUtf8(path.join('src', 'controller', 'background.js'));
    const hasRetryHelper = background.includes('async withTabEditRetry(');
    const hasTransientMatcher = background.includes("tabs cannot be edited right now");
    const hasRetryInGrouping = background.includes("withTabEditRetry('groupTabsBulk.create'")
      || background.includes("withTabEditRetry('groupTab.create'");

    if (!hasRetryHelper || !hasTransientMatcher || !hasRetryInGrouping) {
      const missing = [
        !hasRetryHelper ? 'withTabEditRetry helper' : null,
        !hasTransientMatcher ? 'matcher de error transitorio de tabs' : null,
        !hasRetryInGrouping ? 'uso de retry en operaciones de agrupación' : null
      ].filter(Boolean).join(', ');
      return error(name, `Protecciones faltantes: ${missing}`);
    }

    return ok(name, 'Reintentos de tabs configurados para errores transitorios');
  } catch (e) {
    return error(name, e.message || String(e));
  }
}

const results = [
  testRuntimeSelfTestHooks(),
  testLocalAssetsExist(),
  testManifestCoverage(),
  testPipelineOfflineConfiguration(),
  testNotificationImageConfiguration(),
  testTabsRetrySafeguards()
];

const failed = results.filter((r) => r.status === 'ERROR');
if (failed.length > 0) {
  process.exitCode = 1;
}
