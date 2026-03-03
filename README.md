# TabFlo v2.0 (Chrome/Chromium)
Organiza y domina tus pestañas con un dashboard potente, búsqueda inteligente, auto‑agrupación semántica/local, sesiones, árbol animado de historial y estadísticas en tiempo real.

TabFlo es una extensión ligera y enfocada en la comodidad: menos clics, más contexto y cero ruido visual. Ideal para quienes trabajan con muchas pestañas y necesitan ordenarlas, guardarlas y recuperarlas sin esfuerzo.

—

## 📚 Índice

- [Para usuarios](#para-usuarios)
  - [TL;DR (Uso en 30 segundos)](#tldr-uso-en-30-segundos)
  - [Principales características](#-principales-características)
  - [Guía paso a paso](#-guía-paso-a-paso)
  - [Preferencias y reglas](#-preferencias-y-reglas)
  - [Atajos de teclado](#-atajos-de-teclado)
  - [Permisos y privacidad](#-permisos-y-privacidad)
  - [Instalación (modo desarrollador)](#-instalación-modo-desarrollador)
  - [FAQ](#-solución-de-problemas-faq)
- [Para desarrolladores](#para-desarrolladores)
  - [Requisitos](#requisitos)
  - [Estructura del proyecto](#estructura-del-proyecto)
  - [Arquitectura y flujo](#arquitectura-y-flujo)
  - [IA local: embeddings y offscreen](#ia-local-embeddings-y-offscreen)
  - [Modelos y binarios WASM](#modelos-y-binarios-wasm)
  - [Ejecución de tests](#ejecución-de-tests)
  - [Guía de desarrollo local](#guía-de-desarrollo-local)
  - [Flujo de trabajo con Git](#flujo-de-trabajo-con-git)
  - [Empaquetado y publicación](#empaquetado-y-publicación)
  - [Consejos de depuración](#consejos-de-depuración)
  - [Contribuir](#-contribuir)
  - [Notas de versión](#-notas-de-versión-extracto-v2x)

—

## Para usuarios

### 🧪 TL;DR (Uso en 30 segundos)

1) Instala la extensión en modo desarrollador (ver más abajo).
2) Abre el Dashboard desde el icono o crea un atajo en `chrome://extensions/shortcuts`.
3) Escribe en la barra de búsqueda para filtrar por título/URL (fuzzy).
4) Selecciona múltiples pestañas con `Shift`/`Ctrl` y aplica acciones en bloque.
5) Guarda la sesión con nombre y proyecto; restaúrala cuando quieras.
6) Explora el “Árbol de Pestañas e Historial” para una vista creativa por fecha y dominios.

—

### 🚀 Principales características

- Gestión avanzada de pestañas
  - Multi‑selección con `Shift + Click` (rangos) y `Ctrl + Click` (individual).
  - Acciones en bloque: agrupar, mover entre ventanas, fijar/desfijar y cerrar.
  - Drag & drop para reordenar desde el Dashboard.

- Búsqueda fuzzy instantánea
  - Coincide por subsecuencias en títulos y URLs, tolerante a errores tipográficos.
  - Filtros rápidos por chips: Esta ventana, Fijadas, Sonando, Suspendidas.

- Auto‑agrupación (dominio y semántica local)
  - Por Dominio/Categoría: crea grupos con color y nombre automáticamente.
  - Por Semántica (IA 100% local): agrupa por similitud de contenido cuando las reglas/domino no aplican. Respeta siempre la jerarquía y nunca reubica pestañas que ya pertenecen a grupos “protegidos” (no comienzan con `Auto:`).
  - Nombres de grupo inteligentes: sugiere títulos basados en tema extraído del contenido (encabezados H1/H2, meta/OG description y texto visible), p. ej. `Auto: Infraestructura Cloud`.
  - Rendimiento: inicialización perezosa del documento offscreen y del pipeline de embeddings; sólo se activa si hay pestañas sin clasificar por reglas/dominio.

- Sesiones y respaldos
  - Guarda la sesión actual con nombre y etiqueta de proyecto.
  - Importa/Exporta JSON para backups y migraciones.
  - Restaura selectivamente manteniendo ventanas y grupos.

- Árbol animado de Pestañas e Historial
  - Agrupación inteligente: pestañas/ventanas cerradas organizadas por fecha y luego por dominio.
  - Filtrado dinámico: buscador dedicado para el historial y botones de restauración masiva.
  - Controles: Actualizar, Expandir/Colapsar todo y Limpiar historial local.

- Estadísticas de RAM y pestañas
  - Uso de RAM en tiempo real (permiso `system.memory`).
  - Contador de pestañas y estimación del uso de memoria de Chrome.

- Interfaz adaptativa y cómoda
  - Dashboard completo con barra lateral.
  - Vista vertical compacta (`~380×700px`) para trabajo en paralelo.
  - Modo compacto para listar cientos de pestañas sin scroll infinito.

—

### 🧭 Guía paso a paso

#### 1) Abrir el Dashboard
- Haz clic en el icono de la extensión o asigna un atajo desde `chrome://extensions/shortcuts`.
- Botón “Vista vertical” para abrir un panel lateral ideal en pantallas anchas.

#### 2) Buscar y filtrar
- Escribe en “Buscar pestañas (fuzzy)…”. No hace falta escribir exacto: `gthb iss` coincide con “GitHub Issues”.
- Usa los chips de filtro para ver solo:
  - “Esta ventana” (pestañas de la ventana actual)
  - “Fijadas”
  - “Sonando” (con audio)
  - “Suspendidas” (descartadas)

#### 3) Seleccionar varias pestañas y actuar en bloque
- Selección múltiple:
  - `Shift + Click`: selecciona un rango.
  - `Ctrl + Click`: añade/quita elementos individuales.
- Acciones disponibles en la barra de multi‑selección:
  - Mover a otra ventana o a una nueva.
  - Agrupar en un `tabGroup` (con color y nombre).
  - Fijar / Desfijar.
  - Cerrar seleccionadas.

#### 4) Organización automática y limpieza
- Agrupar por Dominio: botón “Agrupar por Dominio”.
- Cerrar Duplicadas: encuentra URLs repetidas y cierra copias.
- Silenciar Otras: deja solo la activa con sonido.
- Suspender Inactivas: descarta pestañas no usadas para liberar RAM (respeta lista blanca).

#### 5) Sesiones (guardar, restaurar, backup)
- Guarda tu sesión actual con un nombre y, opcionalmente, una etiqueta de proyecto.
- Restaura ventanas y pestañas cuando quieras (incluso parcialmente).
- Exporta/Importa sesiones en JSON para backup o migraciones entre equipos.

#### 6) Árbol de Pestañas e Historial (vista animada)
- Vista inteligente: tus pestañas y ventanas cerradas recientemente, organizadas jerárquicamente.
- Agrupación multinivel:
  - Nivel 1: Por fecha (día de cierre).
  - Nivel 2: Por dominio (sitio web).
- Filtrado dinámico: usa la barra de búsqueda del árbol para encontrar rápidamente por título, URL o nombre del dominio.
- Acciones rápidas:
  - “Abrir”: restaura una pestaña individual.
  - “Abrir todos”: restaura todas las pestañas de un dominio específico de un solo clic.
- Controles de vista:
  - “↻ Actualizar”: recarga datos de la API de sesiones y el historial local.
  - “＋ Expandir” / “－ Colapsar”: abre o cierra todos los nodos del árbol.
  - “🧹 Limpiar Local”: borra el historial guardado localmente por la extensión.

#### 7) Stats de Memoria
- Ve el uso de RAM y el conteo de pestañas en tiempo real.
- Si la API nativa de procesos no está disponible, la app estima el uso de memoria de Chrome.

—

### ⚙️ Preferencias y reglas

#### Preferencias (Dashboard → Configuración & Debug)
- “Eliminar grupos al iniciar”: desagrupa tabs automáticamente al abrir el navegador.
- “Agrupar por dominio/categoría (auto)”: intenta ubicar tabs nuevas en grupos según reglas.
- “Agrupar por semántica (IA local)”: reagrupa periódicamente por similitud de contenido.
- “Excluir dominios de Suspender Inactivas”: mantén ciertos sitios siempre activos.

#### Reglas de auto‑agrupación (por dominio/categoría)
- Crea reglas por dominio/host o patrones (coma‑separados): p. ej. `github.com, gitlab.com` → grupo “Desarrollo” (color púrpura).
- Edita/Elimina reglas desde la lista; exporta/importa reglas JSON; restáuralas a valores por defecto.

#### Jerarquía de auto‑agrupación
- Orden de aplicación (siempre en este orden):
  1) Reglas definidas en JSON (dominio/categoría y excepciones).
  2) Agrupación por Dominio (si está activada en Preferencias).
  3) Agrupación Semántica local (IA) como último recurso.
- Grupos protegidos: cualquier grupo cuyo título no empiece por `Auto:` se considera manual o por regla y no será modificado por la IA.
- Cohesión y outliers: la IA sólo propone grupos cuando detecta suficiente similitud entre miembros; detecta y aparta outliers automáticamente.

—

### ⌨️ Atajos de teclado

Atajos globales con asignación por defecto:

| Atajo | Acción |
|---|---|
| `Alt+Shift+←` | Mover pestaña activa a la izquierda |
| `Alt+Shift+→` | Mover pestaña activa a la derecha |

Atajos sin asignación por defecto (configúralos tú):

- Abrir el Dashboard principal (comando: `open-dashboard`).
- Guardar sesión actual (comando: `save-session`).

Para asignarlos, abre `chrome://extensions/shortcuts` y busca “TabFlo”.

Accesos rápidos dentro del Dashboard:

| Atajo | Acción |
|---|---|
| `Alt + F` | Enfocar barra de búsqueda |
| `Alt + V` | Abrir Dashboard en modo vertical |
| `Alt + M` | Alternar modo compacto |
| `Alt + S` | Abrir diálogo de guardar sesión |
| `Alt + R` | Recargar datos manualmente |
| `Alt + A` | Seleccionar todas las pestañas |
| `Delete` | Cerrar pestañas seleccionadas |
| `Escape` | Limpiar selección / Cerrar paneles |

—

### 🔒 Permisos y privacidad

- `tabs`, `tabGroups`, `sessions`: gestionar pestañas, grupos y sesiones.
- `storage`: guardar preferencias y sesiones localmente en tu navegador.
- `notifications`, `alarms`: recordatorios y tareas temporizadas (p. ej. pestañas temporales).
- `system.memory`, `management`: estadísticas del sistema y extensiones (solo lectura). Si `system.memory` no está disponible, se usa estimación.
- `offscreen`, `scripting`: necesarios para IA local (documento offscreen) y operaciones avanzadas.

Privacidad ante todo: tus datos no salen del navegador. No hay servidores externos ni analíticas.

Notas de privacidad específicas de IA local:
- El modelo `all-MiniLM-L6-v2` y los binarios WASM se cargan desde el propio paquete de la extensión (recursos accesibles por la web).
- El documento offscreen se crea bajo demanda y procesa localmente trozos de contenido de tus pestañas (títulos, encabezados y pequeños fragmentos de texto) únicamente para calcular embeddings y agrupar. No se realiza telemetría.

—

### 📦 Instalación (modo desarrollador)

1. Descarga o clona este repositorio.
2. Abre `chrome://extensions/` y activa “Modo desarrollador”.
3. Clic en “Cargar descomprimida” y selecciona la carpeta del proyecto.
4. Opcional: configura atajos en `chrome://extensions/shortcuts`.

Compatibilidad: Chrome/Chromium y navegadores basados en Chromium (p. ej. Edge). Manifest V3.

—

### 🧰 Solución de problemas (FAQ)

- No veo estadísticas de RAM.
  - Requiere el permiso `system.memory`. Si tu navegador no lo ofrece en tu canal, verás valores estimados.

- Los atajos no funcionan.
  - Asigna o cambia teclas en `chrome://extensions/shortcuts`. Evita combinaciones en uso por el sistema.

- No cambian las reglas o preferencias.
  - Abre el Dashboard y pulsa “Recargar datos” (`Alt+R`). Si persiste, recarga la extensión desde `chrome://extensions/`.

- “Limpiar Local” del Árbol borra mis “Recientes” de Chrome?
  - No. Solo elimina el historial local de la extensión. Chrome mantiene su propia lista de “Recientemente cerrados”.

- ¿Puedo perder pestañas por error?
  - Antes de cierres masivos, considera guardar una sesión. Puedes restaurar pestañas desde la sección de sesiones o desde los “Recientes” del navegador.

—

## Para desarrolladores

### Requisitos

- Navegador Chromium (Chrome/Edge) con soporte de Manifest V3.
- Node.js v18+ para ejecutar pruebas locales (`.mjs`).
- WebStorm/IDE JetBrains recomendado para edición del proyecto.

—

### Estructura del proyecto

- `manifest.json`: configuración MV3 (permisos, service worker, opciones, comandos, WARs).
- `src/controller/`
  - `background.js`: Service Worker. Orquesta eventos de `chrome.tabs`, `tabGroups`, `sessions`, notificaciones y mensajería con vistas/offscreen.
  - `AutoGrouper.js`: lógica de auto‑agrupación (dominio/semántica) y coordinación del backend offscreen.
  - `AutoGrouperUtils.js`: utilidades de clustering (k‑means, estimación de `k`, etiquetas de grupo, rutas WASM).
  - `offscreen.html` / `offscreen.js`: documento offscreen donde corren Transformers.js + ONNX Runtime (WASM) 100% offline.
- `src/model/`
  - `TabModel.js`, `ConfigModel.js`, `PersistenceManager.js`: modelos y acceso a `chrome.storage.local`.
- `src/view/`
  - `popup.*`, `dashboard.*`: UI en vanilla JS + CSS.
- `src/assets/models/`: modelo `all-MiniLM-L6-v2` (config, tokenizer, onnx, vocab…).
- `src/vendor/onnxruntime/`: binarios ORT‑WASM (simd/threaded incluidos).
- `src/vendor/transformers/`: bundle `transformers.min.js` + WASM emparejado en `dist/`.
- `tests/`: pruebas Node para utilidades y verificaciones offline de la extensión.

—

### Arquitectura y flujo

1) Eventos del sistema (tabs, tabGroups, sessions, onStartup) llegan a `background.js` (clase `TabController`).
2) `TabController` consulta/actualiza `ConfigModel` y decide acciones (mover/agrupar/ungroup/suspender, etc.).
3) Para clustering semántico, `AutoGrouper`:
   - Garantiza un documento offscreen único (`chrome.offscreen.createDocument`).
   - Inicializa el pipeline de embeddings local y mantiene cachés de snippets/embeddings.
   - Envía/recibe mensajes al offscreen para inicializar y calcular embeddings.
4) La UI (popup/dashboard) recibe broadcasts ligeros (`chrome.runtime.sendMessage`) para repintar secciones.

Mensajes relevantes:
- Offscreen emite: `OFFSCREEN_READY` al cargar.
- SW → Offscreen: `OFFSCREEN_PING`, `OFFSCREEN_INIT { modelName }`, `OFFSCREEN_EMBED { texts[] }`, `OFFSCREEN_RUN_TESTS`.
- Offscreen → SW: `OFFSCREEN_INIT_DONE { ok, error? }` y respuestas `{ ok, ... }` a cada solicitud.

—

### IA local: embeddings y offscreen

- Motor: `transformers.min.js` con backend ONNX Runtime (WASM) empacado localmente.
- Sin red: `offscreen.js` fuerza `env.allowLocalModels = true` y `env.allowRemoteModels = false`.
- Modelo por defecto: `all-MiniLM-L6-v2` cargado desde `src/assets/models/...`.
- Normalización de salida: vectores `float32[]` por texto con `pooling='mean'` y `normalize=true`.
- Fallback: si `chrome.offscreen` falla o `embeddingProvider` es `lexical`, `AutoGrouper` usa clustering por tokens locales (sin IA).

Detalles clave de la implementación:
- Inicialización perezosa: no se crea el offscreen ni se carga el modelo hasta que hay pestañas sin clasificar por reglas/domain. Esto reduce el impacto en el arranque.
- Extracción de contenido enriquecida para embeddings: 
  - Prioriza `H1/H2`, `meta[name="description"]`, `meta[property="og:description"]` y luego fragmentos del `body`.
  - Límite de snippet aumentado a ~420 caracteres por pestaña para mejor contexto.
  - Cache de snippets/embeddings para evitar trabajo repetido.
- Calidad de clustering: 
  - Umbrales por defecto: `minMemberSim = 0.35` y `minClusterCohesion = 0.42`.
  - Post‑proceso: cálculo de centroides, descarte de outliers y, si hace falta, partición local (k=2) de clusters de baja cohesión.
- Respeto de la jerarquía y de los grupos protegidos: la IA nunca reubica pestañas que ya estén en grupos creados por reglas o por el usuario (títulos no `Auto:`).

—

### Modelos y binarios WASM

- Archivos críticos incluidos en `web_accessible_resources` (manifest):
  - `src/assets/models/all-MiniLM-L6-v2/*` (config, tokenizer, onnx, vocab).
  - `src/vendor/onnxruntime/*.wasm` y `src/vendor/transformers/dist/*.wasm`.
- Si cambias de modelo o carpeta, actualiza `manifest.json` en `web_accessible_resources`.
- Los paths WASM se construyen y normalizan en `AutoGrouperUtils.buildWasmPaths` y utilidades equivalentes en `offscreen.js`.

—

### Ejecución de tests

Requiere Node.js v18+ (soporta módulos ES).

- Utilidades de clustering/paths:

```
node tests/autoGrouperUtils.test.mjs
```

- Chequeos offline de la extensión (assets, manifest, hooks de pruebas, notificaciones):

```
node tests/offlineExtensionChecks.mjs
```

- Semántica y cohesión (respetando jerarquía y calidad de clusters):

```
node tests/semanticStickiness.test.mjs
node tests/autoGroupingHierarchy.test.mjs
node tests/offscreenLazyInit.test.mjs
node tests/clusteringQuality.test.mjs
node tests/outlierDetection.test.mjs
```

- Ejemplo de ejecución secuencial (PowerShell):

```
node .\tests\autoGrouperUtils.test.mjs; `
node .\tests\semanticStickiness.test.mjs; `
node .\tests\offlineExtensionChecks.mjs; `
node .\tests\autoGroupingHierarchy.test.mjs; `
node .\tests\offscreenLazyInit.test.mjs; `
node .\tests\clusteringQuality.test.mjs; `
node .\tests\outlierDetection.test.mjs
```

Todos los scripts salen con código `1` si fallan (útil para CI local).

—

### Guía de desarrollo local

Prerequisitos

- Node.js 18 o superior (para ejecutar los tests `.mjs`).
- Navegador Chromium (Chrome/Edge) actualizado.
- WebStorm/IDE JetBrains recomendado.

Flujo de desarrollo

1) Carga la extensión descomprimida durante el desarrollo:
   - Abre `chrome://extensions` → activa “Modo desarrollador”.
   - “Cargar descomprimida” → selecciona la carpeta raíz del proyecto.
2) Abre el Dashboard desde el icono o define atajos en `chrome://extensions/shortcuts`.
3) Itera sobre los archivos en `src/view` (UI), `src/controller` (lógica/Service Worker) y `src/model` (persistencia/config):
   - Tras cambios en `background.js`, pulsa “Recargar” en `chrome://extensions` y abre la consola del Service Worker para ver logs.
   - Para el documento offscreen (`offscreen.html/.js`), usa `chrome://inspect/#service-workers`.
4) Ejecuta pruebas locales con Node (ver sección anterior) para validar clustering, reglas y chequeos offline.

Convenciones

- Estilo: JavaScript ES2022 módulos, sin bundler. Mantener imports relativos claros.
- Nombres de grupos automáticos: prefijo `Auto:` reservado para IA/reglas; los grupos sin ese prefijo se consideran “protegidos”.
- Rendimiento: preservar inicialización perezosa del offscreen y caches donde aplique.

Activos locales (modelos/WASM)

- Los modelos ONNX y binarios WASM se versionan en el repositorio para permitir el modo 100% offline.
- Si cambias rutas o añades modelos, actualiza también `manifest.json › web_accessible_resources` y los helpers de paths en `AutoGrouperUtils.js`/`offscreen.js`.

—

### Flujo de trabajo con Git

Política de ignorados (.gitignore)

- Se ignoran artefactos de build, cachés, logs y archivos de entorno (`.env*`).
- IDEs: se ignora `.idea/*` excepto configuraciones útiles versionadas: `modules.xml`, `vcs.xml`, `jsonSchemas.xml`, `codeStyles/`, `inspectionProfiles/`, `runConfigurations/`.
- Gestores de paquetes: se ignoran `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` (no se versionan locks en este proyecto).
- Extensiones Chrome: se ignoran `*.crx` y `*.pem`.
- Importante: NO se ignoran por patrón los archivos `.wasm` ni los modelos `.onnx` porque la extensión debe funcionar offline.

Ramas y versionado

- Rama principal: `main` (estable).
- Trabaja en ramas cortas por tema: `feat/*`, `fix/*`, `chore/*`, `docs/*`, `test/*`.
- Versionado sigue `manifest.json › version` (formato `major.minor.patch`). Procura alinear incrementos con cambios funcionales (SemVer aproximado).

Commits y PRs

- Convención de commits recomendada (Conventional Commits):
  - `feat: …`, `fix: …`, `docs: …`, `refactor: …`, `test: …`, `chore: …`.
- Haz PRs pequeños y enfocados. Incluye:
  - Contexto del problema y la solución.
  - Evidencia manual o salida de tests (copiar consola es suficiente).
  - Notas si tocaste `manifest.json`, rutas WASM/modelos o permisos.

Checklist antes de mergear

- [ ] Pruebas locales de Node pasan.
- [ ] La extensión carga en `chrome://extensions` sin errores en SW u offscreen.
- [ ] Actualizaste `manifest.json` si cambiaste recursos/permiso/version.
- [ ] README actualizado si agregaste capacidades visibles para el usuario.

—

### Empaquetado y publicación

1) Sube la versión en `manifest.json` (`version`).
2) Verifica que `web_accessible_resources` cubra nuevos modelos/WASM si añadiste/renombraste recursos.
3) Prueba manual: carga descomprimida y valida Dashboard, popup y offscreen (observa la consola del Service Worker y del offscreen).
4) Empaqueta desde `chrome://extensions` → “Empaquetar extensión” o genera un ZIP de la carpeta (sin archivos de pruebas si aplica a tu flujo de publicación).

—

### Consejos de depuración

- Service Worker: chrome://extensions → Detalles → “Service worker” → “Inspeccionar vistas”.
- Documento Offscreen: abre `chrome://inspect/#service-workers` y filtra por tu extensión; `offscreen.html` expone su propia consola.
- Mensajería: busca en código los tipos `OFFSCREEN_*` y acciones `TAB_*` en `background.js`.
- Reintentos seguros: operaciones sobre tabs usan `withTabEditRetry` para errores transitorios (dragging, etc.).

—

## 🤝 Contribuir

¡PRs bienvenidas! Para bugs/ideas, abre un Issue con:
- Pasos para reproducir
- Comportamiento esperado vs. actual
- Versión del navegador/SO
- Capturas o GIF si es posible

—

## 📝 Notas de versión (extracto v2.x)

- Nueva sección “Árbol de Pestañas e Historial” (por fecha/por ventanas) con animaciones.
- Endpoints `GET_RECENTLY_CLOSED` y `GET_WINDOWS_TABS` en background.
- Historial local enriquecido (`windowId`/`groupId`) y límite ampliado a 200 entradas.
- Gráfico/estadísticas de memoria mejorados y accesibles también desde el Popup.
- Preferencia para desagrupar pestañas al iniciar; auto‑agrupación por dominio/categoría y por semántica (IA local).
- Exclusiones para “Suspender Inactivas”.
- Acciones rápidas: “Silenciar Otras”, fijar/desfijar en bloque, cerrar duplicadas.

Mejoras recientes en IA local y auto‑agrupación:
- Jerarquía estricta: 1) Reglas JSON, 2) Dominio (si está activo), 3) Semántica como último recurso.
- Inicialización perezosa del offscreen/embeddings; sin coste si no hay pestañas pendientes de clasificar.
- Análisis de contenido más rico (H1/H2, meta/OG description y cuerpo) para mejor naming y agrupación.
- Calidad de clustering: umbrales de cohesión y detección de outliers para evitar mezclar temas no relacionados.

—

## 🗺️ Roadmap sugerido

- Reglas personalizadas avanzadas (palabras clave/regex) y pausa temporal de auto‑agrupación.
- Suspensión inteligente con umbrales de inactividad y lista blanca más flexible.
- Accesibilidad mejorada (roles ARIA, lectores de pantalla, navegación total por teclado).
- Internacionalización (ES/EN/PT) con `_locales`.
- Métricas locales opcionales (tiempo activo por pestaña) con exportación CSV.
- Perfiles/espacios de trabajo con sesiones vinculadas.
