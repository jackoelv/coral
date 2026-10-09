// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "../lib/forge-std/src/Test.sol";
import {CoralIdoBase} from "./helpers/CoralIdoBase.sol";
import {CoralIdo} from "../src/CoralIdo.sol";
import {CoralNFT} from "../src/CoralNFT.sol";
import {CoralNftInterest} from "../src/CoralNftInterest.sol";
import {CoralNetworks} from "../src/network/CoralNetworks.sol";
import {CoralToken} from "../src/CoralToken.sol";

contract CoralNftInterestTest is CoralIdoBase {
    CoralNftInterest internal interest;

    function setUp() public override {
        super.setUp();
        interest = new CoralNftInterest(address(ido), owner);
        vm.startPrank(owner);
        nemo.setInterestMinter(address(interest));
        ido.setNftInterest(address(interest));
        vm.stopPrank();
    }

    function test_twoNftsPayOnePercentAfterAFullWeek() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1_000 * UNIT);
        assertEq(nft.balanceOf(alice), 2);
        assertEq(interest.pending(alice), 0);

        _advanceWeeks(1);
        assertEq(interest.pending(alice), 1_000 * UNIT);

        uint256 treasury = usdt.balanceOf(address(ido));
        vm.prank(alice);
        interest.claim();
        assertEq(nemo.balanceOf(alice), 100_000 * UNIT + 1_000 * UNIT);
        assertEq(usdt.balanceOf(address(ido)), treasury);
        assertEq(interest.pending(alice), 0);
    }

    function test_tierRates() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 5_000 * UNIT);
        _advanceWeeks(1);
        assertEq(interest.pending(alice), 10_000 * UNIT);

        _register(bob, "BOB00001", "");
        _contribute(bob, 10_000 * UNIT);
        _advanceWeeks(1);
        assertEq(interest.pending(bob), 25_000 * UNIT);

        _register(carol, "CAROL001", "");
        _contribute(carol, 7_500 * UNIT);
        _advanceWeeks(1);
        assertEq(interest.pending(carol), 15_000 * UNIT);

        _register(dave, "DAVE0001", "");
        _contribute(dave, 30_000 * UNIT);
        _advanceWeeks(1);
        assertEq(interest.pending(dave), 90_000 * UNIT);
    }

    function test_oneNftPaysNothing() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 500 * UNIT);
        assertEq(nft.balanceOf(alice), 0);
        _advanceWeeks(1);
        assertEq(interest.pending(alice), 0);
        vm.prank(alice);
        vm.expectRevert(CoralNftInterest.NothingToClaim.selector);
        interest.claim();
    }

    function test_laterNftsDoNotRaiseFinishedWeeks() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1_000 * UNIT);
        _advanceWeeks(1);
        _contribute(alice, 4_000 * UNIT);
        assertEq(nft.balanceOf(alice), 10);
        _advanceWeeks(1);
        assertEq(interest.pending(alice), 1_000 * UNIT + 10_000 * UNIT);
    }

    function test_closeSaleStopsLaterWeeksButKeepsTheCurrentOne() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1_000 * UNIT);
        vm.prank(owner);
        ido.endIdo();
        assertEq(ido.idoEndedWeek(), 1);
        _advanceWeeks(5);
        assertEq(interest.pending(alice), 1_000 * UNIT);
    }

    function test_tierChangeAppliesFromTheCurrentWeek() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1_000 * UNIT);
        _advanceWeeks(1);
        vm.prank(owner);
        interest.setTiers(_tiers(2, 200));
        assertEq(interest.versionCount(), 2);
        _advanceWeeks(1);
        assertEq(interest.pending(alice), 1_000 * UNIT + 2_000 * UNIT);
    }

    function test_sameWeekTierEditOverwrites() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1_000 * UNIT);
        vm.startPrank(owner);
        interest.setTiers(_tiers(2, 150));
        interest.setTiers(_tiers(2, 200));
        vm.stopPrank();
        assertEq(interest.versionCount(), 1);
        _advanceWeeks(1);
        assertEq(interest.pending(alice), 2_000 * UNIT);
    }

    function test_importDoesNotMintAndGrantEarnsFromThatWeek() public {
        vm.startPrank(owner);
        ido.importUsers(_one(alice), _oneCode("ALICE001"));
        ido.importVolumes(_one(alice), _oneAmount(1_000 * UNIT));
        nemo.mint(alice, 100_000 * UNIT);
        vm.stopPrank();
        assertEq(nft.balanceOf(alice), 0);
        assertEq(nemo.balanceOf(alice), 100_000 * UNIT);
        assertEq(ido.nftMinted(alice), 2);
        assertEq(ido.totalNemoAllocated(), 0);

        _openSale();
        _advanceWeeks(1);
        vm.prank(owner);
        ido.grantNft(alice, 2);
        assertEq(nft.balanceOf(alice), 2);
        assertEq(ido.nftMinted(alice), 2);
        assertEq(_self(alice), 1_000 * UNIT);
        assertEq(interest.pending(alice), 0);

        _advanceWeeks(1);
        assertEq(interest.pending(alice), 1_000 * UNIT);

        _contribute(alice, 500 * UNIT);
        assertEq(nft.balanceOf(alice), 3);
        assertEq(ido.nftMinted(alice), 3);
    }

    function test_globalInterestCapStopsFurtherAccrual() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1_000 * UNIT);
        vm.expectEmit(address(interest));
        emit CoralNftInterest.InterestCapUpdated(500 * UNIT);
        vm.prank(owner);
        interest.setInterestCap(500 * UNIT);
        _advanceWeeks(1);
        assertEq(interest.pending(alice), 500 * UNIT);
        _advanceWeeks(1);
        assertEq(interest.pending(alice), 500 * UNIT);
    }

    function test_accountInterestStopsAtPrincipal() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1_000 * UNIT);
        vm.expectEmit(address(interest));
        emit CoralNftInterest.AccountCapBpsUpdated(100);
        vm.prank(owner);
        interest.setAccountCapBps(100);
        _advanceWeeks(2);
        assertEq(interest.pending(alice), 1_000 * UNIT);
    }

    function test_nftCapIsTenThousand() public {
        _openSale();
        _register(alice, "ALICE001", "");
        assertEq(ido.nftCap(), 10_000);
        _contribute(alice, 1000 * UNIT);
        assertEq(ido.nftsAllocated(), 2);
    }

    function test_rejectsBadTiersAndASecondInterestLink() public {
        CoralNftInterest.Tier[] memory tiers = new CoralNftInterest.Tier[](1);
        tiers[0] = CoralNftInterest.Tier({minNfts: 2, weeklyBps: 1001});
        vm.prank(owner);
        vm.expectRevert(CoralNftInterest.InvalidTiers.selector);
        interest.setTiers(tiers);

        vm.prank(owner);
        vm.expectRevert(CoralIdo.InterestAlreadySet.selector);
        ido.setNftInterest(address(interest));
    }

    function test_replacementStartsAtTheCutWeek() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1_000 * UNIT);
        _advanceWeeks(1);

        CoralNftInterest next = _switchInterest();
        assertTrue(interest.detached());
        assertEq(interest.stopWeek(), ido.currentWeek());
        assertEq(next.startWeek(), interest.stopWeek());
        assertEq(interest.pending(alice), 1_000 * UNIT);
        assertEq(next.pending(alice), 0);

        _advanceWeeks(1);
        assertEq(interest.pending(alice), 1_000 * UNIT);
        assertEq(next.pending(alice), 1_000 * UNIT);

        vm.prank(alice);
        interest.claim();
        vm.prank(alice);
        next.claim();
        assertEq(nemo.balanceOf(alice), 102_000 * UNIT);
    }

    function test_laterMintDoesNotRepriceDetachedWeeks() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1_000 * UNIT);
        _advanceWeeks(1);
        CoralNftInterest next = _switchInterest();

        _contribute(alice, 4_000 * UNIT);
        assertEq(nft.balanceOf(alice), 10);
        assertEq(interest.pending(alice), 1_000 * UNIT);

        _advanceWeeks(1);
        assertEq(interest.pending(alice), 1_000 * UNIT);
        assertEq(next.pending(alice), 10_000 * UNIT);
    }

    function test_secondReplacementStillSettlesTheFirst() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1_000 * UNIT);
        _advanceWeeks(1);
        CoralNftInterest second = _switchInterest();
        _advanceWeeks(1);
        CoralNftInterest third = _switchInterest();

        _contribute(alice, 4_000 * UNIT);
        assertEq(interest.pending(alice), 1_000 * UNIT);
        assertEq(second.pending(alice), 1_000 * UNIT);

        _advanceWeeks(1);
        assertEq(third.pending(alice), 10_000 * UNIT);
        assertEq(interest.pending(alice), 1_000 * UNIT);
        assertEq(second.pending(alice), 1_000 * UNIT);
    }

    function test_swapAfterEndDoesNotOpenAnotherStream() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 1_000 * UNIT);
        vm.prank(owner);
        ido.endIdo();

        CoralNftInterest next = _switchInterest();
        _advanceWeeks(3);
        assertEq(interest.pending(alice), 1_000 * UNIT);
        assertEq(next.pending(alice), 0);
    }

    function test_ninthInterestReverts() public {
        for (uint256 i = 0; i < 7; i++) {
            _switchInterest();
        }
        CoralNftInterest ninth = new CoralNftInterest(address(ido), owner);
        vm.prank(owner);
        vm.expectRevert(CoralIdo.TooManyInterests.selector);
        ido.setNftInterest(address(ninth));
    }

    function _switchInterest() internal returns (CoralNftInterest next) {
        next = new CoralNftInterest(address(ido), owner);
        vm.startPrank(owner);
        nemo.setInterestMinter(address(next));
        ido.setNftInterest(address(next));
        vm.stopPrank();
    }

    function _advanceWeeks(
        uint256 count
    ) internal {
        vm.roll(block.number + 30 * count);
    }

    function _tiers(
        uint256 minNfts,
        uint256 weeklyBps
    ) internal pure returns (CoralNftInterest.Tier[] memory tiers) {
        tiers = new CoralNftInterest.Tier[](4);
        tiers[0] = CoralNftInterest.Tier({minNfts: minNfts, weeklyBps: weeklyBps});
        tiers[1] = CoralNftInterest.Tier({minNfts: 10, weeklyBps: 200});
        tiers[2] = CoralNftInterest.Tier({minNfts: 20, weeklyBps: 250});
        tiers[3] = CoralNftInterest.Tier({minNfts: 60, weeklyBps: 300});
    }

    function _one(
        address account
    ) internal pure returns (address[] memory accounts) {
        accounts = new address[](1);
        accounts[0] = account;
    }

    function _oneCode(
        string memory code
    ) internal pure returns (bytes32[] memory codes) {
        codes = new bytes32[](1);
        codes[0] = _code(code);
    }

    function _oneAmount(
        uint256 amount
    ) internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](1);
        amounts[0] = amount;
    }
}

contract CoralNftInterestCalendarTest is Test {
    function test_beijingSundayStepsAtMidnight() public {
        vm.chainId(56);
        CoralToken token = new CoralToken(address(this));
        CoralNFT nft = new CoralNFT(address(this), "FreeDaoRWA", "FREEDAONFT");
        CoralNetworks.Params memory params = CoralNetworks.bscMainnet();
        CoralIdo ido = new CoralIdo(params.usdt, address(token), address(nft), address(this), params);
        CoralNftInterest interest = new CoralNftInterest(address(ido), address(this));
        assertTrue(interest.calendarWeeks());

        uint256 boundary = interest.weekBoundary(100);
        vm.warp(boundary - 30);
        assertEq(interest.interestWeek(block.timestamp), 99);
        vm.warp(boundary);
        assertEq(interest.interestWeek(block.timestamp), 100);
    }
}
