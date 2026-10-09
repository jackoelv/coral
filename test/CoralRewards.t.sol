// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CoralIdoBase} from "./helpers/CoralIdoBase.sol";
import {CoralRewards} from "../src/CoralRewards.sol";
import {CoralNetworks} from "../src/network/CoralNetworks.sol";

contract CoralRewardsTest is CoralIdoBase {
    CoralRewards internal rewards;
    address internal publisher = makeAddr("publisher");

    function setUp() public override {
        super.setUp();
        rewards = new CoralRewards(address(ido), owner, CoralNetworks.local());
        vm.startPrank(owner);
        ido.setRewards(address(rewards));
        rewards.setPublisher(publisher);
        vm.stopPrank();
        _openSale();
    }

    function test_merklePaysTeamOnce() public {
        _register(alice, "ALICE001", "");
        _contribute(alice, 500 * UNIT);
        _register(bob, "BOB00001", "ALICE001");
        _contribute(bob, 1000 * UNIT);
        assertEq(_direct(alice), 100 * UNIT);

        _publish(_leaf(alice, 30 * UNIT), 30 * UNIT);
        uint256 before = usdt.balanceOf(alice);
        vm.prank(alice);
        rewards.claim(30 * UNIT, new bytes32[](0));
        assertEq(usdt.balanceOf(alice) - before, 30 * UNIT);
        assertEq(rewards.outstanding(), 0);
        assertEq(rewards.merkleRoot(), _leaf(alice, 30 * UNIT));

        vm.prank(alice);
        vm.expectRevert(CoralRewards.NothingToClaim.selector);
        rewards.claim(30 * UNIT, new bytes32[](0));
    }

    function test_strangerCannotPublish() public {
        vm.prank(carol);
        vm.expectRevert(CoralRewards.NotPublisher.selector);
        rewards.publishRoot(_leaf(alice, 1 * UNIT), bytes32("h"), 1 * UNIT, "ipfs://leaf");
    }

    function test_ownerCanStillPublish() public {
        _register(alice, "ALICE001", "");
        _contribute(alice, 10_000 * UNIT);
        vm.prank(owner);
        rewards.publishRoot(_leaf(alice, 1 * UNIT), bytes32("h"), 1 * UNIT, "");
        assertEq(rewards.committed(), 1 * UNIT);
    }

    function test_badProofReverts() public {
        _register(alice, "ALICE001", "");
        _contribute(alice, 10_000 * UNIT);
        _publish(_leaf(alice, 10 * UNIT), 10 * UNIT);
        vm.prank(alice);
        vm.expectRevert(CoralRewards.InvalidProof.selector);
        rewards.claim(11 * UNIT, new bytes32[](0));
    }

    function test_maxIncreaseCapsOnePublish() public {
        _register(alice, "ALICE001", "");
        _contribute(alice, 10_000 * UNIT);
        vm.prank(owner);
        rewards.setMaxRootIncrease(5 * UNIT);
        vm.prank(publisher);
        vm.expectRevert(CoralRewards.IncreaseTooLarge.selector);
        rewards.publishRoot(_leaf(alice, 6 * UNIT), bytes32("h"), 6 * UNIT, "");
        _publish(_leaf(alice, 5 * UNIT), 5 * UNIT);
        assertEq(rewards.committed(), 5 * UNIT);
    }

    function test_pauseBlocksTeamClaim() public {
        _register(alice, "ALICE001", "");
        _contribute(alice, 10_000 * UNIT);
        _publish(_leaf(alice, 10 * UNIT), 10 * UNIT);
        vm.prank(owner);
        ido.pause();
        vm.prank(alice);
        vm.expectRevert();
        rewards.claim(10 * UNIT, new bytes32[](0));
    }

    function test_historicalBudgetAllowsRootBeforeNewDeposits() public {
        vm.prank(owner);
        rewards.setHistoricalTeamBudget(70 * UNIT);
        _publish(_leaf(alice, 70 * UNIT), 70 * UNIT);
        assertEq(rewards.committed(), 70 * UNIT);

        vm.prank(publisher);
        vm.expectRevert(CoralRewards.CapExceeded.selector);
        rewards.publishRoot(_leaf(alice, 71 * UNIT), bytes32("h"), 71 * UNIT, "");
    }

    function test_rootAboveGlobalCapReverts() public {
        _register(alice, "ALICE001", "");
        _contribute(alice, 1000 * UNIT);
        vm.prank(publisher);
        vm.expectRevert(CoralRewards.CapExceeded.selector);
        rewards.publishRoot(_leaf(alice, 251 * UNIT), bytes32("h"), 251 * UNIT, "");
    }

    function test_mainnetParamsRejectLocalChain() public {
        vm.expectRevert(CoralRewards.WrongNetwork.selector);
        new CoralRewards(address(ido), owner, CoralNetworks.bscMainnet());
    }

    function _publish(
        bytes32 root,
        uint256 cumulative
    ) internal {
        vm.prank(publisher);
        rewards.publishRoot(root, bytes32("h"), cumulative, "ipfs://leaves");
    }

    function _leaf(
        address account,
        uint256 cumulative
    ) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))));
    }
}
