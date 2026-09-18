import { describe, expect, it } from 'vitest';
import {
  REFUND_CEIL_GAS, decodeOrder, foldEvents, gwei, neededAt, orderStatus, parseUsdc, priceCapAt, priceOf, refundOf, reserveAt, runsLeft, usdc18,
  type Order, type OrderEvent,
} from '../../src/lib/orders';

const G = 1_000_000_000n; // 1 gwei
const live: Order = {
  payer: '0xA8965A47c9b6ed34F47B374f36cF6c752D24852a',
  nextDue: 1_789_730_000n,
  interval: 60n,
  paused: false,
  payee: '0x352e5cDea885DBCAbe850259CA8AA6759b5aAA60',
  createdBlock: 21_487_540n,
  maxGasPrice: 100n * G,
  amount: 20_000_000_000_000_000n,
  tip: 10_000_000_000_000_000n,
  deposit: 100_000_000_000_000_000n,
};

describe('reserve and needed', () => {
  it('reserve is REFUND_CEIL_GAS × min(basefee, maxGasPrice)', () => {
    expect(reserveAt(20n * G, 100n * G)).toBe(REFUND_CEIL_GAS * 20n * G); // 0.0024 USDC
    expect(reserveAt(20n * G, 5n * G)).toBe(REFUND_CEIL_GAS * 5n * G);
    expect(usdc18(reserveAt(20n * G, 100n * G))).toBe('0.0024');
  });
  it('needed mirrors the contract: amount + tip + reserve', () => {
    expect(usdc18(neededAt(live, 20n * G))).toBe('0.0324');
  });
  it('runs left is whole runs of needed', () => {
    expect(runsLeft(live, 20n * G)).toBe(3n);
    expect(runsLeft({ ...live, deposit: 32_400_000_000_000_000n - 1n }, 20n * G)).toBe(0n);
  });
});

describe('prices', () => {
  it('priceCap = min(2·basefee, maxGasPrice)', () => {
    expect(priceCapAt(100n * G, 20n * G)).toBe(40n * G);
    expect(priceCapAt(20n * G, 20n * G)).toBe(20n * G);
  });
  it('price = min(gasprice, 2·basefee, maxGasPrice) — the three caps each bind', () => {
    expect(priceOf(20n * G, 20n * G, 100n * G)).toBe(20n * G);
    expect(priceOf(60n * G, 20n * G, 100n * G)).toBe(40n * G);
    expect(priceOf(30n * G, 20n * G, 20n * G)).toBe(20n * G);
  });
});

describe('refundOf', () => {
  it('metered × price when the deposit covers it', () => {
    expect(refundOf(58_030n, 20n * G, 70_000_000_000_000_000n)).toBe(58_030n * 20n * G);
  });
  it('clamps metered at REFUND_CEIL_GAS', () => {
    expect(refundOf(500_000n, 20n * G, 10n ** 18n)).toBe(REFUND_CEIL_GAS * 20n * G);
  });
  it('is bounded by what is left in the deposit', () => {
    expect(refundOf(58_030n, 20n * G, 1_000n)).toBe(1_000n);
  });
});

describe('orderStatus', () => {
  const now = live.nextDue;
  it('Due when funded and nextDue has passed', () => expect(orderStatus(live, 20n * G, now)).toBe('Due'));
  it('Waiting before nextDue', () => expect(orderStatus(live, 20n * G, now - 1n)).toBe('Waiting'));
  it('Underfunded beats Waiting and Due', () => {
    expect(orderStatus({ ...live, deposit: 1n }, 20n * G, now)).toBe('Underfunded');
    expect(orderStatus({ ...live, deposit: 1n }, 20n * G, now - 100n)).toBe('Underfunded');
  });
  it('Paused beats everything but None', () => {
    expect(orderStatus({ ...live, paused: true, deposit: 1n }, 20n * G, now)).toBe('Paused');
    expect(orderStatus({ ...live, payer: '0x0000000000000000000000000000000000000000' }, 20n * G, now)).toBe('None');
  });
  it('a pricey executor sees Underfunded where an honest one sees Due (the pre-check uses its own price)', () => {
    const exact = { ...live, deposit: neededAt(live, 20n * G) };
    expect(orderStatus(exact, 20n * G, now)).toBe('Due');
    // at 30 Gwei the same order needs more than it holds
    expect(exact.deposit < exact.amount + exact.tip + REFUND_CEIL_GAS * 30n * G).toBe(true);
  });
});

describe('decimals', () => {
  it('renders native wei ÷ 10¹⁸ without truncating to 6 decimals', () => {
    expect(usdc18(1_160_600_000_000_000n)).toBe('0.0011606');
    expect(usdc18(20_000_000_000_000_000n)).toBe('0.02');
    expect(usdc18(0n)).toBe('0');
    expect(usdc18(-278_000_000_000_000n)).toBe('-0.000278');
    expect(usdc18(1_000_000_000_000_000_000n)).toBe('1');
    expect(usdc18(1_234_567_890_123_456_789n)).toBe('1.234567890123456789');
    expect(usdc18(1_234_567_890_123_456_789n, 6)).toBe('1.234567');
  });
  it('parses USDC strings to 18-decimal wei and round-trips', () => {
    expect(parseUsdc('0.02')).toBe(20_000_000_000_000_000n);
    expect(parseUsdc('1')).toBe(10n ** 18n);
    expect(parseUsdc('0.000000000000000001')).toBe(1n);
    expect(usdc18(parseUsdc('0.0324'))).toBe('0.0324');
    expect(() => parseUsdc('abc')).toThrow();
  });
  it('gwei helper', () => {
    expect(gwei(20_000_000_000n)).toBe('20');
    expect(gwei(20_461_249_992n)).toBe('20.461249992');
  });
});

describe('decodeOrder', () => {
  it('maps the orders(id) tuple to a typed order', () => {
    const o = decodeOrder([live.payer, 1, 60, false, live.payee, 5, 100_000_000_000, live.amount, live.tip, live.deposit]);
    expect(o.nextDue).toBe(1n);
    expect(o.interval).toBe(60n);
    expect(o.maxGasPrice).toBe(100n * G);
    expect(o.createdBlock).toBe(5n);
  });
});

describe('foldEvents', () => {
  const ex = (tx: string, block: bigint, paid: boolean, logIndex = 1): OrderEvent => ({
    kind: 'Executed', id: 1n, executor: live.payer, gasMetered: 58_030n, price: 20n * G, refund: 58_030n * 20n * G, tip: live.tip,
    nextDue: 1n, paid, blockNumber: block, transactionHash: tx as `0x${string}`, logIndex,
  });
  it('orders runs newest first and attaches Paused to its own Executed', () => {
    const runs = foldEvents([
      ex('0xaaa', 10n, true),
      { kind: 'Paused', id: 1n, executor: live.payer, reason: 1, blockNumber: 12n, transactionHash: '0xbbb', logIndex: 0 },
      ex('0xbbb', 12n, false, 1),
      ex('0xccc', 11n, true),
    ]);
    expect(runs.map((r) => r.transactionHash)).toEqual(['0xbbb', '0xccc', '0xaaa']);
    expect(runs[0].paid).toBe(false);
    expect(runs[0].pausedReason).toBe(1);
    expect(runs[1].pausedReason).toBeUndefined();
  });
  it('drops duplicates from overlapping scans', () => {
    const runs = foldEvents([ex('0xaaa', 10n, true), ex('0xaaa', 10n, true)]);
    expect(runs).toHaveLength(1);
  });
});
