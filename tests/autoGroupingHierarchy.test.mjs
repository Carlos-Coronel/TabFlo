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
  // Reducir umbral para el test
  grouper.minClusterSize = 1;
  return { grouper, calls };
}

function mockChromeWithGroups(titleById = {}) {
  globalThis.chrome = {
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: async (id) => ({ id, title: titleById[id] || '' })
    }
  };
}

async function testProtectedTabsAreNotMoved() {
  const { grouper, calls } = createStubbedGrouper();
  mockChromeWithGroups({ 10: 'Google' }); // grupo no-Auto => protegido

  const settings = {
    autoSuspendBySemanticCluster: false,
    autoGroupSemanticNotifications: false,
    semanticStickinessEnabled: true,
    semanticStickinessConsecutiveRequired: 1,
    semanticMinDwellMsBeforeReassign: 0
  };

  await grouper.applyClusters(1, [
    { label: 'Dev', tabIds: [1, 2], tabs: [{ id: 1, groupId: 10 }, { id: 2, groupId: -1 }] }
  ], settings);

  // Debe agrupar sólo la pestaña 2 (no protegida)
  if (calls.length !== 1) {
    throw new Error('Se esperaba exactamente una llamada a groupTabsBulk');
  }
  const ids = calls[0].tabIds;
  if (ids.includes(1) || !ids.includes(2)) {
    throw new Error('La semántica no debe mover pestañas protegidas por grupo no-Auto');
  }
}

async function testAllProtectedNoGrouping() {
  const { grouper, calls } = createStubbedGrouper();
  mockChromeWithGroups({ 10: 'Google', 11: 'Social' });

  const settings = {
    autoSuspendBySemanticCluster: false,
    autoGroupSemanticNotifications: false,
    semanticStickinessEnabled: true,
    semanticStickinessConsecutiveRequired: 1,
    semanticMinDwellMsBeforeReassign: 0
  };

  await grouper.applyClusters(1, [
    { label: 'Media', tabIds: [3, 4], tabs: [{ id: 3, groupId: 10 }, { id: 4, groupId: 11 }] }
  ], settings);

  if (calls.length !== 0) {
    throw new Error('No debería haberse intentado agrupar cuando todas las pestañas están protegidas');
  }
}

(async () => {
  try {
    await testProtectedTabsAreNotMoved();
    await testAllProtectedNoGrouping();
    console.log('[OK] autoGroupingHierarchy.test.mjs');
  } catch (e) {
    console.error('[FAIL] autoGroupingHierarchy.test.mjs:', e?.message || e);
    process.exitCode = 1;
  }
})();
