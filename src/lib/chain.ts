import { defineChain } from 'viem';

/** Arc mainnet. Native gas token is USDC with 18-decimal `msg.value`; the ERC-20 view is 6 decimals. */
export const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc explorer', url: 'https://explorer.arc.io' } },
  contracts: {
    // "common Ethereum contract" deployed on Arc; the open-orders list reads through it, sequential eth_call is the fallback
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
});

export const RPC_URL = 'https://rpc.mainnet.arc.io';
export const EXPLORER = 'https://explorer.arc.io';
export const CHAIN_ID_HEX = '0x13b2';

/** EIP-7708 system emitter: every native USDC movement is a `Transfer` log from this address (18 decimals). */
export const SYSTEM_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE' as const;

/** Arc's documented minimum base fee; transactions with maxFeePerGas below it are silently dropped. */
export const MIN_BASEFEE = 20_000_000_000n;

export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`;
