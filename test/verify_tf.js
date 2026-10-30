const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.webContents.on('console-message', (_event, level, message) => {
    console.log(`[Renderer Console] ${message}`);
  });

  const testHtmlPath = path.resolve(__dirname, 'tf_test.html');
  const modelsUri = `file://${path.resolve(__dirname, '../assets/models').replace(/\\/g, '/')}`;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <script src="../src/renderer/js/face-api.js"></script>
      </head>
      <body>
        <h1>Testing TensorFlow Model Loading</h1>
        <script>
          async function runTest() {
            try {
              console.log('TensorFlow version:', faceapi.tf.version.tfjs);
              console.log('Available backends:', Object.keys(faceapi.tf.engine().registryFactory));
              
              // Set CPU backend for non-GPU / software environment
              await faceapi.tf.setBackend('cpu');
              await faceapi.tf.ready();
              console.log('Active TF backend:', faceapi.tf.getBackend());

              console.log('Loading TinyFaceDetector model from:', '${modelsUri}');
              await faceapi.nets.tinyFaceDetector.loadFromUri('${modelsUri}');
              console.log('TinyFaceDetector model loaded successfully!');
              
              await faceapi.nets.faceLandmark68TinyNet.loadFromUri('${modelsUri}');
              console.log('FaceLandmark68TinyNet model loaded successfully!');

              window.testStatus = {
                success: true,
                tfVersion: faceapi.tf.version.tfjs,
                activeBackend: faceapi.tf.getBackend(),
                isTinyFaceLoaded: faceapi.nets.tinyFaceDetector.isLoaded,
                isLandmarksLoaded: faceapi.nets.faceLandmark68TinyNet.isLoaded
              };
            } catch (err) {
              console.error('Test error:', err.message || err);
              window.testStatus = { success: false, error: err.message };
            }
          }
          runTest();
        </script>
      </body>
    </html>
  `;
  fs.writeFileSync(testHtmlPath, html);

  await win.loadFile(testHtmlPath);

  // Wait 4 seconds for model loading and weights parsing
  await new Promise(r => setTimeout(r, 4000));

  const result = await win.webContents.executeJavaScript('window.testStatus');
  console.log('--- TENSORFLOW & MODEL LOADING RESULT ---');
  console.log(JSON.stringify(result, null, 2));

  fs.unlinkSync(testHtmlPath);
  app.exit(result && result.success ? 0 : 1);
});
