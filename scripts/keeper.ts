import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { fetchBond, takeSnapshot } from "../src/lib/solana";

async function main() {
  const programId = process.env.NEXT_PUBLIC_PROGRAM_ID;
  const bondAddress = process.env.BOND_ADDRESS;
  if (!programId || !bondAddress)
    throw new Error("Set NEXT_PUBLIC_PROGRAM_ID and BOND_ADDRESS.");
  const conn = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed",
  );
  const genesis = await conn.getGenesisHash();
  if (
    genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" &&
    !/localhost|127\.0\.0\.1/.test(conn.rpcEndpoint)
  )
    throw new Error("Keeper is restricted to Devnet or a local validator.");
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
  const wallet = {
    publicKey: key.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(key);
      return tx;
    },
  };
  const program = new PublicKey(programId),
    bond = new PublicKey(bondAddress);
  console.log(
    `Watching ${bond}. Only due snapshots are submitted; settlement remains issuer-authorized.`,
  );
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
  });
  process.on("SIGTERM", () => {
    stop = true;
  });
  while (!stop) {
    try {
      const current = await fetchBond(conn, program, bond);
      const active = current.bond.actions.find((a) => a.status === "scheduled");
      const slot = await conn.getSlot("confirmed");
      const now = await conn.getBlockTime(slot);
      if (active && now && now >= active.recordDate) {
        console.log(
          `Snapshot confirmed: ${await takeSnapshot(conn, program, wallet, bond, active.id)}`,
        );
      }
    } catch (e) {
      console.error(`Keeper will retry: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
