import { expect, test } from '@playwright/test';

// Live reads from Arc mainnet through the public RPC. No wallet, no writes. Skipped (not failed) when the RPC is unreachable.
const RPC = 'https://rpc.mainnet.arc.io';
const HERO = '0x2f6a352d11823a37ad085151067856131833ef978445fbed5941e7d17b5b0c95';

test.beforeEach(async ({ request }) => {
  const up = await request.post(RPC, { data: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] } }).then((r) => r.ok()).catch(() => false);
  test.skip(!up, 'Arc public RPC unreachable from this runner');
});

test.describe('live: mainnet reads', () => {
  test('the footer reads OVERHEAD from the contract and the open-orders list comes from Multicall3', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.foot')).toContainText('OVERHEAD() 32503 gas (read from the contract)', { timeout: 20_000 });
    const table = page.locator('.orders table');
    await expect(table).toBeVisible({ timeout: 20_000 });
    await expect(table.locator('tbody tr').first()).toContainText('#1');
    await expect(page.locator('.orders')).toContainText('Base fee now');
  });

  test('the seeded order #1 renders its card, status and history', async ({ page }) => {
    await page.goto('/#/o/1');
    await expect(page.getByRole('heading', { name: 'Order #1' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.badge')).toHaveText(/DUE|WAITING|UNDERFUNDED/);
    await expect(page.locator('.kv')).toContainText('created at block');
    await expect(page.locator('.kv')).toContainText('21493738');
    const runs = page.locator('.runs');
    await expect(runs).toContainText('0x0a59…d04d', { timeout: 40_000 }); // the day-one run, found by the two-ended scan
    await expect(runs).toContainText('58415');
  });

  test('the committed hero receipt decodes to drift 0 and refund ÷ fee 1.000000, although its order is cancelled', async ({ page }) => {
    await page.goto(`/#/o/5/tx/${HERO}`);
    await expect(page.getByRole('status')).toContainText('cancelled since this run', { timeout: 20_000 });
    const r = page.locator('.receipt');
    await expect(r).toContainText('Receipt — paid', { timeout: 20_000 });
    await expect(r).toContainText('58415 gas metered × 20 Gwei');
    await expect(r).toContainText('drift 0 gas');
    await expect(r).toContainText('refund ÷ fee 1.000000');
    await expect(r).toContainText('0x8E2F…1ccb → 0xA896…852a  0.0021683 USDC');
    await expect(r.getByRole('link', { name: 'transaction', exact: true })).toHaveAttribute('href', `https://explorer.arc.io/tx/${HERO}`);
  });

  test('a transaction of another order is refused on this order\'s route', async ({ page }) => {
    await page.goto(`/#/o/1/tx/${HERO}`);
    await expect(page.getByRole('alert')).toContainText('executed order #5, not #1', { timeout: 20_000 });
  });
});
