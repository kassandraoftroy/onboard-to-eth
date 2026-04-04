import { parseAbi } from "viem";

export const passkeySmartAccountAbi = parseAbi([
  "function digest(address to, uint256 value, bytes data) view returns (bytes)",
  "function execute(address to, uint256 value, bytes data, bool requireUserVerification, (bytes authenticatorData, string clientDataJSON, uint256 challengeIndex, uint256 typeIndex, uint256 r, uint256 s) auth) payable",
  "function nonce() view returns (uint256)",
  "function publicKeyX() view returns (bytes32)",
  "function publicKeyY() view returns (bytes32)",
]);

export const passkeySmartAccountFactoryAbi = parseAbi([
  "function predictAddress(bytes32 pubKeyX, bytes32 pubKeyY, bytes32 salt) view returns (address)",
  "function createAccount(bytes32 pubKeyX, bytes32 pubKeyY, bytes32 salt) returns (address)",
]);

/** Matches `IETHRegistrarController` in ens-contracts `staging` (label, uint8 reverseRecord, bytes32 referrer). */
export const ethRegistrarControllerAbi = parseAbi([
  "function available(string label) view returns (bool)",
  "function rentPrice(string label, uint256 duration) view returns (uint256 base, uint256 premium)",
  "function minCommitmentAge() view returns (uint256)",
  "function makeCommitment((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer) registration) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer) registration) payable",
]);

export const publicResolverAbi = parseAbi([
  "function multicall(bytes[] data) returns (bytes[])",
  "function setAddr(bytes32 node, uint256 coinType, bytes addr)",
]);
