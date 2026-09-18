import { expect, test } from '@playwright/test';

// Layout at phone / tablet / desktop widths: no horizontal overflow, touch targets ≥ 36 px, header fits.
for (const [name, width, height] of [['mobile', 375, 740], ['tablet', 768, 1024], ['desktop', 1440, 900]] as const) {
  test(`${name} ${width}px — no horizontal overflow, targets ≥ 36 px, masthead fits`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'New order' })).toBeVisible();
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW).toBeLessThanOrEqual(width);
    const mast = await page.locator('.masthead').boundingBox();
    expect(mast!.width).toBeLessThanOrEqual(width);
    for (const b of await page.locator('button:visible, .links a:visible').all()) {
      const box = await b.boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(36);
    }
    await page.goto('/#/judge');
    await expect(page.locator('.judge')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
