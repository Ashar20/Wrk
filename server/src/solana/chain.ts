/** The only things the validator needs from Solana. Injected so tests never touch a network. */
export interface ChainPort {
  cluster: string;
  /** True when `signature` is a confirmed transaction signed by `signer` carrying exactly `memo`. */
  verifyMemo(signature: string, expected: { signer: string; memo: string }): Promise<boolean>;
  /** Send the memo on behalf of an email-account user. Fees are paid by the treasury. Returns the signature. */
  anchor(args: { signerSecret: Uint8Array; memo: string }): Promise<string>;
  /** Transfer reward tokens to the contributor. Returns the payout transaction signature. */
  pay(args: { contributor: string; amountUsdc: number; episodeId: string }): Promise<string>;
}

export const memoText = (bountyId: string, episodeId: string, manifestHash: string) =>
  `wrk:v1:${bountyId}:${episodeId}:${manifestHash}`;
