// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "../lib/forge-std/src/Test.sol";
import {Pausable} from "../lib/openzeppelin-contracts/contracts/utils/Pausable.sol";
import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {CkeyAirdrop} from "../src/CkeyAirdrop.sol";
import {CoralToken} from "../src/CoralToken.sol";

contract CkeyAirdropTest is Test {
    CoralToken internal token;
    CkeyAirdrop internal drop;

    address internal owner = makeAddr("owner");
    address internal proposer = makeAddr("proposer");
    address internal reviewer = makeAddr("reviewer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        token = new CoralToken(owner);
        drop = new CkeyAirdrop(address(token), owner, proposer, reviewer);
        _allow();
        _fund(1000e18);
        assertEq(token.minter(), address(0));
    }

    // ------------------------------------------------------------ happy path

    function test_twoStepGrantThenClaim() public {
        _grantOne(bytes32("a"), alice, 10e18);
        assertEq(drop.claimable(alice), 10e18);
        vm.prank(alice);
        drop.claim();
        assertEq(token.balanceOf(alice), 10e18);
        assertEq(drop.reserve(), 990e18);
        assertEq(drop.outstanding(), 0);

        vm.prank(alice);
        vm.expectRevert(CoralToken.TransfersLocked.selector);
        token.transfer(bob, 1e18);
    }

    function test_hashMatchesOffChainEncoding() public view {
        address[] memory who = new address[](2);
        who[0] = 0x1111111111111111111111111111111111111111;
        who[1] = 0x2222222222222222222222222222222222222222;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 100e18;
        amounts[1] = 1;
        assertEq(drop.hashList(who, amounts), 0x4695118f12f18f0134053499c702b31d5c44e7067067e04cc48abc5f1d69e183);
    }

    function test_grantIsCumulativeAcrossBatches() public {
        _grantOne(bytes32("a"), alice, 10e18);
        _grantOne(bytes32("b"), alice, 5e18);
        vm.prank(alice);
        drop.claim();
        assertEq(token.balanceOf(alice), 15e18);
    }

    // ------------------------------------------------------------ two-person rule (H-1)

    function test_reviewerCannotGrantWithoutProposal() public {
        vm.prank(reviewer);
        vm.expectRevert(CkeyAirdrop.NotPending.selector);
        drop.grant(bytes32("x"), _one(reviewer), _amt(1000e18));
    }

    function test_reviewerCannotChangeProposedList() public {
        _propose(bytes32("a"), _one(alice), _amt(10e18));
        vm.prank(reviewer);
        vm.expectRevert(CkeyAirdrop.ListMismatch.selector);
        drop.grant(bytes32("a"), _one(reviewer), _amt(10e18));
        vm.prank(reviewer);
        vm.expectRevert(CkeyAirdrop.ListMismatch.selector);
        drop.grant(bytes32("a"), _one(alice), _amt(11e18));
    }

    function test_proposerCannotGrant() public {
        _propose(bytes32("a"), _one(proposer), _amt(10e18));
        vm.prank(proposer);
        vm.expectRevert(CkeyAirdrop.NotReviewer.selector);
        drop.grant(bytes32("a"), _one(proposer), _amt(10e18));
    }

    function test_strangersCannotProposeOrGrant() public {
        vm.prank(alice);
        vm.expectRevert(CkeyAirdrop.NotProposer.selector);
        drop.propose(bytes32("a"), bytes32(0), 1, 1);
        vm.prank(owner);
        vm.expectRevert(CkeyAirdrop.NotProposer.selector);
        drop.propose(bytes32("a"), bytes32(0), 1, 1);
        _propose(bytes32("a"), _one(alice), _amt(1e18));
        vm.prank(owner);
        vm.expectRevert(CkeyAirdrop.NotReviewer.selector);
        drop.grant(bytes32("a"), _one(alice), _amt(1e18));
    }

    function test_rolesMustBeDistinct() public {
        vm.startPrank(owner);
        vm.expectRevert(CkeyAirdrop.RoleConflict.selector);
        drop.setReviewer(proposer, true);
        vm.expectRevert(CkeyAirdrop.RoleConflict.selector);
        drop.setProposer(reviewer, true);
        vm.expectRevert(CkeyAirdrop.RoleConflict.selector);
        drop.setReviewer(owner, true);
        vm.expectRevert(CkeyAirdrop.RoleConflict.selector);
        drop.transferOwnership(reviewer);
        drop.transferOwnership(carol);
        vm.expectRevert(CkeyAirdrop.RoleConflict.selector);
        drop.setProposer(carol, true);
        vm.stopPrank();

        vm.expectRevert(CkeyAirdrop.RoleConflict.selector);
        new CkeyAirdrop(address(token), owner, alice, alice);
        vm.expectRevert(CkeyAirdrop.RoleConflict.selector);
        new CkeyAirdrop(address(token), owner, owner, alice);
    }

    function test_removedReviewerCannotGrant() public {
        _propose(bytes32("a"), _one(alice), _amt(1e18));
        vm.prank(owner);
        drop.setReviewer(reviewer, false);
        vm.prank(reviewer);
        vm.expectRevert(CkeyAirdrop.NotReviewer.selector);
        drop.grant(bytes32("a"), _one(alice), _amt(1e18));
    }

    function test_batchCannotBeReused() public {
        _grantOne(bytes32("a"), alice, 1e18);
        vm.prank(proposer);
        vm.expectRevert(CkeyAirdrop.BatchUsed.selector);
        drop.propose(bytes32("a"), bytes32(0), 1, 1);
        vm.prank(reviewer);
        vm.expectRevert(CkeyAirdrop.NotPending.selector);
        drop.grant(bytes32("a"), _one(alice), _amt(1e18));
    }

    function test_rejectedBatchCannotBeGranted() public {
        _propose(bytes32("a"), _one(alice), _amt(1e18));
        vm.prank(alice);
        vm.expectRevert(CkeyAirdrop.NotAuthorized.selector);
        drop.reject(bytes32("a"));
        vm.prank(reviewer);
        drop.reject(bytes32("a"));
        vm.prank(reviewer);
        vm.expectRevert(CkeyAirdrop.NotPending.selector);
        drop.grant(bytes32("a"), _one(alice), _amt(1e18));
    }

    function test_proposerCanWithdrawOwnProposal() public {
        _propose(bytes32("a"), _one(alice), _amt(1e18));
        vm.prank(proposer);
        drop.reject(bytes32("a"));
        (, CkeyAirdrop.Status status,,,) = drop.proposals(bytes32("a"));
        assertEq(uint8(status), uint8(CkeyAirdrop.Status.Rejected));
    }

    function test_duplicateRecipientReverts() public {
        address[] memory who = new address[](2);
        who[0] = alice;
        who[1] = alice;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1e18;
        amounts[1] = 2e18;
        _propose(bytes32("a"), who, amounts);
        vm.prank(reviewer);
        vm.expectRevert(CkeyAirdrop.DuplicateRecipient.selector);
        drop.grant(bytes32("a"), who, amounts);
    }

    function test_batchTooLarge() public {
        vm.prank(proposer);
        vm.expectRevert(CkeyAirdrop.BatchTooLarge.selector);
        drop.propose(bytes32("big"), bytes32(0), 101, 101);
    }

    function test_fullBatchFitsGas() public {
        address[] memory who = new address[](100);
        uint256[] memory amounts = new uint256[](100);
        for (uint256 i; i < 100; ++i) {
            who[i] = address(uint160(i + 1000));
            amounts[i] = 1e18;
        }
        _propose(bytes32("full"), who, amounts);
        vm.prank(reviewer);
        uint256 before = gasleft();
        drop.grant(bytes32("full"), who, amounts);
        assertLt(before - gasleft(), 5_000_000);
    }

    // ------------------------------------------------------------ reserve (M-2)

    function test_overAllocationReverts() public {
        _propose(bytes32("a"), _one(alice), _amt(1000e18 + 1));
        vm.prank(reviewer);
        vm.expectRevert(CkeyAirdrop.InsufficientReserve.selector);
        drop.grant(bytes32("a"), _one(alice), _amt(1000e18 + 1));
    }

    function test_directTransferIsNotGrantable() public {
        vm.prank(owner);
        token.mint(carol, 50e18);
        vm.prank(carol);
        token.transfer(address(drop), 50e18);
        assertEq(drop.stray(), 50e18);
        assertEq(drop.unallocated(), 1000e18);

        _propose(bytes32("otc"), _one(bob), _amt(1000e18 + 50e18));
        vm.prank(reviewer);
        vm.expectRevert(CkeyAirdrop.InsufficientReserve.selector);
        drop.grant(bytes32("otc"), _one(bob), _amt(1000e18 + 50e18));

        vm.prank(owner);
        drop.returnStray(carol, 50e18);
        assertEq(token.balanceOf(carol), 50e18);
        assertEq(drop.stray(), 0);
    }

    function test_directMintIsNotGrantable() public {
        vm.prank(owner);
        token.mint(address(drop), 10e18);
        assertEq(drop.unallocated(), 1000e18);
        assertEq(drop.stray(), 10e18);
    }

    function test_returnStrayCannotTouchReserve() public {
        vm.prank(owner);
        vm.expectRevert(CkeyAirdrop.ExceedsUnallocated.selector);
        drop.returnStray(owner, 1);
    }

    function test_ownerWithdrawsOnlyUnallocated() public {
        _grantOne(bytes32("a"), alice, 100e18);
        vm.prank(owner);
        drop.withdrawUnallocated(carol, 900e18);
        assertEq(token.balanceOf(carol), 900e18);
        vm.prank(owner);
        vm.expectRevert(CkeyAirdrop.ExceedsUnallocated.selector);
        drop.withdrawUnallocated(carol, 1);
        vm.prank(alice);
        drop.claim();
        assertEq(token.balanceOf(alice), 100e18);
        assertEq(drop.reserve(), 0);
    }

    function test_onlyOwnerFunds() public {
        vm.prank(owner);
        token.mint(carol, 5e18);
        vm.startPrank(carol);
        token.approve(address(drop), 5e18);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol));
        drop.fund(5e18);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ emergency (M-1)

    function test_pauseStopsGrantAndClaim() public {
        _grantOne(bytes32("a"), alice, 10e18);
        _propose(bytes32("b"), _one(bob), _amt(1e18));
        vm.prank(reviewer);
        drop.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        drop.claim();
        vm.prank(reviewer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        drop.grant(bytes32("b"), _one(bob), _amt(1e18));
        vm.prank(proposer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        drop.propose(bytes32("c"), bytes32(0), 1, 1);

        vm.prank(reviewer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, reviewer));
        drop.unpause();
        vm.prank(owner);
        drop.unpause();
        vm.prank(alice);
        drop.claim();
        assertEq(token.balanceOf(alice), 10e18);
    }

    function test_strangerCannotPause() public {
        vm.prank(alice);
        vm.expectRevert(CkeyAirdrop.NotAuthorized.selector);
        drop.pause();
    }

    function test_ownerRevokesWhilePaused() public {
        _grantOne(bytes32("a"), alice, 10e18);
        vm.startPrank(owner);
        drop.pause();
        drop.revokeUnclaimed(_one(alice), _amt(10e18));
        drop.setReviewer(reviewer, false);
        drop.unpause();
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(CkeyAirdrop.NothingToClaim.selector);
        drop.claim();
        assertEq(drop.unallocated(), 1000e18);
    }

    function test_revokeThenClaimRemaining() public {
        _grantOne(bytes32("a"), alice, 10e18);
        vm.prank(reviewer);
        drop.revokeUnclaimed(_one(alice), _amt(4e18));
        vm.prank(alice);
        drop.claim();
        assertEq(token.balanceOf(alice), 6e18);
        vm.prank(reviewer);
        vm.expectRevert(CkeyAirdrop.ExceedsUnclaimed.selector);
        drop.revokeUnclaimed(_one(alice), _amt(1));
    }

    function test_strangerCannotRevoke() public {
        _grantOne(bytes32("a"), alice, 10e18);
        vm.prank(proposer);
        vm.expectRevert(CkeyAirdrop.NotAuthorized.selector);
        drop.revokeUnclaimed(_one(alice), _amt(1));
    }

    // ------------------------------------------------------------ ownership and token state

    function test_renounceDisabled() public {
        vm.prank(owner);
        vm.expectRevert(CkeyAirdrop.RenounceDisabled.selector);
        drop.renounceOwnership();
        assertEq(drop.owner(), owner);
    }

    function test_claimFailsWhenNotAllowlisted() public {
        _grantOne(bytes32("a"), alice, 10e18);
        vm.prank(owner);
        token.setTransferAllowlist(address(drop), false);
        vm.prank(alice);
        vm.expectRevert(CoralToken.TransfersLocked.selector);
        drop.claim();
        assertEq(drop.claimable(alice), 10e18);
    }

    function test_tokenPauseBlocksClaim() public {
        _grantOne(bytes32("a"), alice, 10e18);
        vm.prank(owner);
        token.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        drop.claim();
        assertEq(drop.claimable(alice), 10e18);
    }

    function test_secondClaimPaysNothing() public {
        _grantOne(bytes32("a"), alice, 10e18);
        vm.prank(alice);
        drop.claim();
        vm.prank(alice);
        vm.expectRevert(CkeyAirdrop.NothingToClaim.selector);
        drop.claim();
    }

    function testFuzz_reserveInvariant(
        uint96 g1,
        uint96 g2,
        uint96 r,
        uint96 w,
        uint96 s
    ) public {
        uint256 a = bound(g1, 1, 400e18);
        uint256 b = bound(g2, 1, 400e18);
        _grantOne(bytes32("1"), alice, a);
        _grantOne(bytes32("2"), bob, b);
        uint256 rev = bound(r, 0, a);
        if (rev > 0) {
            vm.prank(owner);
            drop.revokeUnclaimed(_one(alice), _amt(rev));
        }
        uint256 donation = bound(s, 0, 100e18);
        if (donation > 0) {
            vm.prank(owner);
            token.mint(address(drop), donation);
        }
        vm.prank(bob);
        drop.claim();
        uint256 take = bound(w, 0, drop.unallocated());
        if (take > 0) {
            vm.prank(owner);
            drop.withdrawUnallocated(owner, take);
        }
        assertGe(drop.reserve(), drop.outstanding());
        assertEq(token.balanceOf(address(drop)), drop.reserve() + drop.stray());
        assertEq(drop.stray(), donation);
        if (a > rev) {
            vm.prank(alice);
            drop.claim();
        }
        assertEq(drop.outstanding(), 0);
    }

    // ------------------------------------------------------------ helpers

    function _allow() internal {
        vm.prank(owner);
        token.setTransferAllowlist(address(drop), true);
    }

    function _fund(
        uint256 amount
    ) internal {
        vm.startPrank(owner);
        token.mint(owner, amount);
        token.approve(address(drop), amount);
        drop.fund(amount);
        vm.stopPrank();
    }

    function _propose(
        bytes32 id,
        address[] memory who,
        uint256[] memory amounts
    ) internal {
        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            total += amounts[i];
        }
        vm.prank(proposer);
        drop.propose(id, keccak256(abi.encode(who, amounts)), who.length, total);
    }

    function _grantOne(
        bytes32 id,
        address who,
        uint256 amount
    ) internal {
        _propose(id, _one(who), _amt(amount));
        vm.prank(reviewer);
        drop.grant(id, _one(who), _amt(amount));
    }

    function _one(
        address who
    ) internal pure returns (address[] memory rows) {
        rows = new address[](1);
        rows[0] = who;
    }

    function _amt(
        uint256 amount
    ) internal pure returns (uint256[] memory rows) {
        rows = new uint256[](1);
        rows[0] = amount;
    }
}
