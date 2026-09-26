// Launches a real VS Code with the extension under development and runs suite.cjs inside it.
const path = require('path');
const fs = require('fs');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
(async () => {
  const root = path.resolve(__dirname, '../..');
  try {
    const cachePath = path.join(root, '.vscode-test');
    let exe = await downloadAndUnzipVSCode({ cachePath });
    // Newer macOS builds renamed Contents/MacOS/Electron → Code.
    if (!fs.existsSync(exe)) exe = path.join(path.dirname(exe), 'Code');
    await runTests({
      vscodeExecutablePath: exe,
      extensionDevelopmentPath: path.join(root, 'vscode'),
      extensionTestsPath: path.join(__dirname, 'suite.cjs'),
      // Short user-data dir: macOS limits IPC socket paths to 104 chars.
      launchArgs: [path.join(root, 'samples'), '--user-data-dir', fs.mkdtempSync(path.join(require('os').tmpdir(), 'dl-')), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome'],
      cachePath: path.join(root, '.vscode-test'),
    });
  } catch (e) {
    console.error('Integration tests failed', e);
    process.exit(1);
  }
})();
