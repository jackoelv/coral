// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CoralIdoBase} from "./helpers/CoralIdoBase.sol";
import {CoralIdo} from "../src/CoralIdo.sol";
import {CoralToken} from "../src/CoralToken.sol";

contract CoralIdoTest is CoralIdoBase {
    function test_noReferrer_noDirect_balanceIncreases() public {
        _openSale();
        _register(alice, "ALICE001", "");
        uint256 beforeBal = usdt.balanceOf(address(ido));
        _contribute(alice, 1000 * UNIT);
        assertEq(usdt.balanceOf(address(ido)), beforeBal + 1000 * UNIT);
        assertEq(_direct(alice), 0);
        assertEq(_self(alice), 1000 * UNIT);
        assertEq(ido.pendingOf(alice), 0);
    }

    function test_direct10Percent_A_refers_B_1000() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(alice, 100 * UNIT);
        _contribute(bob, 1000 * UNIT);

        assertEq(_self(bob), 1000 * UNIT);
        assertEq(_direct(alice), 100 * UNIT);

        uint256 aliceBefore = usdt.balanceOf(alice);
        vm.prank(alice);
        ido.claim();
        assertEq(usdt.balanceOf(alice), aliceBefore + 100 * UNIT);
        assertEq(ido.pendingOf(alice), 0);
    }

    function test_directRequiresReferrerSelfAtLeast100() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(bob, 1000 * UNIT);
        assertEq(_self(alice), 0);
        assertEq(_direct(alice), 0);
    }

    function test_qualifiedReferrerEarnsOnFifty() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(alice, 100 * UNIT);
        _contribute(bob, 50 * UNIT);
        assertEq(_direct(alice), 5 * UNIT);
    }

    function test_referrerAt50EarnsNothingOnDownline100() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(alice, 50 * UNIT);
        _contribute(bob, 100 * UNIT);
        assertEq(_direct(alice), 0);
    }

    function test_crossing100DoesNotBackfillDirect() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(alice, 50 * UNIT);
        _contribute(bob, 100 * UNIT);
        _contribute(alice, 50 * UNIT);
        assertEq(_self(alice), 100 * UNIT);
        assertEq(_direct(alice), 0);
        _contribute(bob, 80 * UNIT);
        assertEq(_direct(alice), 8 * UNIT);
    }

    function test_qualifiedReferrerEarnsOnFiftyAfterOwn1000() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(alice, 1000 * UNIT);
        _contribute(bob, 50 * UNIT);

        assertEq(_self(bob), 50 * UNIT);
        assertEq(_direct(alice), 5 * UNIT);
        assertEq(uint256(ido.roleOf(bob)), uint256(CoralIdo.Role.Explorer));
        assertEq(uint256(ido.roleOf(alice)), uint256(CoralIdo.Role.Partner));
    }

    function test_directBpsChangeAppliesNextDepositOnly() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _register(carol, "CAROL001", "ALICE001");
        _contribute(alice, 100 * UNIT);
        _contribute(bob, 1000 * UNIT);
        assertEq(_direct(alice), 100 * UNIT);

        vm.prank(owner);
        ido.setDirectReferralBps(500);
        _contribute(carol, 1000 * UNIT);
        assertEq(_direct(alice), 150 * UNIT);
    }

    function test_deepChainStillContributes() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _register(carol, "CAROL001", "BOB00001");
        _register(dave, "DAVE0001", "CAROL001");
        _contribute(carol, 100 * UNIT);
        _contribute(dave, 1000 * UNIT);
        assertEq(_self(dave), 1000 * UNIT);
        assertEq(_direct(carol), 100 * UNIT);
        assertEq(ido.referrerOf(dave), carol);
    }

    function test_hasChildrenCannotBindReferrer() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _register(carol, "CAROL001", "");
        assertTrue(ido.hasChildren(alice));
        vm.prank(alice);
        vm.expectRevert(CoralIdo.HasChildren.selector);
        ido.bindReferrer(_code("CAROL001"));
    }

    function test_bindReferrerOnce() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "");
        vm.prank(bob);
        ido.bindReferrer(_code("ALICE001"));
        assertEq(ido.getAccount(bob).referrer, alice);
        vm.prank(bob);
        vm.expectRevert(CoralIdo.AlreadyBound.selector);
        ido.bindReferrer(_code("ALICE001"));
    }

    function test_selfReferralReverts() public {
        _openSale();
        vm.prank(alice);
        vm.expectRevert(CoralIdo.SelfReferral.selector);
        ido.register(_code("ALICE001"), _code("ALICE001"));
    }

    function test_invalidCodeReverts() public {
        _openSale();
        vm.prank(alice);
        vm.expectRevert(CoralIdo.InvalidCode.selector);
        ido.register(bytes32(uint256(1)), bytes32(0));
    }

    function test_duplicateCodeReverts() public {
        _openSale();
        _register(alice, "ALICE001", "");
        vm.prank(bob);
        vm.expectRevert(CoralIdo.CodeTaken.selector);
        ido.register(_code("ALICE001"), bytes32(0));
    }

    function test_contributeRequiresSaleOpen() public {
        vm.prank(owner);
        ido.freezeImport();
        _register(alice, "ALICE001", "");
        vm.prank(alice);
        vm.expectRevert(CoralIdo.SaleClosedError.selector);
        ido.contribute(100 * UNIT);
    }

    function test_openSaleRequiresFrozenImport() public {
        vm.prank(owner);
        vm.expectRevert(CoralIdo.ImportNotFrozenError.selector);
        ido.openSale();
    }

    function test_minIdoEnforced() public {
        _openSale();
        _register(alice, "ALICE001", "");
        vm.prank(alice);
        vm.expectRevert(CoralIdo.AmountTooSmall.selector);
        ido.contribute(1);
    }

    function test_registerAndContribute_oneCall() public {
        _openSale();
        _register(alice, "ALICE001", "");
        vm.prank(bob);
        ido.registerAndContribute(_code("BOB00001"), _code("ALICE001"), 50 * UNIT);
        assertTrue(ido.getAccount(bob).registered);
        assertEq(_self(bob), 50 * UNIT);
        assertEq(_direct(alice), 0);
    }

    function test_claimAndTreasuryReserve() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(alice, 100 * UNIT);
        _contribute(bob, 1000 * UNIT);

        uint256 pending = ido.pendingOf(alice);
        assertEq(pending, 100 * UNIT);
        uint256 aliceBefore = usdt.balanceOf(alice);
        vm.prank(alice);
        ido.claim();
        assertEq(usdt.balanceOf(alice), aliceBefore + pending);
        assertEq(ido.pendingOf(alice), 0);

        uint256 reserved = ido.reservedRewards();
        assertEq(reserved, 0);
        uint256 withdrawable = ido.treasuryWithdrawable();
        assertEq(withdrawable, usdt.balanceOf(address(ido)));
        vm.prank(owner);
        ido.withdrawTreasury(owner, withdrawable);
        assertEq(usdt.balanceOf(address(ido)), 0);
    }

    function test_cannotDrainReservedRewards() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(alice, 100 * UNIT);
        _contribute(bob, 1000 * UNIT);

        uint256 reserved = ido.reservedRewards();
        uint256 withdrawable = ido.treasuryWithdrawable();
        assertEq(reserved, 100 * UNIT);
        assertEq(withdrawable, 1100 * UNIT - 100 * UNIT);
        vm.prank(owner);
        vm.expectRevert(CoralIdo.InsufficientTreasury.selector);
        ido.withdrawTreasury(owner, withdrawable + 1);
    }

    function test_identityPartnerAndCoBuilder() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(alice, 1000 * UNIT);
        _contribute(bob, 30_000 * UNIT);
        assertEq(uint256(ido.roleOf(alice)), uint256(CoralIdo.Role.Partner));
        assertEq(uint256(ido.roleOf(bob)), uint256(CoralIdo.Role.Partner));
        assertEq(_direct(alice), 3000 * UNIT);
    }

    function test_noTeamRewardsOnContribute() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _register(carol, "CAROL001", "BOB00001");
        _contribute(alice, 1000 * UNIT);
        _contribute(bob, 10_000 * UNIT);
        _contribute(carol, 1000 * UNIT);
        assertEq(_direct(bob), 100 * UNIT);
        assertEq(_direct(alice), 1000 * UNIT);
    }

    function test_rewardCapOnParams() public {
        vm.prank(owner);
        vm.expectRevert(CoralIdo.RewardBpsTooHigh.selector);
        ido.setDirectReferralBps(2501);

        vm.prank(owner);
        ido.setDirectReferralBps(2500);
        assertEq(ido.directReferralBps(), 2500);
    }

    function test_rootanvlCodeAllowed() public {
        _openSale();
        _register(alice, "ROOTANVL", "");
        assertEq(ido.codeToAccount(_code("ROOTANVL")), alice);
    }

    function test_contributeMintsPlaceholderNemo() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 100 * UNIT);
        assertEq(nemo.balanceOf(alice), 10_000 * UNIT);
        assertEq(ido.totalNemoAllocated(), 10_000 * UNIT);
        assertEq(ido.tokensFor(100 * UNIT), 10_000 * UNIT);
    }

    function test_directUnchangedWhenMintingNemo() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(bob, 1000 * UNIT);
        assertEq(_direct(alice), 0);
        assertEq(_self(bob), 1000 * UNIT);
        assertEq(nemo.balanceOf(bob), 100_000 * UNIT);
        assertEq(nemo.balanceOf(alice), 0);
    }

    function test_holderCannotTransferMintedNemo() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 100 * UNIT);
        vm.prank(alice);
        vm.expectRevert(CoralToken.TransfersLocked.selector);
        nemo.transfer(bob, 1);
    }

    function test_tokensPerUsdtChangeAppliesNextMint() public {
        _openSale();
        _register(alice, "ALICE001", "");
        vm.prank(owner);
        ido.setTokensPerUsdt(50e18);
        _contribute(alice, 100 * UNIT);
        assertEq(nemo.balanceOf(alice), 5000 * UNIT);
    }

    function test_capExceededRevertsContribute() public {
        _openSale();
        _register(alice, "ALICE001", "");
        uint256 cap = nemo.CAP();
        vm.prank(owner);
        ido.setTokensPerUsdt(cap);
        _contribute(alice, 1 * UNIT);
        vm.prank(alice);
        vm.expectRevert(CoralToken.CapExceeded.selector);
        ido.contribute(1 * UNIT);
    }
}
