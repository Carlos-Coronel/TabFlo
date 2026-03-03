import { ConfigModel } from '../model/ConfigModel.js';
import { Logger } from '../util/Logger.js';
// Nota: La inferencia ONNX/Transformers se moverá a un documento offscreen.
import { buildClusterLabel, estimateK, kmeans } from './AutoGrouperUtils.js';

export class AutoGrouper {
  constructor({ groupTabsBulk, broadcast, notify }) {
    this.groupTabsBulk = groupTabsBulk;
    this.broadcast = broadcast;
    this.notify = notify;

    this.modelName = 'all-MiniLM-L6-v2';
    this.maxSnippetLength = 420;
    this.batchSize = 8;
    this.minTabsToCluster = 3;
    this.minClusterSize = 2;
    this.maxClusters = 8;
    this.debounceMs = 400;
    this.clusterColor = 'blue';
    // Umbrales de calidad para evitar mezclar temas sin relación
    this.minMemberSim = 0.35;         // similitud mínima miembro-centroide para pertenecer a un cluster
    this.minClusterCohesion = 0.42;   // cohesión media mínima de un cluster para ser aceptado

    this._timer = null;
    this._initPromise = null;
    this._offscreenInitPromise = null;
    this._pipeline = null; // marcador de inicialización ("offscreen" | "lexical")
    this._offscreenReady = false;
    this._embeddingMode = 'offscreen'; // modo actual de embeddings
    this._embeddingCache = new Map();
    this._snippetCache = new Map();
    this._lastAssignments = new Map();
    this._lastClusters = new Map();
    this._autoGroupIdsByWindow = new Map();
    // Estabilidad: mapas para “stickiness” y estado estable
    this._stableAssignments = new Map(); // tabId -> label aceptado
    this._pendingMoves = new Map(); // tabId -> { targetLabel, count, firstTs, lastTs }
    this._lastMoveTs = new Map(); // tabId -> timestamp del último cambio estable
  }

  clearTabCache(tabId) {
    if (tabId == null) return;
    this._embeddingCache.delete(tabId);
    this._snippetCache.delete(tabId);
    this._lastAssignments.delete(tabId);
    this._stableAssignments.delete(tabId);
    this._pendingMoves.delete(tabId);
    this._lastMoveTs.delete(tabId);
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      try {
        const provider = await ConfigModel.getEmbeddingProvider();
        if (provider === 'lexical') {
          this._offscreenReady = false;
          this._embeddingMode = 'lexical';
          this._pipeline = 'lexical';
          return;
        }

        // Proveedor 'openai' eliminado: sólo soportamos 'local' y 'lexical'

        // provider === 'local' | 'auto'
        // Activación perezosa (lazy): no inicializar offscreen aquí; se hará al primer cálculo de embeddings
        // cuando realmente sea necesario (y sólo si hay pestañas elegibles)
        this._pipeline = 'offscreen';
        this._embeddingMode = 'offscreen';
      } catch (e) {
        // Protección extra
        Logger.warn('AutoGrouper: init encontró un error inesperado. Usando fallback léxico.', e);
        this._offscreenReady = false;
        this._embeddingMode = 'lexical';
        this._pipeline = 'lexical';
      }
    })();
    return this._initPromise;
  }

  async ensureOffscreenReady() {
    if (this._offscreenReady) return;
    if (this._offscreenInitPromise) return this._offscreenInitPromise;

    this._offscreenInitPromise = (async () => {
      try {
        if (!chrome.offscreen?.createDocument || !chrome.offscreen?.hasDocument) {
          throw new Error('API chrome.offscreen no disponible');
        }

        // Crear documento offscreen si no existe
        const has = await chrome.offscreen?.hasDocument?.();
        if (!has) {
          try {
            await chrome.offscreen.createDocument({
              url: chrome.runtime.getURL('src/controller/offscreen.html'),
              reasons: ['BLOBS'],
              justification: 'IA local para AutoGrouper: ejecutar ONNX/Transformers en documento offscreen'
            });
          } catch (e) {
            const message = String(e?.message || e || '').toLowerCase();
            // Si otra llamada concurrente ya lo creó, continuamos.
            if (!message.includes('single offscreen document')) {
              throw e;
            }
          }
        }

        // Esperar a que el documento offscreen anuncie que está listo para recibir mensajes
        await new Promise((resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(() => {
            if (settled) return; settled = true;
            try { chrome.runtime.onMessage.removeListener(listener); } catch {}
            reject(new Error('OFFSCREEN_READY timeout'));
          }, 6000);

          const listener = (msg) => {
            if (msg?.type === 'OFFSCREEN_READY' && !settled) {
              settled = true;
              clearTimeout(timeout);
              try { chrome.runtime.onMessage.removeListener(listener); } catch {}
              resolve();
            }
          };
          try { chrome.runtime.onMessage.addListener(listener); } catch {}

          // Enviar pings periódicos por si el evento READY se perdió
          let attempts = 0;
          const ping = () => {
            if (settled) return;
            attempts++;
            chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' }, (resp) => {
              const err = chrome.runtime.lastError;
              if (!settled && !err && resp?.ok) {
                settled = true;
                clearTimeout(timeout);
                try { chrome.runtime.onMessage.removeListener(listener); } catch {}
                resolve();
              } else if (attempts < 6) {
                setTimeout(ping, 500);
              }
            });
          };
          ping();
        });

        // Enviar INIT al offscreen para construir el pipeline y esperar confirmación por evento separado
        // 1) Preparar el listener de DONE ANTES de enviar INIT para evitar race conditions
        const waitDone = new Promise((resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(() => {
            if (settled) return; settled = true;
            try { chrome.runtime.onMessage.removeListener(listener); } catch {}
            reject(new Error('OFFSCREEN_INIT_DONE timeout'));
          }, 30000);

          const listener = (msg) => {
            if (msg?.type === 'OFFSCREEN_INIT_DONE' && !settled) {
              settled = true;
              clearTimeout(timeout);
              try { chrome.runtime.onMessage.removeListener(listener); } catch {}
              if (msg.ok) {
                this._offscreenReady = true;
                resolve();
              } else {
                reject(new Error(msg?.error || 'OFFSCREEN_INIT_DONE failed'));
              }
            }
          };
          try { chrome.runtime.onMessage.addListener(listener); } catch {}
        });

        // 2) Enviar INIT y esperar el ACK rápido (opcional, pero útil para errores inmediatos)
        await new Promise((resolve, reject) => {
          let settled = false;
          const t = setTimeout(() => {
            if (settled) return; settled = true;
            reject(new Error('OFFSCREEN_INIT ack timeout'));
          }, 4000);
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_INIT', modelName: this.modelName }, (resp) => {
            const err = chrome.runtime.lastError;
            if (settled) return;
            settled = true;
            clearTimeout(t);
            if (err) return reject(err);
            if (resp && resp.ok) {
              resolve();
            } else {
              reject(new Error(resp?.error || 'OFFSCREEN_INIT failed to ack'));
            }
          });
        });

        // 3) Esperar la notificación final de DONE
        await waitDone;
        Logger.debug('Offscreen ready for embeddings');
      } catch (e) {
        Logger.error('ensureOffscreenReady failed:', e);
        throw e;
      } finally {
        this._offscreenInitPromise = null;
      }
    })();

    return this._offscreenInitPromise;
  }

  buildTestResult(test, ok, reason) {
    return {
      test,
      status: ok ? 'OK' : 'ERROR',
      reason: String(reason || (ok ? 'Sin detalles' : 'Fallo sin detalles'))
    };
  }

  async runOfflineSelfTests() {
    const results = [];

    try {
      await this.ensureOffscreenReady();
      const has = await chrome.offscreen?.hasDocument?.();
      results.push(this.buildTestResult(
        'ensureOffscreenReady',
        Boolean(has),
        has ? 'Offscreen document creado y disponible' : 'chrome.offscreen.hasDocument() devolvió false'
      ));
    } catch (e) {
      results.push(this.buildTestResult('ensureOffscreenReady', false, e?.message || e));
    }

    try {
      const offscreenReport = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_RUN_TESTS', modelName: this.modelName }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(err);
          resolve(resp);
        });
      });

      if (!offscreenReport?.ok) {
        results.push(this.buildTestResult('offscreen.selfTests', false, offscreenReport?.error || 'Respuesta inválida del offscreen'));
      } else {
        const nested = Array.isArray(offscreenReport.results) ? offscreenReport.results : [];
        if (nested.length === 0) {
          results.push(this.buildTestResult('offscreen.selfTests', false, 'Offscreen no devolvió resultados de prueba'));
        } else {
          nested.forEach((item) => {
            const ok = item?.status === 'OK';
            results.push(this.buildTestResult(item?.test || 'offscreen.unknown', ok, item?.reason || 'Sin razón'));
          });
        }
      }
    } catch (e) {
      results.push(this.buildTestResult('offscreen.selfTests', false, e?.message || e));
    }

    return results;
  }

  async ensureReady() {
    if (!this._pipeline) await this.init();
  }

  scheduleRecluster(reason = 'unknown') {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.runRecluster(reason).catch((e) => Logger.error('AutoGrouper recluster failed:', e));
    }, this.debounceMs);
  }

  async runRecluster(reason = 'manual') {
    const settings = await ConfigModel.getSettings();
    if (!settings.autoGroupBySemanticEnabled) return;

    await this.ensureReady();

    const tabs = await chrome.tabs.query({});
    const tabsByWindow = new Map();
    for (const tab of tabs) {
      if (!tab || tab.id == null) continue;
      const list = tabsByWindow.get(tab.windowId) || [];
      list.push(tab);
      tabsByWindow.set(tab.windowId, list);
    }

    for (const [windowId, windowTabs] of tabsByWindow.entries()) {
      // 1) Detectar pestañas "protegidas" (ya agrupadas por reglas/domino/manual => grupo título no "Auto:")
      const protectedTabIds = new Set();
      try {
        const groupIds = new Set();
        for (const t of windowTabs) {
          const gid = t?.groupId;
          if (gid != null && gid !== (chrome?.tabGroups?.TAB_GROUP_ID_NONE ?? -1)) groupIds.add(gid);
        }
        const titleByGroupId = new Map();
        if (groupIds.size > 0 && chrome?.tabGroups?.get) {
          for (const gid of groupIds) {
            try {
              const g = await chrome.tabGroups.get(gid);
              const title = String(g?.title || '').trim().toLowerCase();
              titleByGroupId.set(gid, title);
            } catch (_) {}
          }
        }
        for (const t of windowTabs) {
          const gid = t?.groupId;
          if (gid == null || gid === (chrome?.tabGroups?.TAB_GROUP_ID_NONE ?? -1)) continue;
          const lower = titleByGroupId.get(gid);
          if (lower && !lower.startsWith('auto:')) protectedTabIds.add(t.id);
        }
      } catch (_) {}

      // 2) Trabajar sólo con pestañas no protegidas (o sin grupo) para activar offscreen únicamente cuando haga falta
      const eligibleTabs = windowTabs.filter(t => !protectedTabIds.has(t.id));
      const tabInfos = await this.buildTabInfos(eligibleTabs);
      if (tabInfos.length < 2) continue;

      await this.populateEmbeddings(tabInfos);
      const clusters = this.clusterTabInfos(tabInfos);

      this.emitHooks(clusters, reason);
      await this.applyClusters(windowId, clusters, settings);
    }
  }

  async buildTabInfos(tabs) {
    const results = await Promise.all(tabs.map(async (tab) => {
      const text = await this.getTabText(tab);
      const signature = `${tab.title || ''}|${tab.url || ''}|${text}`;
      return {
        tab,
        text,
        signature,
        embedding: null
      };
    }));
    return results.filter(r => r.text && r.text.length > 0);
  }

  async getTabText(tab) {
    const title = String(tab.title || '').trim();
    const url = String(tab.url || '').trim();
    const snippet = await this.getTabSnippet(tab, title, url);
    const parts = [title, snippet, url].filter(Boolean);
    return parts.join('\n').trim();
  }

  async getTabSnippet(tab, title, url) {
    if (!tab?.id || !this.isSnippetEligible(url)) return '';
    const cached = this._snippetCache.get(tab.id);
    if (cached && cached.url === url && cached.title === title) return cached.snippet;

    if (!chrome?.scripting?.executeScript) return '';
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (max) => {
          try {
            const pick = (sel) => {
              const el = document.querySelector(sel);
              return (el && (el.content || el.getAttribute('content') || el.textContent) || '').trim();
            };
            const metaDesc = pick('meta[name="description"]');
            const ogDesc = pick('meta[property="og:description"]');
            const headings = Array.from(document.querySelectorAll('h1, h2'))
              .map(h => (h.textContent || '').trim())
              .filter(Boolean)
              .join(' ');
            const body = (document.body?.innerText || '').trim();

            // Componer priorizando encabezados y descripciones
            const raw = [headings, metaDesc || ogDesc, body]
              .filter(Boolean)
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
            return raw.slice(0, max);
          } catch(_) {
            const text = document.body?.innerText || '';
            return text.replace(/\s+/g, ' ').trim().slice(0, max);
          }
        },
        args: [this.maxSnippetLength]
      });
      const snippet = String(res?.result || '').trim();
      this._snippetCache.set(tab.id, { url, title, snippet });
      return snippet;
    } catch (e) {
      return '';
    }
  }

  isSnippetEligible(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  async populateEmbeddings(tabInfos) {
    const pendingTexts = [];
    const pendingInfos = [];

    for (const info of tabInfos) {
      const tabId = info.tab?.id;
      const cached = this._embeddingCache.get(tabId);
      if (cached && cached.signature === info.signature) {
        info.embedding = cached.embedding;
      } else {
        pendingTexts.push(info.text);
        pendingInfos.push(info);
      }
    }

    for (let i = 0; i < pendingTexts.length; i += this.batchSize) {
      const chunkTexts = pendingTexts.slice(i, i + this.batchSize);
      const chunkInfos = pendingInfos.slice(i, i + this.batchSize);
      const vectors = await this.computeEmbeddings(chunkTexts);
      for (let j = 0; j < chunkInfos.length; j++) {
        const info = chunkInfos[j];
        const vector = vectors[j] || [];
        info.embedding = vector;
        const tabId = info.tab?.id;
        if (tabId != null) {
          this._embeddingCache.set(tabId, { signature: info.signature, embedding: vector });
        }
      }
    }
  }

  async computeEmbeddings(texts) {
    // Si ya estamos en modo léxico, evitamos offscreen
    if (this._embeddingMode === 'lexical') {
      return this.lexicalEmbed(texts);
    }

    // Proveedor remoto eliminado

    try {
      if (!this._offscreenReady) await this.ensureOffscreenReady();
      const resp = await new Promise((resolve, reject) => {
        let settled = false;
        const t = setTimeout(() => {
          if (settled) return; settled = true;
          reject(new Error('OFFSCREEN_EMBED timeout'));
        }, 12000);
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_EMBED', texts }, (out) => {
          const err = chrome.runtime.lastError;
          if (settled) return;
          settled = true;
          clearTimeout(t);
          if (err) return reject(err);
          if (out && out.ok) return resolve(out.vectors || []);
          reject(new Error(out?.error || 'OFFSCREEN_EMBED failed'));
        });
      });
      return resp;
    } catch (e) {
      // Si el backend no está disponible, pivotamos a embeddings léxicos para no bloquear la función
      const msg = String(e?.message || e || '').toLowerCase();
      if (msg.includes('no available backend') || msg.includes('offscreen_init') || msg.includes('offscreen_embed')) {
        Logger.warn('AutoGrouper: OFFSCREEN_EMBED/INIT falló, usando fallback léxico. Motivo:', e);
        this._embeddingMode = 'lexical';
        this._pipeline = 'lexical';
        return this.lexicalEmbed(texts);
      }
      // Para otros errores, también aplicamos fallback como último recurso
      Logger.warn('AutoGrouper: error inesperado en embeddings offscreen, usando fallback léxico.', e);
      this._embeddingMode = 'lexical';
      this._pipeline = 'lexical';
      return this.lexicalEmbed(texts);
    }
  }

  // Integración con proveedores remotos eliminada: sólo local/offline y fallback léxico

  // Fallback simple sin dependencias: vectorización léxica por hashing y normalización L2
  lexicalEmbed(texts) {
    const dim = 256; // dimensión compacta para clustering ligero
    const stop = new Set([
      'the','and','for','with','from','this','that','you','your','are','was','were','have','has','not','but','all','any','can','como','para','por','una','uno','unos','unas','que','con','sin','las','los','del','de','y','el','la','en','es','un','al','lo'
    ]);

    const hash = (s) => {
      let h = 2166136261 >>> 0; // FNV-1a
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    };

    const tokenize = (t) => (String(t || '')
      .toLowerCase()
      .match(/[a-záéíóúüñ0-9]{3,}/gi) || [])
      .filter(tok => !stop.has(tok));

    const vectors = [];
    for (const text of texts) {
      const v = new Float32Array(dim);
      const toks = tokenize(text);
      for (const tok of toks) {
        const idx = hash(tok) % dim;
        v[idx] += 1;
      }
      // normalización L2
      let norm = 0;
      for (let i = 0; i < dim; i++) norm += v[i] * v[i];
      norm = Math.sqrt(norm) || 1;
      const row = new Array(dim);
      for (let i = 0; i < dim; i++) row[i] = v[i] / norm;
      vectors.push(row);
    }
    return vectors;
  }

  clusterTabInfos(tabInfos) {
    const vectors = tabInfos.map(info => info.embedding || []);
    const total = vectors.length;
    const k = estimateK(total, this.minTabsToCluster, this.maxClusters);
    const assignments = kmeans(vectors, k);

    // Construir clusters crudos
    const rawClusters = new Map();
    assignments.forEach((clusterIndex, idx) => {
      if (!rawClusters.has(clusterIndex)) rawClusters.set(clusterIndex, []);
      rawClusters.get(clusterIndex).push(tabInfos[idx]);
    });

    const accepted = [];
    const globalOutliers = [];

    // Funciones auxiliares
    const cosine = (a, b) => {
      let dot = 0, na = 0, nb = 0;
      const L = Math.max(a.length, b.length);
      for (let i = 0; i < L; i++) {
        const ai = a[i] || 0;
        const bi = b[i] || 0;
        dot += ai * bi;
        na += ai * ai;
        nb += bi * bi;
      }
      const denom = (Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1);
      return denom ? (dot / denom) : 0;
    };
    const centroid = (mems) => {
      if (!mems || mems.length === 0) return [];
      const dim = mems[0]?.embedding?.length || 0;
      const c = new Array(dim).fill(0);
      for (const m of mems) {
        const v = m.embedding || [];
        for (let d = 0; d < dim; d++) c[d] += v[d] || 0;
      }
      for (let d = 0; d < c.length; d++) c[d] /= mems.length;
      return c;
    };

    const evaluateCluster = (members) => {
      if (!members || members.length === 0) return { core: [], out: [], cohesion: 0 };
      const c = centroid(members);
      const sims = members.map(m => cosine(m.embedding || [], c));
      const core = [];
      const out = [];
      let sum = 0;
      for (let i = 0; i < members.length; i++) {
        const s = sims[i];
        sum += s;
        if (s >= this.minMemberSim) core.push(members[i]);
        else out.push(members[i]);
      }
      const cohesion = sum / members.length;
      return { core, out, cohesion };
    };

    // 1) Filtrar por cohesión y outliers por cluster
    for (const members of rawClusters.values()) {
      if (!members || members.length === 0) continue;
      if (members.length < this.minClusterSize) {
        // Demasiado pequeño: considerar para re-agrupación posterior
        globalOutliers.push(...members);
        continue;
      }

      const eval1 = evaluateCluster(members);
      // Si la cohesión es muy baja, intentar dividir en 2 subclusters
      if (eval1.cohesion < this.minClusterCohesion && members.length >= (this.minClusterSize * 2)) {
        const subVectors = members.map(m => m.embedding || []);
        const subAssign = kmeans(subVectors, 2);
        const subMap = new Map();
        subAssign.forEach((ci, idx) => {
          if (!subMap.has(ci)) subMap.set(ci, []);
          subMap.get(ci).push(members[idx]);
        });
        for (const subMembers of subMap.values()) {
          if (subMembers.length < this.minClusterSize) {
            globalOutliers.push(...subMembers);
            continue;
          }
          const ev = evaluateCluster(subMembers);
          if (ev.core.length >= this.minClusterSize && ev.cohesion >= this.minClusterCohesion) {
            accepted.push(ev.core);
            if (ev.out.length) globalOutliers.push(...ev.out);
          } else {
            globalOutliers.push(...subMembers);
          }
        }
      } else {
        // Cohesión aceptable o no divisible
        if (eval1.core.length >= this.minClusterSize && eval1.cohesion >= this.minClusterCohesion) {
          accepted.push(eval1.core);
          if (eval1.out.length) globalOutliers.push(...eval1.out);
        } else {
          // Cluster pobre: enviar a outliers para intentar re-agrupación global
          globalOutliers.push(...members);
        }
      }
    }

    // 2) Intentar formar clusters adicionales con outliers si son suficientes
    if (globalOutliers.length >= this.minClusterSize) {
      const remain = [...globalOutliers];
      // Re-clusterizar con un k heurístico pequeño para evitar sobre-agrupación
      const k2 = Math.min(estimateK(remain.length, this.minTabsToCluster, this.maxClusters), 3);
      const vec2 = remain.map(m => m.embedding || []);
      const asg2 = kmeans(vec2, Math.max(2, k2));
      const map2 = new Map();
      asg2.forEach((ci, idx) => {
        if (!map2.has(ci)) map2.set(ci, []);
        map2.get(ci).push(remain[idx]);
      });
      const newAccepted = [];
      for (const mm of map2.values()) {
        if (mm.length < this.minClusterSize) continue;
        const ev = evaluateCluster(mm);
        if (ev.core.length >= this.minClusterSize && ev.cohesion >= this.minClusterCohesion) {
          newAccepted.push(ev.core);
        }
      }
      if (newAccepted.length > 0) accepted.push(...newAccepted);
    }

    // 3) Construir objetos de salida
    const result = [];
    for (const members of accepted) {
      if (!members || members.length === 0) continue;
      const label = buildClusterLabel(members.map(m => ({
        title: m.tab.title || '',
        url: m.tab.url || '',
        snippet: m.text || ''
      })));
      result.push({
        label,
        tabs: members.map(m => m.tab),
        tabIds: members.map(m => m.tab.id)
      });
    }
    return result;
  }


  emitHooks(clusters, reason) {
    const currentAssignments = new Map();
    const currentClusters = new Map();

    for (const cluster of clusters) {
      const label = cluster.label;
      const tabIds = cluster.tabIds.filter(id => id != null);
      currentClusters.set(label, new Set(tabIds));
      for (const tabId of tabIds) {
        currentAssignments.set(tabId, label);
      }
    }

    for (const [tabId, label] of currentAssignments.entries()) {
      const prev = this._lastAssignments.get(tabId);
      if (prev && prev !== label) {
        this.broadcast?.({ action: 'AUTO_GROUP_TAB_MOVED', tabId, from: prev, to: label, reason });
      }
    }

    for (const [label, members] of currentClusters.entries()) {
      const prev = this._lastClusters.get(label);
      if (!prev) {
        this.broadcast?.({ action: 'AUTO_GROUP_CLUSTER_CREATED', label, size: members.size, reason });
      } else if (!this.setEquals(prev, members)) {
        this.broadcast?.({ action: 'AUTO_GROUP_CLUSTER_UPDATED', label, size: members.size, reason });
      }
    }

    this._lastAssignments = currentAssignments;
    this._lastClusters = currentClusters;
  }

  setEquals(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }

  async applyClusters(windowId, clusters, settings) {
    // Aplicación incremental: no limpiar grupos en cada ciclo.
    const newGroupIds = new Set();

    // Jerarquía de agrupación: respetar primero reglas JSON y dominio (si aplicaron).
    // Para ello, evitamos que la agrupación semántica mueva pestañas que ya
    // pertenecen a un grupo "no-Auto" (p. ej., creados por reglas o por dominio).
    // Heurística: consideramos "Auto" aquellos grupos con título que comienza por "Auto:".
    // Todo grupo con otro título se trata como protegido.
    const protectedTabIds = new Set();
    try {
      // Recopilar todos los groupId presentes en los clusters
      const groupIds = new Set();
      const tabById = new Map();
      for (const cluster of clusters) {
        for (const t of (cluster.tabs || [])) {
          if (!t || t.id == null) continue;
          tabById.set(t.id, t);
          const gid = t.groupId;
          if (gid != null && typeof gid !== 'undefined' && gid !== (chrome?.tabGroups?.TAB_GROUP_ID_NONE ?? -1)) {
            groupIds.add(gid);
          }
        }
      }

      // Consultar títulos de grupos si la API está disponible
      const titleByGroupId = new Map();
      if (groupIds.size > 0 && chrome?.tabGroups?.get) {
        for (const gid of groupIds) {
          try {
            const g = await chrome.tabGroups.get(gid);
            titleByGroupId.set(gid, String(g?.title || ''));
          } catch (_) {
            // ignorar errores al leer el grupo (puede haberse eliminado)
          }
        }
      }

      // Marcar tabs protegidas (grupo con título no-"Auto:")
      for (const [id, t] of tabById.entries()) {
        const gid = t.groupId;
        if (gid == null || gid === (chrome?.tabGroups?.TAB_GROUP_ID_NONE ?? -1)) continue;
        const title = titleByGroupId.get(gid);
        if (!title) continue; // si no conocemos el título, no bloqueamos
        const lower = String(title).trim().toLowerCase();
        if (!lower.startsWith('auto:')) {
          protectedTabIds.add(id);
        }
      }
    } catch (_) {
      // Fallback silencioso: si algo falla, no bloqueamos nada
    }

    // Construir asignaciones propuestas: tabId -> label
    const proposed = new Map();
    for (const c of clusters) {
      for (const id of (c.tabIds || [])) {
        if (id != null) proposed.set(id, c.label);
      }
    }

    const stickinessOn = settings.semanticStickinessEnabled !== false;
    const rawConsec = Number(settings.semanticStickinessConsecutiveRequired);
    const needConsecutive = Math.max(1, Number.isFinite(rawConsec) ? rawConsec : 2);
    const rawDwell = Number(settings.semanticMinDwellMsBeforeReassign);
    const minDwell = Math.max(0, Number.isFinite(rawDwell) ? rawDwell : 30000);

    // Filtrar por cluster: sólo mover pestañas elegibles y aceptadas según “stickiness”
    for (const cluster of clusters) {
      const allIds = (cluster.tabIds || []).filter(x => x != null);
      if (allIds.length < this.minClusterSize) continue;

      const acceptedIds = [];
      for (const tabId of allIds) {
        // Respetar jerarquía: si la pestaña ya está en un grupo no-Auto (reglas/domino/manual), no moverla
        if (protectedTabIds.has(tabId)) {
          try { await Logger.debug('applyClusters.skip.protected', { tabId, reason: 'non-auto group' }); } catch {}
          continue;
        }
        const label = cluster.label;
        const prevStable = this._stableAssignments.get(tabId);
        try { await Logger.debug('applyClusters.iter', { tabId, label, prevStable }); } catch {}
        if (!stickinessOn) {
          // Sin stickiness: aceptar siempre y marcar como estable
          this._stableAssignments.set(tabId, label);
          acceptedIds.push(tabId);
          try { await Logger.debug('applyClusters.accept.noStickiness', { tabId, label }); } catch {}
          continue;
        }

        if (!prevStable) {
          // Primera asignación estable
          this._stableAssignments.set(tabId, label);
          this._lastMoveTs.set(tabId, Date.now());
          // Aceptamos el movimiento inicial
          acceptedIds.push(tabId);
          // Limpiar pending si existiera
          this._pendingMoves.delete(tabId);
          try { await Logger.debug('applyClusters.accept.first', { tabId, label }); } catch {}
          continue;
        }

        if (prevStable === label) {
          // Se mantiene en su grupo estable -> sin movimiento
          this._pendingMoves.delete(tabId);
          try { await Logger.debug('applyClusters.keep', { tabId, label }); } catch {}
          continue; // ya está dentro; si falta, no forzamos mover porque debería permanecer
        }

        // Evaluar cambio de grupo con histeresis
        const now = Date.now();
        const lastMove = this._lastMoveTs.get(tabId) || 0;
        const dwellOk = (now - lastMove) >= minDwell;
        // Fast-path: si sólo se requiere 1 consecutiva y cumple dwell, aceptar de inmediato
        if (dwellOk && needConsecutive <= 1) {
          this._stableAssignments.set(tabId, label);
          this._lastMoveTs.set(tabId, now);
          this._pendingMoves.delete(tabId);
          acceptedIds.push(tabId);
          try { await Logger.debug('applyClusters.accept.fast', { tabId, label }); } catch {}
          continue;
        }
        const p = this._pendingMoves.get(tabId);
        if (p && p.targetLabel === label) {
          p.count += 1;
          p.lastTs = now;
          this._pendingMoves.set(tabId, p);
        } else {
          this._pendingMoves.set(tabId, { targetLabel: label, count: 1, firstTs: now, lastTs: now });
        }
        const cur = this._pendingMoves.get(tabId);
        if (dwellOk && cur.count >= needConsecutive) {
          // Aceptar el cambio
          this._stableAssignments.set(tabId, label);
          this._lastMoveTs.set(tabId, now);
          this._pendingMoves.delete(tabId);
          acceptedIds.push(tabId);
          try { await Logger.debug('applyClusters.accept.hysteresis', { tabId, label, count: cur.count }); } catch {}
        }
      }

      if (acceptedIds.length >= this.minClusterSize) {
        const groupTitle = `Auto: ${cluster.label}`;
        const groupId = await this.groupTabsBulk(acceptedIds, groupTitle, this.clusterColor);
        try { await Logger.debug('applyClusters.group', { label: cluster.label, acceptedCount: acceptedIds.length }); } catch {}
        if (groupId != null) newGroupIds.add(groupId);
        if (settings.autoSuspendBySemanticCluster) {
          const filteredCluster = { ...cluster, tabs: (cluster.tabs || []).filter(t => acceptedIds.includes(t.id)), tabIds: acceptedIds };
          await this.autoSuspendCluster(filteredCluster, settings);
        }
      }
    }

    // Mantener referencia de grupos automáticos creados
    if (newGroupIds.size > 0) {
      const prev = this._autoGroupIdsByWindow.get(windowId) || new Set();
      const merged = new Set([...prev, ...newGroupIds]);
      this._autoGroupIdsByWindow.set(windowId, merged);
    }

    if (settings.autoGroupSemanticNotifications && clusters.length > 0) {
      this.notify?.('Autoagrupador', `Agrupación semántica aplicada.`);
    }
  }

  async clearAutoGroups(windowId) {
    const groupIds = this._autoGroupIdsByWindow.get(windowId);
    if (!groupIds || groupIds.size === 0) return;
    for (const groupId of groupIds) {
      try {
        const groupedTabs = await chrome.tabs.query({ windowId, groupId });
        const ids = groupedTabs.map(t => t.id).filter(id => id != null);
        if (ids.length > 0) await chrome.tabs.ungroup(ids);
      } catch {}
    }
  }

  async autoSuspendCluster(cluster, settings) {
    const exclusions = Array.isArray(settings.suspendExclusions) ? settings.suspendExclusions : [];
    for (const tab of cluster.tabs) {
      if (!tab || tab.id == null) continue;
      if (tab.active || tab.pinned) continue;
      const domain = this.extractDomain(tab.url);
      if (domain && exclusions.includes(domain)) continue;
      try { await chrome.tabs.discard(tab.id); } catch {}
    }
  }

  extractDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  }
}