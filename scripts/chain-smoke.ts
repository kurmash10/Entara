import assert from "node:assert/strict";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { readFileSync, writeFileSync } from "node:fs";
import { demoBond } from "../src/lib/engine";
import {
  createBond,
  fetchBond,
  announce,
  takeSnapshot,
  settle,
  fundTreasury,
  cancelAction,
  send,
} from "../src/lib/solana";

async function main() {
  const conn = new Connection(
    process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899",
    "confirmed",
  );
  if (
    !/localhost|127\.0\.0\.1/.test(conn.rpcEndpoint) &&
    (await conn.getGenesisHash()) !==
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  )
    throw new Error("Tests run only on a local validator or Devnet.");
  const key = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        readFileSync(
          process.env.SOLANA_KEYPAIR || ".local/deployer.json",
          "utf8",
        ),
      ),
    ),
  );
  const programKey = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(".local/program-keypair.json", "utf8")),
    ),
  );
  const program = programKey.publicKey;
  const wallet = {
    publicKey: key.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(key);
      return tx;
    },
  };
  if ((await conn.getBalance(key.publicKey)) < 0.15 * LAMPORTS_PER_SOL) {
    const sig = await conn.requestAirdrop(key.publicKey, 2 * LAMPORTS_PER_SOL);
    const latest = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...latest });
  }
  const now = (await conn.getBlockTime(await conn.getSlot()))!;
  const holders = [21, 22, 23].map((n) =>
    Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58(),
  );
  const draft = demoBond(now, holders, key.publicKey.toBase58());
  draft.periodSeconds = 1;
  draft.maturity = now + 180;
  draft.treasury = "0";
  const address = new PublicKey(
    await createBond(conn, program, wallet, draft, () => {}, console.log),
  );
  const signatures: string[] = [];
  const currentTime = async () =>
    (await conn.getBlockTime(await conn.getSlot()))!;
  async function waitUntil(timestamp: number) {
    while ((await currentTime()) < timestamp)
      await new Promise((r) => setTimeout(r, 1000));
  }
  let state = await fetchBond(conn, program, address);
  assert.equal(state.bond.outstanding, "40");
  const scheduledTime = (await currentTime()) + 20;
  signatures.push(
    await announce(
      conn,
      program,
      wallet,
      address,
      state.nextAction,
      "coupon",
      scheduledTime,
      "0",
    ),
  );
  await assert.rejects(
    () => takeSnapshot(conn, program, wallet, address, 0),
    /0x1778|Record date has not arrived/,
  );
  await waitUntil(scheduledTime);
  signatures.push(await takeSnapshot(conn, program, wallet, address, 0));
  state = await fetchBond(conn, program, address);
  assert.equal(state.bond.actions[0].total, "2000000000");
  await assert.rejects(
    () => settle(conn, program, wallet, address, state, 0, 0),
    /0x177b|Insufficient mock USD/,
  );
  assert.equal(
    (await fetchBond(conn, program, address)).bond.holders[0].paid,
    "0",
    "Unfunded settlement must be atomic",
  );
  signatures.push(
    await fundTreasury(
      conn,
      wallet,
      address,
      state.paymentMint,
      50_000_000_000n,
    ),
  );
  const stranger = Keypair.generate();
  const unauthorized = {
    publicKey: stranger.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(stranger);
      return tx;
    },
  };
  // Fund transaction fees so failure proves authorization checks, not lack of SOL.
  await send(conn, wallet, [
    SystemProgram.transfer({
      fromPubkey: key.publicKey,
      toPubkey: stranger.publicKey,
      lamports: 10_000_000,
    }),
  ]);
  await assert.rejects(
    () => settle(conn, program, unauthorized, address, state, 0, 0),
    /0x7d1|has one constraint/,
  );
  for (let i = 0; i < 3; i++)
    signatures.push(await settle(conn, program, wallet, address, state, 0, i));
  await assert.rejects(() =>
    settle(conn, program, wallet, address, state, 0, 0),
  );
  state = await fetchBond(conn, program, address);
  assert.equal(state.bond.holders[0].paid, "500000000");
  const earlyTime = (await currentTime()) + 20;
  signatures.push(
    await announce(
      conn,
      program,
      wallet,
      address,
      state.nextAction,
      "early",
      earlyTime,
      "10",
    ),
  );
  await waitUntil(earlyTime);
  signatures.push(await takeSnapshot(conn, program, wallet, address, 1));
  state = await fetchBond(conn, program, address);
  assert.deepEqual(
    state.bond.actions[1].entitlements.map((e) => e.quantity),
    ["3", "5", "2"],
  );
  signatures.push(await settle(conn, program, wallet, address, state, 1, 0));
  await assert.rejects(() => cancelAction(conn, program, wallet, address, 1));
  state = await fetchBond(conn, program, address);
  assert.equal(state.bond.actions[1].status, "processing");
  for (let i = 1; i < 3; i++)
    signatures.push(await settle(conn, program, wallet, address, state, 1, i));
  state = await fetchBond(conn, program, address);
  assert.equal(state.bond.outstanding, "30");
  signatures.push(
    await announce(
      conn,
      program,
      wallet,
      address,
      state.nextAction,
      "redemption",
      Math.max((await currentTime()) + 1, state.bond.maturity),
      "0",
    ),
  );
  await waitUntil(Math.max((await currentTime()) + 1, state.bond.maturity));
  signatures.push(await takeSnapshot(conn, program, wallet, address, 2));
  state = await fetchBond(conn, program, address);
  for (let i = 0; i < 3; i++)
    signatures.push(await settle(conn, program, wallet, address, state, 2, i));
  state = await fetchBond(conn, program, address);
  assert.equal(state.bond.outstanding, "0");
  assert.equal(state.bond.treasury, "8000000000");
  for (let i = 0; i < holders.length; i++) {
    const bonds = await getAccount(
      conn,
      getAssociatedTokenAddressSync(
        state.bondMint,
        new PublicKey(holders[i]),
        false,
        TOKEN_2022_PROGRAM_ID,
      ),
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    assert.equal(bonds.amount, 0n);
    assert.equal(bonds.isFrozen, true);
    const payment = await getAccount(
      conn,
      getAssociatedTokenAddressSync(
        state.paymentMint,
        new PublicKey(holders[i]),
      ),
    );
    assert.equal(payment.amount, BigInt(state.bond.holders[i].paid));
  }
  const report = {
    rpc: conn.rpcEndpoint,
    program: program.toBase58(),
    bond: address.toBase58(),
    signatures,
    completedAt: new Date().toISOString(),
    state: state.bond,
  };
  writeFileSync(".local/chain-smoke.json", JSON.stringify(report, null, 2));
  console.log(
    `All on-chain checks passed. Bond: ${address}. Report: .local/chain-smoke.json`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
