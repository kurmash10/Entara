import { Keypair } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

mkdirSync(".local", { recursive: true });
function keypair(file: string) {
  if (existsSync(file))
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))),
    );
  const key = Keypair.generate();
  writeFileSync(file, JSON.stringify([...key.secretKey]), {
    mode: 0o600,
    flag: "wx",
  });
  return key;
}
const program = keypair(".local/program-keypair.json");
const deployer = keypair(".local/deployer.json");
const id = program.publicKey.toBase58();
const source = "programs/corporate-actions/src/lib.rs";
writeFileSync(
  source,
  readFileSync(source, "utf8").replace(
    /declare_id!\("[^"]+"\)/,
    `declare_id!("${id}")`,
  ),
);
writeFileSync(
  "Anchor.toml",
  readFileSync("Anchor.toml", "utf8").replace(
    /corporate_actions = "[^"]+"/g,
    `corporate_actions = "${id}"`,
  ),
);
const env = existsSync(".env.local")
  ? readFileSync(".env.local", "utf8")
  : "NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com\n";
writeFileSync(
  ".env.local",
  env.match(/^NEXT_PUBLIC_PROGRAM_ID=/m)
    ? env.replace(
        /^NEXT_PUBLIC_PROGRAM_ID=.*$/m,
        `NEXT_PUBLIC_PROGRAM_ID=${id}`,
      )
    : `${env}\nNEXT_PUBLIC_PROGRAM_ID=${id}\n`,
);
console.log(
  `Program ID: ${id}\nDevnet deployer: ${deployer.publicKey.toBase58()}\nPrivate keys are stored only in ${path.resolve(".local")} (gitignored). Build the program after running this script.`,
);
