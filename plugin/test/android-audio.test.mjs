import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Device regression: Redmi WebView 154 rejected communication-device selection
// with "Requires MODIFY_AUDIO_SETTINGS and RECORD_AUDIO" on APK 1.5.1.
// This locks the packaging prerequisite; real capture is separately validated.
test('Android WebView microphone declares both Chromium communication-device permissions', () => {
  const manifest = fs.readFileSync(new URL('../../android/AndroidManifest.xml', import.meta.url), 'utf8')
  for (const name of ['RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS']) {
    assert.match(manifest, new RegExp('<uses-permission\\s+android:name="android\\.permission\\.' + name + '"\\s*/>'), 'Missing '+name+' prevents the WebView audio source from starting')
  }
})
