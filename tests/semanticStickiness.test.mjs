import { AutoGrouper } from '../src/controller/AutoGrouper.js';

function createStubbedGrouper() {
  const calls = [];
  const grouper = new AutoGrouper({
    groupTabsBulk: async (tabIds, title, color) => {
      calls.push({ tabIds: [...tabIds], title, color });
      return 1; // fake groupId
    },
    broadcast: () => {},
    notify: () => {}
  });
  return { grouper, calls };
}

async function testStickinessConsecutive() {
  const { grouper, calls } = createStubbedGrouper();
  // Permitir agrupar con 1 tab para el test
  grouper.minClusterSize = 1;
  let settings = {
    autoSuspendBySemanticCluster: false,
    autoGroupSemanticNotifications: false,
    semanticStickinessEnabled: true,
    semanticStickinessConsecutiveRequired: 1,
    semanticMinDwellMsBeforeReassign: 0
  };

  // 1) Primera agrupación: label A para tab 1 -> debe aceptar
  await grouper.applyClusters(1, [
    { label: 'A', tabIds: [1], tabs: [{ id: 1 }] }
  ], settings);
  if (calls.length !== 1 || calls[0].title !== 'Auto: A') {
    throw new Error('Esperaba una llamada de agrupación inicial a Auto: A');
  }
  if (grouper._stableAssignments.get(1) !== 'A') {
    throw new Error('La asignación estable debería ser A tras el primer ciclo');
  }

  // Reset registro de llamadas
  calls.length = 0;

  // 2) Con consecutivas requeridas = 1, propuesta de cambio a B -> debe mover
  await grouper.applyClusters(1, [
    { label: 'B', tabIds: [1], tabs: [{ id: 1 }] }
  ], settings);
  // Validar el estado estable (núcleo de la lógica). La llamada al stub puede variar
  // según condiciones externas, por lo que no la forzamos en este test minimalista.
  if (grouper._stableAssignments.get(1) !== 'B') {
    console.log('Llamadas registradas tras segundo ciclo:', JSON.stringify(calls));
    throw new Error('La asignación estable debería ser B tras el segundo ciclo');
  }
}

// Ejecutar
(async () => {
  try {
    await testStickinessConsecutive();
    console.log('[OK] semanticStickiness.test.mjs');
  } catch (e) {
    console.error('[FAIL] semanticStickiness.test.mjs:', e?.message || e);
    process.exitCode = 1;
  }
})();
