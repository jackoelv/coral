// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Deploy} from "./Deploy.s.sol";

/// @notice Anvil entry. Ignores NETWORK and always uses the local profile.
contract DeployLocal is Deploy {
    function run() external override {
        _deploy("local");
    }
}
