# onboard-to-eth

Foundry contracts plus TypeScript helpers to onboard with a **passkey-controlled smart account** and an **ENS** name whose multicoin `addr` records point at that account on each chain you care about.

## Smart account model

### `PasskeySmartAccount`

The account is a minimal contract ([`src/PasskeySmartAccount.sol`](src/PasskeySmartAccount.sol)) whose only authority is a **secp256r1 (P-256)** public key—the same curve WebAuthn / passkeys use.

- **`publicKeyX` / `publicKeyY`** – Immutable `bytes32` coordinates (left-padded big-endian field elements).
- **`nonce`** – Increments on every successful `execute`, so signatures cannot be replayed.
- **`digest(to, value, data)`** – Returns the exact **opaque bytes** you must supply as the WebAuthn **`publicKey.challenge`** when signing. The preimage binds `nonce`, `block.chainid`, the target call (`to`, `value`, `data`).
- **`execute(to, value, data, requireUserVerification, auth)`** – Verifies a **WebAuthn authentication assertion** (client data JSON + authenticator data + `(r, s)` on the SHA-256 message WebAuthn defines), then performs `to.call{value: value}(data)`. On-chain verification uses OpenZeppelin **`P256.verify`** (RIP-7212 precompile when the chain supports it, Solidity fallback otherwise).

Anyone can pay gas to submit `execute`; only someone who can satisfy the passkey check can authorize the inner call.

### `PasskeySmartAccountFactory`

[`src/PasskeySmartAccountFactory.sol`](src/PasskeySmartAccountFactory.sol) deploys accounts with **CREATE2** from `(publicKeyX, publicKeyY, salt)`. If this factory is deployed at the **same address** with the **same bytecode** on multiple chains, the **counterfactual address** of a given key + salt is **identical on every such chain**. That property is what lets one ENS name resolve to the “same” account address across L1 and L2s.

## ENS + passkey account shape

End state you are aiming for:

1. **`.eth` name** – Registered on the chain where ENS lives for that name (typically **Ethereum mainnet**), with **owner** set to your **passkey smart account address** (counterfactual at registration time is fine).
2. **Smart account** – Deployed on **each** chain where you want the account to exist, via the factory, with the **same** P-256 public key.
3. **Resolver records** – On that ENS chain, the name’s resolver stores **`setAddr(node, coinType, …)`** for each chain’s ENS multicoin type so `addr(name, coinType)` returns your smart account address. The bundled `onboard` flow uses [`ensEvmCoinType`](onboard/ensCoinType.ts): **60** for `chainId` 1, and **`0x80000000 | chainId`** for other EVM chains (see [ENSIP-11](https://docs.ens.domains/ensip/11)).

## Onboarding flow (`onboard`)

The function **`onboard`** in [`onboard/onboard.ts`](onboard/onboard.ts) runs the pipeline in order:

| Step | What happens |
|------|----------------|
| 1. Reserve | `commit(makeCommitment(registration))` on the **ETH registrar controller** (anti-frontrun commitment). |
| 2. Wait | Waits for `minCommitmentAge` (plus a short buffer) after the commit is mined. |
| 3. Finish registration | `register(...)` with **`owner` = predicted passkey account address**, your **resolver**, and registration fee (with default slippage on top of `rentPrice`). |
| 4. Deploy account | `factory.createAccount(pubKeyX, pubKeyY, salt)` on **every** chain in `chains` (must include `ensChain`). |
| 5. Set addresses | On `ensChain`, the account **`execute`**s the resolver’s **`multicall`** of **`setAddr`** calls—one per chain in `chains`—so each coin type maps to the same smart account address. |

Signing step: the code reads **`digest(resolver, 0, multicallCalldata)`** from the deployed account, you implement **`signPasskey({ challenge })`** to produce a WebAuthn assertion for those bytes, then submits **`execute`** (gas can be paid by any configured `walletClient.account`).

### Prerequisites

- **Foundry** – `forge build`, `forge test`.
- **Node** – `npm install`, `npm run build` (compiles contracts + TypeScript).
- **Factory** – Deploy `PasskeySmartAccountFactory` and use the **same factory address** on each chain if you want **one** address for the account everywhere.
- **ENS contracts** – Pass the correct **`controllerAddress`** and **`resolverAddress`** for the network you use. The ABIs in [`onboard/abis.ts`](onboard/abis.ts) match the **`Registration`** shape from [ens-contracts `IETHRegistrarController`](https://github.com/ensdomains/ens-contracts/blob/staging/contracts/ethregistrar/IETHRegistrarController.sol) (`label`, `uint8 reverseRecord`, `bytes32 referrer`). If your deployed controller differs, update the ABI or addresses.
- **`walletClient.account`** – Must be set (funding EOA for gas and ETH registrar payment).

### Using the TypeScript API

After `npm run build`, import from the package name or from `./dist/index.js` in this repo.

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { mainnet, optimism } from "viem/chains";
import { onboard, webAuthnAssertionToAuth } from "onboard-to-eth";

// publicClients: one PublicClient per chainId you pass in `chains`
// walletClient: must have .account set; same key can fund all chains if you switch chain on send

await onboard({
  chains: [mainnet, optimism],
  ensChain: mainnet,
  factoryAddress: "0x…",
  passkeyPublicKey: { x: "0x…", y: "0x…" }, // 32-byte hex per coordinate
  salt: "0x…", // bytes32
  ens: {
    label: "myname", // without ".eth"
    secret: "0x…", // bytes32; keep private until register
    duration: 31536000n, // seconds, e.g. 1 year
    resolverAddress: "0x…",
    controllerAddress: "0x…",
    reverseRecord: 0,
  },
  walletClient,
  publicClients: {
    [mainnet.id]: publicMainnet,
    [optimism.id]: publicOp,
  },
  signPasskey: async ({ challenge }) => {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: credentialId, type: "public-key" }],
        userVerification: "preferred",
      },
    });
    if (!cred || cred.type !== "public-key") throw new Error("no assertion");
    const assertion = cred.response as AuthenticatorAssertionResponse;
    const clientDataJSON = new TextDecoder().decode(assertion.clientDataJSON);
    return webAuthnAssertionToAuth(assertion, clientDataJSON);
  },
});
```

Helpers live in [`onboard/passkey.ts`](onboard/passkey.ts) (`webAuthnAssertionToAuth`, DER parsing, JSON field indices). The **`challenge`** passed to WebAuthn must be the raw **`digest`** bytes (e.g. `Uint8Array` backed by the same bytes the contract hashes).

### Exports

Package entry: [`onboard/index.ts`](onboard/index.ts) — `onboard`, `WebAuthnAuth` types, `ensEvmCoinType`, passkey helpers, and optional mainnet address hints in [`onboard/constants.ts`](onboard/constants.ts) (always verify on-chain before production).

## Commands

```bash
forge test              # Solidity tests
npm run build:contracts # forge build
npm run build:js        # tsc → dist/
npm run build           # both
```
