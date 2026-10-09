// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

interface ICoralVaultPay {
    function usdt() external view returns (IERC20);
    function totalContributed() external view returns (uint256);
    function totalImported() external view returns (uint256);
    function totalDirectAccrued() external view returns (uint256);
    function disburse(address to, uint256 amount) external;
}

interface ICoralRewardsView {
    function outstanding() external view returns (uint256);
}
