// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "../../lib/forge-std/src/Test.sol";
import {CoralIdo} from "../../src/CoralIdo.sol";
import {CoralToken} from "../../src/CoralToken.sol";
import {FreeDaoNFT} from "../../src/FreeDaoNFT.sol";
import {CoralNetworks} from "../../src/network/CoralNetworks.sol";
import {MockUSDT} from "../../src/MockUSDT.sol";

contract CoralIdoBase is Test {
    uint256 internal constant UNIT = 1e18;

    MockUSDT internal usdt;
    CoralToken internal nemo;
    FreeDaoNFT internal nft;
    CoralIdo internal ido;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal eve = makeAddr("eve");

    function setUp() public virtual {
        usdt = new MockUSDT();
        (ido, nemo) = _deployPair(address(usdt));
        _mintApprove(alice, 1_000_000 * UNIT);
        _mintApprove(bob, 1_000_000 * UNIT);
        _mintApprove(carol, 1_000_000 * UNIT);
        _mintApprove(dave, 1_000_000 * UNIT);
        _mintApprove(eve, 1_000_000 * UNIT);
    }

    function _deployPair(
        address usdtToken
    ) internal returns (CoralIdo vault, CoralToken token) {
        token = new CoralToken(owner);
        nft = new FreeDaoNFT(owner, "FreeDaoRWA", "FREEDAONFT");
        vault = new CoralIdo(usdtToken, address(token), address(nft), owner, CoralNetworks.local());
        vm.startPrank(owner);
        token.setMinter(address(vault));
        nft.setMinter(address(vault));
        vm.stopPrank();
    }

    function _mintApprove(
        address who,
        uint256 amount
    ) internal {
        usdt.mint(who, amount);
        vm.prank(who);
        usdt.approve(address(ido), type(uint256).max);
    }

    function _code(
        string memory s
    ) internal pure returns (bytes32 out) {
        bytes memory b = bytes(s);
        uint256 len = b.length;
        require(len > 0 && len <= 32, "code");
        for (uint256 i = 0; i < len; ++i) {
            out |= bytes32(uint256(uint8(b[i]))) << (8 * (31 - i));
        }
    }

    function _openSale() internal {
        vm.startPrank(owner);
        ido.freezeImport();
        ido.openSale();
        vm.stopPrank();
    }

    function _register(
        address who,
        string memory code,
        string memory referrerCode
    ) internal {
        bytes32 invite = _code(code);
        bytes32 referrer = bytes(referrerCode).length == 0 ? bytes32(0) : _code(referrerCode);
        vm.prank(who);
        ido.register(invite, referrer);
    }

    function _contribute(
        address who,
        uint256 amount
    ) internal {
        vm.prank(who);
        ido.contribute(amount);
    }

    function _self(
        address who
    ) internal view returns (uint256) {
        return ido.getAccount(who).selfVolume;
    }

    function _direct(
        address who
    ) internal view returns (uint256) {
        return ido.getAccount(who).directRewards;
    }

}
