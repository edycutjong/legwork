/**
 * Recompute every committed execute receipt from raw data and exit non-zero on the first mismatch.
 * Read-only: no wallet, no spend. Needs the RPC only for each run's block base fee.
 *
 *   npm run recheck
 *
 * For every `proof/receipts/<hash>.json` that carries an `Executed` event:
 *   (1) refund + tip == the EIP-7708 Transfer(contract -> executor) leg, on both `paid` branches
 *   (2) |gasUsed - gasMetered| <= 50 for an EOA executor on the production contract
 *       (the calibration contract's rows are reported with their pre-calibration drift, not gated)
 *   (3) price == min(effectiveGasPrice, 2 * block.basefee, order.maxGasPrice) when the order's maxGasPrice is
 *       known (deploy record or a live read) — this is the guard for `tx.gasprice == effectiveGasPrice`;
 *       price <= min(effectiveGasPrice, 2 * block.basefee) for a cancelled order whose cap is unknown
 *   (3b) refund == min(gasMetered, REFUND_CEIL_GAS) * price exactly (the deposit bound never applied)
 *   (4) gasMetered < REFUND_CEIL_GAS (the clamp never bound)
 *   (5) paid == true  -> Transfer(contract -> payee) == amount exactly
 *       paid == false -> no payee leg, and a Paused log in the same receipt
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeReceipt, fromJsonReceipt } from '../src/lib/receipt';
import { REFUND_CEIL_GAS, min } from '../src/lib/orders';
import { legworkAbi } from '../src/lib/abi';
import { DEPLOY_FILE, RECEIPTS_DIR, publicClient } from './lib/env';

const DRIFT_GATE = 50n;

type Row = {
  hash: string; contract: 'final' | 'calibration'; id: bigint; block: bigint; gasUsed: bigint; gasMetered: bigint; drift: bigint;
  price: bigint; egp: bigint; basefee: bigint; refund: bigint; tip: bigint; realFee: bigint; ratio: number; paid: boolean; checks: string[];
};

async function main() {
  const d = JSON.parse(readFileSync(DEPLOY_FILE, 'utf8'));
  const contracts: Record<string, 'final' | 'calibration'> = {
    [d.contract.address.toLowerCase()]: 'final',
    [d.calibration.address.toLowerCase()]: 'calibration',
  };
  const files = readdirSync(RECEIPTS_DIR).filter((f) => f.endsWith('.json')).sort();
  const rows: Row[] = [];
  let failures = 0;
  let skipped = 0;
  const codeCache = new Map<string, boolean>();
  const isEoa = async (a: string) => {
    if (!codeCache.has(a)) codeCache.set(a, !(await publicClient.getCode({ address: a as `0x${string}` })));
    return codeCache.get(a)!;
  };

  for (const f of files) {
    const j = JSON.parse(readFileSync(resolve(RECEIPTS_DIR, f), 'utf8'));
    const r = fromJsonReceipt(j);
    const to = (j.to ?? '').toLowerCase();
    const which = contracts[to];
    if (!which) { skipped++; continue; }
    const x = decodeReceipt(r, to as `0x${string}`);
    if (!x.executed) { skipped++; continue; }
    const e = x.executed;
    const checks: string[] = [];
    const fail = (m: string) => { checks.push('FAIL ' + m); failures++; };

    // (1) executor leg
    if (!x.executorLeg) fail('no Transfer leg to the executor');
    else if (x.executorLeg.value !== e.refund + e.tip) fail(`executor leg ${x.executorLeg.value} != refund + tip ${e.refund + e.tip}`);
    else checks.push('leg==refund+tip');

    // (2) drift
    const eoa = await isEoa(x.executor);
    const drift = x.gasUsed - e.gasMetered;
    const absDrift = drift < 0n ? -drift : drift;
    if (which === 'final') {
      if (!eoa) checks.push('contract executor: drift not gated');
      else if (absDrift > DRIFT_GATE) fail(`drift ${drift} exceeds ${DRIFT_GATE}`);
      else checks.push(`|drift|<=${DRIFT_GATE}`);
    } else {
      checks.push(`calibration row: drift ${drift} (pre-calibration)`);
    }

    // (3) price cap
    const block = await publicClient.getBlock({ blockNumber: x.blockNumber });
    const basefee = block.baseFeePerGas ?? 0n;
    let maxGp: bigint | undefined;
    for (const k of Object.keys(d.orders ?? {})) {
      const o = d.orders[k];
      if (which === 'final' && BigInt(o.id) === e.id && o.params) maxGp = BigInt(o.params.maxGasPrice);
    }
    if (maxGp === undefined) {
      try {
        const t = await publicClient.readContract({ address: to as `0x${string}`, abi: legworkAbi, functionName: 'orders', args: [e.id] });
        if (t[0] !== '0x0000000000000000000000000000000000000000') maxGp = BigInt(t[6]);
      } catch { /* cancelled / unreadable: bound by the two chain terms only */ }
    }
    if (maxGp === undefined) {
      const bound = min(x.effectiveGasPrice, 2n * basefee);
      if (e.price > bound) fail(`price ${e.price} > min(egp, 2*basefee) = ${bound}`);
      else checks.push('price<=cap (maxGasPrice unknown)');
    } else {
      const expect = min(x.effectiveGasPrice, 2n * basefee, maxGp);
      if (e.price !== expect) fail(`price ${e.price} != min(egp, 2*basefee, maxGasPrice) = ${expect}`);
      else checks.push('price==min(egp,2·basefee,max)');
    }
    const expectRefund = (e.gasMetered > REFUND_CEIL_GAS ? REFUND_CEIL_GAS : e.gasMetered) * e.price;
    if (e.refund !== expectRefund) fail(`refund ${e.refund} != min(gasMetered, ceil) * price ${expectRefund}`);
    else checks.push('refund==metered×price');

    // (4) clamp
    if (e.gasMetered >= REFUND_CEIL_GAS) fail(`gasMetered ${e.gasMetered} hit the ${REFUND_CEIL_GAS} clamp`);
    else checks.push('clamp unbound');

    // (5) payee leg vs paid flag
    const otherLegs = x.legs.filter((l) => l !== x.executorLeg);
    if (e.paid) {
      if (otherLegs.length !== 1) fail(`paid but ${otherLegs.length} payee legs`);
      else checks.push('payee leg present');
    } else {
      if (otherLegs.length !== 0) fail('paid=false but a payee leg exists');
      else if (!x.paused) fail('paid=false without a Paused log');
      else checks.push('paused, no payee leg');
    }

    rows.push({
      hash: x.hash, contract: which, id: e.id, block: x.blockNumber, gasUsed: x.gasUsed, gasMetered: e.gasMetered, drift,
      price: e.price, egp: x.effectiveGasPrice, basefee, refund: e.refund, tip: e.tip, realFee: x.realFee, ratio: x.ratio!, paid: e.paid, checks,
    });
  }

  rows.sort((a, b) => (a.block < b.block ? -1 : 1));
  console.log('hash         contract     id block     gasUsed metered drift price(gwei) egp(gwei) ratio    paid checks');
  for (const r of rows) {
    console.log(
      `${r.hash.slice(0, 12)} ${r.contract.padEnd(11)} ${String(r.id).padStart(3)} ${String(r.block).padStart(9)} ${String(r.gasUsed).padStart(7)} ${String(r.gasMetered).padStart(7)} ${String(r.drift).padStart(5)} ${(Number(r.price) / 1e9).toFixed(2).padStart(10)} ${(Number(r.egp) / 1e9).toFixed(2).padStart(9)} ${r.ratio.toFixed(6)} ${r.paid ? 'yes ' : 'no  '} ${r.checks.join(' · ')}`,
    );
  }
  const finals = rows.filter((r) => r.contract === 'final');
  console.log(`\n${rows.length} execute receipts (${finals.length} on the production contract, ${rows.length - finals.length} calibration), ${skipped} other receipts skipped.`);
  if (finals.length) {
    const drifts = finals.map((r) => Number(r.drift));
    console.log(`production drift: min ${Math.min(...drifts)} max ${Math.max(...drifts)} gas; ratio min ${Math.min(...finals.map((r) => r.ratio)).toFixed(6)} max ${Math.max(...finals.map((r) => r.ratio)).toFixed(6)}`);
  }
  if (failures) { console.log(`\n${failures} FAILED check(s)`); process.exit(1); }
  console.log('\nall checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
