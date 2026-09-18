/**
 * Pure order arithmetic — the same formulas the contract uses, so the page (and the recheck script) can
 * recompute every number from raw chain data. Amounts are native wei (18 decimals); prices are wei per gas.
 */

export const REFUND_CEIL_GAS = 120_000n;
export const PAYEE_GAS = 30_000n;

export type Order = {
  payer: `0x${string}`;
  nextDue: bigint;
  interval: bigint;
  paused: boolean;
  payee: `0x${string}`;
  createdBlock: bigint;
  maxGasPrice: bigint;
  amount: bigint;
  tip: bigint;
  deposit: bigint;
};

export type OrderStatus = 'None' | 'Due' | 'Waiting' | 'Underfunded' | 'Paused';

const ZERO = '0x0000000000000000000000000000000000000000';

/** Decode the tuple the public `orders(id)` getter returns. */
export function decodeOrder(t: readonly [string, number | bigint, number | bigint, boolean, string, number | bigint, number | bigint, bigint, bigint, bigint]): Order {
  return {
    payer: t[0] as `0x${string}`,
    nextDue: BigInt(t[1]),
    interval: BigInt(t[2]),
    paused: t[3],
    payee: t[4] as `0x${string}`,
    createdBlock: BigInt(t[5]),
    maxGasPrice: BigInt(t[6]),
    amount: t[7],
    tip: t[8],
    deposit: t[9],
  };
}

export const isOpen = (o: Order) => o.payer.toLowerCase() !== ZERO;

export const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));

/** Per-run reserve at a given base fee: `REFUND_CEIL_GAS × min(basefee, maxGasPrice)`. */
export const reserveAt = (basefee: bigint, maxGasPrice: bigint) => REFUND_CEIL_GAS * min(basefee, maxGasPrice);

/** What one honest run needs in the deposit: `amount + tip + reserve`. Mirrors `needed(id)`. */
export const neededAt = (o: Pick<Order, 'amount' | 'tip' | 'maxGasPrice'>, basefee: bigint) =>
  o.amount + o.tip + reserveAt(basefee, o.maxGasPrice);

/** Ceiling on the refund price right now: `min(2 × basefee, maxGasPrice)`. Mirrors `priceCap(id)`. */
export const priceCapAt = (maxGasPrice: bigint, basefee: bigint) => min(2n * basefee, maxGasPrice);

/** The price `execute` actually uses: `min(tx.gasprice, 2 × basefee, maxGasPrice)`. */
export const priceOf = (gasPrice: bigint, basefee: bigint, maxGasPrice: bigint) => min(gasPrice, 2n * basefee, maxGasPrice);

/**
 * The refund the contract pays for a metered figure: clamp at `REFUND_CEIL_GAS`, multiply by the price,
 * bound by what is left in the deposit after `amount + tip` (plus `amount` back if the payee refused).
 */
export function refundOf(gasMetered: bigint, price: bigint, depositAfterDebit: bigint): bigint {
  const metered = gasMetered > REFUND_CEIL_GAS ? REFUND_CEIL_GAS : gasMetered;
  const refund = metered * price;
  return refund > depositAfterDebit ? depositAfterDebit : refund;
}

/** Mirrors `status(id)` given the current base fee and timestamp. */
export function orderStatus(o: Order, basefee: bigint, now: bigint): OrderStatus {
  if (!isOpen(o)) return 'None';
  if (o.paused) return 'Paused';
  if (o.deposit < neededAt(o, basefee)) return 'Underfunded';
  if (now >= o.nextDue) return 'Due';
  return 'Waiting';
}

/** Whole honest runs the deposit still covers. */
export const runsLeft = (o: Order, basefee: bigint) => {
  const n = neededAt(o, basefee);
  return n === 0n ? 0n : o.deposit / n;
};

/** Native 18-decimal wei → USDC string (÷ 10¹²; never the truncating 6-decimal ERC-20 view). */
export function usdc18(wei: bigint, maxFrac = 18): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  let frac = (v % 10n ** 18n).toString().padStart(18, '0').slice(0, maxFrac).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Wei per gas → Gwei string. */
export const gwei = (wei: bigint) => usdc18(wei * 10n ** 9n);

/** Parse a USDC decimal string ("0.02") into native wei (18 decimals). */
export function parseUsdc(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,18}))?$/.exec(s.trim());
  if (!m) throw new Error(`not a USDC amount: ${s}`);
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? '').padEnd(18, '0'));
}

// ---------------------------------------------------------------- events → history

export type ExecutedLog = {
  kind: 'Executed';
  id: bigint;
  executor: `0x${string}`;
  gasMetered: bigint;
  price: bigint;
  refund: bigint;
  tip: bigint;
  nextDue: bigint;
  paid: boolean;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
};
export type PausedLog = {
  kind: 'Paused';
  id: bigint;
  executor: `0x${string}`;
  reason: number;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
};
export type OrderEvent = ExecutedLog | PausedLog;

export type Run = {
  transactionHash: `0x${string}`;
  /** index of the Executed log — a batching contract can run several owed periods of one order in one transaction */
  logIndex: number;
  blockNumber: bigint;
  executor: `0x${string}`;
  gasMetered: bigint;
  price: bigint;
  refund: bigint;
  tip: bigint;
  nextDue: bigint;
  paid: boolean;
  /** present when the payee refused in this run */
  pausedReason?: number;
};

/**
 * Fold raw `Executed` / `Paused` logs into runs, newest first (block, then log index). One run per `Executed` log — a
 * batching contract that catches up several owed periods of one order in one transaction produces several runs with the
 * same hash. A `Paused` log is emitted just before the `Executed(…, paid = false)` of the same run, so it attaches to the
 * nearest `Executed` after it in the same transaction. Duplicate logs (the same tx + logIndex — a failed scan round re-reads
 * its windows, since `scanBounded` keeps no partial state) are dropped; the result does not depend on input order.
 */
export function foldEvents(events: OrderEvent[]): Run[] {
  const seen = new Set<string>();
  const unique: OrderEvent[] = [];
  for (const e of events) {
    const k = `${e.transactionHash}:${e.logIndex}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(e);
  }
  // chain order: by block, then by log index — so "the Executed after this Paused" is well defined
  unique.sort((a, b) => (a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex - b.logIndex));
  const runs: Run[] = [];
  let pending: number | undefined; // a Paused reason waiting for its Executed in the same transaction
  let pendingTx: string | undefined;
  for (const e of unique) {
    if (e.kind === 'Paused') {
      pending = e.reason;
      pendingTx = e.transactionHash;
      continue;
    }
    const run: Run = {
      transactionHash: e.transactionHash,
      logIndex: e.logIndex,
      blockNumber: e.blockNumber,
      executor: e.executor,
      gasMetered: e.gasMetered,
      price: e.price,
      refund: e.refund,
      tip: e.tip,
      nextDue: e.nextDue,
      paid: e.paid,
    };
    if (pending !== undefined && pendingTx === e.transactionHash) run.pausedReason = pending;
    pending = undefined;
    pendingTx = undefined;
    runs.push(run);
  }
  return runs.reverse();
}
