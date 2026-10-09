// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "../lib/forge-std/src/Test.sol";
import {CoralIdoBase} from "./helpers/CoralIdoBase.sol";
import {CoralIdo} from "../src/CoralIdo.sol";
import {CoralNetworks} from "../src/network/CoralNetworks.sol";
import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {CoralToken} from "../src/CoralToken.sol";
import {MockUSDT} from "../src/MockUSDT.sol";

contract CoralAllocationTest is CoralIdoBase {
    function test_weekAdvancesAfterOneDuration() public {
        _openSale();
        vm.roll(block.number + 30);
        assertEq(ido.currentWeek(), 1);
    }

    function test_contributeMintsPlaceholderNemo() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _contribute(alice, 100 * UNIT);
        assertEq(nemo.balanceOf(alice), 10_000 * UNIT);
        assertEq(ido.totalNemoAllocated(), 10_000 * UNIT);
    }

    function test_importDoesNotPayNemo() public {
        vm.startPrank(owner);
        address[] memory wallets = new address[](1);
        bytes32[] memory codes = new bytes32[](1);
        wallets[0] = alice;
        codes[0] = _code("ALICE001");
        ido.importUsers(wallets, codes);
        address[] memory volW = new address[](1);
        uint256[] memory selves = new uint256[](1);
        volW[0] = alice;
        selves[0] = 1000 * UNIT;
        ido.importVolumes(volW, selves);
        ido.freezeImport();
        ido.openSale();
        vm.stopPrank();

        assertEq(nemo.balanceOf(alice), 0);
        assertEq(ido.totalNemoAllocated(), 0);
    }

    function test_emptyVaultStillMintsOnContribute() public {
        _openSale();
        _register(alice, "ALICE001", "");
        assertEq(nemo.balanceOf(address(ido)), 0);
        _contribute(alice, 100 * UNIT);
        assertEq(_self(alice), 100 * UNIT);
        assertEq(nemo.balanceOf(alice), 10_000 * UNIT);
    }

    function test_saleOpenedAtStableOnReopen() public {
        _openSale();
        uint256 opened = ido.saleOpenedAt();
        uint256 openedBlock = ido.saleOpenedBlock();
        vm.prank(owner);
        ido.closeSale();
        vm.warp(block.timestamp + 3 days);
        vm.roll(block.number + 10);
        vm.prank(owner);
        ido.openSale();
        assertEq(ido.saleOpenedAt(), opened);
        assertEq(ido.saleOpenedBlock(), openedBlock);
    }

    function test_wrongNetworkParamsRevert() public {
        vm.chainId(56);
        vm.expectRevert(CoralIdo.WrongNetwork.selector);
        new CoralIdo(address(usdt), address(nemo), address(nft), owner, CoralNetworks.local());
    }

}

contract CoralTokenTest is Test {
    CoralToken internal token;
    address internal owner = makeAddr("owner");
    address internal minter = makeAddr("minter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal campaign = makeAddr("campaign");

    function setUp() public {
        token = new CoralToken(owner);
        vm.prank(owner);
        token.setMinter(minter);
    }

    function test_startsEmptyCapped() public view {
        assertEq(token.name(), "Ckey");
        assertEq(token.symbol(), "CKEY");
        assertEq(token.totalSupply(), 0);
        assertEq(token.CAP(), 1_000_000_000e18);
        assertEq(token.minter(), minter);
    }

    function test_minterCanMint() public {
        vm.prank(minter);
        token.mint(alice, 1e18);
        assertEq(token.balanceOf(alice), 1e18);
    }

    function test_ownerCanMintCampaignInventory() public {
        vm.prank(owner);
        token.mint(campaign, 1000e18);
        assertEq(token.balanceOf(campaign), 1000e18);
    }

    function test_strangerMintReverts() public {
        vm.prank(alice);
        vm.expectRevert(CoralToken.NotAuthorized.selector);
        token.mint(alice, 1e18);
    }

    function test_capExceededReverts() public {
        uint256 cap = token.CAP();
        vm.prank(minter);
        token.mint(alice, cap);
        vm.prank(minter);
        vm.expectRevert(CoralToken.CapExceeded.selector);
        token.mint(alice, 1);
    }

    function test_plainTransferReverts() public {
        vm.prank(minter);
        token.mint(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(CoralToken.TransfersLocked.selector);
        token.transfer(bob, 1e18);

        vm.prank(alice);
        token.approve(bob, 1e18);
        vm.prank(bob);
        vm.expectRevert(CoralToken.TransfersLocked.selector);
        token.transferFrom(alice, bob, 1e18);
    }

    function test_allowlistCampaignCanAirdrop() public {
        vm.prank(owner);
        token.mint(campaign, 100e18);
        vm.prank(owner);
        token.setTransferAllowlist(campaign, true);

        vm.prank(campaign);
        token.transfer(alice, 40e18);
        assertEq(token.balanceOf(alice), 40e18);

        vm.prank(alice);
        vm.expectRevert(CoralToken.TransfersLocked.selector);
        token.transfer(bob, 1e18);

        vm.prank(alice);
        token.transfer(campaign, 10e18);
        assertEq(token.balanceOf(campaign), 70e18);
    }

    function test_ownerCanOpenTransfersForEveryone() public {
        vm.prank(minter);
        token.mint(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        token.setTransfersEnabled(true);

        vm.expectEmit(address(token));
        emit CoralToken.TransfersEnabledUpdated(true);
        vm.prank(owner);
        token.setTransfersEnabled(true);
        vm.prank(alice);
        token.transfer(bob, 4e18);
        assertEq(token.balanceOf(bob), 4e18);

        vm.prank(owner);
        token.setTransfersEnabled(false);
        vm.prank(bob);
        vm.expectRevert(CoralToken.TransfersLocked.selector);
        token.transfer(alice, 1e18);
        assertEq(token.balanceOf(bob), 4e18);
    }

    function test_pauseBlocksMint() public {
        vm.prank(owner);
        token.pause();
        vm.prank(minter);
        vm.expectRevert();
        token.mint(alice, 1e18);
        vm.prank(owner);
        token.unpause();
        vm.prank(minter);
        token.mint(alice, 1e18);
        assertEq(token.balanceOf(alice), 1e18);
    }

    function test_cannotRescueSelf() public {
        MockUSDT usdt = new MockUSDT();
        usdt.mint(address(token), 10e18);
        vm.prank(owner);
        token.rescue(usdt, owner, 10e18);
        assertEq(usdt.balanceOf(owner), 10e18);

        vm.prank(owner);
        vm.expectRevert(CoralToken.RescueSelf.selector);
        token.rescue(token, owner, 1);
    }
}
