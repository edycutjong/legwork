/** `#/` — New order form (reserve quoted from the latest base fee) + the open-orders list. */
import { decodeEventLog, isAddress, parseGwei } from 'viem';
import { neededAt, orderStatus, parseUsdc, reserveAt, runsLeft, usdc18 } from '../../lib/orders';
import { legworkAbi } from '../../lib/abi';
import { LIST_PAGE, head, listOrders, waitReceipt } from '../rpc';
import { amount, badge, chip, countdown, errorText, h, notice, spinner } from '../ui';
import { connect, sendCreate, wallet } from '../wallet';

const INTERVALS: [string, number][] = [['every minute', 60], ['hourly', 3600], ['daily', 86400], ['weekly', 604800]];

export async function renderHome(root: HTMLElement) {
  root.replaceChildren();
  const grid = h('div', { class: 'two-col' });
  const formCard = h('div', { class: 'card' }, h('h2', {}, 'New order'), h('p', { class: 'lede' }, 'A standing payment funded with native USDC. Anyone may run it when due; they are repaid the metered gas plus your tip from this deposit.'));
  const listCard = h('div', { class: 'card' }, h('h2', {}, 'Open orders'), h('p', { class: 'lede' }, 'Every order on the contract, read through Multicall3. Click one to run it.'));
  grid.append(formCard, listCard);
  root.append(grid);

  // ---- form
  const payee = h('input', { id: 'f-payee', type: 'text', placeholder: '0x…', autocomplete: 'off', spellcheck: 'false' });
  const amt = h('input', { id: 'f-amount', type: 'text', value: '0.02', inputmode: 'decimal' });
  const interval = h('select', { id: 'f-interval' }, ...INTERVALS.map(([l, s]) => h('option', { value: s }, `${l} (${s} s)`)));
  const tip = h('input', { id: 'f-tip', type: 'text', value: '0.01', inputmode: 'decimal' });
  const maxGp = h('input', { id: 'f-maxgp', type: 'text', value: '100', inputmode: 'decimal' });
  const runs = h('input', { id: 'f-runs', type: 'number', value: '3', min: '1', step: '1' });
  const quote = h('div', { class: 'quote' });
  const status = h('div');
  const submit = h('button', { class: 'btn wide', type: 'submit' }, 'Create order');
  const form = h('form', {},
    h('div', { class: 'field' }, h('label', { for: 'f-payee' }, 'Payee'), payee, h('span', { class: 'hint' }, 'Any address. A contract payee gets a 30,000-gas stipend to accept native USDC; one that refuses pauses the order instead of breaking it.')),
    h('div', { class: 'grid-2' },
      h('div', { class: 'field' }, h('label', { for: 'f-amount' }, 'Amount per run (USDC)'), amt),
      h('div', { class: 'field' }, h('label', { for: 'f-interval' }, 'Interval'), interval)),
    h('div', { class: 'grid-2' },
      h('div', { class: 'field' }, h('label', { for: 'f-tip' }, 'Executor tip (USDC)'), tip, h('span', { class: 'hint' }, 'What whoever runs it earns on top of the gas refund.')),
      h('div', { class: 'field' }, h('label', { for: 'f-maxgp' }, 'Max gas price refunded (Gwei)'), maxGp, h('span', { class: 'hint' }, 'Your ceiling; the contract also caps at 2 × base fee.'))),
    h('div', { class: 'field' }, h('label', { for: 'f-runs' }, 'Runs to deposit for'), runs),
    quote,
    submit,
    status,
  );
  formCard.append(form);

  let hd = { basefee: 20_000_000_000n };
  try { hd = await head(); } catch { /* quote at the documented minimum */ }
  const basefee = hd.basefee;

  const requote = () => {
    try {
      const a = parseUsdc(amt.value || '0'), t = parseUsdc(tip.value || '0'), m = parseGwei(maxGp.value || '0');
      const reserve = reserveAt(basefee, m);
      const perRun = a + t + reserve;
      const n = BigInt(Math.max(1, parseInt(runs.value || '1', 10)));
      const deposit = perRun * n;
      quote.replaceChildren(
        h('div', { class: 'row' }, h('span', {}, 'amount'), amount(a)),
        h('div', { class: 'row' }, h('span', {}, 'tip'), amount(t)),
        h('div', { class: 'row' }, h('span', {}, `gas reserve · 120,000 gas × min(base fee ${usdc18(basefee * 10n ** 9n)} Gwei, ${maxGp.value} Gwei)`), amount(reserve)),
        h('div', { class: 'row' }, h('span', {}, 'one run needs'), amount(perRun)),
        h('div', { class: 'row total' }, h('span', {}, `deposit for ${n} run${n === 1n ? '' : 's'}`), amount(deposit)),
      );
      submit.disabled = false;
      return { a, t, m, deposit };
    } catch (e) {
      quote.replaceChildren(h('div', { class: 'row neg' }, errorText(e)));
      submit.disabled = true;
      return undefined;
    }
  };
  for (const el of [amt, tip, maxGp, runs]) el.addEventListener('input', requote);
  requote();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = requote();
    if (!q) return;
    if (!isAddress(payee.value.trim())) { status.replaceChildren(notice('error', 'Payee is not an address.')); return; }
    submit.disabled = true;
    status.replaceChildren(notice('info', spinner(), ' Waiting for the wallet…'));
    try {
      if (!wallet()) await connect();
      const hash = await sendCreate(payee.value.trim() as `0x${string}`, q.a, parseInt(interval.value, 10), q.t, q.m, q.deposit);
      status.replaceChildren(notice('info', spinner(), ' Sent. Waiting for inclusion…'));
      const r = await waitReceipt(hash);
      const created = r.logs.map((l) => { try { return decodeEventLog({ abi: legworkAbi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === 'Created') as any;
      const id = created?.args?.id as bigint;
      window.location.hash = `#/o/${id}`;
    } catch (e) {
      status.replaceChildren(notice('error', errorText(e)));
      submit.disabled = false;
    }
  });

  // ---- list
  const wrap = h('div', { class: 'table-wrap orders' }, h('p', {}, spinner(), ' reading orders…'));
  listCard.append(wrap);
  try {
    const { total, rows: orders } = await listOrders();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const tbody = h('tbody');
    for (const { id, order } of orders) {
      const st = orderStatus(order, hd.basefee, now);
      const left = Number(order.nextDue - now);
      tbody.append(h('tr', { class: 'row-link', onClick: () => (window.location.hash = `#/o/${id}`) },
        h('td', {}, `#${id}`),
        h('td', {}, chip(order.payee)),
        h('td', {}, `${usdc18(order.amount)} / ${order.interval}s`),
        h('td', {}, `tip ${usdc18(order.tip)}`),
        h('td', {}, badge(st)),
        h('td', {}, st === 'Paused' ? '—' : countdown(left)),
        h('td', {}, `${runsLeft(order, hd.basefee)} · ${usdc18(order.deposit, 6)} left`),
      ));
    }
    wrap.replaceChildren(
      orders.length === 0 ? h('p', { class: 'muted' }, 'No open orders.') :
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'id'), h('th', {}, 'payee'), h('th', {}, 'amount / interval'), h('th', {}, 'tip'), h('th', {}, 'status'), h('th', {}, 'next run'), h('th', {}, 'runs · deposit'))), tbody),
      total > BigInt(LIST_PAGE) ? h('p', { class: 'muted', style: 'margin-top:12px' }, `Showing the newest ${LIST_PAGE} of ${total} orders; older ones open directly at #/o/<id>.`) : '',
      h('p', { class: 'muted', style: 'margin-top:12px' }, `Base fee now ${usdc18(hd.basefee * 10n ** 9n)} Gwei · one honest run of a 0.02 / tip 0.01 order needs ${usdc18(neededAt({ amount: parseUsdc('0.02'), tip: parseUsdc('0.01'), maxGasPrice: parseGwei('100') }, hd.basefee))} USDC.`),
    );
  } catch (e) {
    wrap.replaceChildren(notice('error', 'Could not read the contract: ', errorText(e)));
  }
}
