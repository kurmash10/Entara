import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");
  if (
    (await connection.getGenesisHash()) !==
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  )
    throw new Error("Deployment is restricted to Solana Devnet.");
  const walletPath = process.env.SOLANA_KEYPAIR || ".local/deployer.json";
  const key = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))),
  );
  const program = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(".local/program-keypair.json", "utf8")),
    ),
  );
  const binary = "target/deploy/corporate_actions.so";
  if (!existsSync(binary))
    throw new Error(
      "Build the program first: cargo build-sbf --manifest-path programs/corporate-actions/Cargo.toml",
    );
  const bytes = readFileSync(binary).length;
  const recordDeployment = () => {
    writeFileSync(
      ".local/deployment.json",
      JSON.stringify(
        {
          network: "devnet",
          programId: program.publicKey.toBase58(),
          verifiedAt: new Date().toISOString(),
          bytes,
        },
        null,
        2,
      ),
    );
    console.log(
      `Verified executable program: https://explorer.solana.com/address/${program.publicKey}?cluster=devnet`,
    );
  };
  const existing = await connection.getAccountInfo(program.publicKey);
  if (existing?.executable && existing.data.length >= 36) {
    const dataAddress = new PublicKey(existing.data.subarray(4, 36));
    const programData = await connection.getAccountInfo(dataAddress);
    if (
      programData?.data.subarray(45, 45 + bytes).equals(readFileSync(binary))
    ) {
      console.log(
        "The deployed binary already matches this build. No upload is needed.",
      );
      recordDeployment();
      return;
    }
  }
  const required =
    (await connection.getMinimumBalanceForRentExemption(bytes + 45)) +
    0.05 * LAMPORTS_PER_SOL;
  let balance = await connection.getBalance(key.publicKey);
  console.log(
    `Devnet deployer: ${key.publicKey}\nProgram: ${program.publicKey}\nBalance: ${balance / LAMPORTS_PER_SOL} test SOL; estimated first-deployment requirement: ${(required / LAMPORTS_PER_SOL).toFixed(3)} test SOL`,
  );
  if (balance < required) {
    try {
      const sig = await connection.requestAirdrop(
        key.publicKey,
        2 * LAMPORTS_PER_SOL,
      );
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...latest });
      balance = await connection.getBalance(key.publicKey);
    } catch (e) {
      console.log(
        `Devnet faucet unavailable: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  if (balance < required)
    throw new Error(
      `Fund ${key.publicKey} with at least ${((required - balance) / LAMPORTS_PER_SOL).toFixed(3)} more DEVNET SOL, then rerun. No mainnet funds are needed.`,
    );
  const bufferPath = ".local/deploy-buffer.json";
  if (!existsSync(bufferPath))
    writeFileSync(
      bufferPath,
      JSON.stringify([...Keypair.generate().secretKey]),
      { mode: 0o600, flag: "wx" },
    );
  const cli =
    process.env.SOLANA_CLI ||
    (process.platform === "win32"
      ? path.join(
          homedir(),
          ".local/share/solana/install/active_release/bin/solana.exe",
        )
      : "solana");
  const result = spawnSync(
    cli,
    [
      "program",
      "deploy",
      binary,
      "--program-id",
      ".local/program-keypair.json",
      "--buffer",
      bufferPath,
      "--max-len",
      String(bytes),
      "--keypair",
      walletPath,
      "--url",
      rpc,
      "--commitment",
      "confirmed",
    ],
    { stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error("Solana deployment failed. Inspect the CLI output above.");
  let account = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      account = await connection.getAccountInfo(program.publicKey);
      if (account?.executable) break;
    } catch (e) {
      if (attempt === 2) throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!account?.executable)
    throw new Error("Program is not executable after deployment.");
  recordDeployment();
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
