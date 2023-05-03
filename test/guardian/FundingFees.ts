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

describe("Guardian.PoCs", () => {
  let fixture;
  let wallet, user0, user1, user2, user3, reader;
  let roleStore, dataStore, ethUsdMarket, wnt, usdc, ethUsdSingleTokenMarket, referralStorage, exchangeRouter;

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

  it("Funding fees with short == long markets", async function () {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdSingleTokenMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdSingleTokenMarket.marketToken), decimalToFloat(1));

    // 300K Long
    // 200K Short
    // Longs pay shorts
    // User0 long
    // User1 short
    // User2 short
    // User3 long

    // User0 MarketIncrease long position with long collateral for $100K
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // User1 MarketIncrease short position with short collateral for $100K
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    // User2 MarketIncrease short position with long collateral for $100K
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    // User3 MarketIncrease long with short collateral for $100K
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(100 * 1000, 6), // $100,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // Check that everyone has a position open
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user3.address)).eq(1);
    expect(await getPositionCount(dataStore)).eq(4);

    // 10 days later
    await time.increase(10 * 24 * 60 * 60);

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    const positionKeys = await getPositionKeys(dataStore, 0, 10);

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await usdc.balanceOf(user0.address)).to.eq(0);
    expect(await usdc.balanceOf(user1.address)).to.eq(0);
    expect(await usdc.balanceOf(user2.address)).to.eq(0);
    expect(await usdc.balanceOf(user3.address)).to.eq(0);

    const user0Position = await reader.getPositionInfo(
      dataStore.address,
      referralStorage.address,
      positionKeys[0],
      prices,
      0,
      ethers.constants.AddressZero,
      true
    );

    // Total FundingFees paid by User0
    const totalFeesPaidByUser0 = await user0Position.fees.funding.fundingFeeAmount;

    const user1Position = await reader.getPositionInfo(
      dataStore.address,
      referralStorage.address,
      positionKeys[1],
      prices,
      0,
      ethers.constants.AddressZero,
      true
    );

    // Total FundingFees paid by User3
    const totalFeesForUser1Long = await user1Position.fees.funding.claimableLongTokenAmount;
    const totalFeesForUser1Short = await user1Position.fees.funding.claimableShortTokenAmount;

    const user2Position = await reader.getPositionInfo(
      dataStore.address,
      referralStorage.address,
      positionKeys[2],
      prices,
      0,
      ethers.constants.AddressZero,
      true
    );

    // Total FundingFees paid by User3
    const totalFeesForUser2Long = await user2Position.fees.funding.claimableLongTokenAmount;
    const totalFeesForUser2Short = await user2Position.fees.funding.claimableShortTokenAmount;

    const user3Position = await reader.getPositionInfo(
      dataStore.address,
      referralStorage.address,
      positionKeys[3],
      prices,
      0,
      ethers.constants.AddressZero,
      true
    );

    // Total FundingFees paid by User3
    const totalFeesPaidByUser3 = await user3Position.fees.funding.fundingFeeAmount;

    // User0 MarketDecrease for the whole position size
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // User1 MarketDecrease for the whole position size
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    // User2 MarketDecrease for the whole position size
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    // User3 MarketDecrease for the whole position size
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdSingleTokenMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(100 * 1000, 6), // $100,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // Get market balance
    const marketBalance = await usdc.balanceOf(ethUsdSingleTokenMarket.marketToken);

    // Check how much each user paid and how much each user claimed in funding fees.

    // How much was paid by user1 & user3
    expect(totalFeesPaidByUser0).to.eq("1727986667");
    expect(totalFeesPaidByUser3).to.eq("3456000000");

    // How much was received by user2 & user4
    expect(totalFeesForUser1Long).to.eq("259199999999986667");
    expect(totalFeesForUser2Long).to.eq("259199999999986667");

    expect(totalFeesForUser1Short).to.eq("1295986667");
    expect(totalFeesForUser2Short).to.eq("1295986667");

    const totalFeesForUser1 = totalFeesForUser1Long.add(totalFeesForUser1Short);
    const totalFeesForUser2 = totalFeesForUser2Long.add(totalFeesForUser2Short);

    //expect(totalFeesForUser1.add(totalFeesForUser2)).to.eq(totalFeesPaidByUser0.add(totalFeesPaidByUser3));

    // Actual claimable
    const balanceBefore = await usdc.balanceOf(user1.address);
    await exchangeRouter
      .connect(user1)
      .claimFundingFees([ethUsdSingleTokenMarket.marketToken], [usdc.address], user1.address);
    const balanceAfter = await usdc.balanceOf(user1.address);
    const amountClaimed = balanceAfter.sub(balanceBefore);

    await exchangeRouter
      .connect(user2)
      .claimFundingFees([ethUsdSingleTokenMarket.marketToken], [usdc.address], user2.address);
  });

  it("Funding fees with short == long markets", async function () {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1));

    // 300K Long
    // 200K Short
    // Longs pay shorts
    // User0 long
    // User1 short
    // User2 short
    // User3 long

    // User0 MarketIncrease long position with long collateral for $100K
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // User1 MarketIncrease short position with short collateral for $100K
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    // User2 MarketIncrease short position with long collateral for $100K
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    // User3 MarketIncrease long with short collateral for $100K
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(100 * 1000, 6), // $100,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // Check that everyone has a position open
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user3.address)).eq(1);
    expect(await getPositionCount(dataStore)).eq(4);

    // 10 days later
    await time.increase(10 * 24 * 60 * 60);

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    const positionKeys = await getPositionKeys(dataStore, 0, 10);

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await usdc.balanceOf(user0.address)).to.eq(0);
    expect(await usdc.balanceOf(user1.address)).to.eq(0);
    expect(await usdc.balanceOf(user2.address)).to.eq(0);
    expect(await usdc.balanceOf(user3.address)).to.eq(0);

    const user0Position = await reader.getPositionInfo(
      dataStore.address,
      referralStorage.address,
      positionKeys[0],
      prices,
      0,
      ethers.constants.AddressZero,
      true
    );

    // Total FundingFees paid by User0
    const totalFeesPaidByUser0 = await user0Position.fees.funding.fundingFeeAmount;

    const user1Position = await reader.getPositionInfo(
      dataStore.address,
      referralStorage.address,
      positionKeys[1],
      prices,
      0,
      ethers.constants.AddressZero,
      true
    );

    // Total FundingFees paid by User3
    const totalFeesForUser1Long = await user1Position.fees.funding.claimableLongTokenAmount;
    const totalFeesForUser1Short = await user1Position.fees.funding.claimableShortTokenAmount;

    const user2Position = await reader.getPositionInfo(
      dataStore.address,
      referralStorage.address,
      positionKeys[2],
      prices,
      0,
      ethers.constants.AddressZero,
      true
    );

    // Total FundingFees paid by User3
    const totalFeesForUser2Long = await user2Position.fees.funding.claimableLongTokenAmount;
    const totalFeesForUser2Short = await user2Position.fees.funding.claimableShortTokenAmount;

    const user3Position = await reader.getPositionInfo(
      dataStore.address,
      referralStorage.address,
      positionKeys[3],
      prices,
      0,
      ethers.constants.AddressZero,
      true
    );

    // Total FundingFees paid by User3
    const totalFeesPaidByUser3 = await user3Position.fees.funding.fundingFeeAmount;

    // User0 MarketDecrease for the whole position size
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // User1 MarketDecrease for the whole position size
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    // User2 MarketDecrease for the whole position size
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    // User3 MarketDecrease for the whole position size
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(100 * 1000, 6), // $100,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // Get market balance
    const marketBalance = await usdc.balanceOf(ethUsdMarket.marketToken);

    // Check how much each user paid and how much each user claimed in funding fees.

    // How much was paid by user1 & user3
    expect(totalFeesPaidByUser0).to.eq("1727973334");
    expect(totalFeesPaidByUser3).to.eq("3456000000");

    // How much was received by user2 & user4
    expect(totalFeesForUser1Long).to.eq("0");
    expect(totalFeesForUser2Long).to.eq("0");

    expect(totalFeesForUser1Short).to.eq("2591986667");
    expect(totalFeesForUser2Short).to.eq("2591986667");

    const totalFeesForUser1 = totalFeesForUser1Long.add(totalFeesForUser1Short);
    const totalFeesForUser2 = totalFeesForUser2Long.add(totalFeesForUser2Short);

    //expect(totalFeesForUser1.add(totalFeesForUser2)).to.eq(totalFeesPaidByUser0.add(totalFeesPaidByUser3));

    // Actual claimable
    const balanceBefore = await usdc.balanceOf(user1.address);
    await exchangeRouter
      .connect(user1)
      .claimFundingFees([ethUsdSingleTokenMarket.marketToken], [usdc.address], user1.address);
    const balanceAfter = await usdc.balanceOf(user1.address);
    const amountClaimed = balanceAfter.sub(balanceBefore);

    await exchangeRouter
      .connect(user2)
      .claimFundingFees([ethUsdSingleTokenMarket.marketToken], [usdc.address], user2.address);
  });
});
