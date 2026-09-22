/** `#/o/<id>` — the order sheet: status, countdown, Execute (anyone), the receipt, recent runs, payer controls. */
import { getAddress } from 'viem';
import { explorerAddress, explorerTx } from '../../lib/chain';
import { foldEvents, neededAt, orderStatus, priceCapAt, runsLeft, usdc18, type Order, type OrderEvent, type Run } from '../../lib/orders';
import { decodeReceipt, type Decoded } from '../../lib/receipt';
import { coverage, type ScanState } from '../../lib/scan';
import { CONTRACT, estimateExecute, getOrder, head, receipt as getReceipt, scanHistory, startScan, waitReceipt } from '../rpc';
import { addrLink, badge, chip, countdown, errorText, fmtGwei, h, notice, short, skCard, skTable, spinner, txLink } from '../ui';
import { connect, maxFeeThePageWillSend, onWallet, sendCancel, sendExecute, sendResume, sendTopUp, wallet } from '../wallet';

const ZERO = '0x0000000000000000000000000000000000000000';

export async function renderOrder(root: HTMLElement, id: bigint, opts: { tx?: `0x${string}` } = {}) {
  root.replaceChildren(h('div', { class: 'two-col' }, skCard(`reading order #${id} from the contract…`), h('div', { class: 'card' }, skTable(3, 'reading its runs…'))));
  let order: Order, hd: { number: bigint; timestamp: bigint; basefee: bigint };
  try {
    [order, hd] = await Promise.all([getOrder(id), head()]);
  } catch (e) {
    const again = h('button', { class: 'btn quiet', type: 'button' }, 'Try again');
    again.addEventListener('click', () => renderOrder(root, id, opts));
    root.replaceChildren(notice('error', 'Could not read the order: ', errorText(e)), h('div', { class: 'actions' }, again, h('a', { href: '#/' }, '← all orders')));
    return;
  }
  if (order.payer === ZERO) {
    root.replaceChildren(
      h('div', { class: 'card-head', style: 'margin-bottom:12px' }, h('h2', {}, opts.tx ? `Order #${id} — cancelled, receipt kept` : `Order #${id}`), h('span', { class: 'badge none' }, opts.tx ? 'CANCELLED' : 'NONE')),
      opts.tx
        ? notice('info', `Order #${id} has been cancelled since this run — the receipt below is read from the chain and stays there.`)
        : notice('error', `Order #${id} does not exist (or was cancelled).`),
      h('p', {}, h('a', { href: '#/' }, '← all orders')));
    if (opts.tx) {
      // the order is gone but its receipts are not: render the run from the chain, the payee leg found by elimination
      try {
        const x = decodeReceipt(await getReceipt(opts.tx), CONTRACT);
        if (x.executed && x.executed.id !== id) root.append(notice('error', `That transaction executed order #${x.executed.id}, not #${id}.`));
        else root.append(receiptBox(x, { payee: x.payeeLeg?.to ?? ZERO, amount: x.payeeLeg?.value ?? 0n }));
      } catch (e) { root.append(notice('error', errorText(e))); }
    }
    return;
  }

  const left = h('div');
  const right = h('div');
  root.replaceChildren(h('div', { class: 'two-col' }, left, right));

  // ---------------------------------------------------------------- card
  const card = h('div', { class: 'card order-card' });
  left.append(card);
  let timer: number | undefined;
  let slowTimer: number | undefined; // the 15 s chain re-read; `timer` is the 1 s local clock
  let busy = false; // a transaction this page sent is in flight: the card is not redrawn underneath its status
  let offWallet = () => {};
  let gen = 0; // a history-scan reset while a round is in flight makes that round's result stale
  let seenBlock = 0n; // the newest block this page has seen a receipt in — the scan head must not lag it
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
    const dueAt = `${new Date(Number(order.nextDue) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
    const covers = runsLeft(order, hd.basefee);
    const owedNote = owed > 1n ? h('p', { class: 'muted', style: 'font-size:13px;margin-top:-2px' }, `Due since ${dueAt} — ${owed.toLocaleString('en-US')} periods have accrued; the schedule stays anchored to the original due time and each execute advances it by one interval, so the deposit covers ${covers} of them, so one wallet can run it ${covers === 1n ? 'once' : covers === 2n ? 'twice' : `${covers} times`} back-to-back, one period per execute.`) : '';
    const runBtn = h('button', { class: 'btn wide exec', type: 'button', disabled: st !== 'Due' }, st === 'Due' ? 'Execute — anyone can' : st === 'Waiting' ? 'Execute (not due yet)' : st === 'Paused' ? 'Paused' : 'Underfunded');
    const runNote = h('p', { class: 'muted', style: 'margin-top:10px;font-size:13px;min-height:1.5em' });
    const runStatus = h('div', { style: 'margin-top:12px' });
    runBtn.addEventListener('click', () => execute(runBtn, runStatus));

    card.replaceChildren(
      h('div', { class: 'card-head' }, h('h2', {}, `Order #${id}`), badge(st)),
      h('p', { class: 'lede' }, `${usdc18(order.amount)} USDC to `, chip(order.payee), ` every ${order.interval} s · tip ${usdc18(order.tip)} USDC to whoever runs it`),
      cd,
      owedNote,
      h('dl', { class: 'kv' },
        h('dt', {}, st === 'Due' ? 'due since' : st === 'Paused' ? 'was due' : 'next run due'), h('dd', {}, `${new Date(Number(order.nextDue) * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`),
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
        const eff = mf < hd.basefee ? mf : hd.basefee; // priority 0: the effective price is the base fee, not the max
        if (eff > cap) {
          let g = 60_000n;
          try { g = await estimateExecute(id, wallet()?.address); } catch { /* keep the estimate */ }
          runNote.textContent = `At the current base fee ${fmtGwei(hd.basefee)} the fee is priced above this order's ${fmtGwei(cap)} cap — you would eat ≈ ${usdc18((eff - cap) * g)} USDC of the fee (tip ${usdc18(order.tip)}).`;
        } else {
          runNote.textContent = `The page sends priority 0 at max ${(Number(mf) / 1e9).toFixed(2)} Gwei; your refund is priced at min(that, ${fmtGwei(cap)}). Net ≈ the tip.`;
        }
      });
    }
  };

  const payerControls = (st: string) => {
    const topUpAmt = h('input', { type: 'text', 'aria-label': 'Top-up amount (USDC)', value: usdc18(neededAt(order, hd.basefee)), inputmode: 'decimal', style: 'max-width:160px' });
    const msg = h('div', { style: 'margin-top:12px' });
    const topUp = h('button', { class: 'btn quiet', type: 'button' }, 'Top up');
    const resume = h('button', { class: 'btn quiet', type: 'button', disabled: st !== 'Paused' }, 'Resume');
    const cancel = h('button', { class: 'btn danger', type: 'button' }, 'Cancel & withdraw');
    const run = async (label: string, f: () => Promise<`0x${string}`>) => {
      busy = true;
      msg.replaceChildren(notice('info', spinner(), ` ${label}…`));
      try {
        const hash = await f();
        msg.replaceChildren(notice('info', spinner(), ' Sent ', txLink(hash), ' — waiting for inclusion…'));
        await waitReceipt(hash);
        await refresh(hash);
        msg.replaceChildren(notice('ok', `${label}: done. `, txLink(hash)));
      } catch (e) {
        msg.replaceChildren(notice('error', errorText(e)));
      } finally {
        busy = false;
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
    if (order.payer === ZERO) {
      if (timer) clearInterval(timer);
      if (slowTimer) clearInterval(slowTimer);
      offWallet();
      card.replaceChildren(
        h('h2', {}, `Order #${id}`),
        notice('ok', 'Cancelled — the whole remaining deposit went back to the payer. ', afterTx ? txLink(afterTx, 'transaction') : ''),
        h('p', {}, h('a', { href: '#/' }, '← all orders')),
      );
      return;
    }
    drawCard();
  };

  // onWallet calls its listener once immediately, so this is also the first draw
  timer = window.setInterval(() => {
    // only the countdown text changes each second; the whole card is redrawn on status flips
    const now = BigInt(Math.floor(Date.now() / 1000));
    const st = orderStatus(order, hd.basefee, now);
    const cd = card.querySelector('.countdown');
    const wasDue = card.querySelector('.badge')?.textContent === 'DUE';
    if (st === 'Due' && !wasDue) { drawCard(); return; }
    if (cd && st === 'Waiting') cd.textContent = countdown(Number(order.nextDue - now));
  }, 1000);
  offWallet = onWallet(() => drawCard());
  // The 1 s tick only moves the local clock; the order itself was read once. A shared order (the README's "first come"
  // live order) can be executed, topped up or cancelled from another wallet meanwhile — re-read it every 15 s and
  // redraw only when the chain says it changed, never under a transaction this page is waiting on (drawCard
  // replaces the whole card, status line and payer inputs included).
  const changed = (a: Order, b: Order) => a.nextDue !== b.nextDue || a.deposit !== b.deposit || a.paused !== b.paused || a.payer !== b.payer;
  slowTimer = window.setInterval(async () => {
    if (document.hidden || busy) return;
    try {
      const [o, hd2] = await Promise.all([getOrder(id), head()]);
      if (busy) return;
      hd = hd2; // the base fee feeds needed/cap on the next redraw; the countdown tick reads it too
      if (!changed(order, o)) return;
      order = o;
      if (order.payer === ZERO) { await refresh(); return; }
      drawCard();
      loadRuns(true); // a run by someone else belongs in the table
    } catch { /* transient RPC failure: the card keeps its last good read; the next tick tries again */ }
  }, 15_000);
  window.addEventListener('hashchange', () => { if (timer) clearInterval(timer); if (slowTimer) clearInterval(slowTimer); offWallet(); }, { once: true });

  // ---------------------------------------------------------------- execute → receipt
  async function execute(btn: HTMLButtonElement, out: HTMLElement) {
    btn.disabled = true;
    busy = true;
    out.replaceChildren(notice('info', spinner(), ' Waiting for the wallet…'));
    try {
      if (!wallet()) await connect();
      const hash = await sendExecute(id);
      window.history.replaceState(null, '', `#/o/${id}/tx/${hash}`);
      out.replaceChildren(notice('info', spinner(), ' Sent ', txLink(hash), ' — Arc finalizes at inclusion; one receipt poll…'));
      const r = await waitReceipt(hash);
      seenBlock = r.blockNumber;
      const payee = order.payee, amount = order.amount;
      await refresh();
      out.replaceChildren();
      showReceipt(decodeReceipt(r, CONTRACT, payee), { payee, amount });
      if (order.payer !== ZERO) loadRuns(true); // cancelled meanwhile: the card says so
    } catch (e) {
      out.replaceChildren(notice('error', errorText(e)));
      btn.disabled = false;
    } finally {
      busy = false;
    }
  }

  function showReceipt(x: Decoded, o: Pick<Order, 'payee' | 'amount'>) {
    if (x.executed && x.executed.id !== id) {
      receiptSlot.replaceChildren(notice('error', `That transaction executed order #${x.executed.id}, not #${id}. `, txLink(x.hash)));
      return;
    }
    receiptSlot.replaceChildren(receiptBox(x, o));
  }

  function receiptBox(x: Decoded, o: Pick<Order, 'payee' | 'amount'>) {
    const line = (cls: string, label: string, sub: string, wei: bigint, sign = '') =>
      h('li', { class: `line ${cls}` }, h('span', { class: 'what' }, h('strong', {}, label), sub), h('span', { class: 'amt' }, `${sign}${usdc18(wei)} USDC`, h('small', {}, `${wei} wei`)));
    const e = x.executed;
    const box = h('div', { class: 'receipt' });
    if (!e) {
      box.append(h('h2', {}, 'Receipt'), notice(x.status === 'success' ? 'info' : 'error', `Transaction ${x.status}: no Executed event. `, txLink(x.hash)));
      return box;
    }
    const net = x.executorNet!;
    box.append(
      h('div', { class: 'card-head' }, h('h2', {}, e.paid ? 'Receipt — paid' : 'Receipt — payee refused, order paused'), h('span', { class: `badge ${e.paid ? 'due' : 'paused'}` }, e.paid ? 'PAID' : 'PAUSED')),
      h('p', { class: 'lede' }, 'Executed by ', chip(getAddress(x.executor)), ` in block ${x.blockNumber}. `, txLink(x.hash, 'transaction ' + short(x.hash))),
      h('ul', { class: 'lines' },
        e.paid
          ? line('', 'payee received', `Transfer ${short(CONTRACT)} → ${short(o.payee)} — the EIP-7708 Transfer log Arc's system contract emits for every native USDC move`, x.payeeLeg?.value ?? o.amount)
          : line('debit', 'payee refused', o.payee === ZERO ? 'no payee leg; the amount stayed in the deposit (the order has since been cancelled)' : `no payee leg; ${usdc18(o.amount)} USDC stayed in the deposit`, 0n),
        line('credit', 'executor refunded', `Executed.refund = ${e.gasMetered} gas metered × ${fmtGwei(e.price)}`, e.refund, '+'),
        line('credit', 'executor tipped', 'Executed.tip', e.tip, '+'),
        line('debit', 'real fee paid', `receipt.gasUsed ${x.gasUsed} × effectiveGasPrice ${fmtGwei(x.effectiveGasPrice)} — from the receipt, not from us`, x.realFee, '−'),
        line(`net ${net >= 0n ? 'positive' : 'negative'}`, 'executor net', `refund + tip − real fee · drift ${x.drift} gas (gasUsed − metered) · refund ÷ fee ${x.ratio?.toFixed(6)}`, net < 0n ? -net : net, net >= 0n ? '+' : '−'),
      ),
      h('div', { class: 'legs' }, h('strong', {}, 'Native USDC legs in this receipt (EIP-7708 Transfer logs):'),
        h('ul', {}, ...x.legs.map((l) => h('li', {}, `${short(l.from)} → ${short(l.to)}  ${usdc18(l.value)} USDC  (${l.value} wei)`)))),
      h('div', { class: 'links' },
        h('a', { href: explorerTx(x.hash), target: '_blank', rel: 'noopener' }, 'transaction'),
        h('a', { href: explorerAddress(CONTRACT), target: '_blank', rel: 'noopener' }, 'contract'),
        o.payee === ZERO ? '' : h('a', { href: explorerAddress(o.payee), target: '_blank', rel: 'noopener' }, 'payee'),
        h('a', { href: explorerAddress(getAddress(x.executor)), target: '_blank', rel: 'noopener' }, 'executor')),
    );
    return box;
  }

  if (opts.tx) {
    try {
      const r = await getReceipt(opts.tx);
      seenBlock = r.blockNumber;
      showReceipt(decodeReceipt(r, CONTRACT, order.payee), order);
    } catch (e) { receiptSlot.replaceChildren(notice('error', errorText(e))); }
  }

  // ---------------------------------------------------------------- runs (bounded two-ended scan)
  const runsCard = h('div', { class: 'card runs' }, h('div', { class: 'card-head' }, h('h2', {}, 'Recent runs'), h('span', { class: 'muted', style: 'font-size:13px' }, 'Executed · Paused logs, newest first')));
  const runsBody = h('div', {}, skTable(3, 'scanning 8 × 9,000 blocks — the newest and the oldest…'));
  const older = h('button', { class: 'btn quiet', type: 'button' }, 'Runs in between');
  const scanNote = h('p', { class: 'note muted' });
  runsCard.append(runsBody, h('div', { class: 'actions' }, older), scanNote);
  right.append(runsCard);
  let scan: ScanState | undefined;
  let events: OrderEvent[] = [];

  const drawRuns = (runs: Run[]) => {
    if (runs.length === 0) { runsBody.replaceChildren(h('p', { class: 'muted' }, 'No runs in the scanned range.')); return; }
    runsBody.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'tx'), h('th', {}, 'block'), h('th', {}, 'executor'), h('th', {}, 'metered'), h('th', {}, 'price'), h('th', {}, 'refund + tip'), h('th', {}, 'paid'))),
      h('tbody', {}, ...runs.map((r) => h('tr', {},
        h('td', {}, h('a', { href: `#/o/${id}/tx/${r.transactionHash}` }, short(r.transactionHash))),
        h('td', {}, String(r.blockNumber)),
        h('td', {}, addrLink(r.executor)),
        h('td', {}, String(r.gasMetered)),
        h('td', {}, fmtGwei(r.price)),
        h('td', {}, `${usdc18(r.refund + r.tip)}`),
        h('td', {}, r.paid ? h('span', { class: 'pos' }, 'yes') : h('span', { class: 'neg' }, `no · paused (${r.pausedReason ?? '?'})`)),
      ))))));
  };

  async function loadRuns(reset = false) {
    if (reset || !scan) {
      // the public RPC is load-balanced: a backend can report a head below a block this page has already seen
      const top = [hd.number, order.createdBlock, seenBlock].reduce((a, b) => (b > a ? b : a));
      scan = startScan(top, order.createdBlock);
      events = [];
      gen++;
    }
    const g = gen;
    older.disabled = true;
    try {
      const res = await scanHistory(id, scan, () => g !== gen);
      if (g !== gen) return; // reset happened meanwhile; that round owns the state now
      scan = res.state;
      events.push(...res.logs);
      drawRuns(foldEvents(events));
      const cov = coverage(scan);
      scanNote.textContent = cov.all
        ? `Scanned every block from the order's creation (${order.createdBlock}) to ${scan.head}. Nothing is missing.`
        : `Scanned the newest blocks ${cov.newest?.fromBlock} → ${cov.newest?.toBlock} and the oldest ${cov.oldest?.fromBlock} → ${cov.oldest?.toBlock} in ≤ 9,000-block windows, one request at a time. Runs in between are fetched only on request.`;
      older.disabled = scan.exhausted;
    } catch (e) {
      if (g !== gen) return;
      const again = h('button', { class: 'btn quiet', type: 'button' }, 'Try again');
      again.addEventListener('click', () => { runsBody.replaceChildren(skTable(3, 'scanning again…')); loadRuns(true); });
      runsBody.replaceChildren(notice('error', 'History scan failed: ', errorText(e)), h('div', { class: 'actions', style: 'margin:0 0 12px' }, again));
      older.disabled = true; // nothing has been scanned yet, so there is no "in between" — Try again restarts the scan
    }
  }
  older.addEventListener('click', () => loadRuns());
  loadRuns(true);
}
