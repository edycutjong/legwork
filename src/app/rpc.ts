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

export const client = createPublicClient({ chain: arc, transport: http(RPC_URL, { batch: false }) });

export async function chainOk(): Promise<boolean> {
  try { return (await client.getChainId()) === 5042; } catch { return false; }
}

export async function head() {
  const b = await client.getBlock({ blockTag: 'latest' });
  return { number: b.number, timestamp: b.timestamp, basefee: b.baseFeePerGas ?? 20_000_000_000n };
}

export async function getOrder(id: bigint): Promise<Order> {
  const t = await client.readContract({ address: CONTRACT, abi: legworkAbi, functionName: 'orders', args: [id] });
  return decodeOrder(t as any);
}

export async function getStatus(id: bigint): Promise<number> {
  return client.readContract({ address: CONTRACT, abi: legworkAbi, functionName: 'status', args: [id] });
}

export async function getNeeded(id: bigint): Promise<bigint> {
  return client.readContract({ address: CONTRACT, abi: legworkAbi, functionName: 'needed', args: [id] });
}

export async function getPriceCap(id: bigint): Promise<bigint> {
  return client.readContract({ address: CONTRACT, abi: legworkAbi, functionName: 'priceCap', args: [id] });
}

/** The calibrated constant, read from the contract itself (the deploy record is only the fallback). */
export async function overheadOnChain(): Promise<number> {
  try { return Number(await client.readContract({ address: CONTRACT, abi: legworkAbi, functionName: 'OVERHEAD' })); } catch { return OVERHEAD; }
}

export async function nextId(): Promise<bigint> {
  return client.readContract({ address: CONTRACT, abi: legworkAbi, functionName: 'nextId' });
}

export const LIST_PAGE = 200;

/** The newest `LIST_PAGE` orders through Multicall3 (one round-trip); sequential eth_call if the multicall fails. */
export async function listOrders(): Promise<{ id: bigint; order: Order }[]> {
  const n = await nextId();
  const first = n > BigInt(LIST_PAGE) ? n - BigInt(LIST_PAGE) + 1n : 1n;
  const ids = Array.from({ length: Number(n - first + 1n) }, (_, i) => first + BigInt(i));
  if (n === 0n) return [];
  let tuples: any[];
  try {
    const res = await client.multicall({
      contracts: ids.map((id) => ({ address: CONTRACT, abi: legworkAbi, functionName: 'orders' as const, args: [id] as const })),
      allowFailure: false,
    });
    tuples = res as any[];
  } catch {
    tuples = [];
    for (const id of ids) tuples.push(await client.readContract({ address: CONTRACT, abi: legworkAbi, functionName: 'orders', args: [id] }));
  }
  return ids.map((id, i) => ({ id, order: decodeOrder(tuples[i]) })).filter((x) => isOpen(x.order));
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

/** Bounded backward history for one order: `maxChunks` × ≤ 9,000 blocks, never past createdBlock. */
export async function scanHistory(id: bigint, state: ScanState, maxChunks = CHUNKS_ON_OPEN) {
  return scanBounded<OrderEvent>(state, (w) => orderLogs(id, w.fromBlock, w.toBlock), maxChunks);
}

export const startScan = (headNumber: bigint, createdBlock: bigint) => initialScan(headNumber, createdBlock);

export async function receipt(hash: `0x${string}`) {
  return client.getTransactionReceipt({ hash });
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
