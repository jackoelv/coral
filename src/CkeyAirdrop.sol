// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "../lib/openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @title CkeyAirdrop
/// @notice Claim-style CKEY airdrop. A proposer commits the hash of a recipient list. A different
///         reviewer submits the full list, which must match the hash, and the grant becomes claimable.
///         Recipients pull their own tokens.
///         Only CKEY added through `fund` can be granted. CKEY sent here directly is not grantable,
///         so allowlisting this contract on CKEY does not let locked holders route tokens to others.
///         This contract is not a CKEY minter and must not replace the IDO minter.
contract CkeyAirdrop is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_BATCH = 100;

    enum Status {
        None,
        Pending,
        Granted,
        Rejected
    }

    struct Proposal {
        address proposer;
        Status status;
        uint32 count;
        bytes32 listHash;
        uint256 total;
    }

    IERC20 public immutable ckey;

    mapping(address account => bool enabled) public isProposer;
    mapping(address account => bool enabled) public isReviewer;
    mapping(bytes32 batchId => Proposal proposal) public proposals;
    mapping(address account => uint256 amount) public allocated;
    mapping(address account => uint256 amount) public claimed;

    /// @notice CKEY added through `fund` and not yet claimed or withdrawn.
    uint256 public reserve;
    uint256 public totalAllocated;
    uint256 public totalClaimed;

    event ProposerUpdated(address indexed account, bool enabled);
    event ReviewerUpdated(address indexed account, bool enabled);
    event Funded(address indexed from, uint256 amount);
    event Proposed(bytes32 indexed batchId, address indexed proposer, bytes32 listHash, uint256 count, uint256 total);
    event Rejected(bytes32 indexed batchId, address indexed by);
    event Granted(bytes32 indexed batchId, address indexed recipient, uint256 amount);
    event BatchGranted(bytes32 indexed batchId, address indexed reviewer, uint256 count, uint256 total);
    event Claimed(address indexed account, uint256 amount);
    event Revoked(address indexed account, address indexed by, uint256 amount);
    event UnallocatedWithdrawn(address indexed to, uint256 amount);
    event StrayReturned(address indexed to, uint256 amount);

    error ZeroAddress();
    error RoleConflict();
    error NotProposer();
    error NotReviewer();
    error NotAuthorized();
    error BatchUsed();
    error NotPending();
    error SelfReview();
    error ListMismatch();
    error LengthMismatch();
    error EmptyBatch();
    error BatchTooLarge();
    error DuplicateRecipient();
    error ZeroAmount();
    error InsufficientReserve();
    error NothingToClaim();
    error ExceedsUnclaimed();
    error ExceedsUnallocated();
    error RenounceDisabled();

    constructor(
        address ckey_,
        address initialOwner,
        address proposer_,
        address reviewer_
    ) Ownable(initialOwner) {
        if (ckey_ == address(0) || proposer_ == address(0) || reviewer_ == address(0)) revert ZeroAddress();
        if (proposer_ == reviewer_ || proposer_ == initialOwner || reviewer_ == initialOwner) revert RoleConflict();
        ckey = IERC20(ckey_);
        isProposer[proposer_] = true;
        isReviewer[reviewer_] = true;
        emit ProposerUpdated(proposer_, true);
        emit ReviewerUpdated(reviewer_, true);
    }

    // ---------------------------------------------------------------- views

    function claimable(
        address account
    ) public view returns (uint256) {
        return allocated[account] - claimed[account];
    }

    /// @notice CKEY granted and not yet claimed.
    function outstanding() public view returns (uint256) {
        return totalAllocated - totalClaimed;
    }

    /// @notice Funded CKEY not reserved by current grants.
    function unallocated() public view returns (uint256) {
        return reserve - outstanding();
    }

    /// @notice CKEY held here that did not come through `fund`.
    function stray() public view returns (uint256) {
        uint256 balance = ckey.balanceOf(address(this));
        return balance > reserve ? balance - reserve : 0;
    }

    /// @notice Same as Solidity `keccak256(abi.encode(recipients, amounts))`.
    function hashList(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(recipients, amounts));
    }

    // ---------------------------------------------------------------- owner

    function setProposer(
        address account,
        bool enabled
    ) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (enabled && (isReviewer[account] || _isOwnerSide(account))) revert RoleConflict();
        isProposer[account] = enabled;
        emit ProposerUpdated(account, enabled);
    }

    function setReviewer(
        address account,
        bool enabled
    ) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (enabled && (isProposer[account] || _isOwnerSide(account))) revert RoleConflict();
        isReviewer[account] = enabled;
        emit ReviewerUpdated(account, enabled);
    }

    /// @notice Pull CKEY from the owner. Only funded CKEY can be granted.
    function fund(
        uint256 amount
    ) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 before = ckey.balanceOf(address(this));
        ckey.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = ckey.balanceOf(address(this)) - before;
        reserve += received;
        emit Funded(msg.sender, received);
    }

    function withdrawUnallocated(
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > unallocated()) revert ExceedsUnallocated();
        reserve -= amount;
        ckey.safeTransfer(to, amount);
        emit UnallocatedWithdrawn(to, amount);
    }

    /// @notice Send back CKEY that arrived without `fund`. It never becomes grantable.
    function returnStray(
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > stray()) revert ExceedsUnallocated();
        ckey.safeTransfer(to, amount);
        emit StrayReturned(to, amount);
    }

    /// @notice Owner, proposers, and reviewers can stop proposals, grants, and claims at once.
    function pause() external {
        if (msg.sender != owner() && !isProposer[msg.sender] && !isReviewer[msg.sender]) revert NotAuthorized();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function transferOwnership(
        address newOwner
    ) public override onlyOwner {
        if (isProposer[newOwner] || isReviewer[newOwner]) revert RoleConflict();
        super.transferOwnership(newOwner);
    }

    function _transferOwnership(
        address newOwner
    ) internal override {
        if (isProposer[newOwner] || isReviewer[newOwner]) revert RoleConflict();
        super._transferOwnership(newOwner);
    }

    // ---------------------------------------------------------------- batches

    /// @notice Commit a list by hash. The reviewer must later submit exactly this list.
    function propose(
        bytes32 batchId,
        bytes32 listHash,
        uint256 count,
        uint256 total
    ) external whenNotPaused {
        if (!isProposer[msg.sender]) revert NotProposer();
        if (proposals[batchId].status != Status.None) revert BatchUsed();
        if (count == 0) revert EmptyBatch();
        if (count > MAX_BATCH) revert BatchTooLarge();
        if (total == 0) revert ZeroAmount();
        proposals[batchId] = Proposal({
            proposer: msg.sender, status: Status.Pending, count: uint32(count), listHash: listHash, total: total
        });
        emit Proposed(batchId, msg.sender, listHash, count, total);
    }

    /// @notice Reviewer or owner rejects. The proposer may withdraw its own pending proposal.
    function reject(
        bytes32 batchId
    ) external {
        Proposal storage p = proposals[batchId];
        if (p.status != Status.Pending) revert NotPending();
        if (msg.sender != owner() && !isReviewer[msg.sender] && msg.sender != p.proposer) revert NotAuthorized();
        p.status = Status.Rejected;
        emit Rejected(batchId, msg.sender);
    }

    /// @notice Grant a pending list. A reviewer other than the proposer submits the list matching the hash.
    function grant(
        bytes32 batchId,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external whenNotPaused {
        if (!isReviewer[msg.sender]) revert NotReviewer();
        Proposal storage p = proposals[batchId];
        if (p.status != Status.Pending) revert NotPending();
        if (p.proposer == msg.sender) revert SelfReview();
        uint256 length = recipients.length;
        if (length != amounts.length) revert LengthMismatch();
        if (length != p.count || hashList(recipients, amounts) != p.listHash) revert ListMismatch();

        uint256 total;
        for (uint256 i; i < length; ++i) {
            address recipient = recipients[i];
            if (recipient == address(0)) revert ZeroAddress();
            if (amounts[i] == 0) revert ZeroAmount();
            for (uint256 j; j < i; ++j) {
                if (recipients[j] == recipient) revert DuplicateRecipient();
            }
            total += amounts[i];
        }
        if (total != p.total) revert ListMismatch();
        if (total > unallocated()) revert InsufficientReserve();

        p.status = Status.Granted;
        totalAllocated += total;
        for (uint256 i; i < length; ++i) {
            allocated[recipients[i]] += amounts[i];
            emit Granted(batchId, recipients[i], amounts[i]);
        }
        emit BatchGranted(batchId, msg.sender, length, total);
    }

    /// @notice Pay `msg.sender` the full unclaimed balance.
    function claim() external whenNotPaused nonReentrant {
        uint256 amount = claimable(msg.sender);
        if (amount == 0) revert NothingToClaim();
        claimed[msg.sender] += amount;
        totalClaimed += amount;
        reserve -= amount;
        ckey.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice Reviewer or owner reduces unclaimed balances. Works while paused.
    function revokeUnclaimed(
        address[] calldata accounts,
        uint256[] calldata amounts
    ) external {
        if (msg.sender != owner() && !isReviewer[msg.sender]) revert NotAuthorized();
        uint256 length = accounts.length;
        if (length == 0) revert EmptyBatch();
        if (length != amounts.length) revert LengthMismatch();
        if (length > MAX_BATCH) revert BatchTooLarge();

        uint256 total;
        for (uint256 i; i < length; ++i) {
            address account = accounts[i];
            uint256 amount = amounts[i];
            if (account == address(0)) revert ZeroAddress();
            if (amount == 0) revert ZeroAmount();
            for (uint256 j; j < i; ++j) {
                if (accounts[j] == account) revert DuplicateRecipient();
            }
            if (amount > claimable(account)) revert ExceedsUnclaimed();
            allocated[account] -= amount;
            total += amount;
            emit Revoked(account, msg.sender, amount);
        }
        totalAllocated -= total;
    }

    function _isOwnerSide(
        address account
    ) private view returns (bool) {
        return account == owner() || account == pendingOwner();
    }
}
