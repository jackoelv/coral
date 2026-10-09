// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "../lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "../lib/openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title CoralMultisig
/// @notice Testnet 3-of-4 wallet. Any three signers can immediately call another contract
///         or replace one signer. Not for mainnet.
contract CoralMultisig {
    uint256 public constant THRESHOLD = 3;
    bytes32 public constant EXEC_ACTION = keccak256("exec");
    bytes32 public constant REPLACE_ACTION = keccak256("replace");

    address[4] public signers;
    uint256 public nonce;

    event Executed(address indexed target, uint256 indexed nonce, bytes data);
    event SignerReplaced(address indexed oldSigner, address indexed next, uint256 indexed nonce);

    error BadSigners();
    error NotEnoughSignatures();
    error BadSignature();

    constructor(
        address[4] memory signers_
    ) {
        for (uint256 i = 0; i < 4; i++) {
            if (signers_[i] == address(0)) revert BadSigners();
            for (uint256 j = 0; j < i; j++) {
                if (signers_[j] == signers_[i]) revert BadSigners();
            }
            signers[i] = signers_[i];
        }
    }

    function execHash(
        address target,
        bytes calldata data
    ) external view returns (bytes32) {
        return _raw(EXEC_ACTION, target, address(0), keccak256(data));
    }

    function replaceHash(
        address oldSigner,
        address next
    ) external view returns (bytes32) {
        return _raw(REPLACE_ACTION, oldSigner, next, bytes32(0));
    }

    /// @notice Anyone can submit. The three signatures decide whether it runs.
    function exec(
        address target,
        bytes calldata data,
        bytes[] calldata signatures
    ) external {
        _verify(_raw(EXEC_ACTION, target, address(0), keccak256(data)), signatures);
        uint256 used = nonce;
        nonce = used + 1;
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        emit Executed(target, used, data);
    }

    function replaceSigner(
        address oldSigner,
        address next,
        bytes[] calldata signatures
    ) external {
        _verify(_raw(REPLACE_ACTION, oldSigner, next, bytes32(0)), signatures);
        if (next == address(0)) revert BadSigners();
        uint256 found = type(uint256).max;
        for (uint256 i = 0; i < 4; i++) {
            if (signers[i] == next) revert BadSigners();
            if (signers[i] == oldSigner) found = i;
        }
        if (found == type(uint256).max) revert BadSigners();
        uint256 used = nonce;
        nonce = used + 1;
        signers[found] = next;
        emit SignerReplaced(oldSigner, next, used);
    }

    function _raw(
        bytes32 action,
        address a,
        address b,
        bytes32 dataHash
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), nonce, action, a, b, dataHash));
    }

    function _verify(
        bytes32 hash,
        bytes[] calldata signatures
    ) internal view {
        if (signatures.length != THRESHOLD) revert NotEnoughSignatures();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(hash);
        address[3] memory seen;
        for (uint256 i = 0; i < THRESHOLD; i++) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (!_isSigner(signer)) revert BadSignature();
            for (uint256 j = 0; j < i; j++) {
                if (seen[j] == signer) revert BadSignature();
            }
            seen[i] = signer;
        }
    }

    function _isSigner(
        address account
    ) internal view returns (bool) {
        for (uint256 i = 0; i < 4; i++) {
            if (signers[i] == account) return true;
        }
        return false;
    }
}
