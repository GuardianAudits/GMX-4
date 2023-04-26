import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, handleOrder } from "../../utils/order";
import { getIsAdlEnabled, updateAdlState, executeAdl } from "../../utils/adl";
import { grantRole } from "../../utils/role";
import * as keys from "../../utils/keys";
import { getPositionCount } from "../../utils/position";
import { getAccountPositionCount } from "../../utils/position";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { getPositionKeys } from "../../utils/position";
import { getOrderCount } from "../../utils/order";
import { executeLiquidation } from "../../utils/liquidation";

describe("Guardian.PoCs", () => {
  let fixture;
  let wallet, user0, user1, user2, user3, reader;
  let roleStore, dataStore, ethUsdMarket, wnt, usdc, ethUsdSingleTokenMarket, referralStorage, exchangeRouter, errors;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ wallet, user0, user1, user2, user3 } = fixture.accounts);
    ({
      roleStore,
      dataStore,
      ethUsdMarket,
      wnt,
      usdc,
      ethUsdSingleTokenMarket,
      reader,
      referralStorage,
      exchangeRouter,
      errors,
    } = fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdSingleTokenMarket,
        longTokenAmount: expandDecimals(1000, 18),
      },
    });

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(1000, 9),
      },
    });
  });

  it.only("inconsistent liquidations", async () => {
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 9));
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1, 9));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2));

    // User1 creates a short with size $200,000
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);

    await dataStore.setUint(keys.MIN_COLLATERAL_USD, decimalToFloat(200_000)); // Position is liquidatable
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken), decimalToFloat(5, 10)); // 0.05%
    await dataStore.setUint(keys.POSITION_FEE_RECEIVER_FACTOR, decimalToFloat(1, 0)); // 20%

    await time.increase(14 * 24 * 60 * 60);

    // The position is unable to be liquidated as the values.pnlAmountForPool
    // is overwritten in getLiquidationValues. Therefore the amount that goes into
    // the swapProfitToCollateralToken is never decremented from the poolAmount.
    // The solution is to add the following before resetting the values.pnlAmountForPool:
    //    if (values.pnlTokenForPool != params.position.collateralToken()) {
    //                MarketUtils.applyDeltaToPoolAmount(
    //                    params.contracts.dataStore,
    //                    params.contracts.eventEmitter,
    //                    params.market.marketToken,
    //                    values.pnlTokenForPool,
    //                    values.pnlAmountForPool
    //                );
    //                values.pnlTokenForPool = params.position.collateralToken();
    //    }
    //
    //    (`values.pnlTokenForPool = params.position.collateralToken()` can be moved in the if to save gas)
    await expect(
      executeLiquidation(fixture, {
        account: user1.address,
        market: ethUsdMarket,
        collateralToken: wnt,
        isLong: false,
        minPrices: [expandDecimals(4600, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4600, 4), expandDecimals(1, 6)],
      })
    ).to.be.revertedWithCustomError(errors, "InvalidMarketTokenBalance");

    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);
  });
});
