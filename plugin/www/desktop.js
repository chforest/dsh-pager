/* The desktop keeps its original UI; this adds a separate native picker. */
;(function () {
  'use strict'
  if (location.pathname !== '/' || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) || /Android|iPhone|iPad|DSHApp/i.test(navigator.userAgent) || navigator.standalone === true) return
  function start() {
    var id = 'dsh-local-folder', busy = false, toastTimer
    function notice(text) {
      var node = document.getElementById(id + '-notice')
      if (!node) {
        node = document.createElement('div'); node.id = id + '-notice'; node.setAttribute('role', 'status')
        node.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);z-index:10000;max-width:80vw;padding:12px 18px;border-radius:12px;background:#202124;color:white;font:14px system-ui;box-shadow:0 4px 20px #0003'
        document.body.appendChild(node)
      }
      node.textContent = text; clearTimeout(toastTimer)
      toastTimer = setTimeout(function () { node.remove() }, 7000)
    }
    async function pick() {
      if (busy) return
      busy = true; mount()
      notice('请在电脑弹出的窗口中选择项目文件夹')
      try {
        // Human choice has no request timeout. Never auto-replay an uncertain result.
        var response = await fetch('/m/api/desktop/workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        var result = await response.json()
        if (!response.ok || !result.ok) throw new Error(result.error && result.error.message || '添加工作区失败')
        var value = result.value
        if (value.cancelled) notice('已取消选择')
        else if (value.workspace) notice((value.created ? '已添加工作区：' : '工作区已存在：') + value.workspace.title)
        else throw new Error('未收到工作区结果，请查看工作区列表')
      } catch (err) { notice(err.message + '；请先核对工作区列表') }
      finally { busy = false; mount() }
    }
    function mount() {
      var button = document.getElementById(id)
      if (!button) {
        var anchor = document.querySelector('button[aria-label="添加工作区"],button[aria-label="Add workspace"],button[aria-label="Add Workspace"]')
        if (!anchor) return
        button = document.createElement('button'); button.id = id; button.type = 'button'; button.className = anchor.className
        button.setAttribute('aria-label', '打开本地文件夹'); button.title = '打开本地文件夹并添加为工作区'
        button.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v3M3 7h6l2 3h10l-3 10H3V7z"/></svg>'
        button.onclick = pick; anchor.parentElement.insertBefore(button, anchor)
      }
      button.disabled = busy
    }
    var scheduled = false
    new MutationObserver(function () { if (!scheduled) { scheduled = true; requestAnimationFrame(function () { scheduled = false; mount() }) } }).observe(document.body, { childList: true, subtree: true })
    mount()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
