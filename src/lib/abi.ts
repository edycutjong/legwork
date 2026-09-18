import { parseAbi } from 'viem';

export const legworkAbi = parseAbi([
  'struct Order { address payer; uint48 nextDue; uint32 interval; bool paused; address payee; uint48 createdBlock; uint48 maxGasPrice; uint96 amount; uint96 tip; uint128 deposit; }',
  'function OVERHEAD() view returns (uint256)',
  'function PAYEE_GAS() view returns (uint256)',
  'function REFUND_CEIL_GAS() view returns (uint256)',
  'function EXECUTOR_GAS() view returns (uint256)',
  'function nextId() view returns (uint256)',
  'function orders(uint256 id) view returns (address payer, uint48 nextDue, uint32 interval, bool paused, address payee, uint48 createdBlock, uint48 maxGasPrice, uint96 amount, uint96 tip, uint128 deposit)',
  'function needed(uint256 id) view returns (uint256)',
  'function priceCap(uint256 id) view returns (uint256)',
  'function status(uint256 id) view returns (uint8)',
  'function create(address payee, uint96 amount, uint32 interval, uint96 tip, uint48 maxGasPrice) payable returns (uint256 id)',
  'function execute(uint256 id)',
  'function topUp(uint256 id) payable',
  'function resume(uint256 id)',
  'function cancel(uint256 id)',
  'event Created(uint256 indexed id, address indexed payer, address indexed payee, uint96 amount, uint32 interval, uint96 tip, uint48 maxGasPrice, uint128 deposit)',
  'event Executed(uint256 indexed id, address indexed executor, uint256 gasMetered, uint256 price, uint256 refund, uint256 tip, uint48 nextDue, bool paid)',
  'event Paused(uint256 indexed id, address indexed executor, uint8 reason)',
  'event Resumed(uint256 indexed id)',
  'event ToppedUp(uint256 indexed id, uint128 amount, uint128 deposit)',
  'event Cancelled(uint256 indexed id, uint128 returned)',
  'error NoOrder()',
  'error NotPayer()',
  'error IsPaused()',
  'error NotDue(uint48 nextDue)',
  'error Underfunded(uint256 have, uint256 need)',
  'error BadParams()',
  'error Reentrant()',
  'error PayoutFailed()',
]);

/** ERC-20 / EIP-7708 Transfer, as emitted by Arc's system emitter for native value movements. */
export const transferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
