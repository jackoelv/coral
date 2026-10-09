// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "../lib/forge-std/src/Test.sol";
import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {MessageHashUtils} from "../lib/openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";
import {CoralMultisig} from "../src/CoralMultisig.sol";
import {CoralNetworks} from "../src/network/CoralNetworks.sol";

contract OwnableProbe is Ownable2Step {
    uint256 public value;

    constructor(address owner_) Ownable(owner_) {}

    function setValue(uint256 next) external onlyOwner {
        value = next;
    }
}

contract CoralMultisigTest is Test {
    uint256 internal pk0 = 0xA11CE;
    uint256 internal pk1 = 0xB0B;
    uint256 internal pk2 = 0xCAFE;
    uint256 internal pk3 = 0xD00D;
    uint256 internal outsider = 0xF00D;

    CoralMultisig internal wallet;
    OwnableProbe internal probe;

    function setUp() public {
        address[4] memory signers = [vm.addr(pk0), vm.addr(pk1), vm.addr(pk2), vm.addr(pk3)];
        wallet = new CoralMultisig(signers);
        probe = new OwnableProbe(address(this));
    }

    function test_bscTestnetRewardsDelayIsTenMinutes() public pure {
        assertEq(CoralNetworks.bscTestnet().rewardsDelay, 10 minutes);
        assertEq(CoralNetworks.bscMainnet().rewardsDelay, 24 hours);
        assertEq(CoralNetworks.local().rewardsDelay, 60);
    }

    function test_threeSignaturesRunAnOwnerCall() public {
        probe.transferOwnership(address(wallet));
        bytes memory acceptData = abi.encodeWithSignature("acceptOwnership()");
        wallet.exec(address(probe), acceptData, _three(wallet.execHash(address(probe), acceptData)));
        assertEq(probe.owner(), address(wallet));

        bytes memory setData = abi.encodeWithSignature("setValue(uint256)", 7);
        wallet.exec(address(probe), setData, _three(wallet.execHash(address(probe), setData)));
        assertEq(probe.value(), 7);
    }

    function test_twoSignaturesRevert() public {
        bytes memory data = abi.encodeWithSignature("acceptOwnership()");
        bytes[] memory sigs = new bytes[](2);
        bytes32 hash = wallet.execHash(address(probe), data);
        sigs[0] = _sign(pk0, hash);
        sigs[1] = _sign(pk1, hash);
        vm.expectRevert(CoralMultisig.NotEnoughSignatures.selector);
        wallet.exec(address(probe), data, sigs);
    }

    function test_outsiderSignatureReverts() public {
        bytes memory data = abi.encodeWithSignature("acceptOwnership()");
        bytes32 hash = wallet.execHash(address(probe), data);
        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _sign(pk0, hash);
        sigs[1] = _sign(pk1, hash);
        sigs[2] = _sign(outsider, hash);
        vm.expectRevert(CoralMultisig.BadSignature.selector);
        wallet.exec(address(probe), data, sigs);
    }

    function test_replaceSignerThenRestore() public {
        address old3 = vm.addr(pk3);
        address temp = vm.addr(outsider);
        wallet.replaceSigner(old3, temp, _three(wallet.replaceHash(old3, temp)));
        assertEq(wallet.signers(3), temp);

        bytes memory data = abi.encodeWithSignature("acceptOwnership()");
        bytes32 hash = wallet.execHash(address(probe), data);
        bytes[] memory stale = new bytes[](3);
        stale[0] = _sign(pk0, hash);
        stale[1] = _sign(pk1, hash);
        stale[2] = _sign(pk3, hash);
        vm.expectRevert(CoralMultisig.BadSignature.selector);
        wallet.exec(address(probe), data, stale);

        wallet.replaceSigner(temp, old3, _three(wallet.replaceHash(temp, old3)));
        assertEq(wallet.signers(3), old3);
    }

    function _three(bytes32 hash) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](3);
        sigs[0] = _sign(pk0, hash);
        sigs[1] = _sign(pk1, hash);
        sigs[2] = _sign(pk2, hash);
    }

    function _sign(uint256 pk, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(hash));
        return abi.encodePacked(r, s, v);
    }
}
