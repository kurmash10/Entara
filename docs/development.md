# Entara Development Guide

**Bond actions. Settled.** A workspace for tokenized bond entitlements and corporate actions.

An English-language corporate actions MVP for tokenized bonds on Solana. Create an issuance, allocate bonds, fix holder entitlements, pay a coupon, redeem part of the issuance early, and redeem the remainder at maturity.

This repository includes a Next.js dashboard, a Rust/Anchor program, a browser/CLI Solana client, a snapshot keeper, test scripts, and a clearly separated local simulation. It is a hackathon prototype using test assets, not a KASE integration or a production securities system.

## Verified Devnet deployment

The dashboard is deployed on Vercel: [Entara](https://entara.vercel.app). [Open the completed Devnet issuance](https://entara.vercel.app/?bond=3Pz2VNTrLGHHsTjJbaJypw5ejfqEGuJEbFpnYUzTfrpF).

To publish frontend changes from this linked workspace, run `npx vercel deploy --prod`. `vercel.json` supplies the public Devnet RPC and program address at build time. `.vercelignore` excludes wallet keys, environment files, local toolchains and contract build artifacts. The frontend deployment does not redeploy the Solana program or run the keeper.

Verified on October 6, 2026:

- [Executable program](https://explorer.solana.com/address/BQNmoaaGmwVE3DAgLRAuCXScXSvougAgLA7FoPUnCfMz?cluster=devnet): `BQNmoaaGmwVE3DAgLRAuCXScXSvougAgLA7FoPUnCfMz`.
- [Completed test issuance](https://explorer.solana.com/address/3Pz2VNTrLGHHsTjJbaJypw5ejfqEGuJEbFpnYUzTfrpF?cluster=devnet): all three actions passed with real mock-token transfers and bond burns.
- Outstanding supply: 0; total distributed: 42,000 mock USD; treasury remaining: 8,000 mock USD.
- [Public verification report](devnet-verification.json) includes transaction signatures and the final on-chain snapshot. It contains no private keys.

With the dashboard running and `.env.local` configured, [open the completed Devnet example](http://127.0.0.1:3000/?bond=3Pz2VNTrLGHHsTjJbaJypw5ejfqEGuJEbFpnYUzTfrpF). Connect your own issuer wallet to create a new issuance; the completed example is for inspection.

## Run the dashboard

Requires Node.js 22 or later.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000. **Local demo** works without a wallet, RPC connection or deployed program. It stores simulated state in this browser's local storage. No transaction IDs are fabricated. Switching to **Solana Devnet** uses a separate, real on-chain state.

The default issuance has 40 bonds with a $1,000 face value and a 10% annual coupon paid twice per year. Its three test investors hold 10, 20 and 10 bonds. The demo clock compresses one coupon period to 60 seconds and maturity to six minutes. This affects availability dates, not the coupon formula. Set other dates before issuing if a longer demonstration is needed.

## Demo walkthrough

1. Choose **Create your first bond** and accept or edit the terms and allocations.
2. Schedule a **Coupon**. In local mode, **Advance demo** moves the clock to record date. The snapshot is captured automatically while the page is open.
3. Review $500, $1,000 and $500 entitlements, then **Execute settlement**.
4. Schedule **Early redemption** for 10 bonds. The allocations are 3, 5 and 2 bonds, with corresponding principal payments. Settle them.
5. Schedule **At maturity**, reach record date, then settle the remaining 7, 15 and 8 bonds.
6. The outstanding supply is zero. The total distributed is $42,000 and the default $50,000 treasury has $8,000 left.
7. Open **Activity** or export the JSON report. Refreshing the page preserves state. **Reset demo** clears only the local simulation.

## On-chain design

The authoritative state lives in Solana program accounts:

- `Bond`: issuer, mint addresses, immutable terms, up to eight holders, outstanding principal units, paid totals and coupon counter.
- `CorporateAction`: action kind, record date, actual snapshot time, coupon index, fixed eligible quantities, quantities to redeem, amounts and per-holder settlement flags.
- Bond PDA: `['bond', issuer, bond_mint]`.
- Action PDA: `['action', bond, action_id_u64_le]`.

Bond tokens use Token-2022 `NonTransferable` and `PermanentDelegate`. The program PDA is mint, freeze and permanent-delegate authority. Wallets receive the tokens in their own associated token accounts, which are frozen after issuance. This also prevents direct holder burns from invalidating the registry. The program temporarily thaws an account, burns redeemed units, and freezes it again in the same settlement instruction.

Mock USD is a separate six-decimal SPL token, created by the issuer. The issuer can mint it into the bond's treasury; it has no monetary value. Production fiat/KZT settlement is not implemented.

Only the issuer can allocate, announce, settle or cancel. The first announcement seals the registry. One action can be active at a time, so quantities cannot change between announcement, record date and snapshot. Anyone can submit a due snapshot; it cannot be taken early or overwritten. This makes a delayed keeper safe within this deliberately non-transferable MVP. There is no historical lookup for arbitrary transferable tokens.

Settlement is atomic **per holder**: payment transfer, bond burn and state update either all succeed or all roll back. An action involving several holders uses several transactions. Completed holders are persisted on-chain and skipped on resume. Cancellation is allowed only before the first settlement. Explorer links come from confirmed network records; the action account retains the full result even if an RPC provider prunes old transaction history.

Coupon amounts use `floor(quantity × face_value_microUSD × rate_bps / (10000 × payments_per_year))`. Integer arithmetic avoids floating-point errors. Early redemption uses largest-remainder proportional allocation of whole bonds, with registry-order tie breaking. Its allocations sum exactly to the requested quantity. Coupon accrual, call premiums, taxes and calendars are outside scope; principal redemption and coupons are separate actions.

## Build and deploy to Devnet

Requires Rust and a Solana SBF toolchain. Anchor CLI is optional because the TypeScript client encodes and decodes the program's ABI directly.

```sh
npm run prepare:deployment
cargo build-sbf --arch v0 --tools-version v1.57 --manifest-path programs/corporate-actions/Cargo.toml
npm run deploy:devnet
```

`prepare:deployment` generates project-specific keys under `.local/`, synchronizes `declare_id!` and `Anchor.toml`, and writes the public program ID into `.env.local`. It preserves existing project keys. Run it before building. Never commit `.local/` or share its private key files. The source and `Cargo.lock` are versioned; build artifacts are ignored.

On the prepared Windows workspace, `powershell -ExecutionPolicy Bypass -File scripts/build-program.ps1` can use official extracted platform-tools in `.tools/platform-tools`. It performs the same SBF v0 compilation and stripping steps without changing the machine's global Rust setup.

The deployment script checks the Devnet genesis hash, requests free test SOL if needed, deploys with the project keypair, and verifies that the program account is executable. If the public faucet is rate limited, fund the printed address with **Devnet SOL only**, then rerun. It never requests mainnet SOL or reads another wallet's private key. A successful deployment is recorded in `.local/deployment.json`.

Restart Next.js after public environment changes. Choose **Solana Devnet**, connect Phantom or Solflare in a normal browser, and create a bond. Your connected issuer wallet needs its own Devnet SOL for rent and transaction fees. The app cannot use a browser wallet extension from an embedded browser that lacks that extension. The preset investor addresses are publicly reproducible test identities; replace them for your own test wallets.

Wallet confirmations create the mints and bond, allocate each holder, and fund the treasury. After the bond account has been created, an interrupted allocation can be resumed from the saved setup. An interruption before the bond account exists can leave unused test mints; a retry creates a new issuance. **Open bond** restores a previous issuance by account address. Holder display aliases are local/demo metadata; on-chain identities are wallet public keys.

## Automatic snapshots

Solana programs do not wake themselves on a timer. Run the keeper for unattended record dates:

```sh
# Set BOND_ADDRESS in .env.local, then:
npm run keeper
```

The keeper loads `.env.local`, uses `SOLANA_KEYPAIR` (default `.local/deployer.json`) only to pay fees, checks the chain clock every five seconds, and submits only due snapshots. It does not authorize settlement. Alternatively, use **Capture snapshot** in the dashboard. A missed record-date trigger can be retried safely because the sealed registry is unchanged.

## Verification

```sh
npm test
npm run typecheck
npm run build
cargo test --lib
npm run test:browser
```

The browser test expects a running local web server and a Playwright Chromium installation. Run `npx playwright install chromium`, or set `CHROME_PATH` to an existing Chrome/Edge executable. It exercises all three actions, checks exact balances, reloads state, exports a report, filters history, switches network modes and checks mobile overflow. Screenshots and reports go to ignored `test-results/`.

For actual program integration tests, start a local validator and deploy the compiled program:

```sh
solana-test-validator --ledger .local/validator-ledger --log
solana airdrop 10 --keypair .local/deployer.json --url http://127.0.0.1:8899
solana program deploy target/deploy/corporate_actions.so --program-id .local/program-keypair.json --keypair .local/deployer.json --url http://127.0.0.1:8899
npm run test:chain
```

The `--log` flag avoids a privileged log-file symlink on Windows. Long-running native Windows validators also need permission to create snapshot symlinks; the supplied environment lacks it. Use a suitable WSL/Linux validator or Developer Mode for sustained local validator work. The completed integration verification for this repository ran directly on Devnet.

The integration test defaults to localhost. Set `SOLANA_RPC_URL=https://api.devnet.solana.com` to test the deployed Devnet program instead. It checks real token transfers and burns, insufficient funding rollback, wrong-issuer rejection, early snapshot rejection, partial settlement, duplicate protection and frozen final accounts. Results are written to `.local/chain-smoke.json`. `node scripts/browser-devnet.cjs` additionally checks that the dashboard restores these actual Devnet records.

## Project map

| Path                                    | Purpose                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `src/app/page.tsx`                      | Dashboard, forms, wallet connection, local and Devnet modes              |
| `src/lib/engine.ts`                     | Integer-only local reference engine and entitlement previews             |
| `src/lib/solana.ts`                     | Instruction builders, account decoders, confirmed transaction submission |
| `programs/corporate-actions/src/lib.rs` | Authoritative Anchor program                                             |
| `scripts/keeper.ts`                     | Permissionless snapshot scheduler                                        |
| `scripts/chain-smoke.ts`                | Program integration test                                                 |
| `scripts/browser-smoke.cjs`             | End-to-end UI test                                                       |

## MVP boundaries

Eight holders per issuance; whole non-transferable bonds; one active action; English UI; one selected issuance per browser workspace; mock settlement; accelerated demo scheduling. No KASE API, banking integration, real-money settlement, KYC, secondary market, day-count conventions or security audit is included. Production deployment would require a separate design and review of those concerns.

