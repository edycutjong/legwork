import { expect, test } from '@playwright/test';

// The page needs no key, no wallet and no flag: reading is anonymous JSON-RPC.
test.describe('smoke', () => {
  // The only hosts the page may ever contact: itself and Arc's documented public RPC endpoints (src/lib/chain.ts RPC_URLS —
  // the fallback transport moves to the next one when the primary refuses, which a rate-limited CI runner does see).
  const ALLOWED_HOSTS = ['localhost:4173', 'rpc.mainnet.arc.io', 'rpc.drpc.mainnet.arc.io', 'rpc.quicknode.mainnet.arc.io', 'rpc.blockdaemon.mainnet.arc.io'];

  test('home renders the form and the footer without console errors, and talks only to Arc RPC hosts', async ({ page }) => {
    const errors: string[] = [];
    const hosts = new Set<string>();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/429/.test(m.text())) errors.push(m.text()); });
    page.on('request', (r) => hosts.add(new URL(r.url()).host));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'New order' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create order' })).toBeVisible();
    await expect(page.locator('.foot')).toContainText('chain 5042');
    await expect(page.locator('.foot')).toContainText('0x8E2F8AFC29e9dc127103CD6AD5BCfBe661141ccb');
    expect(errors).toEqual([]);
    for (const h of hosts) expect(ALLOWED_HOSTS).toContain(h);
  });

  test('the static hero in index.html is what renderHome paints (first paint must not lie)', async ({ page, request }) => {
    const raw = await (await request.get('/')).text();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'New order' })).toBeVisible(); // renderHome has replaced the shell content
    const rendered = await page.locator('main .hero h1').innerText();
    const staticHtml = /<h1 id="claim">([\s\S]*?)<\/h1>/.exec(raw)?.[1] ?? '';
    const staticText = await page.evaluate((html) => { const d = document.createElement('div'); d.innerHTML = html; return d.innerText; }, staticHtml);
    expect(staticText).toBe(rendered);
    expect(await page.locator('main [data-static]').count()).toBe(0);
  });

  test('meta: title, description, favicon, Open Graph and Twitter card', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Legwork/);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /exact gas|metered gas/);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /favicon\.svg/);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /^https:\/\/legwork\.edycu\.dev\/og-image\.png(\?v=\d+)?$/);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Legwork/);
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
    const og = await page.request.get('/og-image.png');
    expect(og.status()).toBe(200);
    expect(og.headers()['content-type']).toMatch(/image\/png/);
  });

  test('an unknown order id shows a clear notice and a way back', async ({ page }) => {
    await page.goto('/#/o/999999');
    await expect(page.getByRole('alert')).toContainText('does not exist');
    await expect(page.getByRole('link', { name: '← all orders' })).toBeVisible();
  });

  test('the quote recomputes from the form and refuses a malformed amount', async ({ page }) => {
    await page.goto('/');
    const quote = page.locator('.quote');
    await expect(quote).toContainText('deposit for 3 runs');
    await page.getByLabel('Runs to deposit for').fill('5');
    await expect(quote).toContainText('deposit for 5 runs');
    await page.getByLabel('Amount per run (USDC)').fill('abc');
    await expect(quote).toContainText('not a USDC amount');
    await expect(page.getByRole('button', { name: 'Create order' })).toBeDisabled();
  });
});
