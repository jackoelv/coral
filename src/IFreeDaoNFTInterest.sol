// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IFreeDaoNFTInterest {
    function settle(address account) external;
    function interestWeek(uint256 timestamp) external view returns (uint256);
    function noteSaleOpened() external;
    function noteDetached() external;
}
