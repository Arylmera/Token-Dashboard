// electron-builder afterPack hook: ad-hoc re-sign the macOS .app bundle.
//
// Why: we don't pay for an Apple Developer ID, so the build runs with
// CSC_IDENTITY_AUTO_DISCOVERY=false and electron-builder skips signing.
// On Apple Silicon the inner Electron framework still gets an ad-hoc
// signature (required to launch at all), but the outer bundle's
// _CodeSignature/CodeResources ends up inconsistent with the actual
// contents — extra files (our PyInstaller bundle under Resources/py/,
// helper apps, native modules) aren't covered by the seal.
//
// macOS Sequoia treats that mismatch as "damaged" and refuses to launch.
// Re-signing the whole bundle ad-hoc (`codesign -s -`) with --deep and
// --force regenerates a consistent CodeResources that covers everything,
// turning the install error into the standard "unidentified developer"
// quarantine prompt instead, which the cask's postflight strips.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adHocSign(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`[ad-hoc-sign] codesign --force --deep --sign - ${appPath}`);
  execFileSync(
    'codesign',
    [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--timestamp=none',
      '--options',
      'runtime',
      appPath,
    ],
    { stdio: 'inherit' }
  );

  // Verify — if this fails, the build should fail too.
  console.log('[ad-hoc-sign] verifying signature');
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { stdio: 'inherit' }
  );
};
