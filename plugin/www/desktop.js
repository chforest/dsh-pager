/* The desktop keeps its original UI; this adds a native workspace picker and 3-way queue dock actions (修改 / 引导 / 等待). */
;(function () {
  'use strict'
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) || location.pathname !== '/' || /Android|iPhone|iPad|DSHApp/i.test(navigator.userAgent) || navigator.standalone === true) return
  var isLocal = true
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
    function labelBtn(btn, text, accent) {
      if (!btn || btn.dataset.dshLabeled === text) return
      btn.dataset.dshLabeled = text
      btn.style.cssText = 'width:auto !important;height:26px !important;padding:0 8px !important;gap:4px !important;font-size:12px !important;font-weight:500 !important;' + (accent ? 'color:var(--theme-accent,#2563eb) !important;' : '')
      var span = btn.querySelector('[data-dsh-lbl]')
      if (!span) {
        span = document.createElement('span')
        span.setAttribute('data-dsh-lbl', '1')
        btn.appendChild(span)
      }
      span.textContent = text
    }
    function enhanceQueueDock() {
      var dock = document.querySelector('[data-queue-dock]')
      if (!dock) return
      var toggle = dock.querySelector('button[aria-controls="composer-queue-dock-list"][aria-expanded="false"]')
      if (toggle && !dock.dataset.dshAutoExpanded) {
        dock.dataset.dshAutoExpanded = '1'
        toggle.click()
      }
      var rows = dock.querySelectorAll('#composer-queue-dock-list > div')
      rows.forEach(function (row) {
        var editBtn = row.querySelector('button[aria-label="编辑排队消息"],button[aria-label="Edit queued message"]')
        var steerBtn = row.querySelector('button[aria-label="插话发送"],button[aria-label="Steer now"]')
        var delBtn = row.querySelector('button[aria-label="删除排队消息"],button[aria-label="Remove queued message"]')
        var bar = (editBtn || delBtn || steerBtn || {}).parentElement
        if (!bar) return
        labelBtn(editBtn, '修改', false)
        labelBtn(steerBtn, '引导', true)
        labelBtn(delBtn, '删除', false)
        if (steerBtn && delBtn && steerBtn.previousElementSibling === delBtn) {
          bar.insertBefore(steerBtn, delBtn)
        }
        var waitBtn = bar.querySelector('button[data-dsh-qwait]')
        if (!waitBtn) {
          waitBtn = document.createElement('button')
          waitBtn.type = 'button'
          waitBtn.setAttribute('data-dsh-qwait', '1')
          waitBtn.className = (editBtn || delBtn).className
          waitBtn.title = '保持排队等待当前回合结束后自动发送'
          waitBtn.setAttribute('aria-label', '等待本轮完成')
          waitBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span data-dsh-lbl="1">等待</span>'
          waitBtn.style.cssText = 'width:auto !important;height:26px !important;padding:0 8px !important;gap:4px !important;font-size:12px !important;font-weight:500 !important;'
          waitBtn.onclick = function () {
            waitBtn.dataset.dshWaitAck = '1'
            var lbl = waitBtn.querySelector('[data-dsh-lbl]')
            if (lbl) lbl.textContent = '已选等待'
            waitBtn.style.color = '#16a34a'
            notice('已设为等待：当前回合结束后自动发送')
          }
          if (delBtn) bar.insertBefore(waitBtn, delBtn)
          else bar.appendChild(waitBtn)
        }
      })
    }
    function mount() {
      enhanceQueueDock()
      if (!isLocal) return
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
