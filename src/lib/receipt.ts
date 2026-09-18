/**
 * Everything the receipt panel shows is derived here from a transaction receipt and the order's numbers:
 * the two system-emitter Transfer legs, the contract's own metering, the real fee from the receipt, the drift.
 */
import { decodeEventLog, type Log, type TransactionReceipt } from 'viem';
import { legworkAbi, transferAbi } from './abi';
import { SYSTEM_EMITTER } from './chain';

export type Leg = { from: `0x${string}`; to: `0x${string}`; value: bigint; logIndex: number };

export type Decoded = {
  hash: `0x${string}`;
  blockNumber: bigint;
  status: 'success' | 'reverted';
  executor: `0x${string}`;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  realFee: bigint;
  executed?: { id: bigint; executor: `0x${string}`; gasMetered: bigint; price: bigint; refund: bigint; tip: bigint; nextDue: bigint; paid: boolean };
  paused?: { id: bigint; executor: `0x${string}`; reason: number };
  /** `gasUsed − gasMetered`: the residual after OVERHEAD calibration */
  drift?: bigint;
  /** `refund + tip − realFee` */
  executorNet?: bigint;
  /** refund ÷ realFee, as a float for display */
  ratio?: number;
  legs: Leg[];
  payeeLeg?: Leg;
  executorLeg?: Leg;
};

type MinimalLog = Pick<Log, 'address' | 'topics' | 'data'> & { logIndex?: number | null };

export function decodeReceipt(
  r: Pick<TransactionReceipt, 'transactionHash' | 'blockNumber' | 'status' | 'gasUsed' | 'effectiveGasPrice' | 'from'> & { logs: MinimalLog[] },
  contract: `0x${string}`,
  payee?: `0x${string}`,
): Decoded {
  const out: Decoded = {
    hash: r.transactionHash,
    blockNumber: r.blockNumber,
    status: r.status,
    executor: r.from,
    gasUsed: r.gasUsed,
    effectiveGasPrice: r.effectiveGasPrice,
    realFee: r.gasUsed * r.effectiveGasPrice,
    legs: [],
  };
  for (const l of r.logs) {
    const addr = l.address.toLowerCase();
    if (addr === contract.toLowerCase()) {
      try {
        const ev = decodeEventLog({ abi: legworkAbi, data: l.data, topics: l.topics as any });
        if (ev.eventName === 'Executed') out.executed = { ...(ev.args as any) };
        if (ev.eventName === 'Paused') out.paused = { ...(ev.args as any) };
      } catch { /* not one of ours */ }
    } else if (addr === SYSTEM_EMITTER.toLowerCase()) {
      try {
        const ev = decodeEventLog({ abi: transferAbi, data: l.data, topics: l.topics as any });
        const a = ev.args as { from: `0x${string}`; to: `0x${string}`; value: bigint };
        if (a.from.toLowerCase() === contract.toLowerCase()) {
          out.legs.push({ from: a.from, to: a.to, value: a.value, logIndex: l.logIndex ?? -1 });
        }
      } catch { /* not a Transfer */ }
    }
  }
  if (out.executed) {
    out.drift = out.gasUsed - out.executed.gasMetered;
    out.executorNet = out.executed.refund + out.executed.tip - out.realFee;
    out.ratio = out.realFee === 0n ? 0 : Number((out.executed.refund * 1_000_000n) / out.realFee) / 1_000_000;
    out.executorLeg = out.legs.find((x) => x.to.toLowerCase() === out.executed!.executor.toLowerCase());
    if (payee) out.payeeLeg = out.legs.find((x) => x.to.toLowerCase() === payee.toLowerCase());
    else out.payeeLeg = out.legs.find((x) => x !== out.executorLeg);
  }
  return out;
}

/** Raw JSON receipt (as `cast receipt --json` writes it: hex strings) → the shape decodeReceipt takes. */
export function fromJsonReceipt(j: any) {
  return {
    transactionHash: j.transactionHash as `0x${string}`,
    blockNumber: BigInt(j.blockNumber),
    status: (j.status === '0x1' || j.status === 'success' ? 'success' : 'reverted') as 'success' | 'reverted',
    gasUsed: BigInt(j.gasUsed),
    effectiveGasPrice: BigInt(j.effectiveGasPrice),
    from: j.from as `0x${string}`,
    logs: (j.logs as any[]).map((l) => ({
      address: l.address as `0x${string}`,
      topics: l.topics as `0x${string}`[],
      data: l.data as `0x${string}`,
      logIndex: typeof l.logIndex === 'string' ? parseInt(l.logIndex, 16) : l.logIndex,
    })),
  };
}
