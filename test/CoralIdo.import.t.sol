// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CoralIdoBase} from "./helpers/CoralIdoBase.sol";
import {CoralIdo} from "../src/CoralIdo.sol";
import {CoralRewards} from "../src/CoralRewards.sol";
import {CoralNetworks} from "../src/network/CoralNetworks.sol";

contract CoralIdoImportTest is CoralIdoBase {
    function test_importDoesNotAccrueRewards() public {
        vm.startPrank(owner);
        address[] memory wallets = new address[](2);
        bytes32[] memory codes = new bytes32[](2);
        wallets[0] = alice;
        wallets[1] = bob;
        codes[0] = _code("ALICE001");
        codes[1] = _code("BOB00001");
        ido.importUsers(wallets, codes);

        address[] memory children = new address[](1);
        address[] memory refs = new address[](1);
        children[0] = bob;
        refs[0] = alice;
        ido.importReferrers(children, refs);

        address[] memory volW = new address[](2);
        uint256[] memory selves = new uint256[](2);
        volW[0] = alice;
        volW[1] = bob;
        selves[0] = 1000 * UNIT;
        selves[1] = 5000 * UNIT;
        ido.importVolumes(volW, selves);
        ido.freezeImport();
        ido.openSale();
        vm.stopPrank();

        assertEq(ido.pendingOf(alice), 0);
        assertEq(ido.pendingOf(bob), 0);
        assertEq(_self(alice), 1000 * UNIT);
        assertEq(ido.totalImported(), 6000 * UNIT);
        assertEq(ido.totalContributed(), 0);
        assertEq(ido.reservedRewards(), 0);

        _contribute(bob, 1000 * UNIT);
        assertEq(_direct(alice), 100 * UNIT);
        assertEq(ido.totalContributed(), 1000 * UNIT);
        assertEq(ido.totalImported(), 6000 * UNIT);
    }

    function test_imported4900RaisesRewardCapTo1225() public {
        vm.startPrank(owner);
        address[] memory wallets = new address[](1);
        bytes32[] memory codes = new bytes32[](1);
        wallets[0] = alice;
        codes[0] = _code("ALICE001");
        ido.importUsers(wallets, codes);
        uint256[] memory selves = new uint256[](1);
        selves[0] = 4_900 * UNIT;
        ido.importVolumes(wallets, selves);
        CoralRewards rewards = new CoralRewards(address(ido), owner, CoralNetworks.local());
        ido.setRewards(address(rewards));
        vm.stopPrank();

        assertEq(ido.totalImported(), 4_900 * UNIT);
        assertEq(ido.totalContributed(), 0);
        assertEq(rewards.rewardCap(), 1_225 * UNIT);
    }

    function test_importAfterFreezeReverts() public {
        vm.startPrank(owner);
        ido.freezeImport();
        address[] memory wallets = new address[](1);
        bytes32[] memory codes = new bytes32[](1);
        wallets[0] = alice;
        codes[0] = _code("ALICE001");
        vm.expectRevert(CoralIdo.ImportFrozenError.selector);
        ido.importUsers(wallets, codes);
        vm.stopPrank();
    }

    function test_importLengthMismatch() public {
        address[] memory wallets = new address[](2);
        bytes32[] memory codes = new bytes32[](1);
        wallets[0] = alice;
        wallets[1] = bob;
        codes[0] = _code("ALICE001");
        vm.prank(owner);
        vm.expectRevert(CoralIdo.LengthMismatch.selector);
        ido.importUsers(wallets, codes);
    }

    function test_importDuplicateUserReverts() public {
        vm.startPrank(owner);
        address[] memory wallets = new address[](1);
        bytes32[] memory codes = new bytes32[](1);
        wallets[0] = alice;
        codes[0] = _code("ALICE001");
        ido.importUsers(wallets, codes);
        vm.expectRevert(CoralIdo.AlreadyRegistered.selector);
        ido.importUsers(wallets, codes);
        vm.stopPrank();
    }

    function test_importReferrerCycleReverts() public {
        vm.startPrank(owner);
        address[] memory wallets = new address[](2);
        bytes32[] memory codes = new bytes32[](2);
        wallets[0] = alice;
        wallets[1] = bob;
        codes[0] = _code("ALICE001");
        codes[1] = _code("BOB00001");
        ido.importUsers(wallets, codes);

        address[] memory children = new address[](2);
        address[] memory refs = new address[](2);
        children[0] = bob;
        children[1] = alice;
        refs[0] = alice;
        refs[1] = bob;
        vm.expectRevert(CoralIdo.HasChildren.selector);
        ido.importReferrers(children, refs);
        vm.stopPrank();
    }

    function test_newDepositAfterImportAccrues() public {
        vm.startPrank(owner);
        address[] memory wallets = new address[](2);
        bytes32[] memory codes = new bytes32[](2);
        wallets[0] = alice;
        wallets[1] = bob;
        codes[0] = _code("ROOTANVL");
        codes[1] = _code("BOB00001");
        ido.importUsers(wallets, codes);
        address[] memory children = new address[](1);
        address[] memory refs = new address[](1);
        children[0] = bob;
        refs[0] = alice;
        ido.importReferrers(children, refs);
        address[] memory volW = new address[](1);
        uint256[] memory selves = new uint256[](1);
        volW[0] = alice;
        selves[0] = 100 * UNIT;
        ido.importVolumes(volW, selves);
        ido.freezeImport();
        ido.openSale();
        vm.stopPrank();

        assertEq(ido.pendingOf(alice), 0);
        _contribute(bob, 200 * UNIT);
        assertEq(_direct(alice), 20 * UNIT);
        vm.prank(alice);
        ido.claim();
        assertEq(ido.pendingOf(alice), 0);
    }
}
