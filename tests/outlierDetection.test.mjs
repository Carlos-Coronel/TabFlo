import { AutoGrouper } from '../src/controller/AutoGrouper.js';

function makeInfo(id, embedding, title = '') {
  return {
    tab: { id, title: title || `Tab ${id}`, url: `https://example.com/${id}` },
    text: title || `Text ${id}`,
    signature: `${id}`,
    embedding
  };
}

async function testOutlierIsNotGroupedWithMainCluster() {
  const grouper = new AutoGrouper({ groupTabsBulk: async()=>1, broadcast:()=>{}, notify:()=>{} });
  // Forzar parámetros por si cambian defaults en el futuro
  grouper.minClusterSize = 2;
  grouper.minMemberSim = 0.35;
  grouper.minClusterCohesion = 0.42;

  // Dos similares + 1 outlier ortogonal
  const a1 = makeInfo(1, [1, 0, 0], 'React Docs');
  const a2 = makeInfo(2, [0.95, 0.05, 0], 'React Tutorial');
  const out = makeInfo(3, [0, 0, 1], 'Travel Blog');
  const tabInfos = [a1, a2, out];

  const clusters = grouper.clusterTabInfos(tabInfos);
  if (!Array.isArray(clusters)) throw new Error('clusterTabInfos no devolvió un array');
  if (clusters.length !== 1) {
    throw new Error(`Se esperaba 1 cluster principal, se recibieron ${clusters.length}`);
  }
  const ids = clusters[0].tabIds;
  if (ids.includes(3)) {
    throw new Error('El outlier no debe estar en el grupo principal');
  }
  if (!(ids.includes(1) && ids.includes(2))) {
    throw new Error('El grupo principal debe contener las dos pestañas similares');
  }
}

(async () => {
  try {
    await testOutlierIsNotGroupedWithMainCluster();
    console.log('[OK] outlierDetection.test.mjs');
  } catch (e) {
    console.error('[FAIL] outlierDetection.test.mjs:', e?.message || e);
    process.exitCode = 1;
  }
})();
