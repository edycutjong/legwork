The receipt of one transaction against a throwaway metering contract (`0xcEaFD715562fD7c07363Ff7C86ca36EB37A32fb6`) the builder
deployed on Arc mainnet on 2026-09-17, before this project existed, to check that a contract can price its own execution:
its logged `tx.gasprice` (20,461,249,992 wei) equalled the receipt's `effectiveGasPrice`, and its metered gas was under the
receipt's `gasUsed` by 1,358 for that call shape. Fetched from the chain with `cast receipt`; used by `test/ts/receipt.test.ts`
as a foreign-contract fixture for the receipt decoder. It is not a Legwork receipt and `npm run recheck` ignores it.
