import { AutoGrouper } from '../src/controller/AutoGrouper.js';

function makeInfo(id, embedding, title = '') {
  return {
    tab: { id, title: title || `Tab ${id}`, url: `https://example.com/${id}` },
    text: title || `Text ${id}`,
    signature: `${id}`,
    embedding
  };
}

async function testTwoDistinctTopicsYieldTwoClusters() {
  const grouper = new AutoGrouper({ groupTabsBulk: async()=>1, broadcast:()=>{}, notify:()=>{} });
  // Evitar depender de embeddings reales
  grouper._embeddingMode = 'lexical';

  // Dos temas claramente separados en 3D
  const a1 = makeInfo(1, [1, 0, 0], 'JS Tutorial');
  const a2 = makeInfo(2, [0.9, 0.1, 0], 'Node Guide');
  const b1 = makeInfo(3, [0, 1, 0], 'Cooking Pasta');
  const b2 = makeInfo(4, [0.1, 0.9, 0], 'Italian Recipes');
  const tabInfos = [a1, a2, b1, b2];

  const clusters = grouper.clusterTabInfos(tabInfos);
  if (!Array.isArray(clusters)) throw new Error('clusterTabInfos no devolvió un array');
  if (clusters.length !== 2) {
    throw new Error(`Se esperaban 2 clusters, se recibieron ${clusters.length}`);
  }
  const sizes = clusters.map(c => c.tabIds.length).sort((x,y)=>x-y);
  if (sizes[0] !== 2 || sizes[1] !== 2) {
    throw new Error(`Se esperaban tamaños [2,2], se obtuvieron ${JSON.stringify(sizes)}`);
  }
}

(async () => {
  try {
    await testTwoDistinctTopicsYieldTwoClusters();
    console.log('[OK] clusteringQuality.test.mjs');
  } catch (e) {
    console.error('[FAIL] clusteringQuality.test.mjs:', e?.message || e);
    process.exitCode = 1;
  }
})();
