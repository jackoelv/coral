// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {CoralIdoBase} from "./helpers/CoralIdoBase.sol";
import {CoralIdo} from "../src/CoralIdo.sol";

contract ReentrantUSDT is ERC20 {
    CoralIdo public target;
    uint8 public mode;

    constructor() ERC20("Reentrant", "RUSDT") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }

    function setTarget(
        CoralIdo t
    ) external {
        target = t;
    }

    function setMode(
        uint8 m
    ) external {
        mode = m;
    }

    function transfer(
        address to,
        uint256 amount
    ) public override returns (bool) {
        if (mode == 1) {
            mode = 0;
            target.claim();
        }
        return super.transfer(to, amount);
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public override returns (bool) {
        if (mode == 2) {
            mode = 0;
            target.contribute(1e18);
        }
        return super.transferFrom(from, to, amount);
    }
}

contract CoralIdoSecurityTest is CoralIdoBase {
    function test_pauseBlocksContributeAndClaim() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _contribute(alice, 100 * UNIT);
        _contribute(bob, 1000 * UNIT);

        vm.prank(owner);
        ido.pause();

        vm.prank(bob);
        vm.expectRevert();
        ido.contribute(100 * UNIT);

        vm.prank(alice);
        vm.expectRevert();
        ido.claim();

        vm.prank(owner);
        ido.unpause();
        vm.prank(alice);
        ido.claim();
        assertEq(ido.pendingOf(alice), 0);
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(alice);
        vm.expectRevert();
        ido.freezeImport();

        vm.prank(alice);
        vm.expectRevert();
        ido.setDirectReferralBps(500);
    }

    function test_rejectsEth() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(ido).call{value: 0.1 ether}("");
        assertFalse(ok);
    }

    function test_closeSaleStopsContribute() public {
        _openSale();
        _register(alice, "ALICE001", "");
        vm.prank(owner);
        ido.closeSale();
        vm.prank(alice);
        vm.expectRevert(CoralIdo.SaleClosedError.selector);
        ido.contribute(100 * UNIT);
    }

    function test_claimNothingReverts() public {
        _openSale();
        _register(alice, "ALICE001", "");
        vm.prank(alice);
        vm.expectRevert(CoralIdo.NothingToClaim.selector);
        ido.claim();
    }

    function test_reentrancyOnClaimBlocked() public {
        ReentrantUSDT token = new ReentrantUSDT();
        CoralIdo vault;
        (vault,) = _deployPair(address(token));
        token.setTarget(vault);
        token.mint(alice, 10_000 * UNIT);
        token.mint(bob, 10_000 * UNIT);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);

        vm.startPrank(owner);
        vault.freezeImport();
        vault.openSale();
        vm.stopPrank();

        vm.prank(alice);
        vault.register(_code("ALICE001"), bytes32(0));
        vm.prank(bob);
        vault.register(_code("BOB00001"), _code("ALICE001"));
        vm.prank(alice);
        vault.contribute(100 * UNIT);
        vm.prank(bob);
        vault.contribute(1000 * UNIT);

        token.setMode(1);
        vm.prank(alice);
        vm.expectRevert();
        vault.claim();
    }

    function test_reentrancyOnContributeBlocked() public {
        ReentrantUSDT token = new ReentrantUSDT();
        CoralIdo vault;
        (vault,) = _deployPair(address(token));
        token.setTarget(vault);
        token.mint(alice, 10_000 * UNIT);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);

        vm.startPrank(owner);
        vault.freezeImport();
        vault.openSale();
        vm.stopPrank();
        vm.prank(alice);
        vault.register(_code("ALICE001"), bytes32(0));

        token.setMode(2);
        vm.prank(alice);
        vm.expectRevert();
        vault.contribute(100 * UNIT);
    }

    function test_deepReferralStillBinds() public {
        _openSale();
        _register(alice, "ALICE001", "");
        _register(bob, "BOB00001", "ALICE001");
        _register(carol, "CAROL001", "BOB00001");
        vm.prank(dave);
        ido.register(_code("DAVE0001"), _code("CAROL001"));
        assertEq(ido.referrerOf(dave), carol);
    }

    function test_ownable2Step() public {
        vm.prank(owner);
        ido.transferOwnership(alice);
        assertEq(ido.owner(), owner);
        vm.prank(alice);
        ido.acceptOwnership();
        assertEq(ido.owner(), alice);
    }
}
