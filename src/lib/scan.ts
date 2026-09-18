/**
 * Bounded backward log scan. Arc's public RPC rejects `eth_getLogs` spans above 10,000 blocks (-32012) and
 * rate-limits bursts (-32005), so history is read in ≤ CHUNK-block windows, newest first, one request at a
 * time, and only as far as the reader asks — never past the order's own creation block.
 */

export const CHUNK = 9_000n;
export const CHUNKS_ON_OPEN = 8;

export type Window = { fromBlock: bigint; toBlock: bigint };

/** Successive windows walking back from `head` to `floor` (inclusive), each ≤ CHUNK blocks. */
export function windowsBackward(head: bigint, floor: bigint, chunk = CHUNK): Window[] {
  const out: Window[] = [];
  let to = head;
  while (to >= floor) {
    const from = to - chunk + 1n > floor ? to - chunk + 1n : floor;
    out.push({ fromBlock: from, toBlock: to });
    if (from === floor) break;
    to = from - 1n;
  }
  return out;
}

export type ScanState = { nextTo: bigint; floor: bigint; exhausted: boolean };

/**
 * Scan up to `maxChunks` windows backward from `state.nextTo`, calling `fetch` for each, sequentially.
 * Returns the logs found and the state to continue from ("older runs").
 */
export async function scanBounded<T>(
  state: ScanState,
  fetch: (w: Window) => Promise<T[]>,
  maxChunks = CHUNKS_ON_OPEN,
  chunk = CHUNK,
): Promise<{ logs: T[]; state: ScanState }> {
  const logs: T[] = [];
  let { nextTo, floor } = state;
  let exhausted = state.exhausted;
  let n = 0;
  while (!exhausted && n < maxChunks) {
    const from = nextTo - chunk + 1n > floor ? nextTo - chunk + 1n : floor;
    logs.push(...(await fetch({ fromBlock: from, toBlock: nextTo })));
    n++;
    if (from === floor) {
      exhausted = true;
    } else {
      nextTo = from - 1n;
    }
  }
  return { logs, state: { nextTo, floor, exhausted } };
}

export const initialScan = (head: bigint, createdBlock: bigint): ScanState => ({
  nextTo: head,
  floor: createdBlock,
  exhausted: head < createdBlock,
});
