/** `#/` — the landing: the claim, the New-order form (reserve quoted from the latest base fee), the open-orders list read
 *  through Multicall3, the living diagram of `execute()`, why it needs Arc, the hero receipt, the proof strip, the limits
 *  and the reviewer path. Every number here is either read from the chain now or copied from a committed receipt. */
import { decodeEventLog, isAddress, parseGwei } from 'viem';
import { neededAt, orderStatus, parseUsdc, reserveAt, runsLeft, usdc18 } from '../../lib/orders';
import { legworkAbi } from '../../lib/abi';
import { explorerAddress, explorerTx } from '../../lib/chain';
import { CONTRACT, DEPLOY, LIST_PAGE, head, listOrders, waitReceipt } from '../rpc';
import { amount, badge, chip, countdown, errorText, h, notice, short, skTable, spinner } from '../ui';
import { connect, sendCreate, wallet } from '../wallet';
import { EXEC_DIAGRAM } from './diagram';

const INTERVALS: [string, number][] = [['every minute', 60], ['hourly', 3600], ['daily', 86400], ['weekly', 604800]];
const HERO_TX = '0x2f6a352d11823a37ad085151067856131833ef978445fbed5941e7d17b5b0c95';
const HERO_PAYEE = '0x352e5cDea885DBCAbe850259CA8AA6759b5aAA60';
const HERO_EXECUTOR = '0xA8965A47c9b6ed34F47B374f36cF6c752D24852a';
const REPO = 'https://github.com/edycutjong/legwork';

export async function renderHome(root: HTMLElement) {
  root.replaceChildren();
  const live = (DEPLOY.orders as any)?.live?.id ?? 1;

  // ---------------------------------------------------------------- hero: the claim + the form
  const payee = h('input', { id: 'f-payee', type: 'text', placeholder: '0x…', autocomplete: 'off', spellcheck: 'false' });
  const amt = h('input', { id: 'f-amount', type: 'text', value: '0.02', inputmode: 'decimal' });
  const interval = h('select', { id: 'f-interval' }, ...INTERVALS.map(([l, s]) => h('option', { value: s }, `${l} (${s} s)`)));
  const tip = h('input', { id: 'f-tip', type: 'text', value: '0.01', inputmode: 'decimal' });
  const maxGp = h('input', { id: 'f-maxgp', type: 'text', value: '100', inputmode: 'decimal' });
  const runs = h('input', { id: 'f-runs', type: 'number', value: '3', min: '1', step: '1' });
  const quote = h('div', { class: 'quote' });
  const status = h('div');
  const submit = h('button', { class: 'btn wide', type: 'submit' }, 'Create order');
  const form = h('form', { 'aria-describedby': 'form-after' },
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
    h('p', { class: 'after', id: 'form-after' }, 'Reading needs no wallet. Create signs one transaction with the injected wallet and offers to add Arc (chain 5042) if it is missing.'),
  );
  const formCard = h('div', { class: 'card form-card', id: 'new-order' },
    h('div', { class: 'card-head' }, h('h2', {}, 'New order'), h('span', { class: 'tag' }, 'one transaction')),
    h('p', { class: 'lede' }, 'A standing payment funded with native USDC. Anyone may run it when due; they are repaid the metered gas plus your tip from this deposit.'),
    form);

  const toForm = h('button', { class: 'btn quiet', type: 'button' }, 'Create an order ', h('span', { class: 'arrow', 'aria-hidden': 'true' }, '↓'));
  toForm.addEventListener('click', () => { formCard.scrollIntoView({ block: 'start' }); payee.focus({ preventScroll: true }); });

  root.append(
    h('section', { class: 'hero', 'aria-labelledby': 'claim' },
      h('div', { class: 'hero-copy' },
        h('span', { class: 'eyebrow' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', {}, 'Live on ', h('strong', {}, 'Arc mainnet'), ' · chain 5042', h('span', { class: 'hide-sm' }, ' · 107 committed receipts'))),
        h('h1', { id: 'claim' }, 'Standing USDC orders ', h('span', { class: 'cu' }, 'anyone can run'), ' — ', h('span', { class: 'thin' }, 'repaid the exact gas, in the same dollar, in the same transaction.')),
        h('p', { class: 'lede-lg' }, 'A payer funds a recurring payment with native USDC. When it is due, ', h('strong', {}, 'anyone'), ' calls ', h('code', {}, 'execute()'), ': the contract pays the payee, meters the gas the call consumed and pays the executor that gas plus the payer’s tip — from the same deposit, in the same transaction. On Arc the gas ', h('em', {}, 'is'), ' USDC, so the refund is arithmetic: ', h('strong', {}, 'no oracle, no keeper network, no server.')),
        h('div', { class: 'cta-row' },
          h('a', { class: 'btn', href: `#/o/${live}` }, 'Try the live order ', h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→')),
          toForm,
          h('span', { class: 'also' }, 'or read the ', h('a', { href: `#/o/5/tx/${HERO_TX}` }, 'hero receipt'), ' — no wallet needed')),
        h('div', { class: 'stats', role: 'list' },
          h('div', { class: 'stat', role: 'listitem' }, h('b', {}, h('span', { class: 'cu' }, '0'), ' drift'), h('span', {}, 'gas metered vs used, on 30 of 30 mainnet runs')),
          h('div', { class: 'stat', role: 'listitem' }, h('b', {}, '1.000000'), h('span', {}, 'refund ÷ real fee, every row')),
          h('div', { class: 'stat', role: 'listitem' }, h('b', {}, '58,415'), h('span', {}, 'gas per run · p50 = p95')),
          h('div', { class: 'stat', role: 'listitem' }, h('b', {}, '107'), h('span', {}, 'receipts committed · 0.1944 USDC of gas')))),
      formCard),
  );

  let hd = { basefee: 20_000_000_000n };
  const requote = () => {
    try {
      const a = parseUsdc(amt.value || '0'), t = parseUsdc(tip.value || '0'), m = parseGwei(maxGp.value || '0');
      const reserve = reserveAt(hd.basefee, m);
      const perRun = a + t + reserve;
      const n = BigInt(Math.max(1, parseInt(runs.value || '1', 10)));
      const deposit = perRun * n;
      quote.replaceChildren(
        h('div', { class: 'row' }, h('span', {}, 'amount'), amount(a)),
        h('div', { class: 'row' }, h('span', {}, 'tip'), amount(t)),
        h('div', { class: 'row' }, h('span', {}, `gas reserve · 120,000 gas × min(base fee ${usdc18(hd.basefee * 10n ** 9n)} Gwei, ${maxGp.value} Gwei)`), amount(reserve)),
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
  requote(); // quoted at the documented 20 Gwei minimum first, then again from the latest block — same rows, no layout shift

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = requote();
    if (!q) return;
    if (!isAddress(payee.value.trim())) { status.replaceChildren(notice('error', 'Payee is not an address.')); payee.focus(); return; }
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

  // ---------------------------------------------------------------- open orders (the proof that it is live)
  const wrap = h('div', { class: 'orders orders-wrap' }, skTable(5, 'reading every order on the contract through Multicall3…'));
  root.append(
    h('section', { class: 'section', 'aria-labelledby': 'orders-h' },
      h('div', { class: 'section-head' }, h('span', { class: 'kicker' }, 'Live from the contract'), h('h2', { id: 'orders-h' }, 'Open orders'), h('p', {}, 'Every open order on ', h('a', { href: explorerAddress(CONTRACT), target: '_blank', rel: 'noopener', class: 'mono' }, short(CONTRACT)), ', read through Multicall3 in one round-trip. Click one to run it: you are repaid the gas and keep the tip.')),
      h('div', { class: 'card orders-card' }, wrap)),
  );

  // ---------------------------------------------------------------- how one execute() runs
  const step = (cls: string, code: string, ...rest: (Node | string)[]) => h('li', { class: cls }, h('div', {}, h('code', {}, code), rest.length ? h('span', { class: 'm' }, ...rest) : ''));
  root.append(
    h('section', { class: 'section', 'aria-labelledby': 'exec-h' },
      h('div', { class: 'section-head' }, h('span', { class: 'kicker' }, 'The mechanism'), h('h2', { id: 'exec-h' }, 'One call. The order pays whoever ran it.'), h('p', {}, 'Inside ', h('code', {}, 'execute()'), ' the contract opens a metered window with its first statement, pays the payee, closes the window, and pays the executor ', h('strong', {}, 'exactly the gas it measured'), ' plus the tip — out of the order’s own deposit. Gas and deposit are one asset, so the refund needs no conversion.')),
      h('div', { class: 'exec' },
        h('div', { class: 'card exec-stage' },
          h('div', { class: 'dg-wrap' }, h('div', { class: 'dg-scroll', html: EXEC_DIAGRAM })),
          h('p', { class: 'swipe-hint' }, 'swipe → to see the whole call'),
          h('div', { class: 'mono-eq', 'aria-label': 'The receipt equalities' },
            h('div', { class: 'eq b6' }, h('b', {}, 'refund = gasMetered × ', h('span', { class: 'cu' }, 'price')), '= gasUsed × effectiveGasPrice, to the wei · 58,415 × 20 Gwei = 0.0011683 USDC'),
            h('div', { class: 'eq b7' }, h('b', {}, 'drift ', h('span', { class: 'ok' }, '0'), ' gas'), 'gasUsed − gasMetered · 30 of 30 runs'),
            h('div', { class: 'eq b8' }, h('b', {}, 'refund ÷ fee ', h('span', { class: 'ok' }, '1.000000')), 'the executor’s net is exactly the tip'))),
        h('ol', { class: 'exec-steps', 'aria-label': 'execute(), line by line' },
          step('metered', 'g0 = gasleft()', 'first statement · the window opens'),
          step('metered', 'guard · load order · NoOrder / IsPaused / NotDue', 'a revert costs nobody who simulates first'),
          step('metered', 'price = min(tx.gasprice, 2 × block.basefee, maxGasPrice)', 'Arc does not burn the base fee — the 2× cap bounds a block producer who also executes'),
          step('metered', 'need = amount + tip + 120,000 × price → Underfunded', 'never a partial payment'),
          step('metered', 'nextDue += interval · deposit −= amount + tip', 'effects before interaction'),
          step('metered', 'payee.call{value: amount, gas: 30,000}', 'a refusal pauses the order · the executor is still repaid'),
          step('metered', 'metered = g0 − gasleft() + OVERHEAD', 'measurement point · nothing variable after it'),
          step('', 'executor.call{value: metered × price + tip} · emit Executed', 'one leg, one Transfer log · OVERHEAD 32,503 is read from the contract in the footer')))),
  );

  // ---------------------------------------------------------------- why only on Arc
  root.append(
    h('section', { class: 'section', 'aria-labelledby': 'arc-h' },
      h('div', { class: 'section-head' }, h('span', { class: 'kicker' }, 'Why this needs Arc'), h('h2', { id: 'arc-h' }, 'The gas and the payment are the same dollar.'), h('p', {}, 'Put the same contract on any other EVM chain and a ', h('em', {}, 'USDC'), ' standing order stops working: the metered gas is in ETH and the deposit is an ERC-20, so repaying the executor needs a price and a second balance. On Arc it is one subtraction.')),
      h('div', { class: 'compare' },
        h('div', { class: 'col other' }, h('h3', {}, 'Any other EVM chain'),
          h('ul', {},
            h('li', {}, 'Gas is ETH; the payment is an ERC-20. Two assets, one of which must be priced in the other.'),
            h('li', {}, 'Repaying the executor needs a ', h('strong', {}, 'price oracle'), ' — what was the gas worth in USDC at that block?'),
            h('li', {}, 'So a ', h('strong', {}, 'keeper network'), ' does it: its own token, an upkeep balance the payer funds separately, operators, ERC-20 approvals.'),
            h('li', {}, 'Or a cron box with a hot key and a second-token gas balance that runs dry while the USDC sits there.'))),
        h('div', { class: 'col arc' }, h('h3', {}, 'On Arc'),
          h('ul', {},
            h('li', {}, 'Gas is USDC; the payment is USDC. One 18-decimal native asset — the deposit, the payment, the refund and the tip.'),
            h('li', {}, h('code', {}, 'metered × tx.gasprice'), ' is already the refund. Arithmetic, no oracle, checked against the receipt on every run.'),
            h('li', {}, 'The contract meters and repays inside the same ', h('code', {}, 'execute()'), ' call, from the order’s own deposit. One contract, one transaction.'),
            h('li', {}, 'Anyone runs it — a bot, the payee collecting their own payment, a reviewer — and nets exactly the tip.'))),
        h('p', { class: 'foot-note' }, h('strong', {}, 'Honest scope: '), 'the arithmetic works for any chain’s ', h('em', {}, 'native'), ' asset; Arc is where the native asset is the stablecoin people actually schedule payments in. Arc’s unburned base fee makes the 2 × basefee cap a necessity, finality at inclusion makes the receipt final on the first poll, and EIP-7708 makes both money legs visible as Transfer logs — legibility and robustness, not the dependency itself.'))),
  );

  // ---------------------------------------------------------------- the receipt is the product (order #5, real)
  const line = (cls: string, label: string, sub: string, val: string, wei: string) =>
    h('li', { class: `line ${cls}` }, h('span', { class: 'what' }, h('strong', {}, label), sub), h('span', { class: 'amt' }, val, h('small', {}, `${wei} wei`)));
  root.append(
    h('section', { class: 'section', 'aria-labelledby': 'receipt-h' },
      h('div', { class: 'section-head' }, h('span', { class: 'kicker' }, 'The product'), h('h2', { id: 'receipt-h' }, 'The receipt is the product.'), h('p', {}, 'The one thing this page does better than the explorer: five numbers on one card. What the payee got, what the executor was refunded, the tip, the ', h('strong', {}, 'real fee from the receipt'), ', and the net — with the drift between the contract’s number and the chain’s printed, not hidden.')),
      h('div', { class: 'receipt-block' },
        h('div', { class: 'receipt-hero', 'aria-label': 'The receipt of order #5' },
          h('div', { class: 'head' }, h('strong', {}, 'Receipt — paid'), h('span', {}, 'order #5 · block 21494016')),
          h('p', { class: 'lede' }, 'Executed by ', chip(HERO_EXECUTOR), ' · ', h('a', { href: explorerTx(HERO_TX), target: '_blank', rel: 'noopener' }, 'transaction 0x2f6a…0c95')),
          h('ul', { class: 'lines' },
            line('', 'payee received', `Transfer ${short(CONTRACT)} → ${short(HERO_PAYEE)} — the EIP-7708 Transfer log Arc's system contract emits for every native USDC move`, '0.001 USDC', '1000000000000000'),
            line('credit', 'executor refunded', 'Executed.refund = 58415 gas metered × 20 Gwei', '+0.0011683 USDC', '1168300000000000'),
            line('credit', 'executor tipped', 'Executed.tip', '+0.001 USDC', '1000000000000000'),
            line('debit', 'real fee paid', 'receipt.gasUsed 58415 × effectiveGasPrice 20 Gwei — from the receipt, not from us', '−0.0011683 USDC', '1168300000000000'),
            line('net positive', 'executor net', 'refund + tip − real fee · drift 0 gas (gasUsed − metered) · refund ÷ fee 1.000000', '+0.001 USDC', '1000000000000000')),
          h('div', { class: 'cta' },
            h('a', { class: 'btn quiet', href: `#/o/5/tx/${HERO_TX}` }, 'Open it from the chain ', h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→')),
            h('span', { class: 'mono' }, `#/o/5/tx/${HERO_TX.slice(0, 10)}…`))),
        h('div', { class: 'receipt-notes' },
          h('div', { class: 'note-card' }, h('b', {}, 'Two numbers from the event, one from the receipt.'), 'The refund and the tip are what the contract said it paid; the real fee is ', h('code', {}, 'gasUsed × effectiveGasPrice'), ' from the transaction receipt, which the contract never sees. They agree to the wei: gasUsed 58,415, gasMetered 58,415, drift 0.'),
          h('div', { class: 'note-card' }, h('b', {}, 'Decoded in your browser, not linked to.'), 'The page parses the receipt and its two EIP-7708 ', h('code', {}, 'Transfer'), ' logs — the payee leg and the executor leg — from ', h('code', {}, 'eth_getTransactionReceipt'), '. Explorer links are a convenience; nothing renders differently if the explorer is down.'),
          h('div', { class: 'note-card' }, h('b', {}, 'The order has since been cancelled. The receipt has not.'), 'Order #5 was created from this form and run from the Execute button, then cancelled by its payer. Its receipt stays on the chain and the page still renders it — at ', h('a', { href: `#/o/5/tx/${HERO_TX}` }, '#/o/5/tx/0x2f6a…'), '.'),
          h('div', { class: 'note-card' }, h('b', {}, 'Full precision, both decimals.'), 'Every native amount shows the 18-decimal wei beside the USDC rendering — never the truncating 6-decimal ERC-20 view; Arc’s docs warn that truncation records less than was transferred.')))),
  );

  // ---------------------------------------------------------------- proof · limits · reviewer path
  const stat = (big: string, what: string) => h('div', { class: 'stat', role: 'listitem' }, h('b', {}, big), h('span', {}, what));
  root.append(
    h('section', { class: 'section', 'aria-labelledby': 'proof-h' },
      h('div', { class: 'section-head' }, h('span', { class: 'kicker' }, 'Measured, not promised'), h('h2', { id: 'proof-h' }, 'Thirty real runs. Drift zero on every one.'), h('p', {}, 'One order, 1-second periods, 30 consecutive executes on Arc mainnet. Five of the thirty rows are the payee collecting its own payment. ', h('code', {}, 'npm run recheck'), ' recomputes all 75 committed execute receipts from raw chain data — six equalities per row; the exit code is the verdict. (107 is every mainnet transaction, deploys, creates and cancels included; 75 of them are executes.)')),
      h('div', { class: 'proof', role: 'list' },
        stat('30 / 30', 'bench runs with drift 0 (gate ≤ 50 gas)'),
        stat('58,415', 'gasUsed p50 = p95 · ≈ 0.00117 USDC at 20 Gwei'),
        stat('1.000000', 'refund ÷ real fee on every row'),
        stat('47', 'Foundry cases · unit, fuzz × 512, invariants × 64 × 32'),
        stat('36', 'vitest cases · 4 properties × 5,000 = 20,000 generated inputs'),
        stat('107', 'mainnet receipts committed · 0.1944 USDC of gas'))),
    h('section', { class: 'section', 'aria-labelledby': 'limits-h' },
      h('div', { class: 'limits-grid' },
        h('div', {},
          h('div', { class: 'section-head' }, h('span', { class: 'kicker' }, 'What we do not claim'), h('h2', { id: 'limits-h' }, 'Honest limits'), h('p', {}, 'The five a reviewer should know before pressing anything; all nine are in the README.')),
          h('div', { class: 'card limits-card' },
            h('ul', {},
              h('li', {}, h('strong', {}, 'Executors are two wallets of ours in practice'), ' — the page button, the bench script, the demo payee. Nobody else has run an order yet.'),
              h('li', {}, h('strong', {}, 'All bench rows sit at Arc’s 20 Gwei base fee'), '; the 2 × basefee cap is exercised by tests and one capped receipt, not by the bench.'),
              h('li', {}, h('strong', {}, 'The drift bound holds for plain-account executors'), ' (≤ 50 gas; measured 0 on paid runs, −6 on the refused-payment branch); a contract executor’s own code runs outside the metered window and pays for itself.'),
              h('li', {}, h('strong', {}, 'Explorer source verification was not attempted'), ' (its API sits behind a challenge page); the on-chain runtime bytecode is checked byte-for-byte against the build instead.'),
              h('li', {}, h('strong', {}, 'The contract’s status / needed / priceCap views read block.basefee'), ', which a bare eth_call sees as 0 on Arc’s RPC; this page computes the same arithmetic from the block’s baseFeePerGas and never uses them.')),
            h('p', { class: 'muted', style: 'margin:14px 0 0;font-size:13.5px' }, 'All nine, with the corrections log: ', h('a', { href: `${REPO}#honest-limits-9`, target: '_blank', rel: 'noopener' }, 'README · Honest limits (9)'), '.'))),
        h('div', {},
          h('div', { class: 'section-head' }, h('span', { class: 'kicker' }, 'For reviewers'), h('h2', {}, 'The 60-second path'), h('p', {}, 'No account, no cookies, no key. A wallet only if you want to press the button.')),
          h('div', { class: 'path' },
            h('a', { class: 'step', href: `#/o/${live}` }, h('span', { class: 'n' }, '1'), h('span', {}, h('b', {}, 'Run the seeded order'), h('span', { class: 'd' }, `#/o/${live} is Due · press Execute — anyone can · read the receipt`)), h('span', { class: 'go', 'aria-hidden': 'true' }, '→')),
            h('a', { class: 'step', href: `#/o/5/tx/${HERO_TX}` }, h('span', { class: 'n' }, '2'), h('span', {}, h('b', {}, 'No wallet? Read the hero receipt'), h('span', { class: 'd' }, 'order #5, decoded from the chain in the browser')), h('span', { class: 'go', 'aria-hidden': 'true' }, '→')),
            h('a', { class: 'step', href: '#/judge' }, h('span', { class: 'n' }, '3'), h('span', {}, h('b', {}, 'The reviewer page'), h('span', { class: 'd' }, 'claim · receipts · reproduce line · limits · links')), h('span', { class: 'go', 'aria-hidden': 'true' }, '→')),
            h('pre', { class: 'mono', tabindex: '0' }, `git clone ${REPO} && cd legwork && git submodule update --init\nforge test && npm install && npm test && npm run recheck`))))),
  );

  // ---------------------------------------------------------------- reads: the latest base fee, then the list
  try { hd = await head(); requote(); } catch { /* quoted at the documented minimum */ }
  await loadList();
  async function loadList() {
  try {
    const { total, rows: orders } = await listOrders();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const tbody = h('tbody');
    for (const { id, order } of orders) {
      const st = orderStatus(order, hd.basefee, now);
      const left = Number(order.nextDue - now);
      const go = () => (window.location.hash = `#/o/${id}`);
      tbody.append(h('tr', { class: 'row-link', tabindex: '0', 'aria-label': `Open order #${id}`, onClick: go, onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } } },
        h('td', {}, `#${id}`),
        h('td', {}, chip(order.payee)),
        h('td', {}, `${usdc18(order.amount)} / ${order.interval}s`),
        h('td', {}, `tip ${usdc18(order.tip)}`),
        h('td', {}, badge(st)),
        h('td', {}, st === 'Paused' ? '—' : countdown(left)),
        h('td', {}, `${runsLeft(order, hd.basefee)} · ${usdc18(order.deposit, 6)} left`),
        h('td', {}, h('span', { class: 'go', 'aria-hidden': 'true' }, '→')),
      ));
    }
    wrap.replaceChildren(
      orders.length === 0 ? h('p', { class: 'muted' }, 'No open orders.') :
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'id'), h('th', {}, 'payee'), h('th', {}, 'amount / interval'), h('th', {}, 'tip'), h('th', {}, 'status'), h('th', {}, 'next run'), h('th', {}, 'runs · deposit'), h('th', {}, h('span', { class: 'sr-only' }, 'open')))), tbody)),
      total > BigInt(LIST_PAGE) ? h('p', { class: 'note muted' }, `Showing the newest ${LIST_PAGE} of ${total} orders; older ones open directly at #/o/<id>.`) : '',
      h('p', { class: 'note muted' }, `Base fee now ${usdc18(hd.basefee * 10n ** 9n)} Gwei · one honest run of a 0.02 / tip 0.01 order needs ${usdc18(neededAt({ amount: parseUsdc('0.02'), tip: parseUsdc('0.01'), maxGasPrice: parseGwei('100') }, hd.basefee))} USDC · ${total} order${total === 1n ? '' : 's'} created on the contract so far.`),
    );
  } catch (e) {
    const again = h('button', { class: 'btn quiet', type: 'button' }, 'Try again');
    again.addEventListener('click', () => { wrap.replaceChildren(skTable(5, 'reading every order on the contract through Multicall3…')); loadList(); });
    wrap.replaceChildren(notice('error', 'Could not read the contract: ', errorText(e)), h('div', { class: 'actions' }, again));
  }
  }
}
