// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "echidna-test.sol";
import "DepositHandler.sol";

contract DepositHandlerEchidnaTest is EchidnaTest {
    DepositHandler private depositHandler;

    function setup() public {
        // Deploy and set up external contract dependencies
        // (You will need to replace "/* ... */" with actual constructor arguments)
        depositHandler = new DepositHandler(/* ... */);
    }

    // Test: createDeposit should create a new deposit
    function echidna_test_create_deposit() public returns (bool) {
        DepositUtils.CreateDepositParams memory params = DepositUtils.CreateDepositParams({
            token: address(0),
            amount: 100,
            minPrice: 1,
            maxPrice: 1000,
            maxSlippage: 500
        });

        address account = address(this);
        bytes32 depositId = depositHandler.createDeposit(account, params);

        // Verify if the deposit has been created correctly
        Deposit.Props memory createdDeposit = DepositStoreUtils.get(depositHandler.dataStore(), depositId);

        return createdDeposit.exists() && createdDeposit.account() == account;
    }

    // Test: cancelDeposit should cancel the given deposit
    function echidna_test_cancel_deposit() public returns (bool) {
        DepositUtils.CreateDepositParams memory params = DepositUtils.CreateDepositParams({
            token: address(0),
            amount: 100,
            minPrice: 1,
            maxPrice: 1000,
            maxSlippage: 500
        });

        address account = address(this);
        bytes32 depositId = depositHandler.createDeposit(account, params);

        // Cancel the deposit
        depositHandler.cancelDeposit(depositId);

        // Verify if the deposit has been canceled correctly
        Deposit.Props memory canceledDeposit = DepositStoreUtils.get(depositHandler.dataStore(), depositId);

        return canceledDeposit.status() == Deposit.Status.Canceled;
    }

    // Test: executeDeposit should execute the given deposit
    function echidna_test_execute_deposit() public returns (bool) {
        DepositUtils.CreateDepositParams memory params = DepositUtils.CreateDepositParams({
            token: address(0),
            amount: 100,
            minPrice: 1,
            maxPrice: 1000,
            maxSlippage: 500
        });

        address account = address(this);
        bytes32 depositId = depositHandler.createDeposit(account, params);

        OracleUtils.SetPricesParams memory oracleParams = OracleUtils.SetPricesParams({
            tokens: new address[](1),
            prices: new uint256[](1),
            compactedMinOracleBlockNumbers: new uint256[](1),
            compactedMaxOracleBlockNumbers: new uint256[](1)
        });

        oracleParams.tokens[0] = address(0);
        oracleParams.prices[0] = 100;
        oracleParams.compactedMinOracleBlockNumbers[0] = 0;
        oracleParams.compactedMaxOracleBlockNumbers[0] = 0;

        depositHandler.executeDeposit(depositId, oracleParams);

        // Verify if the deposit has been executed correctly
        Deposit.Props memory executedDeposit = DepositStoreUtils.get(depositHandler.dataStore(), depositId);

        return executedDeposit.status() == Deposit.Status.Executed;
    }

        // Test: simulateExecuteDeposit should not fail on a valid deposit
    function echidna_test_simulate_execute_deposit() public returns (bool) {
        DepositUtils.CreateDepositParams memory params = DepositUtils.CreateDepositParams({
            token: address(0),
            amount: 100,
            minPrice: 1,
            maxPrice: 1000,
            maxSlippage: 500
        });

        address account = address(this);
        bytes32 depositId = depositHandler.createDeposit(account, params);

        OracleUtils.SimulatePricesParams memory simulateParams = OracleUtils.SimulatePricesParams({
            tokens: new address[](1),
            prices: new uint256[](1)
        });

        simulateParams.tokens[0] = address(0);
        simulateParams.prices[0] = 100;

        bool success;
        try depositHandler.simulateExecuteDeposit(depositId, simulateParams) {
            success = true;
        } catch {
            success = false;
        }

        return success;
    }

}