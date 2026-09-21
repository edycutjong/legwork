import './styles.css';
import { explorerAddress } from './lib/chain';
import { CONTRACT, DEPLOY, chainOk, overheadRead } from './app/rpc';
import { renderHome } from './app/views/home';
import { renderOrder } from './app/views/order';
import { renderJudge } from './app/views/judge';
import { h, notice, short } from './app/ui';
import { connect, disconnect, injected, onWallet } from './app/wallet';

// The shell (masthead, nav, <main>, footer) is static markup in index.html so it paints before this bundle has loaded;
// this module adopts it. The deploy-derived href/text are re-set from deploy/arc-mainnet.json so the JSON stays the source
// of truth and the HTML is only what the first paint shows.
const app = document.getElementById('app')!;
const main = document.getElementById('main')!;
const rpcNotice = document.getElementById('rpc-notice')!;
const overheadSlot = document.getElementById('overhead')!;
const walletSlot = h('span');
const LIVE_ID = (DEPLOY.orders as any)?.live?.id ?? 1;

const navLinks = [...app.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Primary"] a')];
app.querySelector('nav[aria-label="Primary"]')!.append(walletSlot);
app.querySelector<HTMLAnchorElement>('a[data-nav="live"]')!.href = `#/o/${LIVE_ID}`;
for (const a of app.querySelectorAll<HTMLAnchorElement>('a[data-nav="contract"], a[data-foot="contract"]')) a.href = explorerAddress(CONTRACT);
app.querySelector('a[data-nav="contract"]')!.textContent = `contract ${short(CONTRACT)}`;
app.querySelector('a[data-foot="contract"]')!.textContent = CONTRACT;
const release = document.getElementById('release') as HTMLAnchorElement;
release.href = __APP_VERSION__.endsWith('-dev') ? 'https://github.com/edycutjong/legwork/releases' : `https://github.com/edycutjong/legwork/releases/tag/${__APP_VERSION__}`;
release.textContent = __APP_VERSION__;
app.querySelector('a.skip')!.addEventListener('click', (e) => { e.preventDefault(); main.focus(); main.scrollIntoView(); });

onWallet((w) => {
  walletSlot.replaceChildren(
    w
      ? h('span', { class: 'wallet-pill on', title: w.address }, h('span', { class: 'mono' }, short(w.address)), h('button', { type: 'button', class: 'disconnect', 'aria-label': 'Disconnect wallet', title: 'Disconnect wallet', onClick: () => disconnect() }, 'disconnect'))
      : h('span', { class: 'wallet-pill' }, injected() ? h('button', { type: 'button', onClick: () => connect().catch((e) => alert(e.message)) }, 'connect wallet') : h('span', { class: 'muted' }, 'reading only — no wallet found')),
  );
});

// Each route renders into its own container: a navigation that lands while the previous view is still awaiting the RPC
// replaces the container, and the stale render keeps writing into a detached node instead of over the new view.
async function route() {
  const hash = window.location.hash || '#/';
  const m = /^#\/o\/(\d+)(?:\/tx\/(0x[0-9a-fA-F]{64}))?$/.exec(hash);
  for (const a of navLinks) {
    const href = a.getAttribute('href') ?? '';
    const current = href === hash || (href === '#/' && hash === '#/') ;
    if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.title = m ? `Order #${m[1]}${m[2] ? ' · receipt' : ''} · Legwork` : hash === '#/judge' ? 'For reviewers · Legwork' : 'Legwork — standing USDC orders on Arc';
  const view = h('div');
  main.replaceChildren(view);
  if (m) await renderOrder(view, BigInt(m[1]), { tx: m[2] as `0x${string}` | undefined });
  else if (hash === '#/judge') renderJudge(view);
  else await renderHome(view);
}

window.addEventListener('hashchange', () => { window.scrollTo({ top: 0 }); route(); }); // registered before the first render, so an early navigation is never lost
// The first view renders before any RPC round-trip (no empty frame, no shift when it fills); the chain check runs beside it.
route();
overheadRead().then(({ value, fromChain }) => (overheadSlot.textContent = fromChain ? `OVERHEAD() ${value} gas (read from the contract) · REFUND_CEIL_GAS 120,000 · payee stipend 30,000` : `OVERHEAD ${value} gas (deploy record — the contract read was rate-limited) · REFUND_CEIL_GAS 120,000 · payee stipend 30,000`));
chainOk().then(({ state, detail }) => {
  if (state === 'down') rpcNotice.replaceChildren(notice('error', 'This browser could not read Arc mainnet from any of its public RPC endpoints (rpc.mainnet.arc.io, then the dRPC, QuickNode and Blockdaemon mirrors): ', h('span', { class: 'mono' }, detail), '. The page reads everything from the chain. "Failed to fetch" means the request never left this browser: try a private window; if that works, an extension (an ad blocker is the usual one) is blocking *.arc.io — allow this site in it and reload.'));
  else if (state === 'rate-limited') rpcNotice.replaceChildren(notice('info', 'The public Arc RPC endpoints rate-limited the page\u2019s first reads (they answer HTTP 429 in bursts). Nothing is wrong on-chain \u2014 reload in a few seconds.'));
});

// Offline fallback only (public/sw.js): navigations still go to the network every time; the worker answers with
// public/offline.html only when that fetch throws, so an online visitor never sees a cached shell or stale chain state.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
