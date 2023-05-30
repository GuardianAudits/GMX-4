import { HardhatRuntimeEnvironment } from "hardhat/types";
import { decimalToFloat, expandDecimals } from "../utils/math";

export default async function ({ network }: HardhatRuntimeEnvironment) {
  if (network.name === "hardhat") {
    return {
      feeReceiver: ethers.constants.AddressZero,
      holdingAddress: ethers.constants.AddressZero,
      minHandleExecutionErrorGas: 1000000,

      depositGasLimitSingle: 0,
      depositGasLimitMultiple: 0,
      withdrawalGasLimitSingle: 0,
      withdrawalGasLimitMultiple: 0,

      singleSwapGasLimit: 0,
      increaseOrderGasLimit: 0,
      decreaseOrderGasLimit: 0,
      swapOrderGasLimit: 0,

      tokenTransferGasLimit: 200_000,
      nativeTokenTransferGasLimit: 50_000,

      estimatedGasFeeBaseAmount: 0,
      estimatedGasFeeMultiplierFactor: 0,

      executionGasFeeBaseAmount: 0,
      executionGasFeeMultiplierFactor: 0,

      maxSwapPathLength: 5,
      maxCallbackGasLimit: 2_000_000,
      minCollateralUsd: decimalToFloat(1),

      minPositionSizeUsd: decimalToFloat(1),
      claimableCollateralTimeDivisor: 60 * 60,
    };
  } else {
    return {
      feeReceiver: "0x49B373D422BdA4C6BfCdd5eC1E48A9a26fdA2F8b",
      holdingAddress: "0x49B373D422BdA4C6BfCdd5eC1E48A9a26fdA2F8b",
      minHandleExecutionErrorGas: 1000000,

      depositGasLimitSingle: 10000,
      depositGasLimitMultiple: 10000,
      withdrawalGasLimitSingle: 10000,
      withdrawalGasLimitMultiple: 10000,

      singleSwapGasLimit: 10000,
      increaseOrderGasLimit: 10000,
      decreaseOrderGasLimit: 10000,
      swapOrderGasLimit: 10000,

      tokenTransferGasLimit: 200_000,
      nativeTokenTransferGasLimit: 50_000,

      estimatedGasFeeBaseAmount: 10000,
      estimatedGasFeeMultiplierFactor: expandDecimals(1, 30),

      executionGasFeeBaseAmount: 10000,
      executionGasFeeMultiplierFactor: expandDecimals(1, 30),

      maxSwapPathLength: 5,
      maxCallbackGasLimit: 2_000_000,
      minPositionSizeUsd: decimalToFloat(1),
      minCollateralUsd: decimalToFloat(1),
      claimableCollateralTimeDivisor: 60 * 60,
    };
  }
}
