import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { isSecretPath } from './files.js'

const EXTRA_PRIVATE = new Set(['.dsh', '.codex', '.agents', '.config', '.android', 'appdata', '$recycle.bin', 'system volume information'])
const fail = (message, status = 400, code = 'folders') => { throw Object.assign(new Error(message), { status, code }) }
const sensitive = value => isSecretPath(value) || value.split(/[\\/]+/).some(part => EXTRA_PRIVATE.has(part.toLowerCase()))
function localPath(value) {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('\0') || !/^[A-Z]:[\\/]/i.test(value) || value.slice(2).includes(':')) fail('请选择本机磁盘的完整文件夹路径')
  if (sensitive(value)) fail('敏感或系统私有目录不提供浏览', 403)
  const normalized = path.win32.normalize(value)
  if (sensitive(normalized)) fail('敏感或系统私有目录不提供浏览', 403)
  return normalized
}
function linkPath(target, parent) {
  // Node may expose a local junction's NT prefix. Strip only drive-qualified
  // local targets; UNC and all other device namespaces remain rejected.
  const local = target.replace(/^(?:\\\\\?\\|\\\?\?\\)(?=[A-Z]:[\\/])/i, '')
  if (/^[\\/]/.test(local)) fail('网络或设备目录不能作为本地工作区', 403)
  return localPath(/^[a-z]:/i.test(local) ? local : path.win32.resolve(parent, local))
}
export function createRemoteFolders({ rpc, driveCandidates, maxEntries = 200, scanLimit = 2000, localDrive, execFileImpl = execFile, now = () => Date.now() } = {}) {
  if (typeof rpc !== 'function') throw Error('folders requires native RPC adapter')
  let writes = Promise.resolve()
  const requests = new Map()
  let driveCache = null, driveAt = 0, driveFlight = null
  let rootsCache = null, workspaceCache = null
  async function driveTypes() {
    if (driveCache && now() - driveAt < 30000) return driveCache
    if (driveFlight) return driveFlight
      // Drive type metadata only. No paths from the request enter shell code,
      // no volume labels or directory contents are queried by this process.
      const command = '[System.IO.DriveInfo]::GetDrives() | ForEach-Object { if ($_.Name -match "^[A-Z]:") { $_.Name.Substring(0,1) + ":" + [int]$_.DriveType } }'
      driveFlight = new Promise((resolve, reject) => execFileImpl(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
        const types = new Map()
        if (!error) for (const line of String(stdout).split(/\r?\n/)) { const hit = /^([A-Z]):([0-6])$/i.exec(line.trim()); if (hit) types.set(hit[1].toUpperCase(), Number(hit[2])) }
        if (error || !types.size) {
          if (driveCache) { driveAt = now() - 28000; resolve(driveCache) }
          else reject(Object.assign(new Error('暂时无法读取电脑磁盘，请稍后重试'), { code: 'folders', status: 503 }))
          return
        }
        driveCache = types; driveAt = now(); resolve(types)
      })).finally(() => { driveFlight = null })
    return driveFlight
  }
  async function isLocalDrive(root) {
    if (localDrive) return localDrive(root)
    return [2, 3, 5, 6].includes((await driveTypes()).get(root[0].toUpperCase()))
  }
  async function safeDirectory(value, depth = 0) {
    if (depth > 16) fail('目录链接层级过多', 403)
    const asked = localPath(value), root = path.win32.parse(asked).root
    if (!await isLocalDrive(root)) fail('仅支持本机磁盘，不浏览网络映射盘', 403)
    let current = root
    const pieces = asked.slice(root.length).split(/[\\/]+/).filter(Boolean)
    try {
      if (!(await fs.promises.stat(root)).isDirectory()) fail('磁盘不可用', 404)
      for (const part of pieces) {
        const next = path.win32.join(current, part), info = await fs.promises.lstat(next)
        if (info.isSymbolicLink()) current = await safeDirectory(linkPath(await fs.promises.readlink(next), current), depth + 1)
        else { if (!info.isDirectory()) fail('所选路径不是文件夹', 400); current = next }
      }
      const real = await fs.promises.realpath(current)
      localPath(real)
      if (!(await fs.promises.stat(real)).isDirectory()) fail('所选路径不是文件夹', 400)
      await fs.promises.access(real, fs.constants.R_OK)
      const handle = await fs.promises.opendir(real)
      await handle.close()
      return real
    } catch (error) {
      if (error.code === 'folders') throw error
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('文件夹不存在', 404)
      fail('无法访问该文件夹，请选择其他目录', 403)
    }
  }
  async function roots() {
    if (rootsCache && now() - rootsCache.at < 5000) return rootsCache.items
    const result = []
    const types = localDrive ? null : await driveTypes()
    const candidates = driveCandidates || [...types.keys()].map(letter => letter + ':\\')
    for (const candidate of candidates) {
      try { const real = await safeDirectory(candidate); result.push({ name: /^[A-Z]:[\\/]$/i.test(candidate) ? candidate.slice(0, 2).toUpperCase() : path.win32.basename(real), path: real }) } catch {}
    }
    rootsCache = { at: now(), items: result }
    return result
  }
  async function registered() {
    if (workspaceCache && now() - workspaceCache.at < 5000) return workspaceCache.items
    const rows = (await rpc('workspace.list', {})).items || [], output = []
    for (const row of rows) {
      if (output.length >= 50) break
      try {
        const real = await safeDirectory(row.path)
        const id = row.workspaceId || row.id
        if (id) output.push({ id, workspaceId: id, title: row.title || path.win32.basename(real) || real, path: real })
      } catch (error) { if (error.status === 503) throw error }
    }
    workspaceCache = { at: now(), items: output }; return output
  }
  async function list(value) {
    const [disks, workspaces] = await Promise.all([roots(), registered()])
    if (value === undefined || value === null || value === '') return { path: null, parent: null, roots: disks, entries: [], truncated: false, workspaces }
    const real = await safeDirectory(value), entries = []
    let scanned = 0, truncated = false
    try {
      const directory = await fs.promises.opendir(real)
      for await (const child of directory) {
        if (++scanned > scanLimit) { truncated = true; break }
        if ((!child.isDirectory() && !child.isSymbolicLink()) || sensitive(child.name)) continue
        const asked = path.win32.join(real, child.name)
        try {
          const canonical = await safeDirectory(asked)
          if (entries.length >= maxEntries) { truncated = true; break }
          entries.push({ name: child.name, path: canonical })
        } catch {}
      }
    } catch { fail('无法读取该文件夹，请返回上级目录', 403) }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    const parent = path.win32.dirname(real)
    return { path: real, parent: parent === real ? null : parent, roots: disks, entries, truncated, workspaces }
  }
  function remember(id, record) {
    if (!requests.has(id) && requests.size >= 128) {
      const retired = [...requests].find(([, value]) => value.state === 'done')
      if (!retired) fail('待核对的添加操作过多，请先核对工作区列表', 409)
      requests.delete(retired[0])
    }
    requests.set(id, record)
  }
  async function add(input) {
    const requestId = input?.requestId || crypto.randomUUID()
    if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)) fail('添加操作编号不正确')
    const real = await safeDirectory(input?.path), key = real.toLowerCase()
    const perform = async () => {
      const old = requests.get(requestId)
      if (old && old.path !== key) fail('同一操作编号不能选择不同文件夹', 409)
      if (old?.state === 'done') return old.result
      // Canonical lookup is read-only and can reconcile a lost create receipt.
      const rows = (await rpc('workspace.list', {})).items || []
      for (const row of rows) {
        let existing
        try { existing = await safeDirectory(row.path) } catch { continue }
        if (existing.toLowerCase() !== key) continue
        const id = row.workspaceId || row.id, result = { workspace: { ...row, id, workspaceId: id, path: existing }, created: false }
        workspaceCache = null; remember(requestId, { path: key, state: 'done', result }); return result
      }
      if (old || [...requests.values()].some(record => record.path === key && record.state === 'unknown')) fail('上次添加结果尚未确认，请刷新工作区列表核对，不会重复发送', 409, 'outcome_unknown')
      remember(requestId, { path: key, state: 'unknown' })
      try {
        const output = await rpc('workspace.create', { path: real })
        const workspace = output?.workspace, id = workspace?.workspaceId || workspace?.id
        if (!id || !workspace.path) throw Error('invalid workspace receipt')
        const checked = await safeDirectory(workspace.path)
        if (checked.toLowerCase() !== key) throw Error('workspace path mismatch')
        const result = { workspace: { ...workspace, id, workspaceId: id, path: checked }, created: output.created === true }
        workspaceCache = null; remember(requestId, { path: key, state: 'done', result }); return result
      } catch { fail('电脑未返回确定的添加结果，请刷新列表核对，不会自动重试', 409, 'outcome_unknown') }
    }
    const result = writes.then(perform); writes = result.catch(() => {}); return result
  }
  return { list, add, safeDirectory }
}
