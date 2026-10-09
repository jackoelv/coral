// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CoralIdoBase} from "./helpers/CoralIdoBase.sol";

/// @notice A few hundred accounts. Deposits no longer walk the invite tree, so a deep
///         line and a direct child cost the same order of gas.
contract CoralScaleTest is CoralIdoBase {
    uint256 internal constant N = 300;

    function test_threeHundredDeposits_deepAndWide() public {
        _openSale();
        for (uint256 i = 0; i < N; i++) {
            _mintApprove(_actor(i), 200_000 * UNIT);
        }
        address root = _actor(0);
        _register(root, "ROOTANVL", "");

        for (uint256 i = 1; i <= 20; i++) {
            _register(_actor(i), _codeOf(i), "ROOTANVL");
        }
        for (uint256 i = 21; i < 60; i++) {
            _register(_actor(i), _codeOf(i), _codeOf(i - 1));
        }
        for (uint256 i = 60; i < N; i++) {
            uint256 parent = 1 + (i % 20);
            _register(_actor(i), _codeOf(i), _codeOf(parent));
        }

        // Prime global counters and the NFT minter so the two measured deposits
        // differ only by the account they touch, not by first-time initialization.
        _pay(_actor(21), 1000 * UNIT);

        uint256 shallowGas = _pay(_actor(2), 1000 * UNIT);
        uint256 deepGas = _pay(_actor(59), 1000 * UNIT);
        uint256 gap = shallowGas > deepGas ? shallowGas - deepGas : deepGas - shallowGas;
        assertLt(gap, 80_000, "deep and shallow contribute gas diverged");

        _pay(_actor(3), 50 * UNIT);
        assertEq(_direct(root), 0);

        _pay(_actor(4), 500 * UNIT);
        _pay(_actor(5), 2_000 * UNIT);
        _pay(_actor(6), 10_000 * UNIT);
        _pay(_actor(7), 30_000 * UNIT);
        _pay(root, 60_000 * UNIT);

        for (uint256 i = 8; i < N; i++) {
            if (i == 59 || i == 2 || i == 21) continue;
            uint256 amount = 100 * UNIT + (i % 5) * 100 * UNIT;
            _pay(_actor(i), amount);
        }

        assertEq(ido.getAccount(_actor(59)).selfVolume, 1000 * UNIT);
        assertGt(ido.totalContributed(), 300 * 100 * UNIT);
        assertEq(_direct(_actor(58)), 0);
        assertEq(ido.getAccount(_actor(21)).selfVolume, 1000 * UNIT);
    }

    function _pay(address who, uint256 amount) internal returns (uint256 used) {
        uint256 before = gasleft();
        vm.prank(who);
        ido.contribute(amount);
        used = before - gasleft();
    }

    function _actor(uint256 i) internal pure returns (address) {
        return address(uint160(0x1000 + i));
    }

    function _codeOf(uint256 i) internal view returns (string memory) {
        if (i == 0) return "ROOTANVL";
        return string.concat("N", vm.toString(1_000_000 + i));
    }
}
