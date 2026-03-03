/*
  Plataforma ProcGen 2D — Sistema profesional y jugable
  API principal (ESM):
    - generateMap(options)
    - printMap(map, options)
    - simulatePlayer(map, physics)
    - validateMap(map, physics)
    - regenerateIfInvalid(options, physics, maxTries?)

  Objetivos clave:
    - Rutas siempre subibles: limitamos dy y dx entre plataformas según física.
    - Micro-variación (Perlin Noise) ≤ 30% del salto vertical; nunca rompe ruta principal.
    - Simulación BFS de caminos con grafo de alcanzabilidad.
    - Validación y regeneración automática.
    - Visualización ASCII con camino óptimo y clasificación de dificultad.
*/

// ------------------------ Utilidades PRNG y ruido ------------------------

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Perlin 1D simple (suficiente para micro-variación decorativa controlada)
function makePerlin1D(rand) {
  // Gradientes pseudoaleatorios por celda
  const grads = new Map();
  const gradAt = (i) => {
    if (!grads.has(i)) grads.set(i, rand() * 2 - 1); // [-1,1]
    return grads.get(i);
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return function perlin(x) {
    const x0 = Math.floor(x);
    const x1 = x0 + 1;
    const dx = x - x0;
    const g0 = gradAt(x0);
    const g1 = gradAt(x1);
    const n0 = g0 * (dx);
    const n1 = g1 * (dx - 1);
    const u = fade(dx);
    return (1 - u) * n0 + u * n1; // rango aproximado [-1,1]
  };
}

// ------------------------ Modelos de datos ------------------------

// Plataforma: { id, x, y, w }
// Mapa: { platforms: Plataforma[], startId, bossId, meta: {...} }

// ------------------------ Generación de mapa ------------------------

/**
 * Genera una ruta base suave y plataformas jugables a lo largo de ella.
 * Nunca rompe la jugabilidad: dx y dy se limitan por la física.
 */
export function generateMap(options = {}) {
  const {
    width = 120,           // ancho lógico del mundo (unidades abstractas)
    height = 40,           // alto lógico
    stepX = 4,             // separación horizontal uniforme base entre peldaños jugables
    routeLength = 26,      // cantidad de peldaños/jumps principales hasta el jefe
    seed = 12345,
    density = 1.0,         // 1.0 = una plataforma jugable por stepX; >1 añade decorativas
    symmetry = false,      // simetría opcional (espejado horizontal)
    physics = defaultPhysics(),
  } = options;

  const rand = mulberry32(hashSeed(seed));
  const perlin = makePerlin1D(rand);

  // Curva base: seno suavizado + ligera deriva para naturalidad
  const baseAmp = Math.min(physics.maxJumpUp * 0.8, height * 0.25);
  const freq = (Math.PI * 2) / Math.max(20, routeLength * 2);

  // Ruta jugable principal (no se ve afectada por micro-variación que rompa jugabilidad)
  const platforms = [];
  let x = 2; // margen izquierdo
  let lastY = Math.floor(height * 0.25 + baseAmp); // arranque bajo

  const maxDyUp = physics.maxJumpUp - 0.001; // margen numérico
  const maxDx = physics.maxJumpHoriz;

  for (let i = 0; i < routeLength; i++) {
    // objetivo suave en curva seno
    const targetY = clamp(
      Math.round(height * 0.4 + Math.sin(i * freq) * baseAmp),
      2,
      height - 4
    );

    // limitar pendiente vertical entre peldaños para asegurar jugabilidad
    const rawDy = targetY - lastY;
    const dy = clamp(rawDy, -physics.maxDrop, maxDyUp);
    const y = clamp(lastY + dy, 2, height - 4);

    platforms.push({ id: `p${i}`, x: Math.round(x), y, w: 3 });
    lastY = y;
    x += Math.min(stepX, maxDx); // mantener distancia que siempre permita subir
  }

  // Boss arena: zona plana al final
  const bossX = Math.min(Math.round(x + 2), width - 3);
  const bossY = clamp(lastY, 2, height - 4);
  const boss = { id: 'B', x: bossX, y: bossY, w: 5 };
  // Aplanar 2-3 plataformas previas para combate claro
  for (let k = 1; k <= 2 && platforms.length - k >= 0; k++) {
    const p = platforms[platforms.length - k];
    p.y = bossY;
    p.w = Math.max(p.w, 3);
  }

  // Inicio
  const start = { id: 'S', x: 1, y: platforms[0].y, w: 3 };

  // Micro-variación decorativa con Perlin (no toca ruta principal jugable de manera peligrosa)
  const maxMicro = Math.floor(physics.maxJumpUp * 0.3);
  const decorated = [];
  // Copiar ruta principal primero (sin variación destructiva)
  decorated.push(start, ...platforms, boss);

  // Añadir plataformas decorativas entre peldaños si density > 1
  if (density > 1) {
    const extraPerGap = Math.floor(density - 1); // número entero adicional entre gaps
    for (let i = 0; i < platforms.length - 1; i++) {
      const a = platforms[i];
      const b = platforms[i + 1];
      for (let e = 1; e <= extraPerGap; e++) {
        const t = e / (extraPerGap + 1);
        const nx = lerp(a.x, b.x, t);
        const baseY = Math.round(lerp(a.y, b.y, t));
        // micro variación suave que no supera 30% y nunca sube más que a.y->b.y permitido
        const noise = perlin(nx * 0.15) * maxMicro;
        const ny = clamp(Math.round(baseY + noise), 2, height - 4);
        // Evitar romper ruta: asegurar que desde a o b se puede alcanzar si se usa
        const okFromA = isReachable(a, { x: nx, y: ny }, physics);
        const okFromB = isReachable({ x: nx, y: ny }, b, physics) || isReachable(b, { x: nx, y: ny }, physics);
        if (okFromA || okFromB) {
          decorated.push({ id: `d${i}_${e}`, x: Math.round(nx), y: ny, w: 2 });
        }
      }
    }
  }

  // Simetría opcional: reflejar mitad izquierda sobre centro
  if (symmetry) {
    const cx = Math.floor(width / 2);
    const mirror = decorated
      .filter(p => p.id !== 'S' && p.id !== 'B')
      .map(p => ({ ...p, id: `m_${p.id}`, x: clamp(2 * cx - p.x, 1, width - 2) }));
    decorated.push(...mirror);
  }

  // Eliminar solapes simples: si dos plataformas caen en mismo (x,y), fusionar por w máx
  const merged = mergeOverlaps(decorated);

  return {
    platforms: merged,
    startId: 'S',
    bossId: 'B',
    meta: { width, height, seed, density, symmetry, physics }
  };
}

function defaultPhysics() {
  return {
    maxJumpHoriz: 5, // distancia horizontal máxima por salto
    maxJumpUp: 4,    // subida vertical máxima por salto
    maxDrop: 6,      // bajada permitida (caída controlada)
  };
}

function isReachable(a, b, physics) {
  const dx = Math.abs(b.x - a.x);
  const dy = b.y - a.y; // positivo si sube
  if (dx > physics.maxJumpHoriz) return false;
  if (dy > physics.maxJumpUp) return false;
  if (dy < -physics.maxDrop) return false;
  return true;
}

function mergeOverlaps(list) {
  const key = (p) => `${p.x},${p.y}`;
  const map = new Map();
  for (const p of list) {
    const k = key(p);
    if (!map.has(k)) map.set(k, { ...p });
    else {
      const cur = map.get(k);
      cur.w = Math.max(cur.w, p.w);
    }
  }
  return Array.from(map.values());
}

// ------------------------ Simulación (grafo) ------------------------

export function simulatePlayer(map, physics = map.meta.physics) {
  const nodes = map.platforms.map(p => p.id);
  const byId = Object.fromEntries(map.platforms.map(p => [p.id, p]));
  const adj = new Map(nodes.map(id => [id, []]));

  for (let i = 0; i < map.platforms.length; i++) {
    for (let j = 0; j < map.platforms.length; j++) {
      if (i === j) continue;
      const a = map.platforms[i];
      const b = map.platforms[j];
      if (isReachable(a, b, physics)) {
        adj.get(a.id).push(b.id);
      }
    }
  }

  // BFS desde inicio
  const start = map.startId;
  const boss = map.bossId;
  const visited = new Set([start]);
  const prev = new Map();
  const q = [start];
  while (q.length) {
    const v = q.shift();
    if (v === boss) break;
    for (const w of adj.get(v)) {
      if (!visited.has(w)) {
        visited.add(w);
        prev.set(w, v);
        q.push(w);
      }
    }
  }

  // Reconstruir camino óptimo (mínimo saltos)
  let optimalPath = [];
  if (visited.has(boss)) {
    let cur = boss;
    while (cur != null) {
      optimalPath.push(cur);
      cur = prev.get(cur);
    }
    optimalPath.reverse();
  }

  // Todas las rutas accesibles (como lista de aristas visitadas simple)
  const accessible = Array.from(visited);

  return { graph: adj, visited, prev, optimalPath, accessible };
}

// ------------------------ Validación y regeneración ------------------------

export function validateMap(map, physics = map.meta.physics) {
  const sim = simulatePlayer(map, physics);
  const bossReachable = sim.visited.has(map.bossId);
  const unreachable = map.platforms
    .filter(p => !sim.visited.has(p.id))
    .map(p => p.id);

  // Clasificación de dificultad: fácil/medio/difícil según longitud de camino y desniveles
  const jumps = sim.optimalPath.length ? sim.optimalPath.length - 1 : Infinity;
  let difficulty = 'difícil';
  if (jumps <= Math.ceil(map.meta.width / (map.meta.physics.maxJumpHoriz * 1.8))) difficulty = 'fácil';
  else if (jumps <= Math.ceil(map.meta.width / (map.meta.physics.maxJumpHoriz * 1.2))) difficulty = 'medio';

  return { ok: bossReachable && unreachable.length === 0, bossReachable, unreachable, sim, difficulty };
}

export function regenerateIfInvalid(options = {}, physics = options.physics || defaultPhysics(), maxTries = 20) {
  let attempt = 0;
  let seed = (options.seed ?? 12345) | 0;
  let last;
  while (attempt < maxTries) {
    const map = generateMap({ ...options, seed });
    const val = validateMap(map, physics);
    if (val.ok) return { map, validation: val, attempts: attempt + 1 };
    // Ajuste ligero: variar seed y si persiste, reducir routeLength un poco para suavizar
    seed = (seed + 1013904223) | 0; // step PRNG distinto
    options = { ...options };
    if ((attempt % 3) === 2) {
      options.routeLength = Math.max(12, Math.floor((options.routeLength ?? 26) * 0.95));
    }
    last = { map, validation: val };
    attempt++;
  }
  return { ...last, attempts: attempt, gaveUp: true };
}

// ------------------------ Visualización ------------------------

export function printMap(map, { showCoords = true, markOptimal = true } = {}) {
  const { width, height } = map.meta;
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => '.'));
  const byId = Object.fromEntries(map.platforms.map(p => [p.id, p]));

  // Marcar plataformas
  for (const p of map.platforms) {
    for (let dx = 0; dx < p.w; dx++) {
      const gx = clamp(p.x + dx, 0, width - 1);
      const gy = clamp(p.y, 0, height - 1);
      const ch = (p.id === map.startId) ? 'S' : (p.id === map.bossId) ? 'B' : 'P';
      grid[gy][gx] = ch;
    }
  }

  // Camino óptimo con '*'
  if (markOptimal) {
    const sim = simulatePlayer(map, map.meta.physics);
    const path = sim.optimalPath;
    for (let i = 0; i < path.length - 1; i++) {
      const a = byId[path[i]];
      const b = byId[path[i + 1]];
      if (!a || !b) continue;
      // Interpolar segmento y marcar
      const steps = Math.max(1, Math.abs(b.x - a.x));
      for (let s = 0; s <= steps; s++) {
        const tx = Math.round(lerp(a.x, b.x, s / steps));
        const ty = Math.round(lerp(a.y, b.y, s / steps));
        if (grid[ty] && grid[ty][tx]) grid[ty][tx] = '*';
      }
    }
    // Reponer S y B si fueron pisados por '*'
    const S = byId[map.startId];
    const B = byId[map.bossId];
    if (S) grid[clamp(S.y, 0, height - 1)][clamp(S.x, 0, width - 1)] = 'S';
    if (B) grid[clamp(B.y, 0, height - 1)][clamp(B.x, 0, width - 1)] = 'B';
  }

  // Imprimir de arriba a abajo (y crece hacia abajo)
  let out = '';
  for (let y = 0; y < height; y++) {
    out += grid[y].join('') + '\n';
  }
  // Coordenadas de plataformas
  if (showCoords) {
    out += '\nPlataformas:\n';
    for (const p of map.platforms) {
      out += `${p.id}: (x=${p.x}, y=${p.y}, w=${p.w})\n`;
    }
  }
  console.log(out);
}

// ------------------------ Helpers ------------------------

function hashSeed(s) {
  // DJB2 simple
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i);
  }
  return h >>> 0;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

// ------------------------ Demo (si se ejecuta directamente con Node) ------------------------

if (typeof process !== 'undefined' && process.argv && import.meta.url &&
    (import.meta.url === (new URL('file://' + process.cwd().replace(/\\/g, '/') + '/' + (process.argv[1] || ''))).href)) {
  // Ejecutar demo rápida: node src/procgen/PlatformerProcGen.mjs
  const physics = { maxJumpHoriz: 5, maxJumpUp: 4, maxDrop: 6 };
  const { map, validation } = regenerateIfInvalid({ width: 80, height: 28, stepX: 4, routeLength: 20, seed: 2026, density: 1.5, symmetry: false, physics }, physics, 25);
  console.log(`Validación: ok=${validation.ok}, jefe=${validation.bossReachable}, dificultad=${validation.difficulty}`);
  printMap(map, { showCoords: false, markOptimal: true });
}

export default { generateMap, printMap, simulatePlayer, validateMap, regenerateIfInvalid };
