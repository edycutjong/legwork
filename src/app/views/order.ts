/** `#/o/<id>` — the order sheet: status, countdown, Execute (anyone), the receipt, recent runs, payer controls. */
import { explorerAddress, explorerTx } from '../../lib/chain';
import { foldEvents, neededAt, orderStatus, priceCapAt, runsLeft, usdc18, type Order, type OrderEvent, type Run } from '../../lib/orders';
import { decodeReceipt, type Decoded } from '../../lib/receipt';
import type { ScanState } from '../../lib/scan';
import { CONTRACT, OVERHEAD, estimateExecute, getOrder, head, receipt as getReceipt, scanHistory, startScan, waitReceipt } from '../rpc';
import { addrLink, amount, badge, chip, countdown, errorText, fmtGwei, h, notice, short, spinner, txLink } from '../ui';
import { connect, maxFeeThePageWillSend, onWallet, sendCancel, sendExecute, sendResume, sendTopUp, wallet } from '../wallet';

export async function renderOrder(root: HTMLElement, id: bigint, opts: { tx?: `0x${string}` } = {}) {
  root.replaceChildren(h('p', {}, spinner(), ` reading order #${id}…`));
  let order: Order, hd: { number: bigint; timestamp: bigint; basefee: bigint };
  try {
    [order, hd] = await Promise.all([getOrder(id), head()]);
  } catch (e) {
    root.replaceChildren(notice('error', 'Could not read the order: ', errorText(e)));
    return;
  }
  if (order.payer === '0x0000000000000000000000000000000000000000') {
    root.replaceChildren(notice('error', `Order #${id} does not exist (or was cancelled).`), h('p', {}, h('a', { href: '#/' }, '← all orders')));
    return;
  }

  const left = h('div');
  const right = h('div');
  root.replaceChildren(h('div', { class: 'two-col' }, left, right));

  // ---------------------------------------------------------------- card
  const card = h('div', { class: 'card' });
  left.append(card);
  let timer: number | undefined;
  const receiptSlot = h('div');
  left.append(receiptSlot);

  const drawCard = () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const st = orderStatus(order, hd.basefee, now);
    const needed = neededAt(order, hd.basefee);
    const cap = priceCapAt(order.maxGasPrice, hd.basefee);
    const secs = Number(order.nextDue - now);
    const isPayer = wallet()?.address.toLowerCase() === order.payer.toLowerCase();
    const owed = st === 'Due' && order.interval > 0n ? (now - order.nextDue) / order.interval + 1n : 0n;
    const cd = h('div', { class: `countdown ${st === 'Due' ? 'due' : 'waiting'}`, 'aria-live': 'polite' }, st === 'Paused' ? 'paused' : st === 'Underfunded' ? 'underfunded' : countdown(secs));
    const owedNote = owed > 1n ? h('p', { class: 'muted', style: 'font-size:13px;margin-top:-4px' }, `${owed} periods are owed — the schedule is anchored, so each execute pays one period and the next is due immediately until it has caught up.`) : '';
    const runBtn = h('button', { class: 'btn wide', type: 'button', disabled: st !== 'Due' }, st === 'Due' ? 'Execute — anyone can' : st === 'Waiting' ? 'Execute (not due yet)' : st === 'Paused' ? 'Paused' : 'Underfunded');
    const runNote = h('p', { class: 'muted', style: 'margin-top:8px;font-size:13px' });
    const runStatus = h('div');
    runBtn.addEventListener('click', () => execute(runBtn, runStatus));

    card.replaceChildren(
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap' }, h('h2', {}, `Order #${id}`), badge(st)),
      h('p', { class: 'lede' }, `${usdc18(order.amount)} USDC to `, chip(order.payee), ` every ${order.interval} s · tip ${usdc18(order.tip)} USDC to whoever runs it`),
      cd,
      owedNote,
      h('dl', { class: 'kv' },
        h('dt', {}, 'next run due'), h('dd', {}, `${new Date(Number(order.nextDue) * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`),
        h('dt', {}, 'deposit'), h('dd', {}, `${usdc18(order.deposit)} USDC`, h('small', { class: 'muted' }, ` · ${order.deposit} wei`)),
        h('dt', {}, 'runs left'), h('dd', {}, `${runsLeft(order, hd.basefee)} · one honest run needs ${usdc18(needed)} USDC`),
        h('dt', {}, 'refunded at ≤'), h('dd', {}, `${fmtGwei(cap)} · min(2 × base fee ${fmtGwei(hd.basefee)}, max ${fmtGwei(order.maxGasPrice)})`),
        h('dt', {}, 'payer'), h('dd', {}, chip(order.payer), isPayer ? ' (you)' : ''),
        h('dt', {}, 'created at block'), h('dd', {}, String(order.createdBlock)),
      ),
      st === 'Underfunded' ? notice('info', `Top up at least ${usdc18(needed - order.deposit)} USDC to make the next run possible. Nothing is paid partially — the contract reverts Underfunded instead. Periods missed while underfunded stay owed and are caught up one per execute after the top-up.`) : '',
      st === 'Paused' ? notice('error', 'The payee refused the last payment, so the order paused. The unpaid amount stayed in the deposit and the executor who found out was still repaid and tipped. The payer can resume or cancel.') : '',
      runBtn, runNote, runStatus,
      isPayer ? payerControls(st) : '',
    );
    if (st === 'Due') {
      maxFeeThePageWillSend().then(async (mf) => {
        if (mf > cap) {
          let g = 60_000n;
          try { g = await estimateExecute(id, wallet()?.address); } catch { /* keep the estimate */ }
          runNote.textContent = `The page will send maxFee ${fmtGwei(mf)}, above this order's ${fmtGwei(cap)} cap — you would eat ≈ ${usdc18((mf - cap) * g)} USDC of the fee (tip ${usdc18(order.tip)}).`;
        } else {
          runNote.textContent = `The page sends priority 0 at max ${fmtGwei(mf)}; your refund is priced at min(that, ${fmtGwei(cap)}). Net ≈ the tip.`;
        }
      });
    }
  };

  const payerControls = (st: string) => {
    const topUpAmt = h('input', { type: 'text', value: usdc18(neededAt(order, hd.basefee)), inputmode: 'decimal', style: 'max-width:160px' });
    const msg = h('div');
    const topUp = h('button', { class: 'btn quiet', type: 'button' }, 'Top up');
    const resume = h('button', { class: 'btn quiet', type: 'button', disabled: st !== 'Paused' }, 'Resume');
    const cancel = h('button', { class: 'btn danger', type: 'button' }, 'Cancel & withdraw');
    const run = async (label: string, f: () => Promise<`0x${string}`>) => {
      msg.replaceChildren(notice('info', spinner(), ` ${label}…`));
      try {
        const hash = await f();
        msg.replaceChildren(notice('info', spinner(), ' Sent ', txLink(hash), ' — waiting for inclusion…'));
        await waitReceipt(hash);
        await refresh(hash);
        msg.replaceChildren(notice('ok', `${label}: done. `, txLink(hash)));
      } catch (e) {
        msg.replaceChildren(notice('error', errorText(e)));
      }
    };
    topUp.addEventListener('click', () => run('Top up', () => sendTopUp(id, BigInt(Math.round(parseFloat(topUpAmt.value) * 1e6)) * 10n ** 12n)));
    resume.addEventListener('click', () => run('Resume', () => sendResume(id)));
    cancel.addEventListener('click', () => { if (confirm(`Cancel order #${id} and withdraw ${usdc18(order.deposit)} USDC?`)) run('Cancel', () => sendCancel(id)); });
    return h('div', { style: 'margin-top:20px;padding-top:16px;border-top:1px solid var(--rule)' },
      h('h3', {}, 'Payer controls'),
      h('div', { class: 'actions' }, h('span', { class: 'field', style: 'margin:0' }, topUpAmt), topUp, resume, cancel),
      msg);
  };

  const refresh = async (afterTx?: `0x${string}`) => {
    [order, hd] = await Promise.all([getOrder(id), head()]);
    if (order.payer === '0x0000000000000000000000000000000000000000') {
      if (timer) clearInterval(timer);
      card.replaceChildren(
        h('h2', {}, `Order #${id}`),
        notice('ok', 'Cancelled — the whole remaining deposit went back to the payer. ', afterTx ? txLink(afterTx, 'transaction') : ''),
        h('p', {}, h('a', { href: '#/' }, '← all orders')),
      );
      return;
    }
    drawCard();
  };

  drawCard();
  timer = window.setInterval(() => {
    // only the countdown text changes each second; the whole card is redrawn on status flips
    const now = BigInt(Math.floor(Date.now() / 1000));
    const st = orderStatus(order, hd.basefee, now);
    const cd = card.querySelector('.countdown');
    const wasDue = card.querySelector('.badge')?.textContent === 'DUE';
    if (st === 'Due' && !wasDue) { drawCard(); return; }
    if (cd && st === 'Waiting') cd.textContent = countdown(Number(order.nextDue - now));
  }, 1000);
  onWallet(() => drawCard());
  window.addEventListener('hashchange', () => timer && clearInterval(timer), { once: true });

  // ---------------------------------------------------------------- execute → receipt
  async function execute(btn: HTMLButtonElement, out: HTMLElement) {
    btn.disabled = true;
    out.replaceChildren(notice('info', spinner(), ' Waiting for the wallet…'));
    try {
      if (!wallet()) await connect();
      const hash = await sendExecute(id);
      window.history.replaceState(null, '', `#/o/${id}/tx/${hash}`);
      out.replaceChildren(notice('info', spinner(), ' Sent ', txLink(hash), ' — Arc finalizes at inclusion; one receipt poll…'));
      const r = await waitReceipt(hash);
      await refresh();
      out.replaceChildren();
      showReceipt(decodeReceipt(r, CONTRACT, order.payee), order);
      loadRuns(true);
    } catch (e) {
      out.replaceChildren(notice('error', errorText(e)));
      btn.disabled = false;
    }
  }

  function showReceipt(x: Decoded, o: Order) {
    const line = (cls: string, label: string, sub: string, wei: bigint, sign = '') =>
      h('li', { class: `line ${cls}` }, h('span', { class: 'what' }, h('strong', {}, label), sub), h('span', { class: 'amt' }, `${sign}${usdc18(wei)} USDC`, h('small', {}, `${wei} wei`)));
    const e = x.executed;
    const box = h('div', { class: 'receipt' });
    if (!e) {
      box.append(h('h2', {}, 'Receipt'), notice(x.status === 'success' ? 'info' : 'error', `Transaction ${x.status}: no Executed event. `, txLink(x.hash)));
      receiptSlot.replaceChildren(box);
      return;
    }
    const net = x.executorNet!;
    box.append(
      h('h2', {}, e.paid ? 'Receipt — paid' : 'Receipt — payee refused, order paused'),
      h('p', { class: 'lede' }, 'Executed by ', chip(x.executor), ` in block ${x.blockNumber}. `, txLink(x.hash, 'transaction ' + short(x.hash))),
      h('ul', { class: 'lines' },
        e.paid
          ? line('', 'payee received', `Transfer ${short(CONTRACT)} → ${short(o.payee)} from the system emitter`, x.payeeLeg?.value ?? o.amount)
          : line('debit', 'payee refused', `no payee leg; ${usdc18(o.amount)} USDC stayed in the deposit`, 0n),
        line('credit', 'executor refunded', `Executed.refund = ${e.gasMetered} gas metered × ${fmtGwei(e.price)}`, e.refund, '+'),
        line('credit', 'executor tipped', 'Executed.tip', e.tip, '+'),
        line('debit', 'real fee paid', `receipt.gasUsed ${x.gasUsed} × effectiveGasPrice ${fmtGwei(x.effectiveGasPrice)} — from the receipt, not from us`, x.realFee, '−'),
        line(`net ${net >= 0n ? 'positive' : 'negative'}`, 'executor net', `refund + tip − real fee · drift ${x.drift} gas (gasUsed − metered, after OVERHEAD ${OVERHEAD}) · refund ÷ fee ${x.ratio?.toFixed(6)}`, net < 0n ? -net : net, net >= 0n ? '+' : '−'),
      ),
      h('div', { class: 'legs' }, h('strong', {}, 'Native USDC legs in this receipt (EIP-7708 Transfer logs):'),
        h('ul', {}, ...x.legs.map((l) => h('li', {}, `${short(l.from)} → ${short(l.to)}  ${usdc18(l.value)} USDC  (${l.value} wei)`)))),
      h('div', { class: 'links' },
        h('a', { href: explorerTx(x.hash), target: '_blank', rel: 'noopener' }, 'transaction'),
        h('a', { href: explorerAddress(CONTRACT), target: '_blank', rel: 'noopener' }, 'contract'),
        h('a', { href: explorerAddress(o.payee), target: '_blank', rel: 'noopener' }, 'payee'),
        h('a', { href: explorerAddress(x.executor), target: '_blank', rel: 'noopener' }, 'executor')),
    );
    receiptSlot.replaceChildren(box);
  }

  if (opts.tx) {
    try { showReceipt(decodeReceipt(await getReceipt(opts.tx), CONTRACT, order.payee), order); } catch (e) { receiptSlot.replaceChildren(notice('error', errorText(e))); }
  }

  // ---------------------------------------------------------------- runs (bounded backward scan)
  const runsCard = h('div', { class: 'card runs' }, h('h2', {}, 'Recent runs'));
  const runsBody = h('div', {}, h('p', {}, spinner(), ' scanning the last 8 × 9,000 blocks…'));
  const older = h('button', { class: 'btn quiet', type: 'button' }, 'Older runs');
  const scanNote = h('p', { class: 'muted', style: 'font-size:13px' });
  runsCard.append(runsBody, h('div', { class: 'actions' }, older), scanNote);
  right.append(runsCard);
  let scan: ScanState | undefined;
  let events: OrderEvent[] = [];

  const drawRuns = (runs: Run[]) => {
    if (runs.length === 0) { runsBody.replaceChildren(h('p', { class: 'muted' }, 'No runs in the scanned range.')); return; }
    runsBody.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'block'), h('th', {}, 'executor'), h('th', {}, 'metered'), h('th', {}, 'price'), h('th', {}, 'refund + tip'), h('th', {}, 'paid'), h('th', {}, 'tx'))),
      h('tbody', {}, ...runs.map((r) => h('tr', {},
        h('td', {}, String(r.blockNumber)),
        h('td', {}, addrLink(r.executor)),
        h('td', {}, String(r.gasMetered)),
        h('td', {}, fmtGwei(r.price)),
        h('td', {}, `${usdc18(r.refund + r.tip)}`),
        h('td', {}, r.paid ? h('span', { class: 'pos' }, 'yes') : h('span', { class: 'neg' }, `no · paused (${r.pausedReason ?? '?'})`)),
        h('td', {}, h('a', { href: `#/o/${id}/tx/${r.transactionHash}` }, short(r.transactionHash))),
      ))))));
  };

  async function loadRuns(reset = false) {
    if (reset || !scan) { scan = startScan(hd.number, order.createdBlock); events = []; }
    older.disabled = true;
    try {
      const res = await scanHistory(id, scan);
      scan = res.state;
      events.push(...res.logs);
      drawRuns(foldEvents(events));
      scanNote.textContent = scan.exhausted
        ? `Scanned back to the order's creation block ${order.createdBlock}. Nothing older can exist.`
        : `Scanned blocks ${scan.nextTo + 1n} → ${hd.number} in ≤ 9,000-block windows. Older runs are fetched only on request, never past block ${order.createdBlock}.`;
      older.disabled = scan.exhausted;
    } catch (e) {
      runsBody.replaceChildren(notice('error', 'History scan failed: ', errorText(e)));
      older.disabled = false;
    }
  }
  older.addEventListener('click', () => loadRuns());
  loadRuns(true);
}
