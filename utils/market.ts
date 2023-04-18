import { calculateCreate2 } from "eth-create2-calculator";
import { expandDecimals } from "./math";
import { hashData, hashString } from "./hash";
import { poolAmountKey, swapImpactPoolAmountKey } from "./keys";
import * as keys from "./keys";

import MarketTokenArtifact from "../artifacts/contracts/market/MarketToken.sol/MarketToken.json";

export const DEFAULT_MARKET_TYPE = hashString("basic-v1");

export function getMarketCount(dataStore) {
  return dataStore.getAddressCount(keys.MARKET_LIST);
}

export function getMarketKeys(dataStore, start, end) {
  return dataStore.getAddressValuesAt(keys.MARKET_LIST, start, end);
}

export async function getPoolAmount(dataStore, market, token) {
  const key = poolAmountKey(market, token);
  return await dataStore.getUint(key);
}

export async function getSwapImpactPoolAmount(dataStore, market, token) {
  const key = swapImpactPoolAmountKey(market, token);
  return await dataStore.getUint(key);
}

export async function getMarketTokenPrice(fixture, overrides: any = {}) {
  return (await getMarketTokenPriceWithPoolValue(fixture, overrides))[0];
}

export async function getMarketTokenPriceWithPoolValue(fixture, overrides: any = {}) {
  const { reader, dataStore, ethUsdMarket } = fixture.contracts;
  const market = overrides.market || ethUsdMarket;
  const pnlFactorType = overrides.pnlFactorType || keys.MAX_PNL_FACTOR_FOR_TRADERS;

  const indexTokenPrice = overrides.indexTokenPrice || {
    min: expandDecimals(5000, 4 + 8),
    max: expandDecimals(5000, 4 + 8),
  };

  const longTokenPrice = overrides.longTokenPrice || {
    min: expandDecimals(5000, 4 + 8),
    max: expandDecimals(5000, 4 + 8),
  };

  const shortTokenPrice = overrides.shortTokenPrice || {
    min: expandDecimals(1, 6 + 18),
    max: expandDecimals(1, 6 + 18),
  };

  return await reader.getMarketTokenPrice(
    dataStore.address,
    market,
    indexTokenPrice,
    longTokenPrice,
    shortTokenPrice,
    pnlFactorType,
    true
  );
}

export function getMarketTokenAddress(
  indexToken,
  longToken,
  shortToken,
  marketType,
  marketFactoryAddress,
  roleStoreAddress,
  dataStoreAddress
) {
  const salt = hashData(
    ["string", "address", "address", "address", "bytes32"],
    ["GMX_MARKET", indexToken, longToken, shortToken, marketType]
  );
  const byteCode = MarketTokenArtifact.bytecode;
  return calculateCreate2(marketFactoryAddress, salt, byteCode, {
    params: [roleStoreAddress, dataStoreAddress],
    types: ["address", "address"],
  });
}
