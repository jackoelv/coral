// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice 18-decimal USDT stand-in for local Anvil / unit tests. Not for mainnet.
contract MockUSDT is ERC20 {
    constructor() ERC20("Tether USD", "USDT") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}
