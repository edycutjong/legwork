/** Tiny DOM helpers. No framework — the page is a landing, an order sheet and a receipt. */
import { explorerAddress, explorerTx } from '../lib/chain';
import { gwei, usdc18, type OrderStatus } from '../lib/orders';

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function chip(address: string, label?: string) {
  const el = h('button', { class: 'chip', type: 'button', title: `${address} — click to copy`, 'aria-label': `${label ?? short(address)} — copy the full address` }, label ?? short(address));
  el.addEventListener('click', async (ev) => {
    ev.stopPropagation(); // a chip inside a clickable table row copies; it does not navigate
    try {
      await navigator.clipboard.writeText(address);
      el.textContent = 'copied';
      el.classList.add('copied');
      setTimeout(() => { el.textContent = label ?? short(address); el.classList.remove('copied'); }, 900);
    } catch { /* clipboard blocked */ }
  });
  return el;
}

export function amount(wei: bigint, suffix = ' USDC') {
  return h('span', { class: 'mono', title: `${wei} wei` }, `${usdc18(wei)}${suffix}`);
}

export const fmtGwei = (wei: bigint) => `${gwei(wei)} Gwei`;

export function badge(status: OrderStatus) {
  const cls = status.toLowerCase();
  return h('span', { class: `badge ${cls}` }, status.toUpperCase());
}

export const txLink = (hash: string, text = short(hash)) => h('a', { href: explorerTx(hash), target: '_blank', rel: 'noopener' }, text);
export const addrLink = (a: string, text = short(a)) => h('a', { href: explorerAddress(a), target: '_blank', rel: 'noopener' }, text);

export function notice(kind: 'info' | 'error' | 'ok', ...content: (Node | string)[]) {
  return h('div', { class: `notice ${kind === 'info' ? '' : kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('span', {}, ...content));
}

export function countdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'due now';
  const s = Math.floor(secondsLeft);
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return d > 0 ? `${d}d ${p(hh)}:${p(mm)}:${p(ss)}` : `${p(hh)}:${p(mm)}:${p(ss)}`;
}

/** A spinner for the wallet flow (the wait is the signer's, not the page's). */
export const spinner = () => h('span', { class: 'spinner', 'aria-hidden': 'true' });

/** Skeletons for RPC reads: they reserve the space the loaded content will take, so nothing below them moves. */
export const skeleton = (cls = '') => h('span', { class: `skeleton ${cls}`.trim(), 'aria-hidden': 'true' }, ' ');
export function skTable(rows: number, caption: string) {
  return h('div', {},
    h('p', { class: 'sk-status' }, caption),
    h('div', { class: 'sk-table', 'aria-hidden': 'true' },
      h('div', { class: 'sk-head' }),
      ...Array.from({ length: rows }, () => h('div', { class: 'sk-row' }, skeleton(), skeleton('tall'), skeleton(), skeleton(), skeleton('tall'), skeleton(), skeleton()))));
}
export function skCard(caption: string) {
  return h('div', { class: 'card sk-card' },
    h('p', { class: 'sk-status' }, caption),
    h('div', { class: 'sk-lines', 'aria-hidden': 'true' }, skeleton('w40'), skeleton('w80'), skeleton('big'), skeleton('w60'), skeleton('w80'), skeleton('w60'), skeleton('w40'), skeleton('w80'), skeleton('big')));
}

export function errorText(e: any): string {
  const m: string = e?.shortMessage || e?.message || String(e);
  const known = /NotDue|Underfunded|IsPaused|NoOrder|NotPayer|BadParams|PayoutFailed|Reentrant/.exec(m);
  if (known) {
    switch (known[0]) {
      case 'NotDue': return 'Not due yet — the contract reverted NotDue; nothing was sent.';
      case 'Underfunded': return 'The deposit cannot cover amount + tip + reserve at your gas price — the contract reverted Underfunded; nothing was paid, not even partially.';
      case 'IsPaused': return 'The order is paused (its payee refused a payment). The payer can resume or cancel.';
      case 'NoOrder': return 'No such order.';
      case 'NotPayer': return 'Only the payer can do that.';
      case 'BadParams': return 'Rejected parameters (zero payee / amount / interval / maxGasPrice, or nothing to resume).';
      case 'PayoutFailed': return 'The payout to you failed — your wallet refused native USDC.';
      case 'Reentrant': return 'Re-entrancy guard.';
    }
  }
  if (/user rejected|denied/i.test(m)) return 'Signature rejected in the wallet.';
  return m.length > 220 ? m.slice(0, 220) + '…' : m;
}
