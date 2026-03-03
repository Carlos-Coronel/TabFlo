const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'you', 'your', 'are', 'was', 'were', 'have',
  'has', 'not', 'but', 'all', 'any', 'can', 'como', 'para', 'por', 'una', 'uno', 'unos', 'unas',
  'que', 'con', 'sin', 'las', 'los', 'del', 'de', 'y', 'el', 'la', 'en', 'es', 'un', 'al', 'lo'
]);

export function estimateK(n, minTabsToCluster, maxClusters) {
  if (n < minTabsToCluster) return 1;
  const heuristic = Math.round(Math.sqrt(n / 2));
  return Math.max(2, Math.min(maxClusters, heuristic));
}

export function kmeans(vectors, k, maxIter = 18) {
  const n = vectors.length;
  if (n === 0) return [];
  if (k <= 1 || n === 1) return new Array(n).fill(0);

  const dim = vectors[0]?.length || 0;
  const centroids = [];
  const used = new Set();
  while (centroids.length < k) {
    const idx = Math.floor(Math.random() * n);
    if (used.has(idx)) continue;
    used.add(idx);
    centroids.push(vectors[idx].slice());
  }

  let assignments = new Array(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dist = euclideanDistance(vectors[i], centroids[c]);
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }

    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const cluster = assignments[i];
      counts[cluster] += 1;
      for (let d = 0; d < dim; d++) {
        sums[cluster][d] += vectors[i][d] || 0;
      }
    }

    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let d = 0; d < dim; d++) {
        centroids[c][d] = sums[c][d] / counts[c];
      }
    }

    if (!changed) break;
  }

  return assignments;
}

export function buildClusterLabel(tabs) {
  const text = tabs.map(t => `${t.title} ${t.snippet || ''}`.trim()).join(' ').toLowerCase();
  const tokens = (text.match(/[a-záéíóúüñ0-9]{3,}/gi) || [])
    .map(t => t.toLowerCase())
    .filter(t => !STOPWORDS.has(t));
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 2).map(([t]) => t);
  if (top.length > 0) {
    return top.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(' · ');
  }

  const fallback = tabs.find(t => t.title)?.title || '';
  if (fallback) return fallback.slice(0, 40);

  const host = tabs.find(t => t.url)?.url || '';
  return host || 'Grupo';
}

export function buildWasmPaths(base) {
  const normalized = base.endsWith('/') ? base : `${base}/`;
  return {
    'ort-wasm.wasm': `${normalized}ort-wasm.wasm`,
    'ort-wasm-simd.wasm': `${normalized}ort-wasm-simd.wasm`,
    'ort-wasm-threaded.wasm': `${normalized}ort-wasm-threaded.wasm`,
    'ort-wasm-simd-threaded.wasm': `${normalized}ort-wasm-simd-threaded.wasm`
  };
}

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}