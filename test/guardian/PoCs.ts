import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, handleOrder } from "../../utils/order";
import * as keys from "../../utils/keys";

describe.only("Guardian.PoCs", () => {
  let fixture;
  let wallet, user0, user1;
  let roleStore, dataStore, ethUsdMarket, wnt, usdc;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ wallet, user0, user1 } = fixture.accounts);
    ({ roleStore, dataStore, ethUsdMarket, wnt, usdc } = fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(50_000 * 1000, 6),
      },
    });
  });

  it("MEDIUM: mis-aligned price impact amounts for decrease orders", async function () {
    const user0Collateral = expandDecimals(100, 18);

    // First create a long position
    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        account: user0,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: user0Collateral,
        sizeDeltaUsd: decimalToFloat(2000 * 1000),
        acceptablePrice: expandDecimals(5001, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Open the same amount of OI on the short side
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(100, 18),
        sizeDeltaUsd: decimalToFloat(2000 * 1000),
        acceptablePrice: expandDecimals(4999, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // Now turn on negative price impact
    // set price impact to 0.1% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 2 * (10 ** -8)

    // .1% for every 2,000,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 2,000,000 => 5 * (10 ** -10)
    // notice that this impact factor actually results in 0.05% impact for the 2_000_000 imbalance
    // as a result of the extra division by 2 in the applyImpactFactor function.
    // E.g. a priceImpactUsd of only $1,000, when it ought to be $2,000 -- this is referenced in PU-1.
    // This is because the impact factor of 0.001 / 2,000,000 * 1e30 already accounts
    // for dividing off the factor of 2 introduced by the exponent of 2.
    //
    // Ex (ignoring precision):
    //
    // exponentValue = 2_000_000 * 2_000_000
    // exponentValue * impactFactor = 2_000_000 * 2_000_000 * .001 / 2_000_000 / 2
    // = 2_000_000 * .001 / 2
    //
    // without the extra division by 2 we already have the result we're looking for, 2_000_000 * .001 = 2,000
    // since 2_000_000 and 1/2_000_000 cancelled the additional x2 introduced.
    // This directly contradicts the example in the applyImpactFactor function.
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(5, 10));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    // The decrease order will experience negative impact, but the negative impact on the executionPrice will
    // not equal the computed impact amount in tokens that is applied to the position impact pool.
    // This will mis-account for the price impact on the exchange in the position impact pool and ultimately
    // perturb the value of the pool in general as it is not correctly offsetting the pnl that traders immediately
    // experience when decreasing their positions.
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        sizeDeltaUsd: decimalToFloat(2000 * 1000),
        acceptablePrice: expandDecimals(4900, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // As stated above the priceImpactUsd actually experienced is $1,000

    // Using the formula to compute the execution price after impact in the BaseOrderUtils.getExecutionPrice function, we get:
    // executionPrice = $5,000 * 2_000_000 / (2_000_000 + 1,000) = 4997501249375312 (~$4,997.50125)

    // Deriving the actual price impact amount experienced in tokens:
    // My position size in tokens is 400 Ether.
    // Without price impact, this is worth $2_000_000
    // with price impact, this is worth $4,997.501249375312 * 400 = $1_999_000.50
    // Meaning -$999.50 was experienced in PI, this translates to -$999.50 / $5,000 ~= .1999 Ether
    const userBalAfter = await wnt.balanceOf(user0.address);
    expect(user0Collateral.sub(userBalAfter)).to.eq("199900049975040000");

    // Using the conversion from the priceImpactUsd to the priceImpactAmount in the PositionPricingUtils.getPriceImpactAmount we get:
    // priceImpactAmount = $1,000 / $5,000 = .2 Ether
    const positionImpactPoolAmount = await dataStore.getUint(
      keys.positionImpactPoolAmountKey(ethUsdMarket.marketToken)
    );
    // Notice there is a very small amount of imprecision here
    // This is from the Precision.applyExponentFactor call in the applyImpactFactor function.
    expect(positionImpactPoolAmount).to.eq("199999999999999996");

    // .1999 Ether != .2 Ether and so the accounting for the position impact pool is slightly out of line
    // with the impact experienced by traders.
  });

  it("HIGH: AdjustedPnL set to 0 causes capped price impact to not be claimable", async () => {
    const user0Collateral = expandDecimals(100 * 5000, 6);

    // Create a long position
    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        account: user0,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: user0Collateral,
        sizeDeltaUsd: decimalToFloat(2000 * 1000),
        acceptablePrice: expandDecimals(5001, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Create a short position of the same size
    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        account: user1,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: user0Collateral,
        sizeDeltaUsd: decimalToFloat(2000 * 1000),
        acceptablePrice: expandDecimals(4999, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // User0 closes their position and experiences significant PI that is capped.
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1, 7));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    // Set PI Cap
    await dataStore.setUint(keys.maxPositionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(0));

    // Set timekey divisor such that all will go to a single timekey
    await dataStore.setUint(keys.CLAIMABLE_COLLATERAL_TIME_DIVISOR, decimalToFloat(1));

    let claimableCollateral = await dataStore.getUint(
      keys.getClaimableCollateralAmountKey(ethUsdMarket.marketToken, wnt.address, 0, user0.address)
    );

    expect(claimableCollateral).to.eq(0);

    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        account: user0,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        sizeDeltaUsd: decimalToFloat(2000 * 1000),
        acceptablePrice: expandDecimals(4000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        precisions: [8, 18],
        minPrices: [expandDecimals(5100, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5100, 4), expandDecimals(1, 6)],
      },
    });

    // PI was capped and the pnl was reduced to 0, but there is no claimable collateral amount
    // Therefore the user completely lost out from the priceImpactDiffUsd, rather than having the
    // potential to claim that pnl amount back in the future

    // Claimable collateral would have gone to timeKey 0, but none is there
    claimableCollateral = await dataStore.getUint(
      keys.getClaimableCollateralAmountKey(ethUsdMarket.marketToken, wnt.address, 0, user0.address)
    );

    expect(claimableCollateral).to.eq(0);
  });
});
