/**
 * The living diagram of one `execute()` — an inline SVG whose beats are CSS keyframes in styles.css (one master clock,
 * transform/opacity only). Its resting picture — no animation, or prefers-reduced-motion — is the resolved state: both
 * legs landed, the metered window closed, the equalities printed. Figures are order #5's real receipt.
 */
export const EXEC_DIAGRAM = `
<svg viewBox="0 0 1000 384" role="img" aria-labelledby="dg-title dg-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="dg-title">How one execute() runs</title>
  <desc id="dg-desc">Anyone calls execute. Inside one metered window the contract pays the payee 0.001 USDC out of the order's deposit, measures the gas the call consumed, and pays the executor 58,415 gas × 20 Gwei plus the tip from the same deposit. The receipt's gasUsed equals the event's gasMetered: drift 0.</desc>
  <defs>
    <linearGradient id="dg-cu" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#C05A24"/><stop offset="0.6" stop-color="#A4471A"/><stop offset="1" stop-color="#7A3410"/></linearGradient>
    <marker id="dg-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#5E574B"/></marker>
    <marker id="dg-arr-cu" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#A4471A"/></marker>
  </defs>
  <style>
    .t { font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; font-size: 12px; fill: #5E574B; }
    .t.ink { fill: #1C1A16; } .t.cu { fill: #A4471A; } .t.ok { fill: #1E6F48; } .t.b { font-weight: 600; } .t.s { font-size: 11px; }
    .ui { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  </style>

  <!-- the metered window: a bracket over the contract that opens at g0 = gasleft() and closes at the measurement point -->
  <g>
    <text class="t s dg-in b4" x="520" y="22" text-anchor="middle">the metered window · nothing variable runs after it closes</text>
    <line class="dg-bracket" x1="280" y1="56" x2="760" y2="56" stroke="#A4471A" stroke-width="2" stroke-dasharray="4 4"/>
    <line class="dg-in b2" x1="280" y1="48" x2="280" y2="64" stroke="#A4471A" stroke-width="2"/>
    <text class="t cu b dg-in b2" x="280" y="42">g0 = gasleft()</text>
    <line class="dg-in b4" x1="760" y1="48" x2="760" y2="64" stroke="#A4471A" stroke-width="2"/>
    <text class="t cu b dg-in b4" x="760" y="42" text-anchor="end">metered = g0 − gasleft() + OVERHEAD</text>
  </g>

  <!-- executor node -->
  <g>
    <circle class="dg-glow" cx="110" cy="200" r="46" fill="none" stroke="#A4471A" stroke-width="10" opacity="0.35"/>
    <circle class="dg-ring" cx="110" cy="200" r="36" fill="none" stroke="#A4471A" stroke-width="2.5"/>
    <circle cx="110" cy="200" r="36" fill="#FFFDF8" stroke="#A4471A" stroke-width="2"/>
    <text class="t cu b" x="110" y="204" text-anchor="middle">anyone</text>
    <text class="t s" x="110" y="252" text-anchor="middle">executor · a bot, the payee, you</text>
    <g class="dg-press">
      <rect x="55" y="266" width="110" height="30" rx="7" fill="url(#dg-cu)"/>
      <text class="ui" x="110" y="286" text-anchor="middle" font-size="12.5" font-weight="600" fill="#FFFDF8">execute(id)</text>
    </g>
  </g>

  <!-- the call -->
  <line x1="150" y1="200" x2="270" y2="200" stroke="#5E574B" stroke-width="1.5" marker-end="url(#dg-arr)"/>
  <text class="t s dg-in b1" x="210" y="190" text-anchor="middle">one transaction</text>

  <!-- the contract -->
  <rect x="280" y="72" width="480" height="236" rx="14" fill="#FFFDF8" stroke="#D8D0BE"/>
  <text class="t ink b" x="300" y="100">Legwork.sol</text>
  <text class="t" x="740" y="100" text-anchor="end">order #5 · 0.001 USDC / 60 s · tip 0.001</text>
  <line x1="300" y1="112" x2="740" y2="112" stroke="#D8D0BE" stroke-dasharray="1 5"/>
  <text class="t s" x="300" y="136">deposit — native USDC, the same asset the gas is paid in</text>
  <!-- the deposit bar: what stays, the payee slice, the refund + tip slice -->
  <rect x="300" y="148" width="250" height="22" rx="4" fill="#1C1A16"/>
  <rect class="dg-pay" x="552" y="148" width="60" height="22" rx="4" fill="#1C1A16" style="--dx:308px;--dy:40px"/>
  <rect class="dg-ref" x="614" y="148" width="126" height="22" rx="4" fill="url(#dg-cu)" style="--dx:-552px;--dy:158px"/>
  <text class="t s dg-in b3" x="300" y="196">nextDue += interval · deposit −= amount + tip — effects first</text>
  <text class="t s dg-in b3" x="300" y="216">payee.call{value: amount, gas: 30,000}</text>
  <text class="t s dg-in b3" x="300" y="236">a refusal pauses the order; the executor is still repaid</text>
  <text class="t s dg-in b4" x="300" y="262">price = min(tx.gasprice, 2 × block.basefee, order.maxGasPrice)</text>
  <text class="t cu b dg-in b5" x="300" y="290">refund = metered × price = 58,415 × 20 Gwei = 0.0011683 USDC</text>

  <!-- the payee leg -->
  <line x1="760" y1="152" x2="846" y2="152" stroke="#1E6F48" stroke-width="1.5" marker-end="url(#dg-arr)" class="dg-in b3"/>
  <circle cx="890" cy="152" r="36" fill="#FFFDF8" stroke="#1E6F48" stroke-width="2"/>
  <text class="t ok b" x="890" y="156" text-anchor="middle">payee</text>
  <text class="t ok b dg-in b3" x="890" y="232" text-anchor="middle">+0.001 USDC</text>
  <text class="t s" x="890" y="250" text-anchor="middle">0x352e…AA60</text>

  <!-- the refund leg -->
  <path d="M280 288 C 236 288 206 300 168 312" fill="none" stroke="#A4471A" stroke-width="1.5" marker-end="url(#dg-arr-cu)" class="dg-in b5"/>
  <text class="t cu b dg-in b5" x="110" y="352" text-anchor="middle">+0.0011683 gas · +0.001 tip</text>

  <!-- the event, last -->
  <text class="t s dg-in b6" x="520" y="340" text-anchor="middle">emit Executed(id, executor, gasMetered 58,415, price, refund, tip, nextDue, paid) · one EIP-7708 Transfer log per leg</text>
  <text class="t s dg-in b6" x="520" y="360" text-anchor="middle">Arc finalizes at inclusion: the first receipt is the final one</text>
</svg>`;
