/**
 * Property tests (fast-check) on the two pure functions that must never be wrong: the refund arithmetic the page
 * recomputes from every receipt, and the log reducer that turns raw Executed/Paused logs into the runs table.
 * 4 properties × 5,000 runs = 20,000 generated cases per `npm test`; the counts are what the README states.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { REFUND_CEIL_GAS, foldEvents, neededAt, priceOf, refundOf, type OrderEvent } from '../../src/lib/orders';

const RUNS = 5_000;
/**
 * On chain a log is identified by (transactionHash, logIndex), logIndex is unique within a block, and a transaction sits in
 * exactly one block — the generators must not produce data that violates any of the three.
 */
const distinctLogs = <T extends { transactionHash: string; logIndex: number; blockNumber: bigint }>(xs: T[]): T[] => {
  const seen = new Set<string>();
  const blockOf = new Map<string, bigint>();
  return xs.filter((x) => {
    const b = blockOf.get(x.transactionHash);
    if (b !== undefined && b !== x.blockNumber) return false;
    const k1 = `${x.transactionHash}:${x.logIndex}`, k2 = `${x.blockNumber}:${x.logIndex}`;
    if (seen.has(k1) || seen.has(k2)) return false;
    seen.add(k1); seen.add(k2); blockOf.set(x.transactionHash, x.blockNumber);
    return true;
  });
};
const wei = fc.bigInt({ min: 0n, max: 10n ** 24n });
const gas = fc.bigInt({ min: 0n, max: 10_000_000n });
const gwei = fc.bigInt({ min: 1n, max: 2n ** 48n - 1n }); // maxGasPrice is uint48 in the contract
const hex = (n: number) => fc.array(fc.constantFrom(...'0123456789abcdef'), { minLength: n, maxLength: n }).map((a) => `0x${a.join('')}` as `0x${string}`);
const addr = hex(40);
// a small pool of transaction hashes so that several logs of one order land in one transaction (a batching executor)
const hash = fc.constantFrom(...Array.from({ length: 6 }, (_, i) => `0x${String(i + 1).padStart(64, 'a')}` as `0x${string}`));

describe('refund arithmetic — mirrors Legwork.sol lines 4, 5, 9–10', () => {
  it('the refund never exceeds what is left in the deposit and never exceeds REFUND_CEIL_GAS × price', () => {
    fc.assert(
      fc.property(gas, gwei, wei, (metered, price, left) => {
        const r = refundOf(metered, price, left);
        expect(r <= left).toBe(true);
        expect(r <= REFUND_CEIL_GAS * price).toBe(true);
        // exact whenever neither bound binds — "exact gas" is this branch
        if (metered <= REFUND_CEIL_GAS && metered * price <= left) expect(r).toBe(metered * price);
      }),
      { numRuns: RUNS },
    );
  });
  it('the price the contract uses is the minimum of the three caps, so no executor can be repaid above 2 × basefee or the payer ceiling', () => {
    fc.assert(
      fc.property(gwei, gwei, gwei, (gasPrice, basefee, maxGasPrice) => {
        const p = priceOf(gasPrice, basefee, maxGasPrice);
        expect(p <= gasPrice && p <= 2n * basefee && p <= maxGasPrice).toBe(true);
        expect(p === gasPrice || p === 2n * basefee || p === maxGasPrice).toBe(true);
        // the pre-check reserve at basefee covers the worst honest refund at that basefee
        const need = neededAt({ amount: 0n, tip: 0n, maxGasPrice }, basefee);
        expect(need >= refundOf(REFUND_CEIL_GAS, priceOf(basefee, basefee, maxGasPrice), need)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

const executed = (id: bigint) =>
  fc.record({
    kind: fc.constant('Executed' as const),
    id: fc.constant(id),
    executor: addr,
    gasMetered: gas,
    price: gwei,
    refund: wei,
    tip: wei,
    nextDue: fc.bigInt({ min: 0n, max: 2n ** 48n - 1n }),
    paid: fc.boolean(),
    blockNumber: fc.bigInt({ min: 0n, max: 10n ** 9n }),
    transactionHash: hash,
    logIndex: fc.integer({ min: 1, max: 500 }),
  });
const paused = (id: bigint) =>
  fc.record({
    kind: fc.constant('Paused' as const),
    id: fc.constant(id),
    executor: addr,
    reason: fc.integer({ min: 0, max: 255 }),
    blockNumber: fc.bigInt({ min: 0n, max: 10n ** 9n }),
    transactionHash: hash,
    logIndex: fc.integer({ min: 0, max: 500 }),
  });

describe('log reducer — foldEvents', () => {
  it('is order-independent and idempotent: any permutation, any duplication of the same logs gives the same runs, newest first, one run per Executed log', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(executed(1n), paused(1n)), { maxLength: 40 }).map(distinctLogs), fc.array(fc.nat(), { maxLength: 40 }), (events, dupIdx) => {
        const shuffled = [...events].reverse().sort((a, b) => (a.logIndex % 3) - (b.logIndex % 3));
        const withDups = [...events, ...dupIdx.filter(() => events.length > 0).map((i) => events[i % events.length])];
        const base = foldEvents(events as OrderEvent[]);
        expect(foldEvents(shuffled as OrderEvent[])).toEqual(base);
        expect(foldEvents(withDups as OrderEvent[])).toEqual(base);
        for (let i = 1; i < base.length; i++) {
          const a = base[i - 1], b = base[i];
          expect(a.blockNumber > b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex > b.logIndex)).toBe(true);
        }
        const distinctExecuted = new Set(events.filter((e) => e.kind === 'Executed').map((e) => `${e.transactionHash}:${e.logIndex}`));
        expect(base.length).toBe(distinctExecuted.size); // a batching executor's several runs in one tx all show
      }),
      { numRuns: RUNS },
    );
  });
  it('a Paused log attaches to the next Executed of its own transaction and never creates a run by itself', () => {
    fc.assert(
      fc.property(fc.array(executed(1n), { maxLength: 20 }).map(distinctLogs), fc.array(paused(1n), { maxLength: 20 }), (ex, pa0) => {
        // half of the Paused logs are placed just before an Executed log of the same transaction and block
        const all = distinctLogs([...ex, ...pa0.map((p, i) => (i % 2 === 0 && ex.length ? { ...p, transactionHash: ex[i % ex.length].transactionHash, blockNumber: ex[i % ex.length].blockNumber, logIndex: ex[i % ex.length].logIndex - 1 } : p))]);
        const shared = all.filter((e) => e.kind === 'Paused');
        const runs = foldEvents(all as OrderEvent[]);
        expect(runs.length).toBe(new Set(ex.map((e) => `${e.transactionHash}:${e.logIndex}`)).size);
        for (const p of shared) {
          const next = ex.filter((e) => e.transactionHash === p.transactionHash && e.blockNumber === p.blockNumber && e.logIndex > p.logIndex).sort((a, b) => a.logIndex - b.logIndex)[0];
          if (!next) continue;
          const r = runs.find((x) => x.transactionHash === next.transactionHash && x.logIndex === next.logIndex)!;
          expect(r.pausedReason).toBeDefined();
        }
        // a Paused with no Executed after it in its transaction attaches to nothing
        for (const r of runs) if (r.pausedReason !== undefined) expect(shared.some((p) => p.transactionHash === r.transactionHash)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});
