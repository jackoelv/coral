// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "../lib/forge-std/src/Test.sol";
import {CoralIdo} from "../src/CoralIdo.sol";
import {CoralNetworks} from "../src/network/CoralNetworks.sol";
import {CoralToken} from "../src/CoralToken.sol";
import {FreeDaoNFT} from "../src/FreeDaoNFT.sol";
import {MockUSDT} from "../src/MockUSDT.sol";

contract CoralIdoHandler is Test {
    CoralIdo public ido;
    MockUSDT public usdt;
    address public owner;
    address[] public actors;
    uint256 public ghostContributed;
    uint256 public ghostClaimed;

    constructor(
        CoralIdo ido_,
        MockUSDT usdt_,
        address owner_,
        address[] memory actors_
    ) {
        ido = ido_;
        usdt = usdt_;
        owner = owner_;
        actors = actors_;
    }

    function register(
        uint256 i,
        uint256 refI
    ) external {
        i = bound(i, 0, actors.length - 1);
        refI = bound(refI, 0, actors.length - 1);
        address who = actors[i];
        if (ido.getAccount(who).registered) return;
        bytes32 selfCode = _actorCode(i);
        bytes32 refCode = bytes32(0);
        if (i != refI && ido.getAccount(actors[refI]).registered) {
            refCode = _actorCode(refI);
        }
        vm.prank(who);
        ido.register(selfCode, refCode);
    }

    function contribute(
        uint256 i,
        uint256 amount
    ) external {
        i = bound(i, 0, actors.length - 1);
        amount = bound(amount, 1e18, 5000e18);
        address who = actors[i];
        if (!ido.getAccount(who).registered) {
            vm.prank(who);
            ido.register(_actorCode(i), bytes32(0));
        }
        uint256 bal = usdt.balanceOf(who);
        if (bal < amount) {
            usdt.mint(who, amount - bal);
        }
        vm.prank(who);
        ido.contribute(amount);
        ghostContributed += amount;
    }

    function claim(
        uint256 i
    ) external {
        i = bound(i, 0, actors.length - 1);
        address who = actors[i];
        uint256 pending = ido.pendingOf(who);
        if (pending == 0) return;
        vm.prank(who);
        ido.claim();
        ghostClaimed += pending;
    }

    function withdrawTreasury(
        uint256 amount
    ) external {
        uint256 maxW = ido.treasuryWithdrawable();
        if (maxW == 0) return;
        amount = bound(amount, 1, maxW);
        vm.prank(owner);
        ido.withdrawTreasury(owner, amount);
    }

    function _actorCode(
        uint256 i
    ) internal pure returns (bytes32) {
        if (i == 0) return bytes32("USER0");
        if (i == 1) return bytes32("USER1");
        if (i == 2) return bytes32("USER2");
        if (i == 3) return bytes32("USER3");
        if (i == 4) return bytes32("USER4");
        if (i == 5) return bytes32("USER5");
        if (i == 6) return bytes32("USER6");
        return bytes32("USER7");
    }
}

contract CoralIdoInvariantTest is Test {
    CoralIdo internal ido;
    CoralToken internal nemo;
    MockUSDT internal usdt;
    CoralIdoHandler internal handler;
    address internal owner = address(this);
    address[] internal actors;

    function setUp() public {
        usdt = new MockUSDT();
        nemo = new CoralToken(owner);
        FreeDaoNFT pass = new FreeDaoNFT(owner, "FreeDaoRWA", "FREEDAONFT");
        ido = new CoralIdo(address(usdt), address(nemo), address(pass), owner, CoralNetworks.local());
        nemo.setMinter(address(ido));
        pass.setMinter(address(ido));
        ido.freezeImport();
        ido.openSale();

        for (uint256 i = 0; i < 8; i++) {
            address a = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            actors.push(a);
            usdt.mint(a, 1_000_000e18);
            vm.prank(a);
            usdt.approve(address(ido), type(uint256).max);
        }

        handler = new CoralIdoHandler(ido, usdt, owner, actors);
        usdt.mint(address(handler), 0);
        targetContract(address(handler));
    }

    function invariant_reservedNotAboveBalance() public view {
        assertLe(ido.reservedRewards(), usdt.balanceOf(address(ido)));
    }

    function invariant_claimedNotAboveAccrued() public view {
        assertLe(ido.totalClaimed(), ido.totalDirectAccrued());
    }

    function invariant_pendingMatchesReserve() public view {
        uint256 sumPending;
        for (uint256 i = 0; i < actors.length; i++) {
            sumPending += ido.pendingOf(actors[i]);
        }
        assertEq(sumPending, ido.reservedRewards());
    }

    function invariant_treasuryPlusReservedEqBalance() public view {
        assertEq(ido.treasuryWithdrawable() + ido.reservedRewards(), usdt.balanceOf(address(ido)));
    }

    function invariant_nemoCapped() public view {
        uint256 held;
        for (uint256 i = 0; i < actors.length; i++) {
            held += nemo.balanceOf(actors[i]);
        }
        held += nemo.balanceOf(address(ido));
        assertLe(held, nemo.CAP());
        assertLe(nemo.totalSupply(), nemo.CAP());
    }
}
