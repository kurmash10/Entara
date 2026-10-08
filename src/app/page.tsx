"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Blocks,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  Copy,
  ExternalLink,
  FileText,
  History,
  LayoutDashboard,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
  X,
  Zap,
  Landmark,
  Coins,
  CalendarDays,
  AlertCircle,
  Play,
  RotateCcw,
} from "lucide-react";
import {
  actionLabel,
  cancel,
  demoBond,
  estimate,
  money,
  parseMoney,
  schedule,
  settleHolder,
  snapshot,
  validateBond,
  type ActionKind,
  type Bond,
  type CorporateAction,
  type Store,
} from "@/lib/engine";
import * as chain from "@/lib/solana";

type View = "Overview" | "Holder registry" | "Corporate actions" | "Activity";
type Modal = "create" | "action" | "fund" | "load" | "help" | "reset" | null;
const DEMO_ISSUER = Keypair.fromSeed(
  new Uint8Array(32).fill(11),
).publicKey.toBase58();
const DEMO_WALLETS = [21, 22, 23].map((n) =>
  Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58(),
);
const KEY = "kase-flow-demo-v1";
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const date = (n: number) =>
  new Date(n * 1000).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const inputDate = (n: number) => {
  const d = new Date(n * 1000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
};
const statusText = (s: string) =>
  ({
    scheduled: "Scheduled",
    ready: "Ready to settle",
    processing: "In progress",
    completed: "Completed",
    cancelled: "Cancelled",
  })[s] || s;

export default function Dashboard() {
  const [store, setStore] = useState<Store>({
    version: 1,
    bond: null,
    clockOffset: 0,
  });
  const [hydrated, setHydrated] = useState(false);
  const [mode, setMode] = useState<"demo" | "devnet">("demo");
  const [networkBond, setNetworkBond] = useState<chain.BondChain | null>(null);
  const [view, setView] = useState<View>("Overview");
  const [modal, setModal] = useState<Modal>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [provider, setProvider] = useState<chain.InjectedWallet | null>(null);
  const [programStatus, setProgramStatus] = useState<
    "checking" | "ready" | "unavailable"
  >("checking");
  const [wallet, setWallet] = useState<string>("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState<Bond | null>(null);
  const [pendingDraft, setPendingDraft] = useState<Bond | null>(null);
  const [kind, setKind] = useState<ActionKind>("coupon");
  const [recordDate, setRecordDate] = useState("");
  const [quantity, setQuantity] = useState("10");
  const [funding, setFunding] = useState("50000");
  const [loadAddress, setLoadAddress] = useState("");
  const [historyFilter, setHistoryFilter] = useState("all");
  const mutex = useRef(false);
  const networkAddress = useRef("");
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const hasLiveBond = useRef(true);
  const signatureCache = useRef(new Map<string, string>());
  const now =
    Math.floor(Date.now() / 1000) + (mode === "demo" ? store.clockOffset : 0);
  void tick;
  const bond = mode === "demo" ? store.bond : networkBond?.bond || null;
  const current = bond?.actions.find(
    (a) => !["completed", "cancelled"].includes(a.status),
  );
  const action =
    bond?.actions.find((a) => a.id === selected) ||
    current ||
    bond?.actions.at(-1);
  const canSign = mode === "demo" || (!!wallet && wallet === bond?.issuer);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Store;
        if (
          parsed.version !== 1 ||
          !Number.isFinite(parsed.clockOffset) ||
          (parsed.bond &&
            (!Array.isArray(parsed.bond.actions) ||
              !Array.isArray(parsed.bond.holders)))
        )
          throw new Error("Invalid saved demo");
        setStore(parsed);
      }
      const pending = localStorage.getItem("kase-pending-draft");
      if (pending) setPendingDraft(JSON.parse(pending));
      setLoadAddress(localStorage.getItem("kase-devnet-bond") || "");
      const sharedBond = new URLSearchParams(window.location.search).get(
        "bond",
      );
      if (sharedBond) {
        setLoadAddress(new PublicKey(sharedBond).toBase58());
        setMode("devnet");
      }
    } catch {
      setNotice({
        text: "Saved demo could not be restored. Create a new test bond.",
        error: true,
      });
    }
    setHydrated(true);
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (hydrated) localStorage.setItem(KEY, JSON.stringify(store));
  }, [store, hydrated]);
  useEffect(() => {
    if (mode !== "devnet") return;
    let disposed = false;
    setProgramStatus("checking");
    if (!chain.PROGRAM_ID) {
      setProgramStatus("unavailable");
      return;
    }
    chain
      .verifyProgram(chain.connection(), new PublicKey(chain.PROGRAM_ID))
      .then(() => {
        if (!disposed) setProgramStatus("ready");
      })
      .catch(() => {
        if (!disposed) setProgramStatus("unavailable");
      });
    return () => {
      disposed = true;
    };
  }, [mode]);
  useEffect(() => {
    if (!provider) return;
    const changed = (key?: PublicKey | null) =>
      setWallet(key?.toBase58() || "");
    const disconnected = () => setWallet("");
    provider.on?.("accountChanged", changed);
    provider.on?.("disconnect", disconnected);
    return () => {
      provider.removeListener?.("accountChanged", changed);
      provider.removeListener?.("disconnect", disconnected);
    };
  }, [provider]);
  useEffect(() => {
    if (
      mode === "demo" &&
      current?.status === "scheduled" &&
      now >= current.recordDate
    ) {
      setStore((s) => {
        const saved = s.bond?.actions.find((a) => a.id === current.id);
        if (!s.bond || saved?.status !== "scheduled") return s;
        return { ...s, bond: snapshot(s.bond, current.id, now) };
      });
    }
  }, [mode, current?.id, current?.status, current?.recordDate, now]);
  const refresh = useCallback(async (address?: string) => {
    if (refreshInFlight.current) await refreshInFlight.current;
    const target =
      address ||
      networkAddress.current ||
      localStorage.getItem("kase-devnet-bond");
    if (!target || !chain.PROGRAM_ID) return;
    const task = (async () => {
      const result = await chain.fetchBond(
        chain.connection(),
        new PublicKey(chain.PROGRAM_ID),
        new PublicKey(target),
      );
      networkAddress.current = target;
      hasLiveBond.current = result.bond.outstanding !== "0";
      for (const item of result.bond.actions) {
        const key =
          item.address +
          item.status +
          item.entitlements.filter((e) => e.settled).length;
        item.signature = signatureCache.current.get(key);
      }
      setNetworkBond(result);
      localStorage.setItem("kase-devnet-bond", target);
      setLoadAddress(target);
    })();
    refreshInFlight.current = task;
    try {
      await task;
    } finally {
      if (refreshInFlight.current === task) refreshInFlight.current = null;
    }
  }, []);
  useEffect(() => {
    if (mode !== "devnet" || !hydrated || !chain.PROGRAM_ID) return;
    const target =
      new URLSearchParams(window.location.search).get("bond") ||
      localStorage.getItem("kase-devnet-bond");
    if (target)
      refresh(target).catch((e) => setNotice({ text: e.message, error: true }));
    const timer = setInterval(() => {
      if (
        !mutex.current &&
        !refreshInFlight.current &&
        hasLiveBond.current &&
        document.visibilityState === "visible"
      )
        refresh().catch(() => {});
    }, 60000);
    return () => clearInterval(timer);
  }, [mode, hydrated, refresh]);
  useEffect(() => {
    if (mode !== "devnet" || !action?.address) return;
    let disposed = false;
    const address = action.address;
    const key =
      address +
      action.status +
      action.entitlements.filter((e) => e.settled).length;
    const apply = (signature: string) => {
      if (!disposed)
        setNetworkBond((previous) =>
          previous
            ? {
                ...previous,
                bond: {
                  ...previous.bond,
                  actions: previous.bond.actions.map((a) =>
                    a.address === address ? { ...a, signature } : a,
                  ),
                },
              }
            : previous,
        );
    };
    const cached = signatureCache.current.get(key);
    if (cached) apply(cached);
    else
      chain
        .connection()
        .getSignaturesForAddress(
          new PublicKey(address),
          { limit: 1 },
          "confirmed",
        )
        .then((signatures) => {
          if (signatures[0] && !signatures[0].err) {
            signatureCache.current.set(key, signatures[0].signature);
            apply(signatures[0].signature);
          }
        })
        .catch(() => {
          /* Optional Explorer enrichment must not block account state. */
        });
    return () => {
      disposed = true;
    };
  }, [
    mode,
    action?.address,
    action?.status,
    action?.entitlements.filter((e) => e.settled).length,
  ]);

  async function run(message: string, fn: () => Promise<void> | void) {
    if (mutex.current) return;
    mutex.current = true;
    setBusy(message);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({
        text:
          e instanceof Error
            ? e.message
            : "Something went wrong. Please try again.",
        error: true,
      });
    } finally {
      mutex.current = false;
      setBusy("");
    }
  }
  async function connect() {
    const root = window as unknown as {
      phantom?: { solana?: chain.InjectedWallet };
      solana?: chain.InjectedWallet;
      solflare?: chain.InjectedWallet;
    };
    const p = root.phantom?.solana || root.solflare || root.solana;
    if (!p) {
      setNotice({
        text: "Open this app in a browser with Phantom or Solflare installed. Local demo works without a wallet.",
        error: true,
      });
      return;
    }
    await run("Connecting wallet…", async () => {
      const result = await p.connect();
      setProvider(p);
      setWallet(result.publicKey.toBase58());
      setNotice({ text: "Wallet connected. Devnet uses test assets only." });
    });
  }
  function context() {
    if (!provider || !wallet)
      throw new Error("Connect an issuer wallet first.");
    if (!chain.PROGRAM_ID)
      throw new Error(
        "Devnet is not configured. Set NEXT_PUBLIC_PROGRAM_ID after deploying the program.",
      );
    return {
      conn: chain.connection(),
      program: new PublicKey(chain.PROGRAM_ID),
      signer: provider,
    };
  }
  function openCreate() {
    setDraft(
      demoBond(now, DEMO_WALLETS, mode === "demo" ? DEMO_ISSUER : wallet),
    );
    setModal("create");
  }
  function openAction(type: ActionKind = "coupon") {
    if (!bond) return;
    setKind(type);
    setQuantity((BigInt(bond.outstanding) / 4n || 1n).toString());
    setRecordDate(
      inputDate(
        Math.max(
          now + 30,
          type === "redemption"
            ? bond.maturity
            : type === "coupon"
              ? bond.issuedAt + bond.periodSeconds * (bond.couponCount + 1)
              : now + 30,
        ),
      ),
    );
    setModal("action");
  }
  async function create() {
    if (!draft) return;
    await run("Creating bond…", async () => {
      const total = draft.holders
        .reduce((n, h) => n + BigInt(h.quantity), 0n)
        .toString();
      const prepared = {
        ...draft,
        issuer: mode === "demo" ? DEMO_ISSUER : wallet,
        totalSupply: total,
        outstanding: total,
        issuedAt: now,
      };
      validateBond(prepared);
      prepared.holders.forEach((h) => {
        if (!PublicKey.isOnCurve(new PublicKey(h.wallet).toBytes()))
          throw new Error("Holder addresses must be regular wallet addresses.");
      });
      if (mode === "demo") {
        setStore((s) => ({ ...s, bond: prepared }));
      } else {
        const { conn, program, signer } = context();
        localStorage.setItem("kase-pending-draft", JSON.stringify(prepared));
        setPendingDraft(prepared);
        const address = await chain.createBond(
          conn,
          program,
          signer,
          prepared,
          (address) => {
            localStorage.setItem("kase-devnet-bond", address);
            localStorage.setItem(
              "kase-pending-draft",
              JSON.stringify({ ...prepared, address }),
            );
            setPendingDraft({ ...prepared, address });
            setLoadAddress(address);
          },
          setBusy,
        );
        await refresh(address);
        localStorage.removeItem("kase-pending-draft");
        setPendingDraft(null);
      }
      setSelected(null);
      setModal(null);
      setView("Overview");
      setNotice({
        text:
          mode === "demo"
            ? "Test bond created. Schedule your first corporate action."
            : "Bond created and treasury funded on Solana Devnet.",
      });
    });
  }
  async function announceAction() {
    if (!bond) return;
    await run("Scheduling corporate action…", async () => {
      const timestamp = Math.floor(new Date(recordDate).getTime() / 1000);
      const updated = schedule(
        bond,
        mode === "demo" ? DEMO_ISSUER : wallet,
        kind,
        timestamp,
        quantity,
        now,
      );
      if (mode === "demo") setStore((s) => ({ ...s, bond: updated }));
      else {
        const { conn, program, signer } = context();
        await chain.announce(
          conn,
          program,
          signer,
          new PublicKey(bond.address!),
          networkBond!.nextAction,
          kind,
          timestamp,
          kind === "early" ? quantity : "0",
        );
        await refresh();
      }
      setSelected(updated.actions.at(-1)!.id);
      setModal(null);
      setNotice({
        text: "Action scheduled. Entitlements will be fixed at the record date.",
      });
    });
  }
  async function execute() {
    if (!bond || !action) return;
    await run("Executing settlement…", async () => {
      if (mode === "demo") {
        let next = bond;
        for (let i = 0; i < action.entitlements.length; i++) {
          if (action.entitlements[i].settled) continue;
          next = settleHolder(next, DEMO_ISSUER, action.id, i);
          // Persist each completed holder so insufficient funds can be resumed safely.
          setStore((s) => ({ ...s, bond: next }));
        }
      } else {
        const { conn, program, signer } = context();
        const address = new PublicKey(bond.address!);
        try {
          for (let i = 0; i < action.entitlements.length; i++) {
            const latest = await chain.fetchBond(conn, program, address);
            if (
              latest.bond.actions.find((a) => a.id === action.id)?.entitlements[
                i
              ]?.settled
            )
              continue;
            setBusy(
              `Settle investor ${i + 1} of ${action.entitlements.length}. Confirm in your wallet.`,
            );
            await chain.settle(
              conn,
              program,
              signer,
              address,
              latest,
              action.id,
              i,
            );
            await refresh();
          }
        } finally {
          await refresh();
        }
      }
      setNotice({
        text:
          mode === "demo"
            ? "Local settlement completed. No blockchain transaction was sent."
            : "All entitlements settled and confirmed on Solana Devnet.",
      });
    });
  }
  async function cancelCurrent() {
    if (!bond || !action) return;
    await run("Cancelling action…", async () => {
      if (mode === "demo")
        setStore((s) => ({ ...s, bond: cancel(bond, DEMO_ISSUER, action.id) }));
      else {
        const { conn, program, signer } = context();
        await chain.cancelAction(
          conn,
          program,
          signer,
          new PublicKey(bond.address!),
          action.id,
        );
        await refresh();
      }
      setNotice({ text: "Action cancelled. You can schedule a replacement." });
    });
  }
  function exportReport() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            network:
              mode === "demo"
                ? "local-simulation-no-on-chain-proof"
                : "solana-devnet",
            exportedAt: new Date().toISOString(),
            bond,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${bond?.symbol || "bond"}-${mode}-report.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ text: "Address copied." });
    } catch {
      setNotice({
        text: "Clipboard unavailable in this browser.",
        error: true,
      });
    }
  }
  let preview: ReturnType<typeof estimate> = [];
  try {
    if (bond && modal === "action")
      preview = estimate(bond, {
        kind,
        targetQuantity: kind === "redemption" ? bond.outstanding : quantity,
      } as CorporateAction);
  } catch {
    /* Invalid form values are explained on submission. */
  }
  const paid = bond?.holders.reduce((n, h) => n + BigInt(h.paid), 0n) || 0n;
  const navItems: { label: View; icon: typeof LayoutDashboard }[] = [
    { label: "Overview", icon: LayoutDashboard },
    { label: "Holder registry", icon: Users },
    { label: "Corporate actions", icon: Blocks },
    { label: "Activity", icon: History },
  ];

  return (
    <div className="shell">
      <div className="main-shell">
        <header className="topbar">
          <a
            href="#"
            className="brand"
            onClick={(e) => {
              e.preventDefault();
              setView("Overview");
            }}
          >
            <span className="brand-mark">
              <i />
              <i />
              <i />
            </span>
            <span>
              Entara
              <small>BOND ACTIONS. SETTLED.</small>
            </span>
          </a>
          <nav>
            {navItems.map(({ label, icon: Icon }) => (
              <button
                key={label}
                className={view === label ? "nav-item active" : "nav-item"}
                onClick={() => setView(label)}
              >
                <Icon size={18} />
                {label}
                {label === "Corporate actions" && current && (
                  <span className="nav-count">1</span>
                )}
              </button>
            ))}
          </nav>
          <div className="topbar-right">
            <button
              className="guide-button"
              aria-label="Demo guide"
              onClick={() => setModal("help")}
            >
              <CircleHelp size={18} />
            </button>
            <label className={`network ${mode}`}>
              <span className="dot" />
              <select
                aria-label="Network mode"
                value={mode}
                disabled={!!busy}
                onChange={(e) => {
                  setMode(e.target.value as "demo" | "devnet");
                  window.history.replaceState(
                    null,
                    "",
                    window.location.pathname,
                  );
                  setSelected(null);
                  setNotice(null);
                }}
              >
                <option value="demo">Local demo</option>
                <option value="devnet">Solana Devnet</option>
              </select>
              <ChevronDown size={12} />
            </label>
            <button
              className="wallet-button"
              onClick={connect}
              disabled={!!busy}
            >
              <Wallet size={15} />
              {wallet ? short(wallet) : "Connect wallet"}
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span /> CAPITAL MARKETS, CONNECTED
              </div>
              <h1>{view === "Overview" ? "Corporate actions" : view}</h1>
              <p>
                {view === "Overview"
                  ? "Manage your bond lifecycle. Every entitlement accounted for."
                  : view === "Holder registry"
                    ? "A clear view of ownership, allocations and distributions."
                    : view === "Corporate actions"
                      ? "Schedule, calculate and settle from one workspace."
                      : "A verifiable record of every corporate action."}
              </p>
            </div>
            <div className="heading-actions">
              {bond && (
                <button className="button secondary" onClick={exportReport}>
                  <ArrowDownToLine size={16} />
                  Export
                </button>
              )}
              <button
                className="button primary"
                onClick={openCreate}
                disabled={!!busy}
              >
                <Plus size={17} />
                Create bond
              </button>
            </div>
          </div>
          {mode === "demo" ? (
            <div className="demo-banner">
              <Sparkles size={17} />
              <span>
                <strong>Local demo workspace</strong> Explore the complete
                lifecycle with simulated balances. No funds or blockchain
                transactions.
              </span>
              <button onClick={() => setModal("help")}>
                How it works <ArrowUpRight size={14} />
              </button>
            </div>
          ) : (
            <div className="demo-banner devnet-banner">
              <ShieldCheck size={17} />
              <span>
                <strong>Solana Devnet</strong> Real test-network transactions.
                Mock USD has no monetary value.{" "}
                {programStatus === "ready"
                  ? "Program verified on Devnet."
                  : programStatus === "checking"
                    ? "Checking program availability?"
                    : "Program is not available on Devnet yet."}
              </span>
              <button onClick={() => setModal("load")}>
                Open bond <ArrowUpRight size={14} />
              </button>
            </div>
          )}
          {notice && (
            <div
              className={`notice ${notice.error ? "error" : "success"}`}
              role={notice.error ? "alert" : "status"}
            >
              {notice.error ? (
                <AlertCircle size={18} />
              ) : (
                <CheckCircle2 size={18} />
              )}
              <span>{notice.text}</span>
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice(null)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {busy && (
            <div className="busy" role="status">
              <LoaderCircle size={17} className="spin" />
              {busy}
            </div>
          )}
          {!hydrated ? (
            <div className="empty">
              <LoaderCircle className="spin" />
              Loading workspace…
            </div>
          ) : !bond ? (
            <div className="empty-state">
              <div className="empty-art">
                <Landmark size={46} />
                <span>
                  <ShieldCheck size={22} />
                </span>
              </div>
              <div className="eyebrow">YOUR FIRST ISSUANCE STARTS HERE</div>
              <h2>One bond. A complete lifecycle.</h2>
              <p>
                Create a test bond, allocate it to your investors, and take it
                from the first coupon to final redemption.
              </p>
              <button className="button primary" onClick={openCreate}>
                <Plus size={17} />
                Create your first bond
              </button>
              {mode === "devnet" && (
                <button
                  className="text-button"
                  onClick={() => setModal("load")}
                >
                  Open an existing bond
                </button>
              )}
              <div className="empty-steps">
                <span>
                  <span>01</span> Issue & allocate
                </span>
                <ArrowRight size={16} />
                <span>
                  <span>02</span> Fix entitlements
                </span>
                <ArrowRight size={16} />
                <span>
                  <span>03</span> Settle & verify
                </span>
              </div>
            </div>
          ) : (
            <>
              {mode === "devnet" && pendingDraft && !bond.sealed && (
                <div className="notice">
                  <AlertCircle size={18} />
                  <span>
                    Issuance setup may be incomplete. Resume the saved
                    distribution and treasury funding.
                  </span>
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() =>
                      run("Resuming issuance…", async () => {
                        const { conn, program, signer } = context();
                        await chain.completeDistribution(
                          conn,
                          program,
                          signer,
                          new PublicKey(bond.address!),
                          pendingDraft,
                          setBusy,
                        );
                        await refresh();
                        setPendingDraft(null);
                        localStorage.removeItem("kase-pending-draft");
                      })
                    }
                  >
                    Resume setup
                  </button>
                </div>
              )}
              {view === "Overview" && (
                <>
                  <section className="metrics" aria-label="Bond statistics">
                    <Metric
                      label="Outstanding principal"
                      value={money(
                        BigInt(bond.outstanding) * BigInt(bond.faceValue),
                        0,
                      )}
                      detail={`${bond.outstanding} of ${bond.totalSupply} bonds outstanding`}
                      icon={<Landmark size={18} />}
                      visual={
                        <div
                          className="metric-art certificates"
                          aria-hidden="true"
                        >
                          <div>
                            <Landmark size={25} />
                            <span>BOND</span>
                            <i />
                            <i />
                          </div>
                          <div>
                            <ShieldCheck size={25} />
                            <span>{bond.symbol}</span>
                            <i />
                            <i />
                          </div>
                          <div>
                            <Landmark size={25} />
                            <span>MOCK USD</span>
                            <i />
                            <i />
                          </div>
                        </div>
                      }
                    />
                    <Metric
                      label="Annual coupon rate"
                      value={`${(bond.couponBps / 100).toFixed(1)}%`}
                      detail={`${bond.paymentsPerYear} payments per year · Fixed rate`}
                      icon={<Coins size={18} />}
                      visual={
                        <div
                          className="metric-art coupon-art"
                          aria-hidden="true"
                        >
                          <div className="rate-orbit">
                            <Coins size={34} />
                          </div>
                          <span>
                            FIXED COUPON
                            <small>
                              {bond.paymentsPerYear} scheduled payments / year
                            </small>
                          </span>
                        </div>
                      }
                    />
                    <Metric
                      label="Registered holders"
                      value={String(bond.holders.length).padStart(2, "0")}
                      detail="Wallets in the holder registry"
                      icon={<Users size={18} />}
                      visual={
                        <div
                          className="metric-art holders-art"
                          aria-hidden="true"
                        >
                          {bond.holders.map((h, i) => (
                            <span key={h.wallet} style={{ zIndex: 8 - i }}>
                              <Users size={22} />
                              <small>{String(i + 1).padStart(2, "0")}</small>
                            </span>
                          ))}
                        </div>
                      }
                    />
                    <Metric
                      label="Total distributed"
                      value={money(paid, 0)}
                      detail={`${bond.actions.filter((a) => a.status === "completed").length} corporate actions completed`}
                      icon={<ArrowDownLeft size={18} />}
                      visual={<DistributionChart actions={bond.actions} />}
                    />
                  </section>
                  <section className="bond-card">
                    <div className="bond-main">
                      <span className="bond-icon">
                        <Landmark size={25} />
                      </span>
                      <div>
                        <div className="inline">
                          <h2>{bond.name}</h2>
                          <span
                            className={`badge ${bond.outstanding === "0" ? "neutral" : "green"}`}
                          >
                            {bond.outstanding === "0" ? "Redeemed" : "Active"}
                          </span>
                        </div>
                        <p>
                          {bond.symbol}
                          <span>•</span>Tokenized fixed-income instrument
                        </p>
                      </div>
                      <button
                        className="icon-button"
                        aria-label="Refresh bond"
                        disabled={!!busy}
                        onClick={() =>
                          mode === "devnet"
                            ? run("Refreshing…", () => refresh())
                            : setNotice({
                                text: "Local workspace is up to date.",
                              })
                        }
                      >
                        <RefreshCw size={17} />
                      </button>
                    </div>
                    <div className="bond-details">
                      <div>
                        <span>Face value</span>
                        <strong>{money(bond.faceValue)}</strong>
                      </div>
                      <div>
                        <span>Maturity</span>
                        <strong>{date(bond.maturity)}</strong>
                      </div>
                      <div>
                        <span>Settlement asset</span>
                        <strong>
                          <span className="currency-icon">$</span>Mock USD{" "}
                          <small>TEST</small>
                        </strong>
                      </div>
                      <div>
                        <span>Ownership</span>
                        <strong>
                          <ShieldCheck size={14} /> Non-transferable
                        </strong>
                      </div>
                      {bond.address && (
                        <a
                          className="text-button"
                          href={chain.explorer(bond.address, "address")}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View on Solana <ExternalLink size={14} />
                        </a>
                      )}
                    </div>
                  </section>
                </>
              )}
              {(view === "Overview" || view === "Corporate actions") && (
                <div className="action-grid">
                  <section className="panel action-list">
                    <div className="panel-heading">
                      <div>
                        <h2>
                          Corporate actions{" "}
                          <span className="count">{bond.actions.length}</span>
                        </h2>
                        <p>From record date to final settlement</p>
                      </div>
                      <button
                        className="icon-button"
                        aria-label="Schedule corporate action"
                        disabled={
                          !!busy ||
                          !!current ||
                          bond.outstanding === "0" ||
                          !canSign
                        }
                        onClick={() => openAction()}
                      >
                        <Plus size={20} />
                      </button>
                    </div>
                    <div className="action-rows">
                      {bond.actions.length === 0 ? (
                        <div className="mini-empty">
                          <CalendarDays size={28} />
                          <strong>No actions scheduled yet</strong>
                          <p>Start with a coupon payment.</p>
                          <button
                            className="button secondary"
                            disabled={!canSign || !!busy}
                            onClick={() => openAction()}
                          >
                            Schedule first action <ArrowRight size={15} />
                          </button>
                        </div>
                      ) : (
                        [...bond.actions].reverse().map((a) => (
                          <button
                            key={a.id}
                            className={`action-row ${action?.id === a.id ? "selected" : ""}`}
                            onClick={() => setSelected(a.id)}
                          >
                            <span className={`action-icon ${a.kind}`}>
                              {a.kind === "coupon" ? (
                                <Coins size={19} />
                              ) : a.kind === "early" ? (
                                <Zap size={19} />
                              ) : (
                                <ArrowDownToLine size={19} />
                              )}
                            </span>
                            <span className="action-row-text">
                              <strong>{actionLabel[a.kind]}</strong>
                              <small>
                                {a.kind === "coupon"
                                  ? `Coupon ${String(a.couponIndex).padStart(2, "0")}`
                                  : `Action ${String(a.id + 1).padStart(2, "0")}`}
                                <span>·</span>
                                {date(a.recordDate)}
                              </small>
                            </span>
                            <span className={`status-dot ${a.status}`} />
                            <ArrowRight size={15} />
                          </button>
                        ))
                      )}
                    </div>
                    <div className="action-list-footer">
                      <ShieldCheck size={15} />
                      {mode === "demo"
                        ? "Local simulation · No on-chain proof"
                        : "Entitlements secured on Solana"}
                    </div>
                  </section>
                  <section className="panel action-detail">
                    {!action ? (
                      <div className="action-placeholder">
                        <span className="circle-grid">
                          <Blocks size={32} />
                        </span>
                        <h3>Your next action, in focus.</h3>
                        <p>
                          Select or schedule an action to review its timeline,
                          entitlements and settlement.
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="panel-heading">
                          <div>
                            <div className="eyebrow">
                              ACTION {String(action.id + 1).padStart(3, "0")}
                            </div>
                            <h2>{actionLabel[action.kind]}</h2>
                          </div>
                          <span
                            className={`badge ${action.status === "completed" ? "green" : action.status === "cancelled" ? "neutral" : "amber"}`}
                          >
                            {statusText(action.status)}
                          </span>
                        </div>
                        <div className="timeline">
                          {["Record date", "Entitlements", "Settlement"].map(
                            (label, i) => {
                              const complete =
                                action.status === "completed" ||
                                (i < 2 && !!action.snapshotAt);
                              return (
                                <div
                                  key={label}
                                  className={
                                    complete
                                      ? "done"
                                      : i === 0 ||
                                          action.status === "ready" ||
                                          action.status === "processing"
                                        ? "next"
                                        : ""
                                  }
                                >
                                  <span>
                                    {complete ? <Check size={13} /> : i + 1}
                                  </span>
                                  <strong>{label}</strong>
                                  <small>
                                    {i === 0
                                      ? date(action.recordDate)
                                      : i === 1
                                        ? action.snapshotAt
                                          ? `${action.entitlements.length} holders fixed`
                                          : "Awaiting snapshot"
                                        : action.status === "completed"
                                          ? "All holders settled"
                                          : action.status === "processing"
                                            ? "Partially settled"
                                            : "Not executed"}
                                  </small>
                                </div>
                              );
                            },
                          )}
                        </div>
                        <div className="entitlement-heading">
                          <h3>Holder entitlements</h3>
                          {action.snapshotAt && (
                            <span>
                              <ShieldCheck size={13} />
                              Snapshot locked
                            </span>
                          )}
                        </div>
                        {action.status === "cancelled" && !action.snapshotAt ? (
                          <div className="awaiting">
                            <X size={20} />
                            <div>
                              <strong>Action cancelled</strong>
                              <p>No entitlements were captured or paid.</p>
                            </div>
                          </div>
                        ) : !action.snapshotAt ? (
                          <div className="awaiting">
                            <Clock3 size={22} />
                            <div>
                              <strong>Waiting for record date</strong>
                              <p>
                                {now < action.recordDate
                                  ? `Snapshot available in ${Math.max(0, action.recordDate - now)} seconds.`
                                  : "Ready to capture the on-chain snapshot."}
                              </p>
                            </div>
                            {mode === "demo" ? (
                              <button
                                className="button secondary small"
                                disabled={!!busy}
                                onClick={() =>
                                  setStore((s) => ({
                                    ...s,
                                    clockOffset:
                                      s.clockOffset +
                                      Math.max(0, action.recordDate - now),
                                  }))
                                }
                              >
                                <Play size={13} />
                                Advance demo
                              </button>
                            ) : (
                              <button
                                className="button secondary small"
                                disabled={
                                  !!busy ||
                                  now < action.recordDate ||
                                  !wallet ||
                                  action.status === "cancelled"
                                }
                                onClick={() =>
                                  run("Capturing snapshot…", async () => {
                                    const { conn, program, signer } = context();
                                    await chain.takeSnapshot(
                                      conn,
                                      program,
                                      signer,
                                      new PublicKey(bond.address!),
                                      action.id,
                                    );
                                    await refresh();
                                  })
                                }
                              >
                                Capture snapshot
                              </button>
                            )}
                          </div>
                        ) : (
                          <div className="table-scroll">
                            <table className="entitlements">
                              <thead>
                                <tr>
                                  <th>INVESTOR</th>
                                  <th>
                                    {action.kind === "coupon"
                                      ? "ENTITLEMENT"
                                      : "BONDS"}
                                  </th>
                                  <th>AMOUNT</th>
                                  <th>STATUS</th>
                                </tr>
                              </thead>
                              <tbody>
                                {action.entitlements.map((h, i) => (
                                  <tr key={h.wallet}>
                                    <td>
                                      <span
                                        className={`avatar avatar-${i % 3}`}
                                      >
                                        {String(i + 1).padStart(2, "0")}
                                      </span>
                                      <span>
                                        {bond.holders.find(
                                          (x) => x.wallet === h.wallet,
                                        )?.name || short(h.wallet)}
                                        <small className="wallet-address">
                                          {short(h.wallet)}
                                        </small>
                                      </span>
                                    </td>
                                    <td
                                      data-label={
                                        action.kind === "coupon"
                                          ? "Entitlement"
                                          : "Bonds redeemed"
                                      }
                                    >
                                      {action.kind === "coupon"
                                        ? `${h.eligibleQuantity ?? "?"} bonds`
                                        : h.quantity}
                                    </td>
                                    <td className="amount">
                                      {money(h.amount)}
                                    </td>
                                    <td>
                                      {h.settled ? (
                                        <span className="paid">
                                          <CheckCircle2 size={13} />
                                          Settled
                                        </span>
                                      ) : (
                                        <span className="muted">Pending</span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr>
                                  <td colSpan={2}>Total distribution</td>
                                  <td className="amount">
                                    {money(action.total)}
                                  </td>
                                  <td>
                                    <span className="asset-tag">MOCK USD</span>
                                  </td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        )}
                        <div className="action-bottom">
                          <div>
                            {action.status === "completed" ? (
                              <span className="paid">
                                <CheckCircle2 size={16} />
                                {mode === "demo"
                                  ? "Simulation completed"
                                  : "Settlement confirmed"}
                              </span>
                            ) : (
                              <>
                                <ShieldCheck size={15} />
                                <span>
                                  {mode === "demo"
                                    ? "Simulated execution"
                                    : "Issuer signature required"}
                                </span>
                              </>
                            )}
                          </div>
                          {action.signature ? (
                            <a
                              className="button secondary small"
                              target="_blank"
                              rel="noreferrer"
                              href={chain.explorer(action.signature)}
                            >
                              View transaction
                              <ExternalLink size={13} />
                            </a>
                          ) : null}
                          {["ready", "processing"].includes(action.status) && (
                            <button
                              className="button primary"
                              disabled={!!busy || !canSign}
                              onClick={execute}
                            >
                              {!!busy ? (
                                <LoaderCircle size={16} className="spin" />
                              ) : (
                                <Zap size={16} />
                              )}{" "}
                              {action.status === "processing"
                                ? "Resume settlement"
                                : "Execute settlement"}
                              <ArrowRight size={15} />
                            </button>
                          )}
                          {action.status === "scheduled" && (
                            <span className="muted">
                              Scheduled for {date(action.recordDate)}
                            </span>
                          )}
                        </div>
                        {["scheduled", "ready"].includes(action.status) &&
                          canSign && (
                            <button
                              className="cancel-link"
                              disabled={!!busy}
                              onClick={cancelCurrent}
                            >
                              Cancel action before settlement
                            </button>
                          )}
                      </>
                    )}
                  </section>
                </div>
              )}
              {view === "Holder registry" && (
                <section className="panel registry">
                  <div className="panel-heading">
                    <div>
                      <h2>Holder registry</h2>
                      <p>
                        {bond.sealed
                          ? "Registry sealed · Ownership fixed for this issuance"
                          : "Distribution open until the first action is scheduled"}
                      </p>
                    </div>
                    <span className="badge neutral">
                      <Users size={13} />
                      {bond.holders.length} investors
                    </span>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>INVESTOR / WALLET</th>
                          <th>BONDS HELD</th>
                          <th>PRINCIPAL VALUE</th>
                          <th>DISTRIBUTED</th>
                          <th>ALLOCATION</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bond.holders.map((h, i) => {
                          const percent =
                            BigInt(bond.outstanding) > 0n
                              ? Number(
                                  (BigInt(h.quantity) * 10000n) /
                                    BigInt(bond.outstanding),
                                ) / 100
                              : 0;
                          return (
                            <tr key={h.wallet}>
                              <td>
                                <span className={`avatar avatar-${i % 3}`}>
                                  {h.name
                                    .split(" ")
                                    .map((s) => s[0])
                                    .slice(0, 2)
                                    .join("")}
                                </span>
                                <span>
                                  <strong>{h.name}</strong>
                                  <small className="wallet-address">
                                    {short(h.wallet)}{" "}
                                    <button
                                      aria-label={`Copy wallet of ${h.name}`}
                                      onClick={() => copy(h.wallet)}
                                    >
                                      <Copy size={11} />
                                    </button>
                                    {mode === "devnet" && (
                                      <a
                                        href={chain.explorer(
                                          h.wallet,
                                          "address",
                                        )}
                                        target="_blank"
                                        rel="noreferrer"
                                        aria-label="View holder on Explorer"
                                      >
                                        <ExternalLink size={11} />
                                      </a>
                                    )}
                                  </small>
                                </span>
                              </td>
                              <td>{h.quantity}</td>
                              <td>
                                {money(
                                  BigInt(h.quantity) * BigInt(bond.faceValue),
                                )}
                              </td>
                              <td>{money(h.paid)}</td>
                              <td>
                                <div className="allocation">
                                  <span style={{ width: `${percent}%` }} />
                                </div>
                                <span>{percent}%</span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              {view === "Activity" && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Action history</h2>
                      <p>
                        {mode === "demo"
                          ? "Local records are simulations, not proof of payment."
                          : "Action accounts and confirmed Solana transaction signatures."}
                      </p>
                    </div>
                    <select
                      aria-label="Filter action history"
                      value={historyFilter}
                      onChange={(e) => setHistoryFilter(e.target.value)}
                    >
                      <option value="all">All statuses</option>
                      <option value="completed">Completed</option>
                      <option value="scheduled">Scheduled</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>ACTION</th>
                          <th>RECORD DATE</th>
                          <th>AMOUNT</th>
                          <th>STATUS</th>
                          <th>VERIFICATION</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bond.actions
                          .filter(
                            (a) =>
                              historyFilter === "all" ||
                              a.status === historyFilter,
                          )
                          .map((a) => (
                            <tr key={a.id}>
                              <td>
                                <button
                                  className="text-button"
                                  onClick={() => {
                                    setSelected(a.id);
                                    setView("Corporate actions");
                                  }}
                                >
                                  {actionLabel[a.kind]}{" "}
                                  <ArrowUpRight size={13} />
                                </button>
                              </td>
                              <td>{date(a.recordDate)}</td>
                              <td>
                                {a.snapshotAt
                                  ? money(a.total)
                                  : "Awaiting snapshot"}
                              </td>
                              <td>
                                <span
                                  className={`badge ${a.status === "completed" ? "green" : "neutral"}`}
                                >
                                  {statusText(a.status)}
                                </span>
                              </td>
                              <td>
                                {a.address ? (
                                  <a
                                    className="text-button"
                                    href={chain.explorer(a.address, "address")}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    On-chain record <ExternalLink size={13} />
                                  </a>
                                ) : (
                                  <span className="muted">
                                    Local simulation
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                    {!bond.actions.filter(
                      (a) =>
                        historyFilter === "all" || a.status === historyFilter,
                    ).length && (
                      <div className="mini-empty">No matching actions yet.</div>
                    )}
                  </div>
                </section>
              )}
              <section className="treasury-strip">
                <span className="treasury-icon">
                  <Wallet size={21} />
                </span>
                <div>
                  <strong>Settlement treasury</strong>
                  <span>
                    {money(bond.treasury)} <small>MOCK USD</small>
                  </span>
                </div>
                <p>Test assets only. Ready when your next action is.</p>
                <button
                  className="button secondary small"
                  disabled={!!busy || !canSign}
                  onClick={() => setModal("fund")}
                >
                  <Plus size={14} />
                  Fund treasury
                </button>
              </section>
            </>
          )}
          <footer>
            <span>
              <span className="dot" />{" "}
              {mode === "demo" ? "Local simulation" : "Solana Devnet"}{" "}
              <span>·</span> Corporate Actions Engine v0.1
            </span>
            <span>
              Built for the KASE track <span>↗</span>
            </span>
            {mode === "demo" && bond && (
              <button onClick={() => setModal("reset")}>
                <RotateCcw size={12} />
                Reset demo
              </button>
            )}
          </footer>
        </main>
      </div>
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            className={`modal ${modal === "create" ? "wide" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <div className="modal-heading">
              <div>
                <div className="eyebrow">
                  {mode === "demo" ? "LOCAL DEMO" : "SOLANA DEVNET"}
                </div>
                <h2 id="modal-title">
                  {modal === "create"
                    ? "Create a tokenized bond"
                    : modal === "action"
                      ? "Schedule corporate action"
                      : modal === "fund"
                        ? "Fund settlement treasury"
                        : modal === "load"
                          ? "Open a Devnet bond"
                          : modal === "reset"
                            ? "Reset local demo?"
                            : "Your demo, step by step"}
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close dialog"
                disabled={!!busy}
                onClick={() => setModal(null)}
              >
                <X size={20} />
              </button>
            </div>
            {notice?.error && (
              <div className="notice error" role="alert">
                <AlertCircle size={18} />
                {notice.text}
              </div>
            )}
            {busy && (
              <div className="busy" role="status">
                <LoaderCircle size={16} className="spin" />
                {busy}
              </div>
            )}
            {modal === "create" && draft && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  create();
                }}
              >
                <p className="form-intro">
                  Issue a non-transferable test bond and allocate it to up to 8
                  wallets. Existing issuances stay on-chain; this workspace
                  shows one at a time.
                </p>
                <div className="form-grid">
                  <Field label="Bond name">
                    <input
                      required
                      maxLength={48}
                      value={draft.name}
                      onChange={(e) =>
                        setDraft({ ...draft, name: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Symbol">
                    <input
                      required
                      maxLength={12}
                      value={draft.symbol}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          symbol: e.target.value.toUpperCase(),
                        })
                      }
                    />
                  </Field>
                  <Field label="Face value (mock USD)">
                    <input
                      required
                      type="number"
                      min="1"
                      defaultValue="1000"
                      onChange={(e) => {
                        try {
                          setDraft({
                            ...draft,
                            faceValue: parseMoney(e.target.value),
                          });
                        } catch {}
                      }}
                    />
                  </Field>
                  <Field label="Annual coupon (%)">
                    <input
                      required
                      type="number"
                      min="0.01"
                      max="100"
                      step="0.01"
                      value={draft.couponBps / 100}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          couponBps: Math.round(Number(e.target.value) * 100),
                        })
                      }
                    />
                  </Field>
                  <Field label="Payments per year">
                    <select
                      value={draft.paymentsPerYear}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          paymentsPerYear: Number(e.target.value),
                        })
                      }
                    >
                      <option value={1}>Annual · 1</option>
                      <option value={2}>Semiannual · 2</option>
                      <option value={4}>Quarterly · 4</option>
                      <option value={12}>Monthly · 12</option>
                    </select>
                  </Field>
                  <Field label="Maturity (your local time)">
                    <input
                      required
                      type="datetime-local"
                      step="1"
                      value={inputDate(draft.maturity)}
                      onChange={(e) => {
                        if (e.target.value)
                          setDraft({
                            ...draft,
                            maturity: Math.floor(
                              new Date(e.target.value).getTime() / 1000,
                            ),
                          });
                      }}
                    />
                  </Field>
                  <Field label="Demo coupon interval (seconds)">
                    <input
                      required
                      type="number"
                      min="1"
                      value={draft.periodSeconds}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          periodSeconds: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field label="Treasury funding (mock USD)">
                    <input
                      required
                      type="number"
                      min="0"
                      defaultValue="50000"
                      onChange={(e) => {
                        try {
                          setDraft({
                            ...draft,
                            treasury: parseMoney(e.target.value),
                          });
                        } catch {}
                      }}
                    />
                  </Field>
                </div>
                <p className="field-help">
                  <Clock3 size={13} />
                  Accelerated demo schedule. Coupon amount still uses the
                  selected annual rate and payment frequency.
                </p>
                <div className="form-section-title">
                  <h3>Initial holder allocation</h3>
                  <span>Public test wallets · replace with your own</span>
                </div>
                {draft.holders.map((h, i) => (
                  <div className="holder-input" key={i}>
                    <input
                      aria-label={`Investor ${i + 1} name`}
                      required
                      value={h.name}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          holders: draft.holders.map((x, j) =>
                            i === j ? { ...x, name: e.target.value } : x,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label={`Investor ${i + 1} wallet`}
                      required
                      value={h.wallet}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          holders: draft.holders.map((x, j) =>
                            i === j
                              ? { ...x, wallet: e.target.value.trim() }
                              : x,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label={`Investor ${i + 1} bonds`}
                      required
                      type="number"
                      min="1"
                      step="1"
                      value={h.quantity}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          holders: draft.holders.map((x, j) =>
                            i === j ? { ...x, quantity: e.target.value } : x,
                          ),
                        })
                      }
                    />
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Remove investor ${i + 1}`}
                      disabled={draft.holders.length === 1}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          holders: draft.holders.filter((_, j) => j !== i),
                        })
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                {draft.holders.length < 8 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        holders: [
                          ...draft.holders,
                          {
                            name: `Investor ${draft.holders.length + 1}`,
                            wallet: "",
                            quantity: "10",
                            paid: "0",
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={14} />
                    Add holder
                  </button>
                )}
                <div className="modal-footer">
                  <span>
                    {mode === "demo"
                      ? "No wallet required. No real funds."
                      : "Requires Devnet SOL and several wallet confirmations."}
                  </span>
                  <button
                    className="button primary"
                    disabled={
                      !!busy ||
                      (mode === "devnet" &&
                        (!wallet || programStatus !== "ready"))
                    }
                    type="submit"
                  >
                    Create bond <ArrowRight size={15} />
                  </button>
                </div>
              </form>
            )}
            {modal === "action" && bond && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  announceAction();
                }}
              >
                <div className="action-options">
                  {(["coupon", "early", "redemption"] as ActionKind[]).map(
                    (k) => (
                      <button
                        type="button"
                        key={k}
                        className={kind === k ? "chosen" : ""}
                        onClick={() => {
                          setKind(k);
                          setRecordDate(
                            inputDate(
                              Math.max(
                                now + 30,
                                k === "redemption"
                                  ? bond.maturity
                                  : k === "coupon"
                                    ? bond.issuedAt +
                                      bond.periodSeconds *
                                        (bond.couponCount + 1)
                                    : now + 30,
                              ),
                            ),
                          );
                        }}
                      >
                        {k === "coupon" ? (
                          <Coins size={19} />
                        ) : k === "early" ? (
                          <Zap size={19} />
                        ) : (
                          <ArrowDownToLine size={19} />
                        )}
                        <strong>
                          {k === "coupon"
                            ? "Coupon"
                            : k === "early"
                              ? "Early redemption"
                              : "At maturity"}
                        </strong>
                      </button>
                    ),
                  )}
                </div>
                <Field label="Record date (your local time)">
                  <input
                    type="datetime-local"
                    required
                    step="1"
                    value={recordDate}
                    onChange={(e) => setRecordDate(e.target.value)}
                  />
                </Field>
                {kind === "early" && (
                  <Field
                    label={`Bonds to redeem · ${bond.outstanding} outstanding`}
                  >
                    <input
                      type="number"
                      required
                      min="1"
                      max={bond.outstanding}
                      step="1"
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                    />
                  </Field>
                )}
                <p className="field-help">
                  {kind === "coupon"
                    ? `Fixed coupon: holdings × ${money(bond.faceValue)} × ${bond.couponBps / 100}% ÷ ${bond.paymentsPerYear}. Rounded down to 6 decimal places.`
                    : kind === "early"
                      ? "Allocated proportionally. Whole-bond remainders go to the largest fractions; ties follow registry order. Accrued coupon is a separate action."
                      : "Redeems the remaining principal and burns the corresponding bond tokens. Coupon is a separate action."}
                </p>
                <div className="preview-total">
                  <span>
                    Estimated distribution
                    <small>Finalized at record date</small>
                  </span>
                  <strong>
                    {money(preview.reduce((n, h) => n + BigInt(h.amount), 0n))}
                  </strong>
                </div>
                <p className="field-help">
                  <ShieldCheck size={14} />
                  Scheduling seals the holder registry. Only one action can be
                  active at a time.
                </p>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setModal(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={!!busy || !canSign}
                  >
                    Schedule action
                    <ArrowRight size={15} />
                  </button>
                </div>
              </form>
            )}
            {modal === "fund" && bond && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run("Funding treasury…", async () => {
                    const amount = parseMoney(funding);
                    if (BigInt(amount) <= 0n)
                      throw new Error("Enter a positive amount.");
                    if (mode === "demo") {
                      setStore((s) => ({
                        ...s,
                        bond: {
                          ...bond,
                          treasury: (
                            BigInt(bond.treasury) + BigInt(amount)
                          ).toString(),
                        },
                      }));
                    } else {
                      const { conn, signer } = context();
                      await chain.fundTreasury(
                        conn,
                        signer,
                        new PublicKey(bond.address!),
                        networkBond!.paymentMint,
                        BigInt(amount),
                      );
                      await refresh();
                    }
                    setModal(null);
                    setNotice({
                      text: "Treasury funded with test-only mock USD.",
                    });
                  });
                }}
              >
                <p className="form-intro">
                  Mint test-only mock USD into this bond’s treasury. These
                  assets have no monetary value.
                </p>
                <Field label="Amount (mock USD)">
                  <input
                    type="number"
                    min="0.000001"
                    step="0.000001"
                    required
                    value={funding}
                    onChange={(e) => setFunding(e.target.value)}
                  />
                </Field>
                <div className="modal-footer">
                  <span>Current balance: {money(bond.treasury)}</span>
                  <button className="button primary" disabled={!!busy}>
                    Fund treasury
                  </button>
                </div>
              </form>
            )}
            {modal === "load" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run("Loading bond from Devnet…", async () => {
                    if (!chain.PROGRAM_ID)
                      throw new Error(
                        "Set NEXT_PUBLIC_PROGRAM_ID after deploying the program.",
                      );
                    await refresh(loadAddress);
                    setModal(null);
                  });
                }}
              >
                <p className="form-intro">
                  Paste the bond account address from a previous issuance. The
                  complete state will be loaded from Solana.
                </p>
                <Field label="Bond account address">
                  <input
                    value={loadAddress}
                    onChange={(e) => setLoadAddress(e.target.value.trim())}
                    required
                    placeholder="Solana account address"
                  />
                </Field>
                <div className="modal-footer">
                  <span>Network: Solana Devnet</span>
                  <button className="button primary" disabled={!!busy}>
                    Open bond
                  </button>
                </div>
              </form>
            )}
            {modal === "reset" && (
              <>
                <p className="form-intro">
                  This removes this browser’s local bond, actions and simulated
                  balances. Devnet accounts are unaffected.
                </p>
                <div className="modal-footer">
                  <button
                    className="button secondary"
                    onClick={() => setModal(null)}
                  >
                    Keep demo
                  </button>
                  <button
                    className="button danger"
                    onClick={() => {
                      setStore({ version: 1, bond: null, clockOffset: 0 });
                      setSelected(null);
                      setModal(null);
                    }}
                  >
                    Reset local demo
                  </button>
                </div>
              </>
            )}
            {modal === "help" && (
              <>
                <p className="form-intro">
                  Three corporate actions. One transparent lifecycle.
                </p>
                <ol className="guide">
                  <li>
                    <strong>Create a bond</strong>
                    <p>
                      Use the preset $1,000 face value, 10% annual coupon and
                      three investors. Demo coupon periods take 60 seconds.
                    </p>
                  </li>
                  <li>
                    <strong>Pay a coupon</strong>
                    <p>
                      Schedule a coupon, wait for record date or use “Advance
                      demo” locally. Review entitlements and execute: 10 bonds
                      receive $500.
                    </p>
                  </li>
                  <li>
                    <strong>Redeem early</strong>
                    <p>
                      Redeem 10 of 40 bonds. The program allocates 3, 5 and 2
                      bonds across the investors, then settles principal.
                    </p>
                  </li>
                  <li>
                    <strong>Redeem the remainder</strong>
                    <p>
                      Schedule maturity redemption, reach its record date and
                      settle the remaining 30 bonds. Review the completed
                      history.
                    </p>
                  </li>
                </ol>
                <div className="guide-note">
                  <ShieldCheck size={19} />
                  <p>
                    <strong>Know your environment.</strong> Local demo never
                    sends transactions. Devnet uses wallet signatures, mock USD
                    transfers and on-chain records. Frozen, non-transferable
                    bond tokens prevent changes to eligibility between
                    scheduling and snapshot.
                  </p>
                </div>
                <div className="modal-footer">
                  <span>English interface · KASE hackathon MVP</span>
                  <button
                    className="button primary"
                    onClick={() => setModal(null)}
                  >
                    Got it
                    <Check size={15} />
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon,
  visual,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
  visual?: React.ReactNode;
}) {
  return (
    <article className="metric">
      <div>
        <span>{label}</span>
        {icon}
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
      {visual}
    </article>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function DistributionChart({ actions }: { actions: CorporateAction[] }) {
  const amounts = actions.map((a) =>
    a.entitlements
      .filter((e) => e.settled)
      .reduce((n, e) => n + Number(e.amount), 0),
  );
  const total = amounts.reduce((n, a) => n + a, 0);
  let cumulative = 0;
  const points = [
    [4, 76],
    ...amounts.map((amount, i) => {
      cumulative += amount;
      return [
        4 + ((i + 1) * 252) / Math.max(1, amounts.length),
        76 - (total ? (cumulative / total) * 62 : 0),
      ];
    }),
  ];
  const line = points.map((p) => p.join(",")).join(" ");
  return (
    <svg
      className="metric-art distribution-chart"
      viewBox="0 0 260 90"
      role="img"
      aria-label={
        total
          ? "Cumulative settled distributions by action"
          : "No distributions settled yet"
      }
    >
      <path
        d="M4 25H256M4 50H256M4 76H256"
        stroke="#eae6f5"
        strokeDasharray="3 5"
      />
      <polygon points={"4,86 " + line + " 256,86"} fill="#ede8ff" />
      <polyline points={line} fill="none" stroke="#7859eb" strokeWidth="2.5" />
      {points.map(([x, y], i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r="3.2"
          fill="#faf9ff"
          stroke="#7859eb"
          strokeWidth="1.7"
        />
      ))}
    </svg>
  );
}
