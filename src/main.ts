import './styles.css';
import { explorerAddress } from './lib/chain';
import { CONTRACT, DEPLOY, chainOk, overheadOnChain } from './app/rpc';
import { renderHome } from './app/views/home';
import { renderOrder } from './app/views/order';
import { renderJudge } from './app/views/judge';
import { h, notice, short } from './app/ui';
import { connect, injected, onWallet } from './app/wallet';

const app = document.getElementById('app')!;
const walletSlot = h('span');
const overheadSlot = h('span', { class: 'mono' }, 'OVERHEAD … · REFUND_CEIL_GAS 120,000 · payee stipend 30,000');
const main = h('main', { id: 'main', tabindex: '-1' });
const rpcNotice = h('div');
const LIVE_ID = (DEPLOY.orders as any)?.live?.id ?? 1;

const navLinks = [
  h('a', { href: '#/' }, 'orders'),
  h('a', { href: `#/o/${LIVE_ID}` }, 'try the live order'),
  h('a', { href: explorerAddress(CONTRACT), target: '_blank', rel: 'noopener' }, `contract ${short(CONTRACT)}`),
  h('a', { href: '#/judge' }, 'for reviewers'),
];

app.append(
  h('a', { class: 'skip', href: '#/', onClick: (e: Event) => { e.preventDefault(); main.focus(); main.scrollIntoView(); } }, 'Skip to content'),
  h('div', { class: 'sheet' },
    h('header', { class: 'masthead' },
      h('a', { class: 'brand', href: '#/' }, h('img', { src: './favicon.svg', alt: '', width: '30', height: '30' }), h('strong', {}, 'Legwork'), h('span', { class: 'muted' }, 'standing USDC orders on Arc')),
      h('nav', { 'aria-label': 'Primary' }, ...navLinks, walletSlot)),
    rpcNotice,
    main,
    h('footer', { class: 'foot' },
      h('span', {}, `Arc mainnet · chain 5042 · contract `, h('a', { href: explorerAddress(CONTRACT), target: '_blank', rel: 'noopener', class: 'mono' }, CONTRACT)),
      overheadSlot,
      h('span', {}, 'No backend: every number on this page comes from eth_call, eth_getLogs, the latest block base fee, eth_gasPrice and the transaction receipt.'),
    ),
  ),
);

onWallet((w) => {
  walletSlot.replaceChildren(
    w
      ? h('span', { class: 'wallet-pill on', title: w.address }, h('span', { class: 'mono' }, short(w.address)))
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
  const view = h('div');
  main.replaceChildren(view);
  if (m) await renderOrder(view, BigInt(m[1]), { tx: m[2] as `0x${string}` | undefined });
  else if (hash === '#/judge') renderJudge(view);
  else await renderHome(view);
}

window.addEventListener('hashchange', () => { window.scrollTo({ top: 0 }); route(); }); // registered before the first render, so an early navigation is never lost
// The first view renders before any RPC round-trip (no empty frame, no shift when it fills); the chain check runs beside it.
route();
overheadOnChain().then((o) => (overheadSlot.textContent = `OVERHEAD() ${o} gas (read from the contract) · REFUND_CEIL_GAS 120,000 · payee stipend 30,000`));
chainOk().then((ok) => {
  if (!ok) rpcNotice.replaceChildren(notice('error', 'The Arc RPC (https://rpc.mainnet.arc.io) is unreachable or is not chain 5042. The page reads everything from it and has no fallback.'));
});
