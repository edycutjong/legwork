import { expect, test } from '@playwright/test';

// The reviewer page must be reachable with no credentials, no session, no wallet — and say the claim sentence.
test('#/judge returns the claim, the 60-second path, receipts, reproduce and limitations with no session', async ({ page, context }) => {
  await context.clearCookies();
  const res = await page.goto('/#/judge');
  expect(res?.status()).toBe(200);
  const card = page.locator('.judge');
  await expect(card).toContainText('Standing USDC orders anyone can run — and be repaid the exact gas, in the same dollar, in the same transaction.');
  await expect(card.getByRole('heading', { name: 'The 60-second path' })).toBeVisible();
  await expect(card).toContainText('0x8E2F8AFC29e9dc127103CD6AD5BCfBe661141ccb');
  await expect(card).toContainText('drift 0');
  await expect(card).toContainText('forge test && npm install && npm test && npm run recheck');
  await expect(card.getByRole('heading', { name: 'What we do not claim' })).toBeVisible();
  await expect(card.getByRole('link', { name: 'repository' })).toHaveAttribute('href', 'https://github.com/edycutjong/legwork-arc');
  await expect(card.getByRole('link', { name: '#/o/1' })).toHaveAttribute('href', '#/o/1');
});
