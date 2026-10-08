import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  type Signer,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  MINT_SIZE,
  ExtensionType,
  getMintLen,
  getAssociatedTokenAddressSync,
  createInitializeMint2Instruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePermanentDelegateInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
  unpackAccount,
} from "@solana/spl-token";
import type { Bond, CorporateAction, ActionKind, Entitlement } from "./engine";

export type Wallet = {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
};
export type InjectedWallet = Wallet & {
  connect(): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  isConnected?: boolean;
  on?(event: string, handler: (key?: PublicKey | null) => void): void;
  removeListener?(
    event: string,
    handler: (key?: PublicKey | null) => void,
  ): void;
};
export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
export const PROGRAM_ID = process.env.NEXT_PUBLIC_PROGRAM_ID || "";
export const connection = () => new Connection(RPC_URL, "confirmed");
const discriminator = (namespace: string, name: string) =>
  Buffer.from(
    sha256(new TextEncoder().encode(`${namespace}:${name}`)),
  ).subarray(0, 8);
export function numberBytes(n: number | bigint, size = 8, signed = false) {
  const b = Buffer.alloc(size);
  if (size === 8) {
    if (signed) b.writeBigInt64LE(BigInt(n));
    else b.writeBigUInt64LE(BigInt(n));
  } else if (size === 4) b.writeUInt32LE(Number(n));
  else if (size === 2) b.writeUInt16LE(Number(n));
  else b.writeUInt8(Number(n));
  return b;
}
const stringBytes = (s: string) => {
  const bytes = Buffer.from(s);
  return Buffer.concat([numberBytes(bytes.length, 4), bytes]);
};
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});
export const bondPda = (
  program: PublicKey,
  issuer: PublicKey,
  mint: PublicKey,
) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("bond"), issuer.toBuffer(), mint.toBuffer()],
    program,
  )[0];
export const actionPda = (program: PublicKey, bond: PublicKey, id: number) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("action"), bond.toBuffer(), numberBytes(id)],
    program,
  )[0];
export const explorer = (address: string, type: "tx" | "address" = "tx") =>
  `https://explorer.solana.com/${type}/${address}?cluster=devnet`;
const ix = (
  programId: PublicKey,
  name: string,
  keys: ReturnType<typeof meta>[],
  fields: Buffer[] = [],
) =>
  new TransactionInstruction({
    programId,
    keys,
    data: Buffer.concat([discriminator("global", name), ...fields]),
  });

const verifiedNetworks = new Set<string>();
export async function assertTestNetwork(conn: Connection) {
  if (verifiedNetworks.has(conn.rpcEndpoint)) return;
  const endpoint = new URL(conn.rpcEndpoint);
  if (
    !["localhost", "127.0.0.1"].includes(endpoint.hostname) &&
    (await conn.getGenesisHash()) !==
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  ) {
    throw new Error(
      "This MVP only sends transactions to Solana Devnet or a local validator.",
    );
  }
  verifiedNetworks.add(conn.rpcEndpoint);
}

export async function send(
  connection: Connection,
  wallet: Wallet,
  instructions: TransactionInstruction[],
  signers: Signer[] = [],
) {
  await assertTestNetwork(connection);
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: wallet.publicKey, ...latest }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...instructions,
  );
  if (signers.length) tx.partialSign(...signers);
  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const result = await connection.confirmTransaction(
    { signature, ...latest },
    "confirmed",
  );
  if (result.value.err)
    throw new Error(
      `Transaction failed: ${JSON.stringify(result.value.err)}. Signature: ${signature}`,
    );
  return signature;
}

class Reader {
  offset = 8;
  constructor(readonly data: Buffer) {}
  key() {
    const key = new PublicKey(
      this.data.subarray(this.offset, this.offset + 32),
    );
    this.offset += 32;
    return key;
  }
  u8() {
    return this.data.readUInt8(this.offset++);
  }
  u16() {
    const n = this.data.readUInt16LE(this.offset);
    this.offset += 2;
    return n;
  }
  u32() {
    const n = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return n;
  }
  u64() {
    const n = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return n;
  }
  i64() {
    const n = this.data.readBigInt64LE(this.offset);
    this.offset += 8;
    return Number(n);
  }
  text() {
    const size = this.u32();
    if (size > 256) throw new Error("Invalid account data.");
    const text = this.data.subarray(this.offset, this.offset + size).toString();
    this.offset += size;
    return text;
  }
}
export type BondChain = {
  bond: Bond;
  bondMint: PublicKey;
  paymentMint: PublicKey;
  nextAction: number;
  active: boolean;
};
export function decodeBond(data: Buffer, address: PublicKey): BondChain {
  if (!data.subarray(0, 8).equals(discriminator("account", "Bond")))
    throw new Error("This address is not a bond account.");
  const r = new Reader(data);
  const issuer = r.key().toBase58();
  const bondMint = r.key();
  const paymentMint = r.key();
  const name = r.text(),
    symbol = r.text(),
    faceValue = r.u64().toString(),
    couponBps = r.u16(),
    paymentsPerYear = r.u8();
  const issuedAt = r.i64(),
    maturity = r.i64(),
    periodSeconds = r.i64();
  const totalSupply = r.u64().toString(),
    outstanding = r.u64().toString(),
    sealed = !!r.u8(),
    active = !!r.u8();
  const couponCount = r.u32(),
    nextAction = Number(r.u64()),
    count = r.u8();
  r.u8();
  if (count > 8 || !Number.isSafeInteger(nextAction))
    throw new Error("Invalid bond account.");
  const holders = Array.from({ length: count }, (_, i) => ({
    wallet: r.key().toBase58(),
    quantity: r.u64().toString(),
    paid: r.u64().toString(),
    name: `Investor ${String(i + 1).padStart(2, "0")}`,
  }));
  return {
    bondMint,
    paymentMint,
    nextAction,
    active,
    bond: {
      address: address.toBase58(),
      issuer,
      name,
      symbol,
      faceValue,
      couponBps,
      paymentsPerYear,
      issuedAt,
      maturity,
      periodSeconds,
      totalSupply,
      outstanding,
      sealed,
      couponCount,
      holders,
      treasury: "0",
      actions: [],
    },
  };
}
export function decodeAction(
  data: Buffer,
  address: PublicKey,
): CorporateAction {
  if (!data.subarray(0, 8).equals(discriminator("account", "CorporateAction")))
    throw new Error("Invalid action account.");
  const r = new Reader(data);
  r.key();
  const id = Number(r.u64());
  const kind = (["coupon", "redemption", "early"] as ActionKind[])[r.u8()];
  const state = r.u8();
  const recordDate = r.i64(),
    snapshotAt = r.i64(),
    targetQuantity = r.u64().toString(),
    couponIndex = r.u32(),
    count = r.u8(),
    total = r.u64().toString();
  const entitlements: Entitlement[] = !snapshotAt
    ? []
    : Array.from({ length: count }, () => ({
        wallet: r.key().toBase58(),
        eligibleQuantity: r.u64().toString(),
        quantity: r.u64().toString(),
        amount: r.u64().toString(),
        settled: !!r.u8(),
      }));
  const status =
    state === 3
      ? "cancelled"
      : state === 2
        ? "completed"
        : state === 0
          ? "scheduled"
          : entitlements.some((e) => e.settled)
            ? "processing"
            : "ready";
  return {
    id,
    kind,
    status,
    recordDate,
    snapshotAt: snapshotAt || undefined,
    targetQuantity,
    couponIndex,
    total,
    entitlements,
    address: address.toBase58(),
  };
}
export async function fetchBond(
  conn: Connection,
  program: PublicKey,
  address: PublicKey,
): Promise<BondChain> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info || !info.owner.equals(program))
    throw new Error("Bond account not found for this program and network.");
  const result = decodeBond(info.data, address);
  const treasury = getAssociatedTokenAddressSync(
    result.paymentMint,
    address,
    true,
  );
  const addresses = [
    treasury,
    ...Array.from({ length: result.nextAction }, (_, i) =>
      actionPda(program, address, i),
    ),
  ];
  for (let start = 0; start < addresses.length; start += 100) {
    const batch = addresses.slice(start, start + 100);
    const accounts = await conn.getMultipleAccountsInfo(batch, "confirmed");
    accounts.forEach((account, i) => {
      if (start + i === 0) {
        result.bond.treasury = unpackAccount(
          treasury,
          account,
          TOKEN_PROGRAM_ID,
        ).amount.toString();
      } else {
        if (!account || !account.owner.equals(program))
          throw new Error(
            "Action account is unavailable. Refresh the bond to try again.",
          );
        result.bond.actions.push(decodeAction(account.data, batch[i]));
      }
    });
  }
  return result;
}
export async function verifyProgram(conn: Connection, program: PublicKey) {
  await assertTestNetwork(conn);
  const account = await conn.getAccountInfo(program);
  if (!account?.executable)
    throw new Error(
      "The corporate actions program is not deployed on this network.",
    );
}

export async function createBond(
  conn: Connection,
  program: PublicKey,
  wallet: Wallet,
  draft: Bond,
  checkpoint: (address: string) => void,
  progress: (message: string) => void,
): Promise<string> {
  await verifyProgram(conn, program);
  const mint = Keypair.generate(),
    payment = Keypair.generate();
  const issuer = wallet.publicKey;
  const bond = bondPda(program, issuer, mint.publicKey);
  const len = getMintLen([
    ExtensionType.NonTransferable,
    ExtensionType.PermanentDelegate,
  ]);
  progress("Create the bond mint and mock USD mint in your wallet.");
  await send(
    conn,
    wallet,
    [
      SystemProgram.createAccount({
        fromPubkey: issuer,
        newAccountPubkey: mint.publicKey,
        lamports: await conn.getMinimumBalanceForRentExemption(len),
        space: len,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeNonTransferableMintInstruction(
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializePermanentDelegateInstruction(
        mint.publicKey,
        bond,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMint2Instruction(
        mint.publicKey,
        0,
        bond,
        bond,
        TOKEN_2022_PROGRAM_ID,
      ),
      SystemProgram.createAccount({
        fromPubkey: issuer,
        newAccountPubkey: payment.publicKey,
        lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(payment.publicKey, 6, issuer, null),
    ],
    [mint, payment],
  );
  const treasury = getAssociatedTokenAddressSync(payment.publicKey, bond, true);
  progress("Create the on-chain bond terms.");
  await send(conn, wallet, [
    ix(
      program,
      "create_bond",
      [
        meta(issuer, true, true),
        meta(bond, true),
        meta(mint.publicKey),
        meta(payment.publicKey),
        meta(treasury, true),
        meta(TOKEN_PROGRAM_ID),
        meta(TOKEN_2022_PROGRAM_ID),
        meta(ASSOCIATED_TOKEN_PROGRAM_ID),
        meta(SystemProgram.programId),
      ],
      [
        stringBytes(draft.name),
        stringBytes(draft.symbol),
        numberBytes(BigInt(draft.faceValue)),
        numberBytes(draft.couponBps, 2),
        numberBytes(draft.paymentsPerYear, 1),
        numberBytes(draft.periodSeconds, 8, true),
        numberBytes(draft.maturity, 8, true),
      ],
    ),
  ]);
  checkpoint(bond.toBase58());
  await completeDistribution(conn, program, wallet, bond, draft, progress);
  return bond.toBase58();
}
export async function completeDistribution(
  conn: Connection,
  program: PublicKey,
  wallet: Wallet,
  address: PublicKey,
  draft: Bond,
  progress: (s: string) => void,
) {
  const chain = await fetchBond(conn, program, address);
  if (chain.bond.issuer !== wallet.publicKey.toBase58() || chain.bond.sealed)
    throw new Error("This issuer cannot modify this registry.");
  if (
    (draft.address && draft.address !== address.toBase58()) ||
    chain.bond.name !== draft.name ||
    chain.bond.symbol !== draft.symbol ||
    chain.bond.faceValue !== draft.faceValue
  )
    throw new Error("Saved issuance setup does not match the selected bond.");
  for (const existing of chain.bond.holders) {
    const intended = draft.holders.find((h) => h.wallet === existing.wallet);
    if (!intended || intended.quantity !== existing.quantity)
      throw new Error("The on-chain allocation differs from the saved setup.");
  }
  for (const holder of draft.holders) {
    if (chain.bond.holders.some((h) => h.wallet === holder.wallet)) continue;
    progress(`Distribute ${holder.quantity} bonds to ${holder.name}.`);
    await addHolder(
      conn,
      program,
      wallet,
      address,
      chain.bondMint,
      new PublicKey(holder.wallet),
      BigInt(holder.quantity),
    );
  }
  const current = await fetchBond(conn, program, address);
  const shortfall = BigInt(draft.treasury) - BigInt(current.bond.treasury);
  if (shortfall > 0n) {
    progress("Fund the treasury with test-only mock USD.");
    await fundTreasury(conn, wallet, address, current.paymentMint, shortfall);
  }
}
export async function addHolder(
  conn: Connection,
  program: PublicKey,
  wallet: Wallet,
  bond: PublicKey,
  mint: PublicKey,
  holder: PublicKey,
  quantity: bigint,
) {
  const ata = getAssociatedTokenAddressSync(
    mint,
    holder,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  return send(conn, wallet, [
    ix(
      program,
      "add_holder",
      [
        meta(wallet.publicKey, true, true),
        meta(bond, true),
        meta(holder),
        meta(mint, true),
        meta(ata, true),
        meta(TOKEN_2022_PROGRAM_ID),
        meta(ASSOCIATED_TOKEN_PROGRAM_ID),
        meta(SystemProgram.programId),
      ],
      [numberBytes(quantity)],
    ),
  ]);
}
export async function fundTreasury(
  conn: Connection,
  wallet: Wallet,
  bond: PublicKey,
  mint: PublicKey,
  amount: bigint,
) {
  if (amount <= 0n) throw new Error("Funding amount must be positive.");
  return send(conn, wallet, [
    createMintToInstruction(
      mint,
      getAssociatedTokenAddressSync(mint, bond, true),
      wallet.publicKey,
      amount,
    ),
  ]);
}
export async function announce(
  conn: Connection,
  program: PublicKey,
  wallet: Wallet,
  bond: PublicKey,
  nextId: number,
  kind: ActionKind,
  recordDate: number,
  target: string,
) {
  return send(conn, wallet, [
    ix(
      program,
      "announce",
      [
        meta(wallet.publicKey, true, true),
        meta(bond, true),
        meta(actionPda(program, bond, nextId), true),
        meta(SystemProgram.programId),
      ],
      [
        numberBytes(["coupon", "redemption", "early"].indexOf(kind), 1),
        numberBytes(recordDate, 8, true),
        numberBytes(BigInt(target)),
      ],
    ),
  ]);
}
export async function takeSnapshot(
  conn: Connection,
  program: PublicKey,
  wallet: Wallet,
  bond: PublicKey,
  id: number,
) {
  return send(conn, wallet, [
    ix(program, "take_snapshot", [
      meta(bond),
      meta(actionPda(program, bond, id), true),
    ]),
  ]);
}
export async function settle(
  conn: Connection,
  program: PublicKey,
  wallet: Wallet,
  address: PublicKey,
  chain: BondChain,
  id: number,
  index: number,
) {
  const holder = new PublicKey(chain.bond.holders[index].wallet);
  const payment = getAssociatedTokenAddressSync(chain.paymentMint, holder);
  const holderBonds = getAssociatedTokenAddressSync(
    chain.bondMint,
    holder,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  return send(conn, wallet, [
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      payment,
      holder,
      chain.paymentMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      holderBonds,
      holder,
      chain.bondMint,
      TOKEN_2022_PROGRAM_ID,
    ),
    ix(
      program,
      "settle",
      [
        meta(wallet.publicKey, false, true),
        meta(address, true),
        meta(actionPda(program, address, id), true),
        meta(holder),
        meta(chain.bondMint, true),
        meta(chain.paymentMint),
        meta(
          getAssociatedTokenAddressSync(chain.paymentMint, address, true),
          true,
        ),
        meta(
          getAssociatedTokenAddressSync(
            chain.bondMint,
            holder,
            false,
            TOKEN_2022_PROGRAM_ID,
          ),
          true,
        ),
        meta(payment, true),
        meta(TOKEN_PROGRAM_ID),
        meta(TOKEN_2022_PROGRAM_ID),
      ],
      [numberBytes(index, 1)],
    ),
  ]);
}
export async function cancelAction(
  conn: Connection,
  program: PublicKey,
  wallet: Wallet,
  bond: PublicKey,
  id: number,
) {
  return send(conn, wallet, [
    ix(program, "cancel", [
      meta(wallet.publicKey, false, true),
      meta(bond, true),
      meta(actionPda(program, bond, id), true),
    ]),
  ]);
}
