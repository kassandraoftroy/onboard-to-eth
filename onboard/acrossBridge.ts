import type { Chain } from "viem";
import type { Address, Hex, PublicClient, WalletClient } from "viem";

const ACROSS_API = "https://app.across.to/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal ABI for `SpokePool.depositV3` (Across v3). */
export const acrossSpokePoolV3Abi = [
  {
    type: "function",
    name: "depositV3",
    stateMutability: "payable",
    inputs: [
      { name: "depositor", type: "address" },
      { name: "recipient", type: "address" },
      { name: "inputToken", type: "address" },
      { name: "outputToken", type: "address" },
      { name: "inputAmount", type: "uint256" },
      { name: "outputAmount", type: "uint256" },
      { name: "destinationChainId", type: "uint256" },
      { name: "exclusiveRelayer", type: "address" },
      { name: "quoteTimestamp", type: "uint32" },
      { name: "fillDeadline", type: "uint32" },
      { name: "exclusivityDeadline", type: "uint32" },
      { name: "message", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

type AvailableRoute = {
  originChainId: number;
  originToken: Address;
  destinationChainId: number;
  destinationToken: Address;
  originTokenSymbol: string;
  destinationTokenSymbol: string;
  isNative?: boolean;
};

export type SuggestedFeesQuote = {
  timestamp: string;
  outputAmount: string;
  spokePoolAddress: Address;
  fillDeadline: string;
  exclusiveRelayer: Address;
  exclusivityDeadline: number;
};

async function acrossGetJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ACROSS_API}${path}`);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Across API ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as T;
}

/**
 * Resolves the canonical ETH (native) bridge route between two EVM chains via Across `available-routes`.
 */
export async function resolveAcrossEthRoute(
  originChainId: number,
  destinationChainId: number,
): Promise<{ inputToken: Address; outputToken: Address }> {
  const routes = await acrossGetJson<AvailableRoute[]>(
    `/available-routes?originChainId=${originChainId}&destinationChainId=${destinationChainId}`,
  );
  const eth = routes.find(
    (r) =>
      r.isNative === true &&
      r.originTokenSymbol === "ETH" &&
      r.destinationTokenSymbol === "ETH" &&
      r.originChainId === originChainId &&
      r.destinationChainId === destinationChainId,
  );
  if (!eth) {
    throw new Error(
      `Across has no native ETH route from chain ${originChainId} to ${destinationChainId}. ` +
        `Only chains/routes listed by Across are supported.`,
    );
  }
  return { inputToken: eth.originToken, outputToken: eth.destinationToken };
}

export async function fetchAcrossSuggestedFees(args: {
  inputToken: Address;
  outputToken: Address;
  originChainId: number;
  destinationChainId: number;
  inputAmount: bigint;
}): Promise<SuggestedFeesQuote & { isAmountTooLow?: boolean; limits?: { minDeposit: string } }> {
  const q = new URLSearchParams({
    inputToken: args.inputToken,
    outputToken: args.outputToken,
    originChainId: String(args.originChainId),
    destinationChainId: String(args.destinationChainId),
    amount: args.inputAmount.toString(),
  });
  return acrossGetJson(`/suggested-fees?${q.toString()}`);
}

/**
 * Find a deposit `inputAmount` (origin wei) such that `outputAmount >= minOutputWei` according to the current quote.
 */
export async function acrossInputAmountForMinOutput(args: {
  inputToken: Address;
  outputToken: Address;
  originChainId: number;
  destinationChainId: number;
  minOutputWei: bigint;
  maxAttempts?: number;
}): Promise<{ inputAmount: bigint; quote: SuggestedFeesQuote }> {
  const { maxAttempts = 24 } = args;
  let probe = args.minOutputWei;
  let lastQuote: (SuggestedFeesQuote & { isAmountTooLow?: boolean; limits?: { minDeposit: string } }) | undefined;

  for (let i = 0; i < maxAttempts; i++) {
    lastQuote = await fetchAcrossSuggestedFees({
      inputToken: args.inputToken,
      outputToken: args.outputToken,
      originChainId: args.originChainId,
      destinationChainId: args.destinationChainId,
      inputAmount: probe,
    });
    if (lastQuote.isAmountTooLow) {
      const minD = lastQuote.limits?.minDeposit ? BigInt(lastQuote.limits.minDeposit) : probe * 2n;
      probe = minD > probe ? minD : probe * 2n;
      continue;
    }
    const out = BigInt(lastQuote.outputAmount);
    if (out >= args.minOutputWei) {
      return { inputAmount: probe, quote: lastQuote };
    }
    probe = (probe * 12n) / 10n + 1n;
  }
  throw new Error(
    `Could not find Across input amount for min output ${args.minOutputWei} after ${maxAttempts} attempts` +
      (lastQuote ? ` (last outputAmount=${lastQuote.outputAmount})` : ""),
  );
}

export async function waitForMinNativeBalance(args: {
  publicClient: PublicClient;
  address: Address;
  minWei: bigint;
  timeoutMs: number;
  pollMs: number;
}): Promise<void> {
  const deadline = Date.now() + args.timeoutMs;
  for (;;) {
    const bal = await args.publicClient.getBalance({ address: args.address });
    if (bal >= args.minWei) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timeout waiting for native balance on chain ${args.publicClient.chain?.id}: have ${bal}, need ${args.minWei}`,
      );
    }
    await sleep(args.pollMs);
  }
}

export type BridgeEthAcrossParams = {
  walletClient: WalletClient;
  fundingChain: Chain;
  destinationChainId: number;
  recipient: Address;
  /** `depositV3` input amount (and `msg.value`) in wei on the funding chain. */
  inputAmount: bigint;
  quote: SuggestedFeesQuote;
  inputToken: Address;
  outputToken: Address;
};

/**
 * Submits `depositV3` on the funding chain using native ETH (`msg.value == inputAmount`) with Across WETH as `inputToken`.
 */
export async function bridgeEthAcrossDepositV3(p: BridgeEthAcrossParams): Promise<Hex> {
  const account = p.walletClient.account;
  if (!account) throw new Error("walletClient.account is required");

  const outputAmount = BigInt(p.quote.outputAmount);
  const quoteTs = Number(p.quote.timestamp);
  const fillDl = Number(p.quote.fillDeadline);
  const exDl =
    typeof p.quote.exclusivityDeadline === "number"
      ? p.quote.exclusivityDeadline
      : Number(p.quote.exclusivityDeadline);

  if (!Number.isFinite(quoteTs) || !Number.isFinite(fillDl) || !Number.isFinite(exDl)) {
    throw new Error("Across quote has invalid numeric timestamp fields");
  }

  return p.walletClient.writeContract({
    account,
    chain: p.fundingChain,
    address: p.quote.spokePoolAddress,
    abi: acrossSpokePoolV3Abi,
    functionName: "depositV3",
    args: [
      account.address,
      p.recipient,
      p.inputToken,
      p.outputToken,
      p.inputAmount,
      outputAmount,
      BigInt(p.destinationChainId),
      p.quote.exclusiveRelayer,
      quoteTs,
      fillDl,
      exDl,
      "0x",
    ],
    value: p.inputAmount,
  });
}
