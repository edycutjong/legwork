/**
 * Bounded two-ended log scan. Arc's public RPC rejects `eth_getLogs` spans above 10,000 blocks (-32012) and
 * rate-limits bursts (-32005 / HTTP 429), so history is read in ≤ CHUNK-block windows, one request at a time,
 * and only as far as the reader asks. The windows come from BOTH ends of the order's life: the newest blocks
 * (a run the reader just made) and the oldest, from the order's creation block (its first runs). At ~2 blocks/s
 * a one-ended backward scan would need dozens of requests to reach a run made yesterday; the two-ended one shows
 * a seeded order's first runs and a reviewer's latest run with the same eight windows. Nothing is ever read
 * before `createdBlock`, and nothing twice within a round (a failed round re-reads its windows: no partial state is kept).
 */

export const CHUNK = 9_000n;
export const CHUNKS_ON_OPEN = 8;

export type Window = { fromBlock: bigint; toBlock: bigint };

/**
 * `hi` is the next block to read on the newest side (walking down), `lo` the next on the oldest side (walking up);
 * the blocks strictly between them are unread. `head` and `floor` are kept so the page can say what was covered.
 */
export type ScanState = { head: bigint; floor: bigint; hi: bigint; lo: bigint; exhausted: boolean };

/**
 * Read up to `maxChunks` windows, alternating newest-side / oldest-side, calling `fetch` for each, sequentially,
 * with a short pause between requests so a burst never trips the RPC's rate limit. Returns the logs found and the
 * state to continue from ("older runs").
 */
export async function scanBounded<T>(
  state: ScanState,
  fetch: (w: Window) => Promise<T[]>,
  maxChunks = CHUNKS_ON_OPEN,
  chunk = CHUNK,
  pauseMs = 0,
): Promise<{ logs: T[]; state: ScanState }> {
  const logs: T[] = [];
  let { hi, lo, exhausted } = state;
  let n = 0;
  while (!exhausted && n < maxChunks) {
    if (n > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    let w: Window;
    if (n % 2 === 0) {
      const from = hi - chunk + 1n > lo ? hi - chunk + 1n : lo;
      w = { fromBlock: from, toBlock: hi };
      hi = from - 1n;
    } else {
      const to = lo + chunk - 1n < hi ? lo + chunk - 1n : hi;
      w = { fromBlock: lo, toBlock: to };
      lo = to + 1n;
    }
    logs.push(...(await fetch(w)));
    n++;
    if (lo > hi) exhausted = true;
  }
  return { logs, state: { ...state, hi, lo, exhausted } };
}

export const initialScan = (head: bigint, createdBlock: bigint): ScanState => ({
  head,
  floor: createdBlock,
  hi: head,
  lo: createdBlock,
  exhausted: head < createdBlock,
});

/** Human-readable coverage: the two read ranges, or "everything". */
export function coverage(s: ScanState): { newest?: Window; oldest?: Window; all: boolean } {
  if (s.head < s.floor) return { all: false }; // nothing could be read: the head lags the creation block
  if (s.exhausted) return { all: true };
  return {
    newest: s.hi < s.head ? { fromBlock: s.hi + 1n, toBlock: s.head } : undefined,
    oldest: s.lo > s.floor ? { fromBlock: s.floor, toBlock: s.lo - 1n } : undefined,
    all: false,
  };
}
