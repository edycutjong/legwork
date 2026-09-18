/** Write side: the injected provider (`window.ethereum`) and nothing else. Touched only when the user signs. */
import { createWalletClient, custom, type Hex, type WalletClient } from 'viem';
import { legworkAbi } from '../lib/abi';
import { arc, CHAIN_ID_HEX, EXPLORER, MIN_BASEFEE, RPC_URL } from '../lib/chain';
import { CONTRACT, gasPrice } from './rpc';

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (e: string, f: (...a: any[]) => void) => void };

export function injected(): Eip1193 | undefined {
  return (window as any).ethereum as Eip1193 | undefined;
}

export type Wallet = { address: `0x${string}`; client: WalletClient };

let current: Wallet | undefined;
const listeners = new Set<(w: Wallet | undefined) => void>();

export function onWallet(f: (w: Wallet | undefined) => void) {
  listeners.add(f);
  f(current);
  return () => listeners.delete(f);
}

function set(w: Wallet | undefined) {
  current = w;
  for (const f of listeners) f(w);
}

export const wallet = () => current;

export async function connect(): Promise<Wallet> {
  const p = injected();
  if (!p) throw new Error('No wallet found. Install an EVM wallet (any injected provider works) and reload.');
  const accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts[0] as `0x${string}`;
  await ensureArc(p);
  const client = createWalletClient({ account: address, chain: arc, transport: custom(p as any) });
  const w = { address, client };
  set(w);
  p.on?.('accountsChanged', (a: string[]) => (a[0] ? set({ address: a[0] as `0x${string}`, client: createWalletClient({ account: a[0] as `0x${string}`, chain: arc, transport: custom(p as any) }) }) : set(undefined)));
  p.on?.('chainChanged', () => window.location.reload());
  return w;
}

/** Switch the wallet to Arc (5042), offering `wallet_addEthereumChain` if it is missing. */
export async function ensureArc(p = injected()) {
  if (!p) throw new Error('no injected provider');
  const id = (await p.request({ method: 'eth_chainId' })) as string;
  if (id.toLowerCase() === CHAIN_ID_HEX) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (e: any) {
    if (e?.code === 4902 || /unrecognized|not added|4902/i.test(String(e?.message))) {
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [{ chainId: CHAIN_ID_HEX, chainName: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: [RPC_URL], blockExplorerUrls: [EXPLORER] }],
      });
    } else {
      throw e;
    }
  }
}

/** Every transaction the page sends: priority 0, maxFee = max(eth_gasPrice, 20 Gwei) — the honest executor's price. */
async function fees() {
  const gp = await gasPrice();
  return { maxFeePerGas: gp > MIN_BASEFEE ? gp : MIN_BASEFEE, maxPriorityFeePerGas: 0n };
}

export async function maxFeeThePageWillSend() {
  return (await fees()).maxFeePerGas;
}

function need(): Wallet {
  if (!current) throw new Error('connect a wallet first');
  return current;
}

export async function sendCreate(payee: `0x${string}`, amount: bigint, interval: number, tip: bigint, maxGasPrice: bigint, deposit: bigint): Promise<Hex> {
  const w = need();
  return w.client.writeContract({ account: w.address, chain: arc, address: CONTRACT, abi: legworkAbi, functionName: 'create', args: [payee, amount, interval, tip, Number(maxGasPrice)], value: deposit, ...(await fees()) });
}

export async function sendExecute(id: bigint): Promise<Hex> {
  const w = need();
  return w.client.writeContract({ account: w.address, chain: arc, address: CONTRACT, abi: legworkAbi, functionName: 'execute', args: [id], ...(await fees()) });
}

export async function sendTopUp(id: bigint, value: bigint): Promise<Hex> {
  const w = need();
  return w.client.writeContract({ account: w.address, chain: arc, address: CONTRACT, abi: legworkAbi, functionName: 'topUp', args: [id], value, ...(await fees()) });
}

export async function sendResume(id: bigint): Promise<Hex> {
  const w = need();
  return w.client.writeContract({ account: w.address, chain: arc, address: CONTRACT, abi: legworkAbi, functionName: 'resume', args: [id], ...(await fees()) });
}

export async function sendCancel(id: bigint): Promise<Hex> {
  const w = need();
  return w.client.writeContract({ account: w.address, chain: arc, address: CONTRACT, abi: legworkAbi, functionName: 'cancel', args: [id], ...(await fees()) });
}
