import { AutoGrouper } from '../src/controller/AutoGrouper.js';

function createGrouper() {
  const calls = { ensure: 0, embed: 0 };
  const grouper = new AutoGrouper({
    groupTabsBulk: async () => 1,
    broadcast: () => {},
    notify: () => {}
  });
  // Forzar modo offscreen pero sin inicializar
  grouper._pipeline = 'offscreen';
  grouper._embeddingMode = 'offscreen';
  grouper._offscreenReady = false;
  // Espiar ensureOffscreenReady
  grouper.ensureOffscreenReady = async () => { calls.ensure++; grouper._offscreenReady = true; };
  return { grouper, calls };
}

function mockChromeForEmbed() {
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (msg, cb) => {
        if (msg?.type === 'OFFSCREEN_EMBED') {
          // Responder con vectores ficticios del mismo tamaño que textos
          const vectors = Array.isArray(msg.texts) ? msg.texts.map((_, i) => [i + 0.5]) : [];
          cb && cb({ ok: true, vectors });
          return;
        }
        if (msg?.type === 'OFFSCREEN_PING' || msg?.type === 'OFFSCREEN_INIT') {
          cb && cb({ ok: true });
          return;
        }
        cb && cb({ ok: true });
      }
    }
  };
}

async function testLazyOffscreenInit() {
  const { grouper, calls } = createGrouper();
  mockChromeForEmbed();

  // Antes de calcular embeddings no debe haberse llamado ensureOffscreenReady
  if (calls.ensure !== 0) throw new Error('ensureOffscreenReady no debe llamarse antes del primer embedding');

  const out = await grouper.computeEmbeddings(['a', 'b']);
  if (!Array.isArray(out) || out.length !== 2) throw new Error('computeEmbeddings no devolvió vectores esperados');
  if (calls.ensure !== 1) throw new Error('ensureOffscreenReady debe llamarse exactamente una vez de forma perezosa');
}

(async () => {
  try {
    await testLazyOffscreenInit();
    console.log('[OK] offscreenLazyInit.test.mjs');
  } catch (e) {
    console.error('[FAIL] offscreenLazyInit.test.mjs:', e?.message || e);
    process.exitCode = 1;
  }
})();
