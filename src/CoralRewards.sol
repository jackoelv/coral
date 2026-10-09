// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "../lib/openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

import {ICoralVaultPay} from "./ICoralRewards.sol";
import {CoralNetworks} from "./network/CoralNetworks.sol";

/// @title CoralRewards
/// @notice Cumulative Merkle root authorizes team-reward withdrawals and activates immediately.
///         A public leaf file lets anyone recompute the root off-chain. A mismatch is fixed by
///         the next root, not by an on-chain challenge. USDT stays in the vault.
contract CoralRewards is Ownable2Step, ReentrancyGuard {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant REWARD_CAP_BPS = 2500;

    ICoralVaultPay public immutable vault;

    /// @notice Key allowed to publish roots. Owner may also publish, then hand ownership to a multisig.
    address public publisher;
    /// @notice Max increase of `committed` in one publish. Zero means no extra limit.
    uint256 public maxRootIncrease;
    /// @notice Room reserved for the one-time historical team settlement.
    ///         It is not 25% of imported volume. Set it to the settled leaf sum.
    uint256 public historicalTeamBudget;

    bytes32 public merkleRoot;
    bytes32 public contentHash;
    string public contentUri;
    /// @notice Sum of leaf cumulatives in the active root.
    uint256 public committed;

    mapping(address => uint256) public claimed;
    uint256 public totalTeamPaid;

    event PublisherUpdated(address indexed publisher);
    event MaxRootIncreaseUpdated(uint256 amount);
    event HistoricalTeamBudgetUpdated(uint256 amount);
    event RootPublished(bytes32 indexed root, bytes32 contentHash, uint256 cumulative, string uri);
    event TeamClaimed(address indexed account, uint256 cumulative, uint256 paid);

    error ZeroAddress();
    error WrongNetwork();
    error NotPublisher();
    error CumulativeTooLow();
    error NothingToClaim();
    error InvalidProof();
    error CapExceeded();
    error IncreaseTooLarge();
    error ExceedsCommitted();

    constructor(
        address vault_,
        address initialOwner,
        CoralNetworks.Params memory params
    ) Ownable(initialOwner) {
        if (block.chainid != params.chainId) revert WrongNetwork();
        if (vault_ == address(0) || initialOwner == address(0)) revert ZeroAddress();
        vault = ICoralVaultPay(vault_);
        publisher = initialOwner;
    }

    function outstanding() public view returns (uint256) {
        if (committed <= totalTeamPaid) return 0;
        return committed - totalTeamPaid;
    }

    function rewardCap() public view returns (uint256) {
        return ((vault.totalContributed() + vault.totalImported()) * REWARD_CAP_BPS) / BPS_DENOMINATOR
            + historicalTeamBudget;
    }

    /// @notice Allow the historical team root to be published before new deposits exist.
    ///         Fund the vault with this much USDT before holders claim. Do not lower it
    ///         below an already published cumulative.
    function setHistoricalTeamBudget(
        uint256 amount
    ) external onlyOwner {
        if (amount < committed) revert CumulativeTooLow();
        historicalTeamBudget = amount;
        emit HistoricalTeamBudgetUpdated(amount);
    }

    function setPublisher(
        address publisher_
    ) external onlyOwner {
        if (publisher_ == address(0)) revert ZeroAddress();
        publisher = publisher_;
        emit PublisherUpdated(publisher_);
    }

    function setMaxRootIncrease(
        uint256 amount
    ) external onlyOwner {
        maxRootIncrease = amount;
        emit MaxRootIncreaseUpdated(amount);
    }

    function publishRoot(
        bytes32 root,
        bytes32 contentHash_,
        uint256 cumulative,
        string calldata uri
    ) external {
        if (msg.sender != publisher && msg.sender != owner()) revert NotPublisher();
        if (root == bytes32(0)) revert InvalidProof();
        if (cumulative < totalTeamPaid) revert CumulativeTooLow();
        if (maxRootIncrease != 0 && cumulative > committed + maxRootIncrease) revert IncreaseTooLarge();
        if (vault.totalDirectAccrued() + cumulative > rewardCap()) revert CapExceeded();
        merkleRoot = root;
        contentHash = contentHash_;
        contentUri = uri;
        committed = cumulative;
        emit RootPublished(root, contentHash_, cumulative, uri);
    }

    function claim(
        uint256 cumulative,
        bytes32[] calldata proof
    ) external nonReentrant {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, cumulative))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) revert InvalidProof();
        uint256 already = claimed[msg.sender];
        if (cumulative < already) revert CumulativeTooLow();
        uint256 pay = cumulative - already;
        if (pay == 0) revert NothingToClaim();
        // Leaves must stay inside the declared total. Without this, a malicious root can
        // declare a tiny `cumulative` (passing maxRootIncrease) while its leaves drain the cap.
        if (totalTeamPaid + pay > committed) revert ExceedsCommitted();
        if (vault.totalDirectAccrued() + totalTeamPaid + pay > rewardCap()) revert CapExceeded();
        claimed[msg.sender] = cumulative;
        totalTeamPaid += pay;
        vault.disburse(msg.sender, pay);
        emit TeamClaimed(msg.sender, cumulative, pay);
    }
}
