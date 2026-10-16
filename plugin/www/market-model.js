export const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : -1
export const categories = item => (Array.isArray(item.category) ? item.category : [item.category]).filter(x => typeof x === 'string')
export const description = item => item.description?.zh?.trim() || '暂未提供中文简介，请查看插件来源说明。'
export function selectPlugins(items, { query = '', category = 'all', sort = 'stars' } = {}) {
  const text = query.trim().toLocaleLowerCase()
  const chosen = items.filter(item => (category === 'all' || categories(item).includes(category)) && (!text || [item.name, item.owner, item.npm, item.description?.zh, item.description?.en].filter(Boolean).join(' ').toLocaleLowerCase().includes(text)))
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN') || String(a.url).localeCompare(String(b.url))
  return chosen.sort((a, b) => {
    if (sort === 'name') return byName(a, b)
    const rank = item => sort === 'added' ? (Number.isFinite(Date.parse(item.added)) ? Date.parse(item.added) : -1) : number(item[sort === 'downloads' ? 'downloads' : 'stars'])
    return rank(b) - rank(a) || byName(a, b)
  })
}
export function installedName(plugin, installed, runtime = []) {
  if (plugin.npm && (Object.hasOwn(installed, plugin.npm) || runtime.some(e => e.moduleName === plugin.npm))) return plugin.npm
  // Never equate unrelated repositories merely because their basename matches.
  const source = String(plugin.url || '').toLowerCase().replace(/\/$/, '')
  return Object.keys(installed).find(name => String(installed[name]).toLowerCase().replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '') === source) || null
}
export function installationState(name, snapshot, runtime) {
  const rows = runtime.filter(e => e.moduleName === name)
  if (rows.some(e => e.enabled && e.fiberPhase === 'active')) return '已启用'
  if (rows.length) return rows.some(e => e.enabled) ? '已安装 · 待就绪' : '已停用'
  const state = snapshot.activation?.[name]?.state
  if (state === 'live') return '已启用'
  if (state === 'missing') return '配置存在 · 缺少文件'
  if (state === 'incompatible') return '版本不兼容'
  if (state === 'disabled') return '已停用'
  return '已安装 · 状态待核对'
}
