import { expect } from "chai";

import { deployFixture } from "../utils/fixture";
import { expandDecimals, decimalToFloat } from "../utils/math";
import { handleDeposit } from "../utils/deposit";
import { OrderType, getOrderCount, handleOrder } from "../utils/order";
import { executeLiquidation } from "../utils/liquidation";
import { grantRole } from "../utils/role";
import { getAccountPositionCount } from "../utils/position";
import { errorsContract } from "../utils/error";

describe("Guardian", () => {
  let fixture;
  let wallet, user0;
  let roleStore, dataStore, ethUsdMarket, wnt, usdc;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ wallet, user0 } = fixture.accounts);
    ({ roleStore, dataStore, ethUsdMarket, wnt, usdc } = fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
      },
    });
  });

  it.only("Long with short", async () => {
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
console.log("increase");
    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(10 * 5000, 6),
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);

    await grantRole(roleStore, wallet.address, "LIQUIDATION_KEEPER");
    console.log("LIQUIDATION #1");

    await expect(
      executeLiquidation(fixture, {
        account: user0.address,
        market: ethUsdMarket,
        collateralToken: usdc,
        isLong: true,
        minPrices: [expandDecimals(5000, 4), expandDecimals(84, 4)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(84, 4)],
        gasUsageLabel: "liquidationHandler.executeLiquidation",
      })
    ).to.be.revertedWithCustomError(errorsContract, "PositionShouldNotBeLiquidated");

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);
    console.log("LIQUIDATION #2");

    await expect(
      executeLiquidation(fixture, {
        account: user0.address,
        market: ethUsdMarket,
        collateralToken: usdc,
        isLong: true,
        minPrices: [expandDecimals(5000, 4), expandDecimals(80, 4)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(80, 4)],
        gasUsageLabel: "liquidationHandler.executeLiquidation",
      })
    )
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);

    expect(await getOrderCount(dataStore)).eq(0);
  });
});
