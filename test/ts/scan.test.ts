import { describe, expect, it } from 'vitest';
import { CHUNK, initialScan, scanBounded, windowsBackward } from '../../src/lib/scan';

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
  it('fetches at most maxChunks windows, sequentially, and hands back where to continue', async () => {
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
    expect(first.state.nextTo).toBe(head - 8n * 9_000n);
    expect(first.logs).toHaveLength(8);
    const second = await scanBounded(first.state, fetch, 8, 9_000n);
    expect(second.state.exhausted).toBe(true);
    expect(calls.at(-1)![0]).toBe(created); // never past createdBlock
    expect(calls).toHaveLength(12);
  });
  it('is already exhausted when the head is before the creation block', async () => {
    const s = initialScan(5n, 10n);
    expect(s.exhausted).toBe(true);
    const r = await scanBounded(s, async () => [1]);
    expect(r.logs).toHaveLength(0);
  });
});
