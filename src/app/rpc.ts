/** Read side: anonymous JSON-RPC only. Nothing here needs a wallet. */
import { createPublicClient, decodeEventLog, http, numberToHex, parseAbiItem, toEventSelector } from 'viem';
import { legworkAbi } from '../lib/abi';
import { arc, RPC_URL } from '../lib/chain';
import { decodeOrder, isOpen, type Order, type OrderEvent } from '../lib/orders';
import { scanBounded, initialScan, type ScanState, CHUNKS_ON_OPEN } from '../lib/scan';
import deploy from '../../deploy/arc-mainnet.json';

export const CONTRACT = deploy.contract.address as `0x${string}`;
export const OVERHEAD = deploy.contract.overhead;
export const DEPLOY = deploy;

// ccipRead off: the page must never fetch anything but the RPC (an OffchainLookup revert would otherwise call out)
export const client = createPublicClient({ chain: arc, transport: http(RPC_URL, { batch: false }), ccipRead: false });

/** The public RPC rate-limits bursts (HTTP 429 / -32005 / "exceeds defined limit"); a plain read is retried a few times, backing off. */
export function isRateLimit(e: any): boolean {
  const code = e?.code ?? e?.cause?.code, msg = String(e?.shortMessage ?? e?.message ?? '');
  return code === -32005 || code === 429 || e?.status === 429 || /429|rate limit|exceeds defined limit/i.test(msg);
}
async function retried<T>(f: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e: any) {
      if (!isRateLimit(e) || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** i)); // 0.8 · 1.6 · 3.2 s
    }
  }
}

/** Three outcomes: the chain answered 5042, it answered something else / is unreachable, or the public RPC only refused the
 *  burst (HTTP 429 — this check fires beside the first view's reads). A refused burst is not an outage and is not reported as one. */
export async function chainOk(): Promise<'ok' | 'down' | 'rate-limited'> {
  try { return (await retried(() => client.getChainId())) === 5042 ? 'ok' : 'down'; } catch (e) { return isRateLimit(e) ? 'rate-limited' : 'down'; }
}

export async function head() {
  const b = await retried(() => client.getBlock({ blockTag: 'latest' }));
  return { number: b.number, timestamp: b.timestamp, basefee: b.baseFeePerGas ?? 20_000_000_000n };
}

export async function getOrder(id: bigint): Promise<Order> {
  const t = await retried(() => client.readContract({ address: CONTRACT, abi: legworkAbi, functionName: 'orders', args: [id] }));
  return decodeOrder(t as any);
}

// The contract's status/needed/priceCap views are deliberately not read here: a bare eth_call is simulated at base fee 0
// on Arc's RPC, so they would report a reserve and cap of 0. The page computes the same arithmetic from the latest block's
// baseFeePerGas (src/lib/orders.ts), which is what the tests cover.

/** The calibrated constant, read from the contract itself (the deploy record is only the fallback). */
export async function overheadOnChain(): Promise<number> {
  return (await overheadRead()).value;
}
/** Same read, saying where the number came from — the footer must not label the fallback as a chain read. */
export async function overheadRead(): Promise<{ value: number; fromChain: boolean }> {
  try { return { value: Number(await retried(() => client.readContract({ address: CONTRACT, abi: legworkAbi, functionName: 'OVERHEAD' }))), fromChain: true }; } catch { return { value: OVERHEAD, fromChain: false }; }
}

export async function nextId(): Promise<bigint> {
  return retried(() => client.readContract({ address: CONTRACT, abi: legworkAbi, functionName: 'nextId' }));
}

export const LIST_PAGE = 200;

/** The newest `LIST_PAGE` orders through Multicall3 (one round-trip); sequential eth_call if the multicall fails. */
export async function listOrders(): Promise<{ total: bigint; rows: { id: bigint; order: Order }[] }> {
  const n = await nextId();
  const first = n > BigInt(LIST_PAGE) ? n - BigInt(LIST_PAGE) + 1n : 1n;
  const ids = Array.from({ length: Number(n - first + 1n) }, (_, i) => first + BigInt(i));
  if (n === 0n) return { total: 0n, rows: [] };
  let tuples: any[];
  try {
    const res = await retried(() => client.multicall({
      contracts: ids.map((id) => ({ address: CONTRACT, abi: legworkAbi, functionName: 'orders' as const, args: [id] as const })),
      allowFailure: false,
    }));
    tuples = res as any[];
  } catch {
    tuples = [];
    for (const id of ids) tuples.push(await client.readContract({ address: CONTRACT, abi: legworkAbi, functionName: 'orders', args: [id] }));
  }
  return { total: n, rows: ids.map((id, i) => ({ id, order: decodeOrder(tuples[i]) })).filter((x) => isOpen(x.order)) };
}

const executedEvent = parseAbiItem('event Executed(uint256 indexed id, address indexed executor, uint256 gasMetered, uint256 price, uint256 refund, uint256 tip, uint48 nextDue, bool paid)');
const pausedEvent = parseAbiItem('event Paused(uint256 indexed id, address indexed executor, uint8 reason)');
const EXECUTED_TOPIC = toEventSelector(executedEvent);
const PAUSED_TOPIC = toEventSelector(pausedEvent);

/**
 * One raw eth_getLogs per window: topics [[Executed, Paused], id] — both event kinds for one order in one request.
 * The public RPC is load-balanced: a backend can lag the head it just reported (-32014 "requested data not
 * available") or rate-limit a burst (-32005). Both are retried once after a short pause, sequentially.
 */
async function orderLogs(id: bigint, fromBlock: bigint, toBlock: bigint): Promise<OrderEvent[]> {
  const params = [{ address: CONTRACT, fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock), topics: [[EXECUTED_TOPIC, PAUSED_TOPIC], numberToHex(id, { size: 32 })] }];
  let raw: any[];
  try {
    raw = (await client.request({ method: 'eth_getLogs', params } as any)) as any[];
  } catch (e: any) {
    const code = e?.code ?? e?.cause?.code;
    if (code !== -32014 && code !== -32005) throw e;
    await new Promise((r) => setTimeout(r, 900));
    raw = (await client.request({ method: 'eth_getLogs', params } as any)) as any[];
  }
  const out: OrderEvent[] = [];
  for (const l of raw) {
    const base = { blockNumber: BigInt(l.blockNumber), transactionHash: l.transactionHash as `0x${string}`, logIndex: parseInt(l.logIndex, 16) };
    if (l.topics[0] === EXECUTED_TOPIC) {
      const d = decodeEventLog({ abi: [executedEvent], data: l.data, topics: l.topics });
      out.push({ kind: 'Executed', ...(d.args as any), blockNumber: base.blockNumber, transactionHash: base.transactionHash, logIndex: base.logIndex });
    } else if (l.topics[0] === PAUSED_TOPIC) {
      const d = decodeEventLog({ abi: [pausedEvent], data: l.data, topics: l.topics });
      out.push({ kind: 'Paused', ...(d.args as any), blockNumber: base.blockNumber, transactionHash: base.transactionHash, logIndex: base.logIndex });
    }
  }
  return out;
}

/** Bounded two-ended history for one order: `maxChunks` × ≤ 9,000 blocks from the head and from createdBlock, ≥ 400 ms apart. */
export async function scanHistory(id: bigint, state: ScanState, stale: () => boolean = () => false, maxChunks = CHUNKS_ON_OPEN) {
  return scanBounded<OrderEvent>(state, (w) => { if (stale()) throw new Error('scan superseded'); return orderLogs(id, w.fromBlock, w.toBlock); }, maxChunks, undefined, 400);
}

export const startScan = (headNumber: bigint, createdBlock: bigint) => initialScan(headNumber, createdBlock);

export async function receipt(hash: `0x${string}`) {
  return retried(() => client.getTransactionReceipt({ hash }));
}

export async function waitReceipt(hash: `0x${string}`) {
  // finality is deterministic on Arc: the first receipt is the final one
  return client.waitForTransactionReceipt({ hash, pollingInterval: 700 });
}

export async function gasPrice() {
  return client.getGasPrice();
}

export async function estimateExecute(id: bigint, from?: `0x${string}`) {
  return client.estimateContractGas({ address: CONTRACT, abi: legworkAbi, functionName: 'execute', args: [id], account: from });
}
