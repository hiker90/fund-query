let sheetRoot = null;
let toastTimer = null;
let pendingConfirm = null;

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

export function num(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function fmtMoney(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

export function fmtNav(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n.toFixed(4) : '—';
}

export function fmtPct(value, { signed = true, digits = 2 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = signed && n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

export function fmtShares(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

export function toneClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const parts = String(iso).split('-');
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : String(iso);
}

export function todayISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export function toast(message, tone = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone;
  el.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-show'), 2800);
}

function getSheetRoot() {
  if (!sheetRoot) sheetRoot = document.getElementById('sheet-root');
  return sheetRoot;
}

export function showSheet({ title = '', subtitle = '', body = '', tall = false } = {}) {
  const el = getSheetRoot();
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `
    <div class="sheet-backdrop" data-action="close-sheet"></div>
    <section class="sheet-panel${tall ? ' is-tall' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grabber" aria-hidden="true"></div>
      <header class="sheet-head">
        <div>
          <h2>${esc(title)}</h2>
          ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
        </div>
        <button class="icon-btn subtle" type="button" data-action="close-sheet" aria-label="关闭">✕</button>
      </header>
      <div class="sheet-body">${body}</div>
    </section>`;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => el.classList.add('is-open'));
}

export function hideSheet() {
  const el = getSheetRoot();
  if (!el || el.hidden) return;
  el.classList.remove('is-open');
  document.body.classList.remove('sheet-open');
  const settle = pendingConfirm;
  pendingConfirm = null;
  if (settle) settle(false);
  setTimeout(() => {
    if (!el.classList.contains('is-open')) {
      el.hidden = true;
      el.innerHTML = '';
    }
  }, 240);
}

export function confirmDialog({
  title = '确认操作',
  message = '',
  confirmText = '确认',
  cancelText = '取消',
  danger = false
} = {}) {
  return new Promise((resolve) => {
    pendingConfirm = resolve;
    showSheet({
      title,
      body: `
        <p class="sheet-text">${esc(message)}</p>
        <div class="sheet-actions">
          <button type="button" class="btn ghost" data-confirm="0">${esc(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-confirm="1">${esc(confirmText)}</button>
        </div>`
    });
    const el = getSheetRoot();
    const onClick = (event) => {
      const button = event.target.closest('[data-confirm]');
      if (!button || !el.contains(button)) return;
      el.removeEventListener('click', onClick, true);
      const value = button.dataset.confirm === '1';
      pendingConfirm = null;
      hideSheet();
      resolve(value);
    };
    el.addEventListener('click', onClick, true);
  });
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideSheet();
});
