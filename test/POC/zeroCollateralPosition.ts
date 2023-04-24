import { expect } from "chai";
import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat, bigNumberify } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, getOrderCount, getOrderKeys, createOrder, handleOrder, executeOrder } from "../../utils/order";
import { getAccountPositionCount, getPositionKeys } from "../../utils/position";
import { handleWithdrawal } from "../../utils/withdrawal";
import * as keys from "../../utils/keys";
import { executeLiquidation } from "../../utils/liquidation";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { errorsContract } from "../../utils/error";

describe.only("Guardian", () => {
  let fixture;
  let user0, user1, user2;
  let dataStore, reader, ethUsdMarket, wnt, usdc, exchangeRouter;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user1, user2 } = fixture.accounts);
    ({ dataStore, reader, ethUsdMarket, wnt, usdc, exchangeRouter } = fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(500000, 6),
      },
    });
  });

  it("CRITICAL: Position with size but 0 collateral breaks funding fees", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 10));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1));
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // User0 creates a long with size $200,000
    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5001, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });
    // User1 creates a short with size $1000
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18),
        sizeDeltaUsd: decimalToFloat(1000),
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);

    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        sizeDeltaUsd: decimalToFloat(100 * 1000),
        acceptablePrice: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        gasUsageLabel: "orderHandler.createOrder",
      },
      execute: {
        gasUsageLabel: "orderHandler.executeOrder",
        minPrices: [expandDecimals(5500, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5500, 4), expandDecimals(1, 6)],
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);

    const positionKeys = await getPositionKeys(dataStore, 0, 10);
    const position = await reader.getPosition(dataStore.address, positionKeys[0]);
    expect(position.numbers.collateralAmount).to.eq(0);
    expect(position.numbers.sizeInUsd).to.eq(expandDecimals(100000, 30));

    // Longs should be paying shorts
    await time.increase(14 * 24 * 60 * 60);

    // On liquidation, the funding fees will be greater than the position's collateral
    // and by a significant amount. These funding fees will be unable to get paid.
    await executeLiquidation(fixture, {
      account: user0.address,
      market: ethUsdMarket,
      collateralToken: wnt,
      isLong: true,
      minPrices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(1000, 4), expandDecimals(1, 6)],
      gasUsageLabel: "liquidationHandler.executeLiquidation",
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getOrderCount(dataStore)).eq(0);

    expect(
      await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user1.address))
    ).eq("0");

    expect(
      await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user1.address))
    ).eq("0");

    // Now User1 decreases
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(1000),
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    expect(
      await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user1.address))
    ).eq("0");

    // We break the market token balance validation and are unable to claim.
    await expect(
      exchangeRouter.connect(user1).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user1.address)
    ).to.be.revertedWithCustomError(errorsContract, "InvalidMarketTokenBalance");

    // If another user earns funding fees, they are also unable to claim
    // as market token balance validation will continue to fail.

    // User1 will pay funding fees.
    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // User2 creates a short with size $500 and shall get paid.
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18),
        sizeDeltaUsd: decimalToFloat(1000),
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);

    // Longs should be paying shorts for this time.
    await time.increase(60);

    // User2 closes their position and has been earning funding fees for ~60 seconds
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(1000),
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);

    // User1 is unable to claim funding fees.
    await expect(
      exchangeRouter.connect(user1).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user1.address)
    ).to.be.revertedWithCustomError(errorsContract, "InvalidMarketTokenBalance");
    // User2 is unable to claim their tiny amount of funding fees.
    await expect(
      exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user1.address)
    ).to.be.revertedWithCustomError(errorsContract, "InvalidMarketTokenBalance");
  });
});
