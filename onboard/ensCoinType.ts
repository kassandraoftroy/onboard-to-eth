/**
 * ENS multicoin coinType for EVM chains (ENSIP-11 style: `0x80000000 | chainId`).
 * Ethereum mainnet legacy coin type 60 is used for chainId 1; other chains use the bitmask form.
 *
 * @see https://docs.ens.domains/ensip/11
 */
export function ensEvmCoinType(chainId: number): number {
  if (chainId === 1) return 60;
  return (0x80000000 | chainId) >>> 0;
}
