import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolve from the running DSH entry: a linked plugin reuses its host's native library.
export async function pickDesktopDirectory(signal) {
  const fromHost={resolve:spec=>{for(const c of [process.argv[1]&&!process.argv[1].startsWith('-')?path.resolve(process.argv[1]):null,import.meta.url,'/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/package.json'].filter(Boolean)){try{return createRequire(c).resolve(spec)}catch{}}return createRequire(import.meta.url).resolve(spec)}}
  const native = await import(pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-host-directory-picker-native')).href)
  return native.pickNativeDirectory(signal)
}
