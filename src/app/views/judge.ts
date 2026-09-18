/** `#/judge` — the reviewer page: one claim, a 60-second path, the receipts, the reproduce line, honest limitations, links. Mirrors JUDGE.md. */
import { explorerAddress, explorerTx } from '../../lib/chain';
import { CONTRACT, DEPLOY } from '../rpc';
import { h } from '../ui';

export const CLAIM = 'Standing USDC orders anyone can run — and be repaid the exact gas, in the same dollar, in the same transaction.';

const HERO_TX = '0x2f6a352d11823a37ad085151067856131833ef978445fbed5941e7d17b5b0c95';
const LIVE_TX = '0x0a598c846c6a6fd0e9f07fcee1f6d643d39bb2c2483ae0e3465ee3c6775cd04d';
const PAUSED_TX = '0xd07f9fb9f06deeab35a0e795ab0440f8150fb60e4f816993d57bee6a1470dc64';
const NOTDUE_TX = '0x4fc9a3af02079e9bad40001108936c268a8269c88c231e6633517db854f556a6';
const REPO = 'https://github.com/edycutjong/legwork-arc';

export function renderJudge(root: HTMLElement) {
  const live = (DEPLOY.orders as any)?.live?.id ?? 1;
  const link = (href: string, text: string) => h('a', { href, target: href.startsWith('#') ? undefined : '_blank', rel: 'noopener' }, text);
  const step = (...c: (Node | string)[]) => h('li', {}, ...c);
  root.replaceChildren(
    h('div', { class: 'card judge' },
      h('h2', {}, 'For reviewers'),
      h('p', { class: 'lede', style: 'font-size:18px;color:var(--ink)' }, CLAIM),
      h('p', { class: 'muted' }, 'Arc mainnet, chain 5042. No backend, no oracle, no keeper network, nothing mocked: every number on this site is read from the chain in your browser.'),

      h('h3', {}, 'The 60-second path'),
      h('ol', { class: 'steps' },
        step('Open the seeded order ', link(`#/o/${live}`, `#/o/${live}`), ' — it is Due; the card quotes the deposit, the reserve and the refund cap from the latest base fee.'),
        step('Press ', h('strong', {}, 'Execute — anyone can'), ' with any wallet holding a few cents of USDC on Arc (the page offers to add the chain). One transaction.'),
        step('Read the receipt: the payee’s amount, your refund (', h('code', {}, 'gasMetered × price'), '), the tip, the real fee from the receipt, and the drift between them — printed side by side, decoded in the browser.'),
        step('No wallet? Open the committed hero run ', link(`#/o/5/tx/${HERO_TX}`, 'order #5 · 0x2f6a…0c95'), ' — the same receipt, read from the chain (the order has since been cancelled; the receipt has not).'),
      ),

      h('h3', {}, 'Receipts'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'contract'), h('dd', {}, link(explorerAddress(CONTRACT), CONTRACT), ' · OVERHEAD 32,503 (read from the chain in the footer) · runtime bytecode == ', h('code', {}, 'forge build'), ' (', h('code', {}, 'scripts/preflight.py --bytecode'), ')'),
        h('dt', {}, 'hero run'), h('dd', {}, link(explorerTx(HERO_TX), '0x2f6a352d…0c95'), ' — gasUsed 58,415 = gasMetered 58,415 · drift 0 · refund ÷ fee 1.000000'),
        h('dt', {}, 'bench'), h('dd', {}, '30 consecutive real executes, 1-second periods: drift 0 on 30/30, refund ÷ fee 1.000000 on 30/30, gasUsed p50 = p95 = 58,415; 5 rows by the payee collecting its own payment'),
        h('dt', {}, 'branches'), h('dd', {}, 'refusing payee → ', link(explorerTx(PAUSED_TX), 'Paused, executor still repaid'), ' · not due → ', link(explorerTx(NOTDUE_TX), 'revert, 24,323 gas'), ' · first live run ', link(explorerTx(LIVE_TX), '0x0a598c84…d04d')),
        h('dt', {}, 'spend'), h('dd', {}, '0.1944 USDC of gas over 107 mainnet transactions; 107 receipts committed under proof/receipts/'),
        h('dt', {}, 'tests'), h('dd', {}, '42 Foundry (34 unit · 2 fuzz × 512 · 6 invariants × 64 × 32) · 36 vitest incl. 4 fast-check properties × 5,000 = 20,000 generated cases on the refund arithmetic and the log reducer · Playwright end-to-end incl. live mainnet reads'),
      ),

      h('h3', {}, 'Reproduce'),
      h('pre', { class: 'mono' }, 'git clone https://github.com/edycutjong/legwork-arc && cd legwork-arc && git submodule update --init\nforge test && npm install && npm test && npm run recheck && python3 scripts/preflight.py --bytecode'),
      h('p', { class: 'muted' }, h('code', {}, 'npm run recheck'), ' recomputes all 75 committed execute receipts from raw chain data — six equalities per row, exit code is the verdict. No key is needed for any of it.'),

      h('h3', {}, 'What we do not claim'),
      h('ul', { class: 'limits' },
        h('li', {}, 'Executors are two wallets of ours in practice (the page button, the bench script, the demo payee). Nobody else has run an order yet.'),
        h('li', {}, 'All bench rows sit at Arc’s 20 Gwei base fee; the 2 × basefee cap is exercised by tests and one capped receipt, not by the bench.'),
        h('li', {}, 'The drift bound (≤ 50 gas, measured 0) holds for plain-account executors; a contract executor’s own code runs outside the metered window and pays for itself.'),
        h('li', {}, 'Explorer source verification was not attempted (its API sits behind a challenge page); the on-chain runtime bytecode is checked byte-for-byte against the build instead.'),
      ),

      h('h3', {}, 'Links'),
      h('div', { class: 'links' },
        link(REPO, 'repository'), link(`${REPO}/blob/main/DEMO.md`, 'DEMO.md — every edge case, one tx each'), link(`${REPO}/blob/main/ARCHITECTURE.md`, 'ARCHITECTURE.md'), link('#/', 'the app'),
      ),
    ),
  );
}
