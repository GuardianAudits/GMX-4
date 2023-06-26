import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";

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
import { expectTokenBalanceIncrease } from "../utils/token";
import { errorsContract } from "../utils/error";

import {
  getWithdrawalCount,
  getWithdrawalKeys,
  createWithdrawal,
  executeWithdrawal,
  handleWithdrawal,
} from "../utils/withdrawal";

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
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(100, 18),
        shortTokenAmount: expandDecimals(250 * 1000, 6),
      },
    });

  });

  it.only("High: Unclimbable funding fees", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 10));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    // User3 creates a short with size $10
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(10, 6),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(10),
        acceptablePrice: expandDecimals(4999, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
    },
    execute: {
        afterExecution: ({ logs }) => {
        const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
        expect(positionIncreaseEvent.executionPrice).eq("4999999500000000");
    },
    },
  });

    // User1 creates a long with size $250,000
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(250 * 1000, 6),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(250 * 1000),
        acceptablePrice: expandDecimals(5013, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
    },
    execute: {
        afterExecution: ({ logs }) => {
        const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
        expect(positionIncreaseEvent.executionPrice).eq("5012498999999999");
    },
    },
  });

    // 300 days later
    await time.increase(300 * 24 * 60 * 60);

    // User1 decreases their position from $250,000 down to $125,000
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(250 * 500),
        acceptablePrice: expandDecimals(4987, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
            const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
            expect(positionDecreaseEvent.executionPrice).eq("5018748999999999"); // ~5012.4 per token
            const feeInfo = getEventData(logs, "PositionFeesCollected");
            expect(feeInfo.fundingFeeAmount).eq("647948237");
        },
      },

    });

    // User1 decreases their whole position
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(10),
        acceptablePrice: expandDecimals(5013, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
    },
    execute: {
        afterExecution: ({ logs }) => {
        const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
        expect(positionDecreaseEvent.executionPrice).eq("5012499500000000"); // ~4996.5 per token
        const feeInfo = getEventData(logs, "PositionFeesCollected");
        expect(feeInfo.fundingFeeAmount).eq("0");
     },
    },
  });

  // Check claimable funding fees
  expect(
    await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user1.address))
  ).eq("0");
  expect(
    await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user1.address))
  ).eq("0");

  expect(
    await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user3.address))
  ).eq("0");
  expect(
    await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user3.address))
  ).eq("647948274");

    // When User3 tries to claim their earned funding fees the transaction will revert because
    // User3 have accumulated more funding fees since User1 decreased their position leading to
    // there being more claimable funding fees than paid until User1 decide to decrease again
    // paying the remaining funding fee to user3.
    await expect(
        expectTokenBalanceIncrease({
        token: usdc,
        account: user3,
        sendTxn: async () => {
          await exchangeRouter.connect(user3).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user3.address);
        },
        increaseAmount: "647948274",
      })).to.be.revertedWithCustomError(errorsContract, "InvalidMarketTokenBalance");

    // Check that only User1 has a position
    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user3.address)).eq(0);

    // User1 decrease the remaining of his position
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(250 * 500),
        acceptablePrice: expandDecimals(4987, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
            const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
            expect(positionDecreaseEvent.executionPrice).eq("5006249999999999"); // ~5012.4 per token
            const feeInfo = getEventData(logs, "PositionFeesCollected");
            expect(feeInfo.fundingFeeAmount).eq("37");
        },
      },
    });

    // Check claimable funding fees
    expect(
        await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user1.address))
      ).eq("0");
      expect(
        await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user1.address))
      ).eq("0");

      expect(
        await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user3.address))
      ).eq("0");
      expect(
        await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user3.address))
      ).eq("647948274");

    // User3 can now claim their earned finding fees 
    await expectTokenBalanceIncrease({
        token: usdc,
        account: user3,
        sendTxn: async () => {
          await exchangeRouter.connect(user3).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user3.address);
        },
        increaseAmount: "647948274",
      });

    // No positions left
    expect(await getAccountPositionCount(dataStore, user1.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user3.address)).eq(0);
});
});
