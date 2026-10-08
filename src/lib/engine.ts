/** Integer-only reference engine. Local demo and UI previews use the same rules as the program. */
export const UNIT = 1_000_000n;
export const MAX_HOLDERS = 8;
export type ActionKind = "coupon" | "redemption" | "early";
export type ActionStatus =
  | "scheduled"
  | "ready"
  | "processing"
  | "completed"
  | "cancelled";
export type Holder = {
  wallet: string;
  name: string;
  quantity: string;
  paid: string;
};
export type Entitlement = {
  wallet: string;
  eligibleQuantity: string;
  quantity: string;
  amount: string;
  settled: boolean;
  signature?: string;
};
export type CorporateAction = {
  id: number;
  kind: ActionKind;
  status: ActionStatus;
  recordDate: number;
  snapshotAt?: number;
  targetQuantity: string;
  couponIndex: number;
  entitlements: Entitlement[];
  total: string;
  signature?: string;
  address?: string;
};
export type Bond = {
  address?: string;
  name: string;
  symbol: string;
  issuer: string;
  faceValue: string;
  couponBps: number;
  paymentsPerYear: number;
  issuedAt: number;
  maturity: number;
  periodSeconds: number;
  totalSupply: string;
  outstanding: string;
  sealed: boolean;
  couponCount: number;
  holders: Holder[];
  actions: CorporateAction[];
  treasury: string;
};
export type Store = { version: 1; bond: Bond | null; clockOffset: number };
export const actionLabel: Record<ActionKind, string> = {
  coupon: "Coupon payment",
  redemption: "Maturity redemption",
  early: "Early redemption",
};
const fail = (message: string): never => {
  throw new Error(message);
};
const U64_MAX = (1n << 64n) - 1n;
export function u64(value: bigint): bigint {
  if (value < 0n || value > U64_MAX)
    fail("Amount exceeds the supported range.");
  return value;
}
export function parseMoney(value: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(value))
    fail("Enter a positive amount with at most six decimal places.");
  const [whole, fraction = ""] = value.split(".");
  return u64(BigInt(whole) * UNIT + BigInt(fraction.padEnd(6, "0"))).toString();
}
export function money(value: string | bigint, decimals = 2): string {
  const n = BigInt(value);
  const whole = n / UNIT;
  return `$${whole.toLocaleString("en-US")}${decimals ? "." + (n % UNIT).toString().padStart(6, "0").slice(0, decimals) : ""}`;
}
export function couponAmount(
  qty: bigint,
  face: bigint,
  bps: number,
  frequency: number,
): bigint {
  if (
    !Number.isInteger(bps) ||
    bps <= 0 ||
    bps > 10000 ||
    ![1, 2, 4, 12].includes(frequency)
  )
    fail("Invalid coupon terms.");
  return u64((qty * face * BigInt(bps)) / (10000n * BigInt(frequency)));
}
/** Largest remainder apportionment. Ties go to the earlier registry position. */
export function apportion(quantities: bigint[], target: bigint): bigint[] {
  const total = quantities.reduce((a, b) => a + b, 0n);
  if (quantities.some((q) => q < 0n) || target <= 0n || target > total)
    fail("Redemption quantity must be between 1 and the outstanding supply.");
  const shares = quantities.map((q) => (q * target) / total);
  const order = quantities
    .map((q, i) => ({ i, remainder: (q * target) % total }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.i - b.i
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  const left = Number(target - shares.reduce((a, b) => a + b, 0n));
  for (let i = 0; i < left; i++) shares[order[i].i]++;
  return shares;
}
export function validateBond(bond: Bond) {
  if (
    !bond.name.trim() ||
    bond.name.length > 48 ||
    !/^[A-Z0-9-]{1,12}$/.test(bond.symbol)
  )
    fail(
      "Enter a name and a symbol (up to 12 uppercase letters, numbers or hyphens).",
    );
  if (BigInt(bond.faceValue) <= 0n) fail("Face value must be positive.");
  if (
    bond.periodSeconds < 1 ||
    !Number.isInteger(bond.periodSeconds) ||
    bond.maturity <= bond.issuedAt
  )
    fail("Invalid bond dates.");
  couponAmount(
    1n,
    BigInt(bond.faceValue),
    bond.couponBps,
    bond.paymentsPerYear,
  );
  if (!bond.holders.length || bond.holders.length > MAX_HOLDERS)
    fail("Add between 1 and 8 holders.");
  if (new Set(bond.holders.map((h) => h.wallet)).size !== bond.holders.length)
    fail("Each holder must have a unique wallet.");
  for (const h of bond.holders)
    if (!/^\d+$/.test(h.quantity) || BigInt(h.quantity) <= 0n)
      fail("Holdings must be positive whole bonds.");
  const supply = bond.holders.reduce((n, h) => n + BigInt(h.quantity), 0n);
  u64(supply * BigInt(bond.faceValue));
  if (
    supply !== BigInt(bond.totalSupply) ||
    supply !== BigInt(bond.outstanding)
  )
    fail("Supply does not match the holder registry.");
}
function authorize(bond: Bond, wallet: string) {
  if (wallet !== bond.issuer)
    fail("Only the issuing wallet can perform this operation.");
}
export function schedule(
  bond: Bond,
  wallet: string,
  kind: ActionKind,
  recordDate: number,
  target: string,
  now: number,
): Bond {
  authorize(bond, wallet);
  if (bond.actions.some((a) => !["completed", "cancelled"].includes(a.status)))
    fail("Complete or cancel the current action first.");
  if (BigInt(bond.outstanding) === 0n)
    fail("This bond has already been fully redeemed.");
  if (!Number.isSafeInteger(recordDate) || recordDate < now)
    fail("Record date cannot be in the past.");
  if (
    kind === "coupon" &&
    recordDate < bond.issuedAt + bond.periodSeconds * (bond.couponCount + 1)
  )
    fail("The next coupon period is not due yet.");
  if (kind !== "redemption" && recordDate > bond.maturity)
    fail("Record date must be on or before maturity.");
  if (kind === "redemption" && recordDate < bond.maturity)
    fail("Principal cannot be redeemed before maturity.");
  if (kind === "early" && recordDate >= bond.maturity)
    fail("Use maturity redemption at or after maturity.");
  if (kind === "early")
    apportion(
      bond.holders.map((h) => BigInt(h.quantity)),
      BigInt(target),
    );
  const action: CorporateAction = {
    id: bond.actions.length,
    kind,
    recordDate,
    status: "scheduled",
    targetQuantity:
      kind === "redemption"
        ? bond.outstanding
        : kind === "early"
          ? target
          : "0",
    couponIndex: bond.couponCount + 1,
    entitlements: [],
    total: "0",
  };
  return { ...bond, sealed: true, actions: [...bond.actions, action] };
}
export function estimate(bond: Bond, action: CorporateAction): Entitlement[] {
  const quantities = bond.holders.map((h) => BigInt(h.quantity));
  const redeemed =
    action.kind === "early"
      ? apportion(quantities, BigInt(action.targetQuantity))
      : quantities;
  return bond.holders.map((h, i) => ({
    wallet: h.wallet,
    eligibleQuantity: h.quantity,
    settled: false,
    quantity: (action.kind === "coupon" ? 0n : redeemed[i]).toString(),
    amount: (action.kind === "coupon"
      ? couponAmount(
          quantities[i],
          BigInt(bond.faceValue),
          bond.couponBps,
          bond.paymentsPerYear,
        )
      : u64(redeemed[i] * BigInt(bond.faceValue))
    ).toString(),
  }));
}
export function snapshot(bond: Bond, id: number, now: number): Bond {
  const action =
    bond.actions.find((a) => a.id === id) ?? fail("Action not found.");
  if (action.status !== "scheduled")
    fail("This action already has a snapshot or is closed.");
  if (now < action.recordDate) fail("Record date has not arrived.");
  const entitlements = estimate(bond, action);
  const total = u64(
    entitlements.reduce((n, h) => n + BigInt(h.amount), 0n),
  ).toString();
  return {
    ...bond,
    actions: bond.actions.map((a) =>
      a.id === id
        ? { ...a, status: "ready", snapshotAt: now, entitlements, total }
        : a,
    ),
  };
}
export function settleHolder(
  bond: Bond,
  wallet: string,
  id: number,
  index: number,
): Bond {
  authorize(bond, wallet);
  const action =
    bond.actions.find((a) => a.id === id) ?? fail("Action not found.");
  if (!["ready", "processing"].includes(action.status))
    fail("The action is not ready for settlement.");
  const item = action.entitlements[index] ?? fail("Holder not found.");
  if (item.settled) fail("This entitlement has already been settled.");
  if (BigInt(bond.treasury) < BigInt(item.amount))
    fail("Insufficient mock USD in the treasury. Fund it and resume.");
  const entitlements = action.entitlements.map((h, i) =>
    i === index ? { ...h, settled: true } : h,
  );
  const completed = entitlements.every((h) => h.settled);
  return {
    ...bond,
    treasury: (BigInt(bond.treasury) - BigInt(item.amount)).toString(),
    outstanding: (BigInt(bond.outstanding) - BigInt(item.quantity)).toString(),
    couponCount:
      completed && action.kind === "coupon"
        ? bond.couponCount + 1
        : bond.couponCount,
    holders: bond.holders.map((h) =>
      h.wallet === item.wallet
        ? {
            ...h,
            quantity: (BigInt(h.quantity) - BigInt(item.quantity)).toString(),
            paid: (BigInt(h.paid) + BigInt(item.amount)).toString(),
          }
        : h,
    ),
    actions: bond.actions.map((a) =>
      a.id === id
        ? { ...a, entitlements, status: completed ? "completed" : "processing" }
        : a,
    ),
  };
}
export function cancel(bond: Bond, wallet: string, id: number): Bond {
  authorize(bond, wallet);
  const action =
    bond.actions.find((a) => a.id === id) ?? fail("Action not found.");
  if (
    ["completed", "cancelled"].includes(action.status) ||
    action.entitlements.some((h) => h.settled)
  )
    fail("An action with settled entitlements cannot be cancelled.");
  return {
    ...bond,
    actions: bond.actions.map((a) =>
      a.id === id ? { ...a, status: "cancelled" } : a,
    ),
  };
}
export function demoBond(now: number, wallets: string[], issuer: string): Bond {
  return {
    name: "Kazakhstan Infrastructure Bond",
    symbol: "KZINF-26",
    issuer,
    faceValue: "1000000000",
    couponBps: 1000,
    paymentsPerYear: 2,
    issuedAt: now,
    maturity: now + 360,
    periodSeconds: 60,
    totalSupply: "40",
    outstanding: "40",
    sealed: false,
    couponCount: 0,
    treasury: "50000000000",
    actions: [],
    holders: wallets.map((wallet, i) => ({
      wallet,
      name:
        ["Aster Capital", "Nomad Ventures", "Steppe Fund"][i] ||
        `Investor ${i + 1}`,
      quantity: ["10", "20", "10"][i] || "10",
      paid: "0",
    })),
  };
}
