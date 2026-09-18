/** These fixtures are real Arc mainnet receipts committed under proof/ — nothing here is synthetic. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeReceipt, fromJsonReceipt } from '../../src/lib/receipt';
import { refundOf } from '../../src/lib/orders';

const CONTRACT = '0x68a92aF2Be2e6A640a19508a0fe44cbc8B2C62E2';
const PAYEE = '0x352e5cDea885DBCAbe850259CA8AA6759b5aAA60';
const REJECTOR = '0x1c17C16177f2aC609440ea20c00D0e108F617c47';
const load = (h: string) => fromJsonReceipt(JSON.parse(readFileSync(`proof/receipts/${h}.json`, 'utf8')));

describe('decodeReceipt on the live order run (0x651700ee…)', () => {
  const x = decodeReceipt(load('0x651700ee3f058685b0cdb896a707f5e5e7e8c507076a3f0f4d6816f3d6e25f0b'), CONTRACT, PAYEE);
  it('reads the metering event and the receipt figures', () => {
    expect(x.status).toBe('success');
    expect(x.gasUsed).toBe(58_030n);
    expect(x.effectiveGasPrice).toBe(20_000_000_000n);
    expect(x.executed?.gasMetered).toBe(58_030n);
    expect(x.executed?.price).toBe(20_000_000_000n);
    expect(x.executed?.paid).toBe(true);
    expect(x.drift).toBe(0n);
    expect(x.ratio).toBe(1);
  });
  it('the offline refund formula equals the on-chain refund', () => {
    const depositAfterDebit = 100_000_000_000_000_000n - 20_000_000_000_000_000n - 10_000_000_000_000_000n;
    expect(refundOf(x.executed!.gasMetered, x.executed!.price, depositAfterDebit)).toBe(x.executed!.refund);
    expect(x.executed!.refund).toBe(x.realFee);
    expect(x.executorNet).toBe(x.executed!.tip);
  });
  it('decodes both system-emitter legs from the contract', () => {
    expect(x.legs).toHaveLength(2);
    expect(x.payeeLeg?.value).toBe(20_000_000_000_000_000n);
    expect(x.executorLeg?.value).toBe(x.executed!.refund + x.executed!.tip);
    expect(x.executorLeg?.to.toLowerCase()).toBe(x.executor.toLowerCase());
  });
});

describe('decodeReceipt on the refused payment (0xf4cdeb75…)', () => {
  const x = decodeReceipt(load('0xf4cdeb7523c64082f9e09fa3bf738fd676bad1ef401c4f7c9622d0d41c3d71b7'), CONTRACT, REJECTOR);
  it('carries Paused then Executed(paid = false), one leg only', () => {
    expect(x.paused?.reason).toBe(1);
    expect(x.executed?.paid).toBe(false);
    expect(x.legs).toHaveLength(1);
    expect(x.payeeLeg).toBeUndefined();
    expect(x.executorLeg?.value).toBe(x.executed!.refund + x.executed!.tip);
    expect(x.drift).toBe(-6n);
  });
});

describe('decodeReceipt on the capped order (0x76d50864…)', () => {
  const x = decodeReceipt(load('0x76d508646679f86e55fbd50fe05b614a61cfa2cfa2721162abe7665f92343eaf'), CONTRACT, PAYEE);
  it('shows the executor eating the difference above maxGasPrice', () => {
    expect(x.effectiveGasPrice).toBe(30_000_000_000n);
    expect(x.executed?.price).toBe(20_000_000_000n);
    expect(x.executed!.refund < x.realFee).toBe(true);
    expect(x.executorNet! < x.executed!.tip).toBe(true);
    expect(x.drift).toBe(0n);
  });
});

describe('decodeReceipt on the calibration contract (0xc97ed057…)', () => {
  const x = decodeReceipt(load('0xc97ed05731a9911c8bb913bffb9e48bfc2a5ff27e16451a18232e55ac2345535'), '0x16B4101605c496C7Fbe54490C6467eeF996EA775', PAYEE);
  it('reports the pre-calibration drift the constant was corrected by', () => {
    expect(x.drift).toBe(1_103n);
    expect(x.executed?.gasMetered).toBe(56_927n);
  });
});

describe('a receipt from a different contract (the 2026-09-17 metering probe)', () => {
  const j = JSON.parse(readFileSync('proof/probe/gasmeter-probe-0x75e398.json', 'utf8'));
  const x = decodeReceipt(fromJsonReceipt(j), '0xcEaFD715562fD7c07363Ff7C86ca36EB37A32fb6');
  it('still yields the system-emitter legs and the real fee, with no Executed event', () => {
    expect(x.executed).toBeUndefined();
    expect(x.legs.length).toBeGreaterThanOrEqual(2);
    expect(x.gasUsed).toBe(38_435n);
    expect(x.effectiveGasPrice).toBe(20_461_249_992n);
  });
});
