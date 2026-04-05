import type { Chain } from "viem";
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeFunctionData,
  hexToBytes,
  namehash,
  toHex,
  toBytes,
} from "viem";
import {
  ethRegistrarControllerAbi,
  passkeySmartAccountAbi,
  passkeySmartAccountFactoryAbi,
  publicResolverAbi,
} from "./abis.js";
import { ensEvmCoinType } from "./ensCoinType.js";
import type { WebAuthnAuth } from "./passkey.js";
import {
  acrossInputAmountForMinOutput,
  bridgeEthAcrossDepositV3,
  fetchAcrossSuggestedFees,
  resolveAcrossEthRoute,
  waitForMinNativeBalance,
} from "./acrossBridge.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type AcrossBridgeConfig = {
  /**
   * Chain where the wallet holds ETH for Across `depositV3` and ENS registration.
   * Defaults to `ensChain` (typical: fund only Ethereum mainnet).
   */
  fundingChain?: Chain;
  /** Extra bps on top of estimated `createAccount` gas (destination native). Default 3000 (30%). */
  destinationGasBufferBps?: number;
  /** Max time to wait for relayer to credit the destination chain. Default 5 minutes. */
  maxWaitForFillMs?: number;
  /** Poll interval when waiting for destination native balance. Default 2500 ms. */
  fillPollMs?: number;
};

export type OnboardParams = {
  /** Chains where the passkey account should be deployed (must include `ensChain`). */
  chains: readonly [Chain, ...Chain[]];
  /** Chain where `.eth` registration and resolver updates happen (typically Ethereum mainnet). */
  ensChain: Chain;
  factoryAddress: Address;
  passkeyPublicKey: { x: Hex; y: Hex };
  salt: Hex;
  ens: {
    label: string;
    secret: Hex;
    duration: bigint;
    resolverAddress: Address;
    /** `Registration.reverseRecord` bitmask; use 0 to skip reverse setup. */
    reverseRecord?: number;
    referrer?: Hex;
    controllerAddress: Address;
  };
  walletClient: WalletClient;
  /** `chainId` → public client for reads and optional gas estimation. */
  publicClients: Record<number, PublicClient>;
  /**
   * Produce a WebAuthn assertion for `challenge` (the bytes returned by `PasskeySmartAccount.digest`).
   * Typically `navigator.credentials.get` with `publicKey.challenge` set to a `Uint8Array` view of these bytes.
   */
  signPasskey: (args: { challenge: Uint8Array }) => Promise<WebAuthnAuth>;
  /** Extra wei on top of `rentPrice` for registration (oracle movement). Default 5%. */
  registrationValueSlippageBps?: number;
  /**
   * When set, bridges native ETH from `fundingChain` (default `ensChain`) via Across to every other chain in `chains`
   * so the wallet can pay `createAccount` gas there without holding native tokens on those chains beforehand.
   * Every chain in `chains` must have an Across native ETH route from the funding chain.
   */
  acrossBridge?: AcrossBridgeConfig;
};

export type OnboardResult = {
  accountAddress: Address;
  ensNode: Hex;
  deployTxHashes: Hex[];
  /** Across `depositV3` tx hashes on the funding chain (only when `acrossBridge` is set). */
  bridgeTxHashes?: Hex[];
  reserveTxHash: Hex;
  registerTxHash: Hex;
  setAddrTxHash: Hex;
};

function clientFor(publicClients: Record<number, PublicClient>, chain: Chain): PublicClient {
  const c = publicClients[chain.id];
  if (!c) throw new Error(`Missing publicClients[${chain.id}] for chain ${chain.name}`);
  return c;
}

/**
 * End-to-end onboarding:
 * 1. Reserve `.eth` label (controller `commit`) then register with owner = counterfactual passkey account.
 * 2. Deploy `PasskeySmartAccount` via CREATE2 on each configured chain (same address everywhere).
 * 3. On `ensChain`, call resolver `multicall` with `setAddr` for each chain’s coin type (passkey `execute`).
 */
export async function onboard(p: OnboardParams): Promise<OnboardResult> {
  const {
    chains,
    ensChain,
    factoryAddress,
    passkeyPublicKey,
    salt,
    ens,
    walletClient,
    publicClients,
    signPasskey,
  } = p;

  if (!chains.some((c) => c.id === ensChain.id)) {
    throw new Error("ensChain must be included in chains[]");
  }

  const slippageBps = p.registrationValueSlippageBps ?? 500;
  const reverseRecord = ens.reverseRecord ?? 0;
  const referrer = ens.referrer ?? ("0x" + "0".repeat(64)) as Hex;
  const payer = walletClient.account;
  if (!payer) throw new Error("walletClient.account is required (funding / relayer EOA)");

  const ensPublic = clientFor(publicClients, ensChain);
  const accountAddress = (await ensPublic.readContract({
    address: factoryAddress,
    abi: passkeySmartAccountFactoryAbi,
    functionName: "predictAddress",
    args: [passkeyPublicKey.x, passkeyPublicKey.y, salt],
  })) as Address;

  const registration = {
    label: ens.label,
    owner: accountAddress,
    duration: ens.duration,
    secret: ens.secret,
    resolver: ens.resolverAddress,
    data: [] as `0x${string}`[],
    reverseRecord,
    referrer,
  } as const;

  const commitment = await ensPublic.readContract({
    address: ens.controllerAddress,
    abi: ethRegistrarControllerAbi,
    functionName: "makeCommitment",
    args: [registration],
  });

  const reserveHash = await walletClient.writeContract({
    account: payer,
    chain: ensChain,
    address: ens.controllerAddress,
    abi: ethRegistrarControllerAbi,
    functionName: "commit",
    args: [commitment],
  });

  await ensPublic.waitForTransactionReceipt({ hash: reserveHash });

  const minAge = await ensPublic.readContract({
    address: ens.controllerAddress,
    abi: ethRegistrarControllerAbi,
    functionName: "minCommitmentAge",
  });

  await sleep(Number(minAge) * 1000 + 2000);

  const price = await ensPublic.readContract({
    address: ens.controllerAddress,
    abi: ethRegistrarControllerAbi,
    functionName: "rentPrice",
    args: [ens.label, ens.duration],
  });
  const [base, premium] = price as readonly [bigint, bigint];
  const total = base + premium;
  const value = total + (total * BigInt(slippageBps)) / 10000n;

  const registerHash = await walletClient.writeContract({
    account: payer,
    chain: ensChain,
    address: ens.controllerAddress,
    abi: ethRegistrarControllerAbi,
    functionName: "register",
    args: [registration],
    value,
  });

  await ensPublic.waitForTransactionReceipt({ hash: registerHash });

  const bridgeHashes: Hex[] = [];
  if (p.acrossBridge !== undefined) {
    const fundingChain = p.acrossBridge.fundingChain ?? ensChain;
    const destGasBufferBps = p.acrossBridge.destinationGasBufferBps ?? 3000;
    const maxWaitForFillMs = p.acrossBridge.maxWaitForFillMs ?? 300_000;
    const fillPollMs = p.acrossBridge.fillPollMs ?? 2500;
    const fundingPublic = clientFor(publicClients, fundingChain);

    for (const chain of chains) {
      if (chain.id === fundingChain.id) continue;

      const destPublic = clientFor(publicClients, chain);
      const gas = await destPublic.estimateContractGas({
        address: factoryAddress,
        abi: passkeySmartAccountFactoryAbi,
        functionName: "createAccount",
        args: [passkeyPublicKey.x, passkeyPublicKey.y, salt],
        account: payer.address,
      });
      const gasPrice = await destPublic.getGasPrice();
      const minDestWei = (gas * gasPrice * (10000n + BigInt(destGasBufferBps))) / 10000n;

      const existing = await destPublic.getBalance({ address: payer.address });
      if (existing >= minDestWei) continue;

      const { inputToken, outputToken } = await resolveAcrossEthRoute(fundingChain.id, chain.id);
      const { inputAmount } = await acrossInputAmountForMinOutput({
        inputToken,
        outputToken,
        originChainId: fundingChain.id,
        destinationChainId: chain.id,
        minOutputWei: minDestWei,
      });

      const quote = await fetchAcrossSuggestedFees({
        inputToken,
        outputToken,
        originChainId: fundingChain.id,
        destinationChainId: chain.id,
        inputAmount,
      });
      if (quote.isAmountTooLow || BigInt(quote.outputAmount) < minDestWei) {
        throw new Error(
          `Across quote insufficient for chain ${chain.id}: outputAmount=${quote.outputAmount}, need >= ${minDestWei}`,
        );
      }

      const bridgeHash = await bridgeEthAcrossDepositV3({
        walletClient,
        fundingChain,
        destinationChainId: chain.id,
        recipient: payer.address,
        inputAmount,
        quote,
        inputToken,
        outputToken,
      });
      bridgeHashes.push(bridgeHash);
      await fundingPublic.waitForTransactionReceipt({ hash: bridgeHash });
      await waitForMinNativeBalance({
        publicClient: destPublic,
        address: payer.address,
        minWei: minDestWei,
        timeoutMs: maxWaitForFillMs,
        pollMs: fillPollMs,
      });
    }
  }

  const deployHashes: Hex[] = [];
  for (const chain of chains) {
    const pub = clientFor(publicClients, chain);
    const h = await walletClient.writeContract({
      account: payer,
      chain,
      address: factoryAddress,
      abi: passkeySmartAccountFactoryAbi,
      functionName: "createAccount",
      args: [passkeyPublicKey.x, passkeyPublicKey.y, salt],
    });
    deployHashes.push(h);
    await pub.waitForTransactionReceipt({ hash: h });
  }

  const node = namehash(`${ens.label}.eth`) as Hex;
  const innerCalls = chains.map((c) =>
    encodeFunctionData({
      abi: publicResolverAbi,
      functionName: "setAddr",
      args: [node, BigInt(ensEvmCoinType(c.id)), toHex(toBytes(accountAddress))],
    }),
  );

  const multicallData = encodeFunctionData({
    abi: publicResolverAbi,
    functionName: "multicall",
    args: [innerCalls],
  });

  const digestHex = (await ensPublic.readContract({
    address: accountAddress,
    abi: passkeySmartAccountAbi,
    functionName: "digest",
    args: [ens.resolverAddress, 0n, multicallData],
  })) as Hex;

  const challenge = hexToBytes(digestHex);
  const auth = await signPasskey({ challenge });

  /** Relayer / EOA pays gas; signature authorizes the call. `to` is the passkey account. */
  const setAddrHash = await walletClient.writeContract({
    account: payer,
    chain: ensChain,
    address: accountAddress,
    abi: passkeySmartAccountAbi,
    functionName: "execute",
    args: [ens.resolverAddress, 0n, multicallData, false, auth],
  });

  await ensPublic.waitForTransactionReceipt({ hash: setAddrHash });

  return {
    accountAddress,
    ensNode: node,
    deployTxHashes: deployHashes,
    ...(p.acrossBridge !== undefined ? { bridgeTxHashes: bridgeHashes } : {}),
    reserveTxHash: reserveHash,
    registerTxHash: registerHash,
    setAddrTxHash: setAddrHash,
  };
}
