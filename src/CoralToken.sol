// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {ERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {ERC20Pausable} from "../lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title CoralToken
/// @notice Pre-issue IDO voucher (name/symbol: Ckey / CKEY).
///         On-demand mint up to CAP. Transfers are locked unless the owner opens
///         `setTransfersEnabled`, or one side of the transfer is on the allowlist.
///         Recipients who are not allowlisted cannot transfer onward while the switch is off.
contract CoralToken is ERC20, ERC20Pausable, Ownable2Step {
    using SafeERC20 for IERC20;

    uint256 public constant CAP = 1_000_000_000e18;

    address public minter;
    /// @notice Latest interest contract. Earlier ones stay in `interestMinters` so users can still claim.
    address public interestMinter;
    mapping(address => bool) public interestMinters;
    mapping(address => bool) public transferAllowlist;
    /// @notice When true, any holder can transfer. When false, only the allowlist rule applies.
    bool public transfersEnabled;

    event MinterUpdated(address indexed minter);
    event InterestMinterUpdated(address indexed interestMinter);
    event TransferAllowlistUpdated(address indexed account, bool allowed);
    event TransfersEnabledUpdated(bool enabled);

    error ZeroAddress();
    error RescueSelf();
    error NotAuthorized();
    error CapExceeded();
    error TransfersLocked();

    constructor(
        address initialOwner
    ) ERC20("Ckey", "CKEY") Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    function setMinter(
        address minter_
    ) external onlyOwner {
        if (minter_ == address(0)) revert ZeroAddress();
        minter = minter_;
        emit MinterUpdated(minter_);
    }

    /// @notice Authorize an interest contract to mint yield. Does not revoke an earlier one.
    function setInterestMinter(
        address interestMinter_
    ) external onlyOwner {
        if (interestMinter_ == address(0)) revert ZeroAddress();
        interestMinter = interestMinter_;
        interestMinters[interestMinter_] = true;
        emit InterestMinterUpdated(interestMinter_);
    }

    function setTransferAllowlist(
        address account,
        bool allowed
    ) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        transferAllowlist[account] = allowed;
        emit TransferAllowlistUpdated(account, allowed);
    }

    /// @notice Open transfers for every holder, or return to the allowlist-only rule.
    function setTransfersEnabled(
        bool enabled
    ) external onlyOwner {
        transfersEnabled = enabled;
        emit TransfersEnabledUpdated(enabled);
    }

    /// @notice Vault (deposits), interest minter (NFT yield), or Owner (manual grants) may mint.
    function mint(
        address to,
        uint256 amount
    ) external {
        if (msg.sender != minter && !interestMinters[msg.sender] && msg.sender != owner()) revert NotAuthorized();
        if (to == address(0)) revert ZeroAddress();
        if (totalSupply() + amount > CAP) revert CapExceeded();
        _mint(to, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover tokens sent here by mistake. Cannot pull this token from holders.
    function rescue(
        IERC20 token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (address(token) == address(this)) revert RescueSelf();
        token.safeTransfer(to, amount);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20, ERC20Pausable) {
        if (from != address(0) && to != address(0) && !transfersEnabled) {
            if (!transferAllowlist[from] && !transferAllowlist[to]) revert TransfersLocked();
        }
        super._update(from, to, value);
    }
}
