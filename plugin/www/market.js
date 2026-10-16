import { selectPlugins, description, categories, number, installedName, installationState } from './market-model.js?v=20261012-2'

const $ = id => document.getElementById(id)
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const state = { plugins: [], categories: {}, snapshot: { installed: {} }, runtime: [], runtimeKnown: false, status: null, tab: 'discover', limit: 24, loading: false, busy: false, selected: null, pending: null }
try { state.pending = JSON.parse(localStorage.getItem('dsh.mobile-market.pending') || 'null') } catch {}
const validSource = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password ? u.href : null } catch { return null } }
const metric = value => number(value) < 0 ? '未收录' : Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)

async function request(url, { method = 'GET', body, timeout = 45000 } = {}) {
  const response = await fetch(url, { method, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}) })
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('连接已失效，请返回 DSH 重新登录后再试')
  const value = await response.json()
  if (!response.ok || value.ok === false) {
    const reason = typeof value.error === 'string' ? value.error : value.error?.message
    throw new Error(reason || value.detail || ('电脑响应失败（' + response.status + '）'))
  }
  return value
}
function savePending(value) {
  try {
    if (value) localStorage.setItem('dsh.mobile-market.pending', JSON.stringify(value))
    else localStorage.removeItem('dsh.mobile-market.pending')
    state.pending = value
    pendingView()
    return true
  } catch { $('notice').textContent = '无法保存安装记录，请在电脑端安装'; return false }
}
function pendingView() {
  $('uncertain').hidden = !state.pending
  $('uncertainText').textContent = state.pending ? (state.busy ? '正在电脑上安装：' : '上次安装结果待核对：') + state.pending.name : ''
  $('releasePending').disabled = state.busy || !state.status || state.status.active || state.status.busy
}
function statusMessage() {
  if (!state.status) return '尚未取得电脑状态，安装暂不可用'
  if (state.status.active || state.status.busy) return '电脑正在处理插件操作，请稍候'
  if (state.status.runningAgents?.length) return '电脑有任务运行中，可以浏览，空闲后再安装'
  return '已连接电脑 · 安装后由同一台 DSH 提供能力'
}
async function getStatus() {
  try { state.status = await request('/dsh-market/status', { timeout: 15000 }); pendingView(); return true }
  catch (error) { state.status = null; pendingView(); $('notice').textContent = error.message; return false }
}
async function installedSnapshot() {
  const [snapshot, runtime] = await Promise.allSettled([
    request('/dsh-market/installed'),
    request('/api/pluginInventory/list', { method: 'POST', body: { type: 'client-request', rpcId: crypto.randomUUID(), method: 'pluginInventory/list', payload: { args: {} } } }),
  ])
  if (snapshot.status !== 'fulfilled') throw snapshot.reason
  state.snapshot = snapshot.value
  state.runtimeKnown = runtime.status === 'fulfilled' && runtime.value.result?.ok === true && Array.isArray(runtime.value.result.value?.entries)
  state.runtime = state.runtimeKnown ? runtime.value.result.value.entries : []
}
function nameOf(plugin) { return installedName(plugin, state.snapshot.installed || {}, state.runtime) }
function stateOf(plugin) { const name = nameOf(plugin); return name ? installationState(name, state.snapshot, state.runtime) : '' }
function installedItems() {
  const names = new Set(Object.keys(state.snapshot.installed || {}))
  for (const row of state.runtime) if (row.moduleName && !row.moduleName.startsWith('@deepseek-ai/') && !row.moduleName.startsWith('cordis:')) names.add(row.moduleName)
  const used = new Set()
  return [...names].map(name => {
    const plugin = state.plugins.find(p => p.npm === name)
    if (plugin) { if (used.has(plugin.url)) return null; used.add(plugin.url); return plugin }
    const known = { 'dsh-pager': '手机和平板界面、消息同步、文件查看和视频播放器。', 'dshmarket': '电脑端中文插件市场，浏览、搜索并管理社区插件。', 'dsh-media-workflow': '本机已安装的媒体制作工作流插件。', 'dsh-pager-market': '手机插件安装的请求去重与回执记录，断线后核对状态，避免重复安装。', 'dsh-mobile-layout': 'DSH 移动端布局适配插件。' }
    return { name, npm: name, owner: '本机插件', category: 'local', description: { zh: known[name] || '本机插件；暂无匹配的市场中文简介。' }, local: true, url: '' }
  }).filter(Boolean)
}
function icon(plugin) {
  const owner = String(plugin.owner || '')
  if (!plugin.local && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner)) return '<span class="icon"><img loading="lazy" referrerpolicy="no-referrer" alt="' + esc(owner + ' 的图标') + '" src="https://avatars.githubusercontent.com/' + encodeURIComponent(owner) + '?size=96"></span>'
  return '<span class="icon" aria-hidden="true">' + esc(String(plugin.name || 'P').slice(0, 1).toUpperCase()) + '</span>'
}
function card(plugin, index) {
  const status = plugin.local ? installationState(plugin.npm, state.snapshot, state.runtime) : stateOf(plugin)
  const cats = categories(plugin).map(c => state.categories[c]?.zh || (c === 'local' ? '本机插件' : c)).join(' · ')
  return '<article class="card"><div class="card-head">' + icon(plugin) + '<div class="identity"><h2>' + esc(plugin.name) + '</h2><small>' + esc(plugin.owner || '') + '</small></div></div><p class="desc">' + esc(description(plugin)) + '</p><div><span class="badge">' + esc(cats) + '</span></div><div class="bottom"><div class="stats">' + (plugin.local ? '' : '<span>★ ' + metric(plugin.stars) + '</span><span>↓ ' + metric(plugin.downloads) + '</span>') + (status ? '<span class="badge">' + esc(status) + '</span>' : '') + '</div><button data-index="' + index + '">详情</button></div></article>'
}
let visible = []
function render() {
  const items = state.tab === 'installed' ? installedItems() : state.plugins
  visible = selectPlugins(items, { query: $('search').value, category: $('category').value, sort: $('sort').value })
  $('cards').innerHTML = visible.slice(0, state.limit).map(card).join('') || '<p class="empty">' + (state.loading ? '正在读取…' : '没有找到匹配的插件') + '</p>'
  $('count').textContent = visible.length + ' 个插件'
  $('more').hidden = visible.length <= state.limit
  $('discover').setAttribute('aria-pressed', String(state.tab === 'discover'))
  $('installed').setAttribute('aria-pressed', String(state.tab === 'installed'))
  $('cards').querySelectorAll('img').forEach(img => { img.onerror = () => { const parent = img.parentElement; parent.textContent = parent.closest('.card').querySelector('h2').textContent.slice(0, 1).toUpperCase() } })
}
async function load() {
  if (state.loading || state.busy) return
  state.loading = true; $('refresh').disabled = true; $('notice').textContent = '正在读取插件目录…'
  try {
    const [catalogue] = await Promise.all([request('/dsh-market/registry', { timeout: 90000 }), installedSnapshot(), getStatus()])
    if (!Array.isArray(catalogue.registry?.plugins)) throw new Error('插件目录格式不正确')
    state.plugins = catalogue.registry.plugins; state.categories = catalogue.registry.categories || {}
    const selected = $('category').value
    $('category').innerHTML = '<option value="all">全部分类</option>' + Object.entries(state.categories).map(([id, label]) => '<option value="' + esc(id) + '">' + esc(label.zh || id) + '</option>').join('') + '<option value="local">本机插件</option>'
    if ([...$('category').options].some(o => o.value === selected)) $('category').value = selected
    $('updated').textContent = '目录更新 ' + (catalogue.registry.updated || '日期未知')
    $('notice').textContent = statusMessage() + (!state.runtimeKnown ? ' · 本机运行状态读取失败，请稍后刷新' : '')
    await reconcile()
  } catch (error) { $('notice').textContent = '加载失败：' + error.message; state.status = null }
  finally { state.loading = false; $('refresh').disabled = false; render(); pendingView() }
}
async function reconcile() {
  if (!state.pending || state.busy) return
  if (state.pending.id) {
    try {
      const record = await request('/m/market-install?id=' + encodeURIComponent(state.pending.id), { timeout: 15000 })
      if (record.state === 'done' && record.receipt?.status === 200 && record.receipt.body?.ok) {
        savePending(null); $('notice').textContent = record.receipt.body.hot ? '已核对安装回执：电脑已安装并热加载' : '已收到电脑安装回执，请在电脑端核对启用状态'; return
      }
    } catch { /* Missing or unreachable records remain pending, not retried. */ }
  }
  const plugin = state.plugins.find(p => p.url === state.pending.url)
  if (plugin && stateOf(plugin) === '已启用') { savePending(null); $('notice').textContent = '已在电脑上检测到该插件并启用' }
}
function detail(plugin) {
  if (state.busy) return
  state.selected = plugin
  const status = plugin.local ? installationState(plugin.npm, state.snapshot, state.runtime) : stateOf(plugin)
  const source = validSource(plugin.url)
  $('detailBody').innerHTML = '<div class="detail-head"><h2 id="detailTitle">' + esc(plugin.name) + '</h2><button id="closeDetail" aria-label="关闭插件详情">×</button></div><p class="detail-desc">' + esc(description(plugin)) + '</p><dl><dt>作者</dt><dd>' + esc(plugin.owner) + '</dd><dt>分类</dt><dd>' + esc(categories(plugin).map(c => state.categories[c]?.zh || '本机插件').join('、')) + '</dd>' + (plugin.local ? '' : '<dt>GitHub 星标 / npm 近30天下载</dt><dd>★ ' + metric(plugin.stars) + ' / ↓ ' + metric(plugin.downloads) + '</dd>') + '<dt>电脑安装状态</dt><dd id="detailInstalled">' + esc(status || '未安装') + '</dd>' + (source ? '<dt>来源</dt><dd><a href="' + esc(source) + '" target="_blank" rel="noopener noreferrer">查看 GitHub 项目 ↗</a></dd>' : '') + '</dl><p class="tip">工具能力由电脑提供；桌面专用面板和主题不一定适用于手机。升级、卸载请在电脑市场中操作。</p>' + (!status && source ? '<label class="confirm"><input id="agree" type="checkbox"><span>我确认将此社区插件安装到电脑 DSH；插件代码可能读取文件或执行命令。</span></label><button id="installPlugin" class="primary" disabled>安装到电脑</button>' : '') + '<p id="detailStatus" role="status"></p>'
  $('closeDetail').onclick = () => $('detail').close()
  const install = $('installPlugin')
  if (install) {
    const update = () => { install.disabled = !$('agree').checked || !!state.pending || state.busy || !state.status || state.status.active || state.status.busy || !!state.status.runningAgents?.length }
    $('agree').onchange = update
    install.onclick = () => installPlugin(plugin)
    update()
    $('detailStatus').textContent = state.pending ? '请先核对上次安装结果' : statusMessage()
  }
  if (!$('detail').open) $('detail').showModal()
}
async function installPlugin(plugin) {
  if (state.busy || state.pending || state.selected !== plugin || !$('agree')?.checked || !validSource(plugin.url)) return
  state.busy = true; $('installPlugin').disabled = true
  try {
    if (!await getStatus()) throw new Error('无法确认电脑状态，请稍后再试')
    if (state.status.active || state.status.busy || state.status.runningAgents?.length) throw new Error('电脑正在忙，请等任务结束后再安装')
    const pending = { id: crypto.randomUUID(), url: plugin.url, name: plugin.name, at: Date.now() }
    if (!savePending(pending)) throw new Error('无法保存安装记录，已取消操作')
    $('detailStatus').textContent = '正在电脑安装，请稍候…'
    // The host deduplicates this ID even if the browser transport replays it.
    let record = await request('/m/market-install', { method: 'POST', body: { id: pending.id, url: plugin.url } })
    const deadline = Date.now() + 300000
    while (record.state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      record = await request('/m/market-install?id=' + encodeURIComponent(pending.id), { timeout: 15000 })
    }
    if (record.state !== 'done' || !record.receipt) throw new Error(record.error || '尚未收到最终安装回执')
    const result = record.receipt.body
    if (record.receipt.status === 200 && result.ok) {
      savePending(null)
      const activations = Object.values(result.activation || {})
      const incompatible = activations.some(a => a.state === 'incompatible')
      $('detailStatus').textContent = incompatible ? '已收到安装回执，但版本不兼容。请在电脑端处理。' : result.hot ? '电脑已完成安装并热加载' : '已收到安装回执，请在电脑端检查是否需要重启'
      if (result.compatibility || result.buildsSkipped || result.activationWarnings?.length) $('detailStatus').textContent += '；电脑端有需要处理的兼容或构建提示'
    } else {
      // Even an error response may follow partial filesystem changes. Keep it
      // pending for explicit reconciliation instead of making Retry the default.
      const reason = typeof result.error === 'string' ? result.error : result.error?.message
      $('detailStatus').textContent = '安装未完成：' + (reason || result.detail || '请在电脑插件市场查看详情') + '。请核对电脑状态，不会自动重试。'
    }
    await installedSnapshot()
    render()
    $('detailInstalled').textContent = stateOf(plugin) || '状态待核对'
  } catch (error) { $('detailStatus').textContent = error.message + (state.pending ? '；结果待核对，不会自动重试。' : '') }
  finally {
    state.busy = false; await getStatus(); pendingView()
    if ($('installPlugin')) { $('installPlugin').disabled = !!state.pending || !!nameOf(plugin); if (nameOf(plugin)) $('installPlugin').textContent = '已安装' }
    $('notice').textContent = state.pending ? '安装结果待核对，请先检查电脑状态' : statusMessage()
  }
}
$('cards').onclick = event => { const button = event.target.closest('[data-index]'); if (button && visible[Number(button.dataset.index)]) detail(visible[Number(button.dataset.index)]) }
$('refresh').onclick = load
$('search').oninput = $('category').onchange = $('sort').onchange = () => { state.limit = 24; render() }
for (const tab of ['discover', 'installed']) $(tab).onclick = () => { state.tab = tab; state.limit = 24; $('category').value = 'all'; render() }
$('more').onclick = () => { state.limit += 24; render() }
$('checkPending').onclick = load
$('releasePending').onclick = () => { if (!state.busy && state.status && !state.status.active && !state.status.busy && window.confirm('确认已经检查电脑端的插件状态？这只解除待核对提示，不会重新发起安装。')) { savePending(null); if (state.selected && $('detail').open) detail(state.selected) } }
$('detail').addEventListener('cancel', event => { if (state.busy) event.preventDefault() })
$('detail').addEventListener('close', () => { if (!state.busy) state.selected = null })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') getStatus() })
setInterval(async () => {
  if (document.visibilityState !== 'visible' || !state.pending) return
  if (await getStatus()) {
    if (state.busy && $('detailStatus')) $('detailStatus').textContent = state.status.active ? '正在电脑安装：' + (state.status.phase || '处理中') : '正在等待最终安装回执…'
    else if (!state.status.active && !state.status.busy) { try { await installedSnapshot(); await reconcile(); render() } catch {} }
  }
}, 5000)
load()
