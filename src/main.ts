import './styles.css';
import { explorerAddress } from './lib/chain';
import { CONTRACT, DEPLOY, chainOk, overheadOnChain } from './app/rpc';
import { renderHome } from './app/views/home';
import { renderOrder } from './app/views/order';
import { h, notice, short } from './app/ui';
import { connect, injected, onWallet } from './app/wallet';

const app = document.getElementById('app')!;
const walletSlot = h('span');
const overheadSlot = h('span', {}, 'OVERHEAD … · REFUND_CEIL_GAS 120,000 · payee stipend 30,000');
const main = h('main');
const rpcNotice = h('div');

app.append(
  h('div', { class: 'sheet' },
    h('header', { class: 'masthead' },
      h('a', { class: 'brand', href: '#/' }, h('img', { src: './favicon.svg', alt: '' }), h('strong', {}, 'Legwork'), h('span', { class: 'muted' }, 'standing USDC orders on Arc')),
      h('nav', {}, h('a', { href: '#/' }, 'orders'), h('a', { href: `#/o/${(DEPLOY.orders as any)?.live?.id ?? 1}` }, 'try the live order'), h('a', { href: explorerAddress(CONTRACT), target: '_blank', rel: 'noopener' }, `contract ${short(CONTRACT)}`), walletSlot)),
    rpcNotice,
    main,
    h('footer', { class: 'foot' },
      h('span', {}, `Arc mainnet · chain 5042 · contract `, h('a', { href: explorerAddress(CONTRACT), target: '_blank', rel: 'noopener' }, CONTRACT)),
      overheadSlot,
      h('span', {}, 'No backend: every number on this page comes from eth_call, eth_getLogs, the latest block base fee, eth_gasPrice and the transaction receipt.'),
    ),
  ),
);

onWallet((w) => {
  walletSlot.replaceChildren(
    w
      ? h('span', { class: 'wallet-pill' }, h('span', { class: 'mono' }, short(w.address)))
      : h('span', { class: 'wallet-pill' }, injected() ? h('button', { type: 'button', onClick: () => connect().catch((e) => alert(e.message)) }, 'connect wallet') : h('span', { class: 'muted' }, 'reading only — no wallet found')),
  );
});

async function route() {
  const hash = window.location.hash || '#/';
  const m = /^#\/o\/(\d+)(?:\/tx\/(0x[0-9a-fA-F]{64}))?$/.exec(hash);
  main.replaceChildren();
  if (m) await renderOrder(main, BigInt(m[1]), { tx: m[2] as `0x${string}` | undefined });
  else await renderHome(main);
}

(async () => {
  overheadOnChain().then((o) => (overheadSlot.textContent = `OVERHEAD() ${o} gas (read from the contract) · REFUND_CEIL_GAS 120,000 · payee stipend 30,000`));
  if (!(await chainOk())) {
    rpcNotice.replaceChildren(notice('error', 'The Arc RPC (https://rpc.mainnet.arc.io) is unreachable or is not chain 5042. The page reads everything from it and has no fallback.'));
  }
  await route();
  window.addEventListener('hashchange', route);
})();
