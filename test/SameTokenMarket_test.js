import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { expectTokenBalanceIncrease } from "../utils/token";
import { deployFixture } from "../utils/fixture";
import { expandDecimals, decimalToFloat } from "../utils/math";
import { handleDeposit } from "../utils/deposit";
import { OrderType, handleOrder } from "../utils/order";
import { getEventData } from "../utils/event";
import { hashString } from "../utils/hash";
import { expectWithinRange } from "../utils/validation";
import * as keys from "../utils/keys";
import { getPositionCount, getAccountPositionCount, getPositionKeys } from "../utils/position";
import { getBalanceOf } from "../utils/token";


describe("Guardian.", () => {
  let fixture;
  let user0, user1, user2, user3;
  let dataStore, ethUsdMarket, referralStorage, wnt, usdc, ethUsdSingleTokenMarket, reader, exchangeRouter;
  const referralCode0 = hashString("example code 0");
  const referralCode1 = hashString("example code 1");

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user1, user2, user3 } = fixture.accounts);
    ({ dataStore, ethUsdMarket, referralStorage, wnt, usdc,ethUsdSingleTokenMarket, reader, exchangeRouter} = fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdSingleTokenMarket,
        longTokenAmount: expandDecimals(500 * 10000, 6),
        shortTokenAmount: expandDecimals(500 * 10000, 6),
      },
    });

  });

  it.only("SameTokenMarket", async () => {

    await dataStore.setUint(keys.fundingFactorKey(ethUsdSingleTokenMarket.marketToken), decimalToFloat(1, 10));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdSingleTokenMarket.marketToken), decimalToFloat(1));
    expect(await dataStore.getUint(keys.fundingUpdatedAtKey(ethUsdSingleTokenMarket.marketToken))).eq(0);
    

    expect(await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdSingleTokenMarket.marketToken))).eq("0");
    const user2BalanceUSDCBEFORE = await usdc.balanceOf(user2.address);

    const user1BalanceUSDCBEFORE = await usdc.balanceOf(user1.address);
    console.log(ethers.utils.formatUnits(user2BalanceUSDCBEFORE, 6));
    console.log(ethers.utils.formatUnits(user1BalanceUSDCBEFORE, 6));

console.log("MarketIncrease: 1");
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(100 * 1000, 6),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000),
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
    },
    });

    console.log("MarketIncrease: 2");

    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(55 * 1000, 6),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(55 * 1000),
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
    },
    });
    console.log("MarketIncrease: 3");

    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(20 * 1000, 6),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(50 * 1000),
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
      },
    });
    await time.increase(24 * 60 * 60);

    console.log("MarketDecrease: 1");

    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000),
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: async ({ logs }) => {
          const feeInfo = getEventData(logs, "PositionFeesCollected");
          expect(feeInfo.fundingFeeAmount).eq("0");
          expect(feeInfo.collateralToken).eq(usdc.address);
        },
      },
    });

    console.log("MarketDecrease: 2");

    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(50 * 1000),
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: async ({ logs }) => {
          const feeInfo = getEventData(logs, "PositionFeesCollected");
          expect(feeInfo.fundingFeeAmount).eq("10537");
          expect(feeInfo.collateralToken).eq(usdc.address);
        },
      },
    });
    console.log("MarketDecrease: 3");

    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(55 * 1000),
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: async ({ logs }) => {
          const feeInfo = getEventData(logs, "PositionFeesCollected");
          expect(feeInfo.fundingFeeAmount).eq("11585");
          expect(feeInfo.collateralToken).eq(usdc.address);
        },
      },
    });
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdSingleTokenMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "22106",
    });

    expect(await getAccountPositionCount(dataStore, user1.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user3.address)).eq(0);


    const user2BalanceUSDC = await usdc.balanceOf(user2.address);

    const user1BalanceUSDC = await usdc.balanceOf(user1.address);
    const user3BalanceUSDC = await usdc.balanceOf(user3.address);
    console.log(ethers.utils.formatUnits(user1BalanceUSDC, 6));
    console.log(ethers.utils.formatUnits(user2BalanceUSDC, 6));
    console.log(ethers.utils.formatUnits(user3BalanceUSDC, 6));
  });
});
