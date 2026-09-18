/**
 * Seed the demo orders on the production contract (idempotent: an order whose key already has an id in
 * deploy/arc-mainnet.json is skipped) and run each once. Prints the Markdown rows DEMO.md uses.
 *
 *   npm run orders               # create live / rejecting / capped if missing, execute each once
 *   npm run orders -- --dry      # print what would be sent
 *   npm run orders -- --not-due  # a 1-hour order: run it once, then send a second execute with a fixed gas limit so the
 *                                # NotDue revert lands as a real status-0 receipt; cancel; record under orders.notDue
 */
import { decodeEventLog, parseGwei } from 'viem';
import { legworkAbi } from '../src/lib/abi';
import { decodeReceipt } from '../src/lib/receipt';
import { usdc18 } from '../src/lib/orders';
import { assertArc, balanceGuard, fees, loadDeploy, publicClient, saveDeploy, saveReceipt, signer } from './lib/env';
import { explorerTx } from '../src/lib/chain';

const dry = process.argv.includes('--dry');
const notDueOnly = process.argv.includes('--not-due');

type Seed = {
  key: string;
  payee: `0x${string}`;
  amount: bigint;
  interval: number;
  tip: bigint;
  maxGasPrice: bigint;
  deposit: bigint;
  /** fee override for the execute (the `capped` row runs at 30 Gwei against a 20 Gwei cap) */
  execFees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  proves: string;
};

async function notDue() {
  const d = loadDeploy();
  const contract = d.contract.address as `0x${string}`;
  const { account, wallet } = signer();
  await balanceGuard(account.address);
  const amount = 1_000_000_000_000_000n, tip = 100_000_000_000_000n, maxGasPrice = parseGwei('100');
  const deposit = 2n * (amount + tip + 120_000n * 20_000_000_000n); // two honest runs' worth
  const createHash = await wallet.writeContract({ address: contract, abi: legworkAbi, functionName: 'create', args: [d.payeeDemo, amount, 3600, tip, Number(maxGasPrice)], value: deposit, ...(await fees()) });
  const cr = await publicClient.waitForTransactionReceipt({ hash: createHash });
  saveReceipt(cr);
  const created = cr.logs.map((l) => { try { return decodeEventLog({ abi: legworkAbi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === 'Created') as any;
  const id = created.args.id as bigint;
  console.log(`order #${id} (1 h interval) created ${createHash}`);
  const runHash = await wallet.writeContract({ address: contract, abi: legworkAbi, functionName: 'execute', args: [BigInt(id)], ...(await fees()) });
  const rr = await publicClient.waitForTransactionReceipt({ hash: runHash });
  saveReceipt(rr);
  const x = decodeReceipt(rr, contract, d.payeeDemo);
  console.log(`run 1: ${runHash} gasUsed ${x.gasUsed} metered ${x.executed?.gasMetered} drift ${x.drift}`);
  // eth_call first: the revert reason a simulating executor sees
  let reason = '';
  try {
    await publicClient.simulateContract({ address: contract, abi: legworkAbi, functionName: 'execute', args: [BigInt(id)], account: account.address });
  } catch (e: any) {
    const rev = e?.cause?.data ?? e?.data;
    reason = rev?.errorName ? `${rev.errorName}(${(rev.args ?? []).join(', ')})` : (e?.shortMessage ?? e?.message ?? String(e));
  }
  console.log(`eth_call now: ${reason}`);
  // then the forced transaction: fixed gas limit, no estimation, lands as status 0
  const failHash = await wallet.writeContract({ address: contract, abi: legworkAbi, functionName: 'execute', args: [BigInt(id)], gas: 80_000n, ...(await fees()) });
  const fr = await publicClient.waitForTransactionReceipt({ hash: failHash });
  saveReceipt(fr);
  console.log(`forced execute: ${failHash} status ${fr.status} gasUsed ${fr.gasUsed} fee ${usdc18(fr.gasUsed * fr.effectiveGasPrice)} USDC`);
  const cancelHash = await wallet.writeContract({ address: contract, abi: legworkAbi, functionName: 'cancel', args: [BigInt(id)], ...(await fees()) });
  const cxr = await publicClient.waitForTransactionReceipt({ hash: cancelHash });
  saveReceipt(cxr);
  console.log(`cancelled ${cancelHash}`);
  d.orders ??= {};
  d.orders.notDue = { id: Number(id), create: createHash, createBlock: Number(cr.blockNumber), firstRun: runHash, firstRunBlock: Number(rr.blockNumber), revert: failHash, revertBlock: Number(fr.blockNumber), revertStatus: fr.status, revertGasUsed: Number(fr.gasUsed), ethCallReason: reason, cancel: cancelHash, cancelBlock: Number(cxr.blockNumber), params: { payee: d.payeeDemo, amount: amount.toString(), interval: 3600, tip: tip.toString(), maxGasPrice: maxGasPrice.toString(), deposit: deposit.toString() } };
  saveDeploy(d);
}

async function main() {
  await assertArc();
  if (notDueOnly) return notDue();
  const d = loadDeploy();
  const contract = d.contract.address as `0x${string}`;
  const seeds: Seed[] = [
    { key: 'live', payee: d.payeeDemo, amount: 20_000_000_000_000_000n, interval: 60, tip: 10_000_000_000_000_000n, maxGasPrice: parseGwei('100'), deposit: 100_000_000_000_000_000n, proves: 'the hero flow; a reviewer earns the tip' },
    { key: 'rejecting', payee: d.rejector.address, amount: 10_000_000_000_000_000n, interval: 60, tip: 10_000_000_000_000_000n, maxGasPrice: parseGwei('100'), deposit: 50_000_000_000_000_000n, proves: 'payee reverts -> Paused + Executed(paid=false); executor still repaid' },
    { key: 'capped', payee: d.payeeDemo, amount: 10_000_000_000_000_000n, interval: 60, tip: 10_000_000_000_000_000n, maxGasPrice: parseGwei('20'), deposit: 50_000_000_000_000_000n, execFees: { maxFeePerGas: parseGwei('30'), maxPriorityFeePerGas: parseGwei('10') }, proves: 'executor at 30 Gwei, refund priced at the 20 Gwei cap' },
  ];
  const { account, wallet } = dry ? ({} as any) : signer();
  if (!dry) await balanceGuard(account.address);
  d.orders ??= {};
  const rows: string[] = [];

  for (const s of seeds) {
    const rec = (d.orders[s.key] ??= {});
    if (rec.id === undefined) {
      console.log(`create ${s.key}: payee ${s.payee} amount ${usdc18(s.amount)} interval ${s.interval}s tip ${usdc18(s.tip)} maxGasPrice ${s.maxGasPrice} deposit ${usdc18(s.deposit)}`);
      if (dry) continue;
      const hash = await wallet.writeContract({
        address: contract, abi: legworkAbi, functionName: 'create',
        args: [s.payee, s.amount, s.interval, s.tip, s.maxGasPrice], value: s.deposit, ...(await fees()),
      });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      saveReceipt(r);
      const created = r.logs.map((l) => { try { return decodeEventLog({ abi: legworkAbi, data: l.data, topics: l.topics }); } catch { return null; } })
        .find((e) => e?.eventName === 'Created') as any;
      rec.id = Number(created.args.id);
      rec.create = hash;
      rec.createBlock = Number(r.blockNumber);
      rec.params = { payee: s.payee, amount: s.amount.toString(), interval: s.interval, tip: s.tip.toString(), maxGasPrice: s.maxGasPrice.toString(), deposit: s.deposit.toString() };
      saveDeploy(d);
      console.log(`  id ${rec.id} tx ${hash} gasUsed ${r.gasUsed}`);
    } else {
      console.log(`${s.key}: id ${rec.id} already created (${rec.create})`);
    }
    if (rec.firstRun) {
      console.log(`  first run already recorded: ${rec.firstRun}`);
      continue;
    }
    if (dry) continue;
    const status = await publicClient.readContract({ address: contract, abi: legworkAbi, functionName: 'status', args: [BigInt(rec.id)] });
    if (status !== 1) { console.log(`  status ${status} (not Due) — skipping the first run`); continue; }
    const hash = await wallet.writeContract({
      address: contract, abi: legworkAbi, functionName: 'execute', args: [BigInt(rec.id)], ...(await fees(s.execFees)),
    });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    saveReceipt(r);
    const x = decodeReceipt(r, contract, s.payee);
    rec.firstRun = hash;
    rec.firstRunBlock = Number(r.blockNumber);
    saveDeploy(d);
    const e = x.executed!;
    console.log(`  execute id ${rec.id} tx ${hash} gasUsed ${x.gasUsed} metered ${e.gasMetered} drift ${x.drift} price ${e.price} egp ${x.effectiveGasPrice} refund ${e.refund} tip ${e.tip} realFee ${x.realFee} ratio ${x.ratio} paid ${e.paid} paused ${x.paused ? 'yes' : 'no'}`);
    rows.push(`| \`${s.key}\` | ${rec.id} | ${usdc18(s.amount)} / ${s.interval} s / tip ${usdc18(s.tip)} / ${Number(s.maxGasPrice) / 1e9} Gwei | ${x.gasUsed} | ${e.gasMetered} | ${x.drift} | ${Number(e.price) / 1e9} | ${Number(x.effectiveGasPrice) / 1e9} | ${usdc18(e.refund)} | ${usdc18(x.realFee)} | ${x.ratio} | ${e.paid ? 'yes' : 'no (Paused)'} | [${hash.slice(0, 10)}…](${explorerTx(hash)}) |`);
  }
  if (rows.length) {
    console.log('\n| key | id | order | gasUsed | metered | drift | price Gwei | effectiveGasPrice Gwei | refund USDC | real fee USDC | ratio | paid | tx |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) console.log(r);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
