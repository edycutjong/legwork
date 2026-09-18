/**
 * Metering bench — N real executes on Arc mainnet, one order, consecutive 1-second periods.
 *
 *   npm run bench                 # 25 runs by the deployer wallet + 5 by the payee wallet (the payee collecting its own payment)
 *   npm run bench -- --n 5        # a small reproduce run (creates, runs and cancels its own order; ≈ a cent of gas)
 *   npm run bench -- --n 5 --no-payee-runs
 *
 * What it does, in order: refuse unless chain id 5042 → create the `bench` order (payee = the demo payee, amount 0.001,
 * interval 1 s, tip 0.0001, maxGasPrice 100 Gwei, deposit sized for N + 1 honest runs) → for i in 1..N: wait until
 * `status(id) == Due`, send `execute(id)` with priority 0 and maxFee = max(eth_gasPrice, 20 Gwei), wait for the receipt
 * (finality is at inclusion), record the row → cancel the order (the unspent deposit returns to the payer).
 * (The `NotDue` revert receipt is produced by `npm run orders -- --not-due` on a 1-hour order, where the race cannot happen.)
 *
 * Rows: proof/rows.csv · summary: proof/results.json · every receipt: proof/receipts/<hash>.json.
 * The pre-stated invariants: |gasUsed − gasMetered| ≤ 50 on every EOA row; refund ÷ realFee = 1.00 ± 0.02 on every row.
 * Exit code 1 if either fails. There is no randomness to seed: the order parameters are the fixed inputs.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeEventLog, parseGwei } from 'viem';
import { legworkAbi } from '../src/lib/abi';
import { decodeReceipt } from '../src/lib/receipt';
import { neededAt, usdc18 } from '../src/lib/orders';
import { ROOT, assertArc, balanceGuard, fees, loadDeploy, publicClient, saveDeploy, saveReceipt, signer } from './lib/env';

const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const N = parseInt(flag('--n') ?? '25', 10);
const PAYEE_RUNS = argv.includes('--no-payee-runs') ? 0 : parseInt(flag('--payee-runs') ?? (flag('--n') ? '0' : '5'), 10);
const DRIFT_GATE = 50n;

type Row = {
  i: number; executor: string; block: bigint; hash: string; gasUsed: bigint; effectiveGasPrice: bigint; gasMetered: bigint; price: bigint;
  refund: bigint; tip: bigint; realFee: bigint; ratio: number; drift: bigint; executorNet: bigint; paid: boolean;
};

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

async function waitDue(contract: `0x${string}`, id: bigint) {
  for (let k = 0; k < 120; k++) {
    const st = await publicClient.readContract({ address: contract, abi: legworkAbi, functionName: 'status', args: [id] });
    if (st === 1) return;
    if (st === 3) throw new Error('bench order Underfunded — deposit sizing was wrong');
    if (st === 4) throw new Error('bench order paused — the demo payee refused?');
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('order never became Due');
}

async function main() {
  await assertArc();
  const d = loadDeploy();
  const contract = d.contract.address as `0x${string}`;
  const payee = d.payeeDemo as `0x${string}`;
  const deployer = signer('deployer');
  const payeeSigner = PAYEE_RUNS > 0 ? signer('payee') : undefined;
  await balanceGuard(deployer.account.address);
  const startBalance = await publicClient.getBalance({ address: deployer.account.address });
  const startedAt = new Date().toISOString();

  const total = N + PAYEE_RUNS;
  const amount = 1_000_000_000_000_000n, tip = 100_000_000_000_000n, maxGasPrice = parseGwei('100');
  const basefee = (await publicClient.getBlock({ blockTag: 'latest' })).baseFeePerGas ?? 20_000_000_000n;
  const needed = neededAt({ amount, tip, maxGasPrice }, basefee);
  const deposit = needed * BigInt(total + 1);
  console.log(`bench: ${N} runs by ${deployer.account.address}${PAYEE_RUNS ? ` + ${PAYEE_RUNS} by the payee ${payee}` : ''}; deposit ${usdc18(deposit)} USDC (${total + 1} × needed ${usdc18(needed)} at base fee ${Number(basefee) / 1e9} Gwei)`);

  // create
  const createHash = await deployer.wallet.writeContract({
    address: contract, abi: legworkAbi, functionName: 'create', args: [payee, amount, 1, tip, Number(maxGasPrice)], value: deposit, ...(await fees()),
  });
  const cr = await publicClient.waitForTransactionReceipt({ hash: createHash });
  saveReceipt(cr);
  const created = cr.logs.map((l) => { try { return decodeEventLog({ abi: legworkAbi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === 'Created') as any;
  const id = created.args.id as bigint;
  console.log(`order #${id} created: ${createHash} (gasUsed ${cr.gasUsed})`);

  const rows: Row[] = [];
  const plan: { who: 'deployer' | 'payee'; s: typeof deployer }[] = [
    ...Array.from({ length: N }, () => ({ who: 'deployer' as const, s: deployer })),
    ...Array.from({ length: PAYEE_RUNS }, () => ({ who: 'payee' as const, s: payeeSigner! })),
  ];
  for (let i = 1; i <= plan.length; i++) {
    const { s } = plan[i - 1];
    await waitDue(contract, id);
    const hash = await s.wallet.writeContract({ address: contract, abi: legworkAbi, functionName: 'execute', args: [id], ...(await fees()) });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    saveReceipt(r);
    const x = decodeReceipt(r, contract, payee);
    const e = x.executed!;
    const row: Row = {
      i, executor: x.executor, block: x.blockNumber, hash, gasUsed: x.gasUsed, effectiveGasPrice: x.effectiveGasPrice, gasMetered: e.gasMetered, price: e.price,
      refund: e.refund, tip: e.tip, realFee: x.realFee, ratio: x.ratio!, drift: x.drift!, executorNet: x.executorNet!, paid: e.paid,
    };
    rows.push(row);
    console.log(`${String(i).padStart(3)} ${row.executor.slice(0, 8)} block ${row.block} gasUsed ${row.gasUsed} metered ${row.gasMetered} drift ${row.drift} price ${Number(row.price) / 1e9} egp ${Number(row.effectiveGasPrice) / 1e9} ratio ${row.ratio.toFixed(6)} net ${usdc18(row.executorNet)} ${row.hash.slice(0, 12)}`);
  }

  // cancel: the unspent deposit returns to the payer
  const cancelHash = await deployer.wallet.writeContract({ address: contract, abi: legworkAbi, functionName: 'cancel', args: [id], ...(await fees()) });
  const cxr = await publicClient.waitForTransactionReceipt({ hash: cancelHash });
  saveReceipt(cxr);
  const cancelled = cxr.logs.map((l) => { try { return decodeEventLog({ abi: legworkAbi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === 'Cancelled') as any;
  console.log(`cancelled: ${cancelHash} returned ${usdc18(cancelled.args.returned)} USDC`);
  const endBalance = await publicClient.getBalance({ address: deployer.account.address });

  // summary
  const eoa = rows; // both executors are EOAs
  const gas = eoa.map((r) => Number(r.gasUsed));
  const drift = eoa.map((r) => Number(r.drift));
  const ratio = eoa.map((r) => r.ratio);
  const net = eoa.map((r) => Number(r.executorNet) / 1e18);
  const absDriftMax = Math.max(...drift.map(Math.abs));
  const ratioOk = ratio.every((x) => Math.abs(x - 1) <= 0.02);
  const driftOk = BigInt(absDriftMax) <= DRIFT_GATE;
  const priceOk = rows.every((r) => r.price === (r.effectiveGasPrice < 2n * basefee ? r.effectiveGasPrice : 2n * basefee) || r.price === maxGasPrice);
  const byExecutor: Record<string, { n: number; gasUsedP50: number; driftMax: number }> = {};
  for (const ex of new Set(rows.map((r) => r.executor))) {
    const rs = rows.filter((r) => r.executor === ex);
    byExecutor[ex] = { n: rs.length, gasUsedP50: pct(rs.map((r) => Number(r.gasUsed)), 50), driftMax: Math.max(...rs.map((r) => Math.abs(Number(r.drift)))) };
  }
  const results = {
    startedAt, finishedAt: new Date().toISOString(), chainId: 5042, contract, overhead: d.contract.overhead, orderId: Number(id),
    order: { payee, amount: amount.toString(), interval: 1, tip: tip.toString(), maxGasPrice: maxGasPrice.toString(), deposit: deposit.toString() },
    n: rows.length, runsByDeployer: N, runsByPayee: PAYEE_RUNS,
    blocks: { first: Number(rows[0].block), last: Number(rows[rows.length - 1].block) },
    basefeeAtCreate: basefee.toString(),
    gasUsed: { p50: pct(gas, 50), p95: pct(gas, 95), min: Math.min(...gas), max: Math.max(...gas) },
    gasMetered: { p50: pct(rows.map((r) => Number(r.gasMetered)), 50), p95: pct(rows.map((r) => Number(r.gasMetered)), 95) },
    drift: { p50: pct(drift, 50), p95: pct(drift, 95), min: Math.min(...drift), max: Math.max(...drift), absMax: absDriftMax, gate: Number(DRIFT_GATE), pass: driftOk },
    ratio: { p50: pct(ratio, 50), p95: pct(ratio, 95), min: Math.min(...ratio), max: Math.max(...ratio), tolerance: 0.02, pass: ratioOk },
    executorNetUsdc: { p50: pct(net, 50), p95: pct(net, 95), min: Math.min(...net), max: Math.max(...net), tipUsdc: Number(tip) / 1e18 },
    realFeeUsdc: { p50: pct(rows.map((r) => Number(r.realFee) / 1e18), 50), p95: pct(rows.map((r) => Number(r.realFee) / 1e18), 95) },
    priceEqualsEffectiveGasPriceOnEveryRow: rows.every((r) => r.price === r.effectiveGasPrice),
    priceCapHeld: priceOk,
    allPaid: rows.every((r) => r.paid),
    byExecutor,
    create: { hash: createHash, gasUsed: Number(cr.gasUsed) },
    cancel: { hash: cancelHash, gasUsed: Number(cxr.gasUsed), returned: cancelled.args.returned.toString() },
    deployerBalance: { before: startBalance.toString(), after: endBalance.toString(), deltaUsdc: Number(endBalance - startBalance) / 1e18 },
  };
  const csv = ['i,executor,block,hash,gasUsed,effectiveGasPrice,gasMetered,price,refund,tip,realFee,ratio,drift,executorNet,paid',
    ...rows.map((r) => [r.i, r.executor, r.block, r.hash, r.gasUsed, r.effectiveGasPrice, r.gasMetered, r.price, r.refund, r.tip, r.realFee, r.ratio.toFixed(6), r.drift, r.executorNet, r.paid].join(','))].join('\n') + '\n';
  const suffix = flag('--n') ? `-n${N}` : '';
  writeFileSync(resolve(ROOT, 'proof', `rows${suffix}.csv`), csv);
  writeFileSync(resolve(ROOT, 'proof', `results${suffix}.json`), JSON.stringify(results, null, 2) + '\n');
  d.orders ??= {};
  d.orders[flag('--n') ? `bench-n${N}` : 'bench'] = { id: Number(id), create: createHash, createBlock: Number(cr.blockNumber), runs: rows.length, firstRun: rows[0].hash, lastRun: rows[rows.length - 1].hash, cancel: cancelHash, cancelBlock: Number(cxr.blockNumber), params: { payee, amount: amount.toString(), interval: 1, tip: tip.toString(), maxGasPrice: maxGasPrice.toString(), deposit: deposit.toString() } };
  saveDeploy(d);

  console.log(`\nn ${rows.length} · gasUsed p50 ${results.gasUsed.p50} p95 ${results.gasUsed.p95} · drift p50 ${results.drift.p50} p95 ${results.drift.p95} (|max| ${absDriftMax}) · ratio p50 ${results.ratio.p50.toFixed(6)} p95 ${results.ratio.p95.toFixed(6)} · executor net p50 ${results.executorNetUsdc.p50} USDC (tip ${results.executorNetUsdc.tipUsdc})`);
  console.log(`price == effectiveGasPrice on every row: ${results.priceEqualsEffectiveGasPriceOnEveryRow} · deployer balance delta ${results.deployerBalance.deltaUsdc.toFixed(6)} USDC`);
  if (!driftOk || !ratioOk) { console.log(`\nINVARIANT FAILED: drift ${driftOk ? 'ok' : 'exceeded ' + DRIFT_GATE}, ratio ${ratioOk ? 'ok' : 'outside ±0.02'}`); process.exit(1); }
  console.log('\ninvariants held on every row');
}

main().catch((e) => { console.error(e); process.exit(1); });
