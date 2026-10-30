/**
 * Vendors the object-detection model used for phone detection so exams work offline.
 *  - copies the TensorFlow.js and COCO-SSD browser bundles into src/renderer/vendor/
 *  - downloads the COCO-SSD (SSDLite MobileNet v2) weights from Google's TF.js model
 *    bucket into assets/models/coco-ssd/
 * Safe to re-run; existing files are kept. Run with: npm run fetch-models
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'src', 'renderer', 'vendor');
const MODEL_DIR = path.join(ROOT, 'assets', 'models', 'coco-ssd');
const MODEL_BASE = 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/';

const BUNDLES = [
  ['@tensorflow/tfjs/dist/tf.min.js', 'tf.min.js'],
  ['@tensorflow-models/coco-ssd/dist/coco-ssd.min.js', 'coco-ssd.min.js']
];

async function download(url, dest) {
  if (fs.existsSync(dest)) return false;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function main() {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  for (const [from, to] of BUNDLES) {
    fs.copyFileSync(require.resolve(from), path.join(VENDOR_DIR, to));
  }
  console.log(`[models] browser bundles copied to ${path.relative(ROOT, VENDOR_DIR)}`);

  fs.mkdirSync(MODEL_DIR, { recursive: true });
  const manifestPath = path.join(MODEL_DIR, 'model.json');
  await download(`${MODEL_BASE}model.json`, manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const shards = manifest.weightsManifest.flatMap(group => group.paths);
  let fetched = 0;
  for (const shard of shards) {
    if (await download(MODEL_BASE + shard, path.join(MODEL_DIR, shard))) fetched++;
  }
  console.log(`[models] coco-ssd: ${shards.length} weight files (${fetched} downloaded) in ${path.relative(ROOT, MODEL_DIR)}`);
}

main().catch(err => {
  console.error('[models] failed:', err.message);
  process.exit(1);
});
