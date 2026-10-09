// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CoralIdoBase} from "./helpers/CoralIdoBase.sol";
import {CoralIdo} from "../src/CoralIdo.sol";

/// @notice Direct-reward and NFT boundaries. Team tiers are off-chain.
contract CoralRewardBoundaries is CoralIdoBase {
    function test_deposit99_selfHasNoDirect_qualifiedUplineEarnsTenPercent() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(alice, 500 * UNIT);
        _contribute(bob, 99 * UNIT);

        assertEq(_self(bob), 99 * UNIT);
        assertEq(_direct(bob), 0);
        assertEq(_direct(alice), 99 * UNIT / 10);
        assertEq(nft.balanceOf(bob), 0);
        assertEq(nft.balanceOf(alice), 0);
    }

    function test_topUpOne_thenLaterDownlinePaysDirect_earlierDownlineIsNotBackfilled() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _register(carol, "CAROL001", "BOB00001");
        _contribute(bob, 99 * UNIT);
        _contribute(carol, 100 * UNIT);
        assertEq(_self(bob), 99 * UNIT);
        assertEq(_direct(bob), 0);

        _contribute(bob, 1 * UNIT);
        assertEq(_self(bob), 100 * UNIT);
        assertEq(_direct(bob), 0);

        _register(dave, "DAVE0001", "BOB00001");
        _contribute(dave, 100 * UNIT);
        assertEq(_direct(bob), 10 * UNIT);
        assertEq(_direct(alice), 0);
    }

    function test_qualBelow500StillPaysDirectOnceSelfReaches100() public {
        _openSale();
        _register(bob, "BOB00001", "");
        _register(carol, "CAROL001", "BOB00001");
        _contribute(bob, 99 * UNIT);
        _contribute(bob, 1 * UNIT);
        _contribute(carol, 300 * UNIT);
        assertEq(_direct(bob), 30 * UNIT);
        assertEq(_self(bob), 100 * UNIT);
        assertEq(nft.balanceOf(bob), 0);
    }

    function test_self500PaysDirectOnLaterDeposit() public {
        _openSale();
        _register(bob, "BOB00001", "");
        _register(carol, "CAROL001", "BOB00001");
        _contribute(bob, 500 * UNIT);
        _contribute(carol, 100 * UNIT);
        assertEq(_direct(bob), 10 * UNIT);
        assertEq(nft.balanceOf(bob), 0);
    }

    function test_nftStaysZeroAt900AndMintsTwoAt1000() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 900 * UNIT);
        assertEq(_self(alice), 900 * UNIT);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(ido.nftMinted(alice), 0);
        assertEq(ido.nftDeferred(alice), 0);

        _contribute(alice, 100 * UNIT);
        assertEq(_self(alice), 1000 * UNIT);
        assertEq(nft.balanceOf(alice), 2);
        assertEq(ido.nftMinted(alice), 2);
        assertEq(ido.nftRemainder(alice), 0);
    }

    function test_nftCountsAtTheThousandBoundary() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 999 * UNIT);
        assertEq(nft.balanceOf(alice), 0);

        _contribute(alice, 500 * UNIT);
        assertEq(_self(alice), 1499 * UNIT);
        assertEq(nft.balanceOf(alice), 2);

        _contribute(alice, 1 * UNIT);
        assertEq(_self(alice), 1500 * UNIT);
        assertEq(nft.balanceOf(alice), 3);
    }

    function test_oneWeiBelow100ImportedSelfEarnsNoDirect() public {
        _importSelf(alice, "ALICE001", 100 * UNIT - 1);
        _openSale();
        _register(bob, "BOB00001", "ALICE001");
        _contribute(bob, 1 * UNIT);
        assertEq(_self(alice), 100 * UNIT - 1);
        assertEq(_direct(alice), 0);
        assertEq(nft.balanceOf(alice), 0);
    }

    function test_importedExactly100EarnsDirectOnOneUsdt_importItselfPaysNothing() public {
        _importSelf(alice, "ALICE001", 100 * UNIT);
        assertEq(_direct(alice), 0);
        assertEq(ido.pendingOf(alice), 0);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(ido.nftMinted(alice), 0);

        _openSale();
        _register(bob, "BOB00001", "ALICE001");
        _contribute(bob, 1 * UNIT);
        assertEq(_direct(alice), UNIT / 10);
    }

    function test_imported1000ReservesTwoNftsWithoutMinting() public {
        _importSelf(alice, "ALICE001", 1000 * UNIT);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(ido.nftMinted(alice), 2);
        assertEq(ido.importedNfts(alice), 2);
        assertEq(_direct(alice), 0);
    }

    function test_directDoesNotRollUpPastAnUnqualifiedReferrer() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _register(carol, "CAROL001", "BOB00001");
        _contribute(alice, 1000 * UNIT);
        _contribute(bob, 50 * UNIT);
        _contribute(carol, 100 * UNIT);
        assertEq(_direct(bob), 0);
        assertEq(_direct(alice), 5 * UNIT);
        assertEq(nft.balanceOf(alice), 2);
    }

    function test_belowMinIdoReverts() public {
        _openSale();
        _register(alice, "ALICE001", "");
        vm.prank(alice);
        vm.expectRevert(CoralIdo.AmountTooSmall.selector);
        ido.contribute(1);
    }

    function _importSelf(address who, string memory code, uint256 volume) internal {
        vm.startPrank(owner);
        address[] memory wallets = new address[](1);
        bytes32[] memory codes = new bytes32[](1);
        wallets[0] = who;
        codes[0] = _code(code);
        ido.importUsers(wallets, codes);
        uint256[] memory selves = new uint256[](1);
        selves[0] = volume;
        ido.importVolumes(wallets, selves);
        vm.stopPrank();
    }
}
