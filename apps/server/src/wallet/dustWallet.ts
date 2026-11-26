// Operator DUST wallet: the SDK's DustWallet() with a different fee coin selection.
// Works around ledger issue 838 (https://github.com/midnightntwrk/midnight-ledger/issues/838): the
// node budgets validation time by tx size (2 µs per byte, 15 ms minimum), and mid-cost calls paid with
// one DUST coin overran it ("1010: Custom error: 231"). A second coin adds ~3 KB (6 ms of budget) but
// only ~2.7 ms of work, so the tx fits.
// TODO: the fix shipped in the pinned ledger-v9 1.0.2; confirm on devnet that DustWallet(cfg) no longer
// hits error 231 and delete this file.
import { CustomForkingDustWallet, dustVariantConfigurations } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { V1Builder } from '@midnightntwrk/wallet-sdk-dust-wallet/v1';
import { V2Builder, SyncService } from '@midnightntwrk/wallet-sdk-dust-wallet/v2';
import { makeIndexerChainVersionProbe } from '@midnightntwrk/wallet-sdk-capabilities/chainVersion';
import { Effect } from 'effect';

type Coin = { value: bigint };

/**
 * Smallest-first selection that always pays with two coins when available. The SDK requests coins until
 * the fee is covered, so every other call hands over a coin with value 0 to make it ask again; the SDK
 * then re-reads the real values by nonce. A surplus coin is spent with a zero fee (renewed at the same
 * value). Ending each payment on a real coin leaves no state between transactions.
 */
export function twoCoinSelection() {
  let lastWasZeroed = false;
  return <TCoin extends Coin>(coins: readonly TCoin[]): TCoin | undefined => {
    const coin = coins
      .filter((c) => c.value > 0n)
      .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
      .at(0);
    if (!coin) return undefined;
    if (!lastWasZeroed && coins.length > 1) {
      lastWasZeroed = true;
      return { ...coin, value: 0n };
    }
    lastWasZeroed = false;
    return coin;
  };
}

/** The SDK's DustWallet(configuration), with twoCoinSelection in the Ledger 9 variant. */
export function OperatorDustWallet(configuration: any): any {
  const { v1, v2, migration } = dustVariantConfigurations(configuration);
  const withProbes = {
    ...configuration,
    chainVersionProbe: configuration.chainVersionProbe ?? makeIndexerChainVersionProbe(configuration),
    ...(configuration.skipLedgerV8DustHistory === true
      ? { dustTimelineStartProbe: () => Effect.runPromise(SyncService.findDustTimelineStart(configuration, configuration.forks.v9)) }
      : {}),
  };
  const selection = twoCoinSelection();
  return CustomForkingDustWallet(
    withProbes,
    { builder: new V1Builder().withDefaults() as any, configuration: v1 as any },
    {
      builder: new V2Builder().withDefaults().withCoinSelection(() => selection as any).withMigration(migration as any) as any,
      configuration: v2 as any,
    },
  );
}
