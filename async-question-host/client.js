window.__ModuleLoader__.load({ id: 'dsh-async-questions', factory: (require) => {
  'use strict';
  const React = require('react');
  const h = React.createElement;
  // Drafts survive the session dock remount. No answers are inferred from a timer.
  const drafts = new Map();
  function draftFor(sessionId, id) {
    const key = sessionId + ':' + id;
    if (!drafts.has(key)) drafts.set(key, { text: '', state: 'idle', answerId: null, error: '' });
    return drafts.get(key);
  }
  function observeAnswer(sessionId, item) {
    const draft = draftFor(sessionId, item.id);
    if (item.status === 'answered' && (item.delivery === 'accepted' || item.delivery === 'not-needed')) {
      draft.state = 'sent'; draft.error = '';
    } else if (item.delivery === 'unknown' || (item.status === 'answered' && item.delivery === 'pending')) draft.state = 'unknown';
    return draft;
  }
  async function submitAnswer(sessionId, item, refresh, fetcher = fetch) {
    const draft = draftFor(sessionId, item.id);
    if (draft.state !== 'idle' || item.status === 'answered' || !draft.text.trim()) return false;
    draft.state = 'sending'; draft.answerId = crypto.randomUUID(); draft.error = '';
    const answer = draft.text.trim();
    refresh();
    try {
      const response = await fetcher('/m/api/async-questions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ s: sessionId, id: item.id, answer, answerId: draft.answerId }),
        signal: AbortSignal.timeout(20000)
      });
      const receipt = await response.json();
      if (!response.ok || !receipt.ok) throw new Error(receipt.error?.message || receipt.error || '答案提交结果未确认');
      const updated = receipt.value?.item || receipt.value;
      if (updated?.status !== 'answered' || !['accepted', 'not-needed'].includes(updated.delivery)) throw new Error('答案提交结果未确认');
      draft.state = 'sent'; draft.error = '';
    } catch (error) {
      // A failed transport may have delivered the answer. Never mint another ID and replay it.
      draft.state = 'unknown'; draft.error = String(error.message || error);
    }
    refresh(); return draft.state === 'sent';
  }
  function questionStatus(item, now) {
    if (item.status === 'answered') return item.delivery === 'accepted' ? '已回答，已排入原会话后续处理' : item.delivery === 'not-needed' ? '已回答' : '答案已记录，送达状态待确认';
    if (item.status === 'deferred') return '暂未收到回答，已结束本次等待，可先处理不依赖答案的工作；仍可补答';
    const seconds = Math.max(0, Math.ceil((Date.parse(item.deadline) - now) / 1000));
    return Number.isFinite(seconds) && seconds > 0 ? '等待你的偏好 · ' + seconds + ' 秒' : '等待状态更新；未替你选择答案';
  }
  function answerText(answer, draft) {
    return typeof answer === 'string' ? answer : typeof answer?.text === 'string' ? answer.text : draft || '已记录';
  }
  function pendingItems(sessionId, items) {
    return items.filter(item => draftFor(sessionId, item.id).state !== 'sent' && (item.status !== 'answered' || !['accepted', 'not-needed'].includes(item.delivery)));
  }
  function AsyncQuestionDock({ sessionId }) {
    const [items, setItems] = React.useState([]), [error, setError] = React.useState('');
    const [, redraw] = React.useState(0), [now, setNow] = React.useState(Date.now());
    const refreshRef = React.useRef(() => {});
    const repaint = () => redraw(n => n + 1);
    React.useEffect(() => {
      if (!sessionId) { setItems([]); return; }
      let live = true, inFlight = false;
      const controller = new AbortController();
      const refresh = async () => {
        if (inFlight || !live) return;
        inFlight = true;
        try {
          const response = await fetch('/m/api/async-questions?s=' + encodeURIComponent(sessionId), { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          const out = await response.json();
          if (!response.ok || !out.ok) throw new Error(out.error?.message || '问题状态暂时无法刷新');
          if (live) {
            const next = (out.value?.items || []).filter(item => item.sessionId === sessionId);
            next.forEach(item => observeAnswer(sessionId, item));
            setItems(next); setError(''); setNow(Date.now());
          }
        } catch (cause) { if (live) setError(cause.message || '问题状态暂时无法刷新'); }
        finally { inFlight = false; }
      };
      refreshRef.current = refresh; setItems([]); void refresh();
      const interval = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
      const focused = () => void refresh(); window.addEventListener('focus', focused);
      return () => { live = false; controller.abort(); clearInterval(interval); window.removeEventListener('focus', focused); refreshRef.current = () => {}; };
    }, [sessionId]);
    if (!sessionId) return null;
    const pending = pendingItems(sessionId, items);
    if (!pending.length) return null;
    return h('section', { 'aria-label': '待补充的偏好问题', style: { margin: '8px 0', border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 12, padding: 12, maxHeight: '35vh', overflow: 'auto' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12 } }, h('strong', null, '偏好问题' + (pending.length ? ' · ' + pending.length + ' 个待补答' : ' · 已回答')), h('button', { type: 'button', onClick: () => void refreshRef.current() }, '刷新状态')),
      h('small', null, '未回答不代表同意。审批和授权仍需明确确认。'),
      error && h('p', { role: 'status' }, error),
      ...pending.map(item => {
        const draft = draftFor(sessionId, item.id), locked = draft.state !== 'idle' || item.status === 'answered';
        const answer = item.answer;
        return h('details', { key: sessionId + ':' + item.id, open: item.status !== 'answered', style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid #8883' } },
          h('summary', { style: { cursor: 'pointer' } }, item.question),
          h('p', { role: 'status', style: { fontSize: 12 } }, questionStatus(item, now)),
          item.independentWork && h('p', { style: { fontSize: 12 } }, '可先进行：' + item.independentWork),
          item.status === 'answered' && h('p', null, '你的回答：' + answerText(answer, draft.text)),
          item.status !== 'answered' && h('div', null,
            h('div', { role: 'group', 'aria-label': '可选偏好', style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, ...(item.options || []).map((option, index) => h('button', { key: index, type: 'button', disabled: locked, 'aria-pressed': draft.text === option, onClick: () => { draft.text = option; repaint(); } }, option))),
            h('textarea', { 'aria-label': '补充回答：' + item.question, value: draft.text, disabled: locked, rows: 2, style: { width: '100%', boxSizing: 'border-box', marginTop: 8 }, onChange: event => { draft.text = event.target.value; repaint(); } }),
            h('button', { type: 'button', disabled: locked || !draft.text.trim(), onClick: () => void submitAnswer(sessionId, item, repaint).then(() => refreshRef.current()) }, draft.state === 'sending' ? '正在提交…' : draft.state === 'sent' ? '已提交' : '提交回答')),
          draft.state === 'unknown' && h('p', { role: 'alert' }, '提交结果未确认，请刷新状态；不会自动重复发送。' + (draft.error ? ' ' + draft.error : '')));
      }));
  }
  function apply(ctx) {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock', id: 'async-preference-questions', order: 25
    }, AsyncQuestionDock));
  }
  return { inject: ['slots'], apply, AsyncQuestionDock, draftFor, observeAnswer, submitAnswer, questionStatus, answerText, pendingItems };
} });
