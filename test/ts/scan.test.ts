import { describe, expect, it } from 'vitest';
import { CHUNK, coverage, initialScan, scanBounded, windowsBackward } from '../../src/lib/scan';

describe('windowsBackward', () => {
  it('walks back from the head in ≤ CHUNK-block windows and stops at the floor', () => {
    const w = windowsBackward(100_000n, 80_500n, 9_000n);
    expect(w[0]).toEqual({ fromBlock: 91_001n, toBlock: 100_000n });
    expect(w[1]).toEqual({ fromBlock: 82_001n, toBlock: 91_000n });
    expect(w[2]).toEqual({ fromBlock: 80_500n, toBlock: 82_000n });
    expect(w).toHaveLength(3);
    for (const x of w) expect(x.toBlock - x.fromBlock + 1n <= 9_000n).toBe(true);
  });
  it('a single window when the order is younger than one chunk', () => {
    expect(windowsBackward(50n, 40n)).toEqual([{ fromBlock: 40n, toBlock: 50n }]);
  });
  it('the default chunk is under the RPC limit of 10,000', () => {
    expect(CHUNK < 10_000n).toBe(true);
  });
});

describe('scanBounded', () => {
  it('reads at most maxChunks windows, sequentially, from both ends, and hands back where to continue', async () => {
    const calls: [bigint, bigint][] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = async (w: { fromBlock: bigint; toBlock: bigint }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push([w.fromBlock, w.toBlock]);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return [w.toBlock];
    };
    const head = 1_000_000n;
    const created = head - 100_000n; // ≈ 11 chunks of history
    const first = await scanBounded(initialScan(head, created), fetch, 8, 9_000n);
    expect(calls).toHaveLength(8);
    expect(maxInFlight).toBe(1);
    expect(first.state.exhausted).toBe(false);
    expect(calls[0]).toEqual([head - 9_000n + 1n, head]); // newest first
    expect(calls[1]).toEqual([created, created + 9_000n - 1n]); // then the creation block
    expect(first.state.hi).toBe(head - 4n * 9_000n);
    expect(first.state.lo).toBe(created + 4n * 9_000n);
    expect(first.logs).toHaveLength(8);
    const second = await scanBounded(first.state, fetch, 8, 9_000n);
    expect(second.state.exhausted).toBe(true);
    expect(calls).toHaveLength(12);
    // every block from created to head read exactly once
    const covered = calls.map(([a, b]) => b - a + 1n).reduce((x, y) => x + y, 0n);
    expect(covered).toBe(head - created + 1n);
    for (const [a, b] of calls) { expect(a >= created).toBe(true); expect(b <= head).toBe(true); expect(b - a + 1n <= 9_000n).toBe(true); }
  });
  it('a run made yesterday and the first run on creation day both surface in the eight windows on open', async () => {
    const head = 21_555_269n, created = 21_493_738n; // order #1, 2026-09-18 20:32 UTC — 61,531 blocks apart
    const hits = [created + 3n, head - 40n]; // first run · a reviewer's run
    const fetch = async (w: { fromBlock: bigint; toBlock: bigint }) => hits.filter((b) => b >= w.fromBlock && b <= w.toBlock);
    const r = await scanBounded(initialScan(head, created), fetch, 2, 9_000n);
    expect(r.logs).toEqual([head - 40n, created + 3n]);
    const cov = coverage(r.state);
    expect(cov.all).toBe(false);
    expect(cov.newest).toEqual({ fromBlock: head - 9_000n + 1n, toBlock: head });
    expect(cov.oldest).toEqual({ fromBlock: created, toBlock: created + 9_000n - 1n });
  });
  it('is already exhausted when the head is before the creation block', async () => {
    const s = initialScan(5n, 10n);
    expect(s.exhausted).toBe(true);
    const r = await scanBounded(s, async () => [1]);
    expect(r.logs).toHaveLength(0);
    expect(coverage(s).all).toBe(true);
  });
  it('pauses between requests when asked, never before the first', async () => {
    const t: number[] = [];
    const fetch = async () => { t.push(Date.now()); return []; };
    await scanBounded(initialScan(100_000n, 1n), fetch, 3, 9_000n, 25);
    expect(t).toHaveLength(3);
    expect(t[1] - t[0]).toBeGreaterThanOrEqual(20);
    expect(t[2] - t[1]).toBeGreaterThanOrEqual(20);
  });
});
