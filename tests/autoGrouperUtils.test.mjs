import { existsSync } from 'fs';
import path from 'path';
import { buildClusterLabel, buildWasmPaths, estimateK, kmeans } from '../src/controller/AutoGrouperUtils.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function testEstimateK() {
  assert(estimateK(1, 3, 8) === 1, 'estimateK should return 1 when below minimum');
  assert(estimateK(3, 3, 8) >= 2, 'estimateK should return at least 2 when threshold met');
  assert(estimateK(100, 3, 4) <= 4, 'estimateK should respect maxClusters');
}

function testBuildClusterLabel() {
  const label = buildClusterLabel([
    { title: 'Proyecto Alpha documentación', snippet: 'Guía de arquitectura y plan', url: 'https://example.com/alpha' },
    { title: 'Alpha API reference', snippet: 'Endpoints y ejemplos', url: 'https://example.com/api' }
  ]);
  assert(label.toLowerCase().includes('alpha'), 'label should include dominant token');
}

function testKmeans() {
  const originalRandom = Math.random;
  let calls = 0;
  Math.random = () => (calls++ === 0 ? 0.0 : 0.99);

  const vectors = [
    [0, 0],
    [0.1, 0.2],
    [10, 10],
    [10.2, 9.8]
  ];
  const assignments = kmeans(vectors, 2, 10);

  Math.random = originalRandom;

  const firstCluster = assignments[0];
  const secondCluster = assignments[2];
  assert(assignments[1] === firstCluster, 'first two points should be in same cluster');
  assert(assignments[3] === secondCluster, 'last two points should be in same cluster');
  assert(firstCluster !== secondCluster, 'clusters should be different');
}

function testBuildWasmPaths() {
  const base = 'chrome-extension://abc123/src/vendor/onnxruntime';
  const paths = buildWasmPaths(base);
  assert(paths['ort-wasm.wasm'] === 'chrome-extension://abc123/src/vendor/onnxruntime/ort-wasm.wasm', 'should normalize base path');
  assert(paths['ort-wasm-simd-threaded.wasm'].endsWith('/ort-wasm-simd-threaded.wasm'), 'should include threaded wasm');
}

function testWasmFilesExist() {
  const root = process.cwd();
  const wasmDir = path.join(root, 'src', 'vendor', 'onnxruntime');
  const files = [
    'ort-wasm.wasm',
    'ort-wasm-simd.wasm',
    'ort-wasm-threaded.wasm',
    'ort-wasm-simd-threaded.wasm'
  ];
  files.forEach((file) => {
    const full = path.join(wasmDir, file);
    assert(existsSync(full), `missing wasm file: ${file}`);
  });
}

testEstimateK();
testBuildClusterLabel();
testKmeans();
testBuildWasmPaths();
testWasmFilesExist();

console.log('autoGrouperUtils tests passed');