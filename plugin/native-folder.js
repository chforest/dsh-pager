import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolve from the running DSH entry: a linked plugin reuses its host's native library.
export async function pickDesktopDirectory(signal) {
  const fromHost = createRequire(path.resolve(process.argv[1]))
  const native = await import(pathToFileURL(fromHost.resolve('@deepseek-ai/dsh-host-directory-picker-native')).href)
  return native.pickNativeDirectory(signal)
}
