/**
 * Shared plumbing for the mainnet scripts. Keys never touch the repo: the signer is decrypted at runtime from a
 * Foundry keystore (`cast wallet decrypt-keystore`) named by LEGWORK_KEYSTORE / LEGWORK_KEYSTORE_PASSWORD_FILE and
 * is never printed. Every script refuses to run unless the RPC reports chain id 5042.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arc, RPC_URL } from '../../src/lib/chain';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RECEIPTS_DIR = resolve(ROOT, 'proof', 'receipts');
export const DEPLOY_FILE = resolve(ROOT, 'deploy', 'arc-mainnet.json');

export const publicClient = createPublicClient({ chain: arc, transport: http(RPC_URL) });

export async function assertArc() {
  const id = await publicClient.getChainId();
  if (id !== 5042) throw new Error(`refusing to run: chain id ${id} is not Arc mainnet (5042)`);
}

export function loadDeploy(): any {
  return JSON.parse(readFileSync(DEPLOY_FILE, 'utf8'));
}
export function saveDeploy(d: any) {
  writeFileSync(DEPLOY_FILE, JSON.stringify(d, null, 2) + '\n');
}

/** Decrypt the keystore in a child process; the key lives only in this process's memory. */
export function signer(which: 'deployer' | 'payee' = 'deployer') {
  const ks = process.env[which === 'payee' ? 'LEGWORK_PAYEE_KEYSTORE' : 'LEGWORK_KEYSTORE'];
  const pw = process.env.LEGWORK_KEYSTORE_PASSWORD_FILE;
  if (!ks || !pw) throw new Error('set LEGWORK_KEYSTORE (+ LEGWORK_PAYEE_KEYSTORE) and LEGWORK_KEYSTORE_PASSWORD_FILE — see .env.example');
  // password goes through the environment (CAST_UNSAFE_PASSWORD), never through argv
  const password = readFileSync(pw.replace(/^~/, process.env.HOME ?? ''), 'utf8').trim();
  const file = ks.replace(/^~/, process.env.HOME ?? '');
  const out = execFileSync('cast', ['wallet', 'decrypt-keystore', basename(file), '--keystore-dir', dirname(file)], {
    encoding: 'utf8', env: { ...process.env, CAST_UNSAFE_PASSWORD: password },
  });
  const key = out.trim().split(/\s+/).pop() as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('keystore decryption did not yield a key');
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: arc, transport: http(RPC_URL) });
  return { account, wallet };
}

/** Serialize a viem receipt the way `cast receipt --json` does (hex fields), so one format lives in proof/receipts. */
export function toJsonReceipt(r: TransactionReceipt) {
  const hex = (v: bigint | number) => '0x' + BigInt(v).toString(16);
  return {
    transactionHash: r.transactionHash,
    blockHash: r.blockHash,
    blockNumber: hex(r.blockNumber),
    transactionIndex: hex(r.transactionIndex),
    from: r.from,
    to: r.to,
    contractAddress: r.contractAddress ?? null,
    status: r.status === 'success' ? '0x1' : '0x0',
    gasUsed: hex(r.gasUsed),
    cumulativeGasUsed: hex(r.cumulativeGasUsed),
    effectiveGasPrice: hex(r.effectiveGasPrice),
    type: r.type,
    logs: r.logs.map((l) => ({
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: hex(l.blockNumber!),
      transactionHash: l.transactionHash,
      transactionIndex: hex(l.transactionIndex!),
      logIndex: hex(l.logIndex!),
      removed: false,
    })),
  };
}

export function saveReceipt(r: TransactionReceipt) {
  if (!existsSync(RECEIPTS_DIR)) mkdirSync(RECEIPTS_DIR, { recursive: true });
  const j = toJsonReceipt(r);
  writeFileSync(resolve(RECEIPTS_DIR, `${r.transactionHash}.json`), JSON.stringify(j, null, 2) + '\n');
  const extra = process.env.LEGWORK_RECEIPT_MIRROR; // optional second copy, outside the repo
  if (extra) {
    if (!existsSync(extra)) mkdirSync(extra, { recursive: true });
    writeFileSync(resolve(extra, `${r.transactionHash}.json`), JSON.stringify(j, null, 2) + '\n');
  }
  return j;
}

/** Fee fields for every transaction the scripts send: priority 0, maxFee = max(eth_gasPrice, 20 Gwei) unless overridden. */
export async function fees(opts?: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }) {
  const gp = await publicClient.getGasPrice();
  const floor = 20_000_000_000n;
  return {
    maxFeePerGas: opts?.maxFeePerGas ?? (gp > floor ? gp : floor),
    maxPriorityFeePerGas: opts?.maxPriorityFeePerGas ?? 0n,
  };
}

export const usdc = (wei: bigint) => (Number(wei) / 1e18).toFixed(6);

export async function balanceGuard(address: `0x${string}`, minWei = 100_000_000_000_000_000n) {
  const b = await publicClient.getBalance({ address });
  if (b < minWei) throw new Error(`stop: ${address} holds ${usdc(b)} USDC, below the ${usdc(minWei)} threshold`);
  return b;
}
