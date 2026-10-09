// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CoralRewards} from "./CoralRewards.sol";
import {CoralNetworks} from "./network/CoralNetworks.sol";

/// @title CoralRewardsMigratable
/// @notice Testnet rewards contract. Same payout rules, plus a one-time seed of amounts
///         already claimed on the previous contract so a new root cannot pay them again.
contract CoralRewardsMigratable is CoralRewards {
    bool public claimsSeeded;

    event ClaimsSeeded(uint256 accounts, uint256 total);

    error AlreadySeeded();
    error LengthMismatch();

    constructor(
        address vault_,
        address initialOwner,
        CoralNetworks.Params memory params
    ) CoralRewards(vault_, initialOwner, params) {}

    /// @notice Copy claimed amounts from the previous rewards contract. Sum becomes `totalTeamPaid`.
    function seedClaims(
        address[] calldata accounts,
        uint256[] calldata amounts
    ) external onlyOwner {
        if (claimsSeeded || totalTeamPaid != 0) revert AlreadySeeded();
        if (accounts.length != amounts.length) revert LengthMismatch();
        uint256 sum;
        for (uint256 i = 0; i < accounts.length; i++) {
            if (accounts[i] == address(0)) revert ZeroAddress();
            if (claimed[accounts[i]] != 0) revert AlreadySeeded();
            claimed[accounts[i]] = amounts[i];
            sum += amounts[i];
        }
        totalTeamPaid = sum;
        claimsSeeded = true;
        emit ClaimsSeeded(accounts.length, sum);
    }
}
