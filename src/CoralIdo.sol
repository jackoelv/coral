// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {Pausable} from "../lib/openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

import {ICoralRewardsView, ICoralVaultPay} from "./ICoralRewards.sol";
import {ICoralNftInterest} from "./ICoralNftInterest.sol";
import {CoralNetworks} from "./network/CoralNetworks.sol";
import {CoralToken} from "./CoralToken.sol";
import {CoralNFT} from "./CoralNFT.sol";

/// @title CoralIdo
/// @notice Vault for invite links, USDT deposits, direct referral, ckey and NFT.
///         Multi-level rewards are not computed here. `CoralRewards` authorizes those payouts.
contract CoralIdo is Ownable2Step, Pausable, ReentrancyGuard, ICoralVaultPay {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant REWARD_CAP_BPS = 2500;
    uint256 public constant NFT_UNIT = 500e18;
    /// @notice Own volume required before an account can earn direct or be treated as qualified upstream.
    uint256 public constant MIN_REWARD_SELF = 100e18;
    /// @notice Own volume required before any NFT is owed. Count is still `volume / NFT_UNIT`.
    uint256 public constant NFT_MIN_SELF = 1000e18;
    uint256 public constant MAX_NFT_INTERESTS = 8;

    enum Role {
        None,
        Explorer,
        Ambassador,
        Partner
    }

    struct Account {
        address referrer;
        bytes32 inviteCode;
        uint256 selfVolume;
        uint256 directRewards;
        uint256 claimed;
        bool registered;
    }

    IERC20 public immutable usdt;
    IERC20 public immutable nemo;
    CoralNFT public immutable nft;
    bool public immutable weekByBlock;
    /// @notice Length of one vault week. Local counts blocks; testnet counts seconds.
    ///         Mainnet NFT interest uses the calendar week in `CoralNftInterest` and does not read this.
    uint256 public immutable weekDuration;

    bool public importFrozen;
    bool public saleOpen;
    uint256 public saleOpenedAt;
    uint256 public saleOpenedBlock;

    uint256 public tokensPerUsdt;

    uint256 public minIdo;
    uint256 public ambassadorMin;
    uint256 public partnerMin;
    uint256 public directReferralBps;

    mapping(address => Account) public accounts;
    mapping(bytes32 => address) public codeToAccount;
    mapping(address => bool) public hasChildren;
    mapping(address => uint256) public nftMinted;

    address public rewards;
    address public proposedRewards;
    uint256 public proposedRewardsEta;
    uint256 public immutable rewardsDelay;
    address public nftInterest;
    address[] public nftInterests;
    bool public idoEnded;
    uint256 public idoEndedWeek;
    uint256 public immutable nftCap;
    uint256 public nftsAllocated;
    mapping(address => uint256) public importedNfts;
    mapping(address => uint256) public grantedNfts;

    uint256 public totalDirectAccrued;
    uint256 public totalClaimed;
    uint256 public totalContributed;
    /// @notice Sum of imported self volume. It is not USDT held by the vault.
    ///         The reward cap counts it so historical deposits keep their 25% room.
    uint256 public totalImported;
    uint256 public totalNemoAllocated;

    event Registered(address indexed account, bytes32 indexed code, address indexed referrer);
    event ReferrerBound(address indexed account, address indexed referrer);
    event Contributed(address indexed account, uint256 amount, uint256 selfVolume, uint256 nemoAmount);
    event NemoAllocated(address indexed account, uint256 nemoAmount);
    event NftMinted(address indexed account, uint256 count, uint256 totalMinted);
    event NftDeferred(address indexed account, uint256 totalDeferred);
    event DirectRewardAccrued(address indexed referrer, address indexed from, uint256 amount);
    event Claimed(address indexed account, uint256 amount);
    event ImportFrozen();
    event SaleOpened();
    event SaleClosed();
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event UserImported(address indexed account, bytes32 indexed code);
    event ReferrerImported(address indexed account, address indexed referrer);
    event VolumeImported(address indexed account, uint256 selfVolume);
    event DirectReferralBpsUpdated(uint256 bps);
    event MinIdoUpdated(uint256 amount);
    event IdentityThresholdsUpdated(uint256 ambassadorMin, uint256 partnerMin);
    event RewardsUpdated(address indexed rewards);
    event RewardsProposed(address indexed next, uint256 eta);
    event RewardsProposalCancelled(address indexed next);
    event IdoEnded(uint256 endedWeek);
    event NftInterestUpdated(address indexed interest);
    event NftGranted(address indexed account, uint256 count);
    event TeamDisbursed(address indexed to, uint256 amount);
    event TokensPerUsdtUpdated(uint256 rate);
    event UnsoldNemoWithdrawn(address indexed to, uint256 amount);

    error NotRegistered();
    error AlreadyRegistered();
    error CodeTaken();
    error InvalidCode();
    error SaleClosedError();
    error ImportFrozenError();
    error ImportNotFrozenError();
    error AlreadyBound();
    error InvalidReferrer();
    error SelfReferral();
    error HasChildren();
    error AmountTooSmall();
    error NothingToClaim();
    error InsufficientTreasury();
    error LengthMismatch();
    error ZeroAddress();
    error InvalidThresholds();
    error RewardBpsTooHigh();
    error InsufficientNemo();
    error InvalidSchedule();
    error WrongNetwork();
    error NotRewards();
    error NotNft();
    error InterestAlreadySet();
    error TooManyInterests();
    error RewardsAlreadySet();
    error RewardsDelayPending();
    error NoProposedRewards();
    error IdoAlreadyEnded();
    error NftCapExceeded();
    error GrantExceedsImport();

    constructor(
        address usdt_,
        address nemo_,
        address nft_,
        address initialOwner,
        CoralNetworks.Params memory params
    ) Ownable(initialOwner) {
        if (block.chainid != params.chainId) revert WrongNetwork();
        if (usdt_ == address(0) || nemo_ == address(0) || nft_ == address(0) || initialOwner == address(0)) {
            revert ZeroAddress();
        }
        if (params.weekDuration == 0 || params.tokensPerUsdt == 0 || params.minIdo == 0) revert InvalidSchedule();
        if (params.directReferralBps > REWARD_CAP_BPS) revert RewardBpsTooHigh();
        usdt = IERC20(usdt_);
        nemo = IERC20(nemo_);
        nft = CoralNFT(nft_);
        weekByBlock = params.weekByBlock;
        weekDuration = params.weekDuration;
        tokensPerUsdt = params.tokensPerUsdt;
        minIdo = params.minIdo;
        ambassadorMin = params.ambassadorMin;
        partnerMin = params.partnerMin;
        directReferralBps = params.directReferralBps;
        if (params.rewardsDelay == 0 || params.nftCap == 0) revert InvalidSchedule();
        rewardsDelay = params.rewardsDelay;
        nftCap = params.nftCap;
    }

    function getAccount(
        address account
    ) external view returns (Account memory) {
        return accounts[account];
    }

    function pendingOf(
        address account
    ) public view returns (uint256) {
        Account storage a = accounts[account];
        if (a.directRewards <= a.claimed) return 0;
        return a.directRewards - a.claimed;
    }

    function referrerOf(
        address account
    ) public view returns (address) {
        return accounts[account].referrer;
    }

    function directReserve() public view returns (uint256) {
        return totalDirectAccrued - totalClaimed;
    }

    function reservedRewards() public view returns (uint256) {
        return directReserve() + _teamOutstanding();
    }

    function treasuryWithdrawable() public view returns (uint256) {
        uint256 bal = usdt.balanceOf(address(this));
        uint256 reserved = reservedRewards();
        if (bal <= reserved) return 0;
        return bal - reserved;
    }

    function roleOf(
        address account
    ) public view returns (Role) {
        Account storage a = accounts[account];
        if (!a.registered || a.selfVolume == 0) return Role.None;
        if (a.selfVolume >= partnerMin) return Role.Partner;
        if (a.selfVolume >= ambassadorMin) return Role.Ambassador;
        return Role.Explorer;
    }

    function currentWeek() public view returns (uint256) {
        if (weekByBlock) {
            if (saleOpenedBlock == 0 || block.number < saleOpenedBlock) return 0;
            return (block.number - saleOpenedBlock) / weekDuration;
        }
        if (saleOpenedAt == 0 || block.timestamp < saleOpenedAt) return 0;
        return (block.timestamp - saleOpenedAt) / weekDuration;
    }

    function tokensFor(
        uint256 amount
    ) public view returns (uint256) {
        return (amount * tokensPerUsdt) / 1e18;
    }

    /// @notice NFTs earned by volume but not minted because this issuance hit `nftCap`.
    ///         The next phase grants them from this on-chain figure.
    function nftDeferred(
        address account
    ) public view returns (uint256) {
        uint256 owed = _nftsOwed(accounts[account].selfVolume);
        uint256 minted = nftMinted[account];
        return owed > minted ? owed - minted : 0;
    }

    function nftRemainder(
        address account
    ) public view returns (uint256) {
        return accounts[account].selfVolume % NFT_UNIT;
    }

    function register(
        bytes32 code,
        bytes32 referrerCode
    ) external whenNotPaused {
        _register(msg.sender, code, referrerCode);
    }

    function bindReferrer(
        bytes32 referrerCode
    ) external whenNotPaused {
        Account storage a = accounts[msg.sender];
        if (!a.registered) revert NotRegistered();
        if (a.referrer != address(0)) revert AlreadyBound();
        address referrer = _referrerFromCode(referrerCode, msg.sender);
        _bindReferrer(msg.sender, referrer);
        emit ReferrerBound(msg.sender, referrer);
    }

    function contribute(
        uint256 amount
    ) external whenNotPaused nonReentrant {
        _contribute(msg.sender, amount);
    }

    function registerAndContribute(
        bytes32 code,
        bytes32 referrerCode,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (!accounts[msg.sender].registered) {
            _register(msg.sender, code, referrerCode);
        }
        _contribute(msg.sender, amount);
    }

    function claim() external whenNotPaused nonReentrant {
        uint256 amount = pendingOf(msg.sender);
        if (amount == 0) revert NothingToClaim();
        accounts[msg.sender].claimed += amount;
        totalClaimed += amount;
        usdt.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function disburse(
        address to,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        if (msg.sender != rewards) revert NotRewards();
        if (to == address(0) || amount == 0) revert ZeroAddress();
        uint256 bal = usdt.balanceOf(address(this));
        uint256 locked = directReserve();
        if (bal < locked + amount) revert InsufficientTreasury();
        usdt.safeTransfer(to, amount);
        emit TeamDisbursed(to, amount);
    }

    /// @notice Called by the NFT before a holder-to-holder transfer moves the balance.
    ///         Settles both sides at their pre-transfer balances so finished weeks are
    ///         paid exactly once and the buyer cannot accrue weeks it never held.
    function settleTransfer(
        address from,
        address to
    ) external nonReentrant {
        if (msg.sender != address(nft)) revert NotNft();
        _settleInterest(from);
        _settleInterest(to);
    }

    function freezeImport() external onlyOwner {
        if (importFrozen) revert ImportFrozenError();
        importFrozen = true;
        emit ImportFrozen();
    }

    function openSale() external onlyOwner {
        if (!importFrozen) revert ImportNotFrozenError();
        saleOpen = true;
        if (saleOpenedAt == 0) {
            saleOpenedAt = block.timestamp;
            saleOpenedBlock = block.number;
            if (nftInterest != address(0)) ICoralNftInterest(nftInterest).noteSaleOpened();
        }
        emit SaleOpened();
    }

    function closeSale() external onlyOwner {
        saleOpen = false;
        emit SaleClosed();
    }

    /// @notice Stops NFT interest for good. Closing the sale does not do this.
    function endIdo() external onlyOwner {
        if (idoEnded) revert IdoAlreadyEnded();
        idoEnded = true;
        if (nftInterest != address(0)) {
            idoEndedWeek = ICoralNftInterest(nftInterest).interestWeek(block.timestamp) + 1;
        }
        emit IdoEnded(idoEndedWeek);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function withdrawTreasury(
        address to,
        uint256 amount
    ) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > treasuryWithdrawable()) revert InsufficientTreasury();
        usdt.safeTransfer(to, amount);
        emit TreasuryWithdrawn(to, amount);
    }

    function withdrawUnsoldNemo(
        address to,
        uint256 amount
    ) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > nemo.balanceOf(address(this))) revert InsufficientNemo();
        nemo.safeTransfer(to, amount);
        emit UnsoldNemoWithdrawn(to, amount);
    }

    function setDirectReferralBps(
        uint256 bps
    ) external onlyOwner {
        if (bps > REWARD_CAP_BPS) revert RewardBpsTooHigh();
        directReferralBps = bps;
        emit DirectReferralBpsUpdated(bps);
    }

    function setMinIdo(
        uint256 amount
    ) external onlyOwner {
        if (amount == 0) revert AmountTooSmall();
        minIdo = amount;
        emit MinIdoUpdated(amount);
    }

    function setIdentityThresholds(
        uint256 ambassadorMin_,
        uint256 partnerMin_
    ) external onlyOwner {
        if (ambassadorMin_ == 0 || ambassadorMin_ > partnerMin_) revert InvalidThresholds();
        ambassadorMin = ambassadorMin_;
        partnerMin = partnerMin_;
        emit IdentityThresholdsUpdated(ambassadorMin_, partnerMin_);
    }

    /// @notice First rewards address is immediate. Later changes use `proposeRewards`.
    function setRewards(
        address rewards_
    ) external onlyOwner {
        if (rewards != address(0)) revert RewardsAlreadySet();
        if (rewards_ == address(0)) revert ZeroAddress();
        rewards = rewards_;
        emit RewardsUpdated(rewards_);
    }

    function proposeRewards(
        address next
    ) external onlyOwner {
        if (rewards == address(0)) revert NoProposedRewards();
        if (next == address(0)) revert ZeroAddress();
        proposedRewards = next;
        proposedRewardsEta = block.timestamp + rewardsDelay;
        emit RewardsProposed(next, proposedRewardsEta);
    }

    function acceptRewards() external onlyOwner {
        if (proposedRewards == address(0)) revert NoProposedRewards();
        if (block.timestamp < proposedRewardsEta) revert RewardsDelayPending();
        rewards = proposedRewards;
        proposedRewards = address(0);
        proposedRewardsEta = 0;
        emit RewardsUpdated(rewards);
    }

    function cancelRewards() external onlyOwner {
        if (proposedRewards == address(0)) revert NoProposedRewards();
        address next = proposedRewards;
        proposedRewards = address(0);
        proposedRewardsEta = 0;
        emit RewardsProposalCancelled(next);
    }

    /// @notice Link an interest contract. A later call freezes the previous one at this week.
    ///         Finished weeks stay claimable there. This contract starts from the same week.
    function setNftInterest(
        address interest_
    ) external onlyOwner nonReentrant {
        if (interest_ == address(0)) revert ZeroAddress();
        uint256 n = nftInterests.length;
        for (uint256 i = 0; i < n; i++) {
            if (nftInterests[i] == interest_) revert InterestAlreadySet();
        }
        if (n == MAX_NFT_INTERESTS) revert TooManyInterests();
        if (n != 0) ICoralNftInterest(nftInterests[n - 1]).noteDetached();
        nftInterests.push(interest_);
        nftInterest = interest_;
        if (saleOpenedAt != 0) ICoralNftInterest(interest_).noteSaleOpened();
        if (idoEnded && idoEndedWeek == 0) {
            idoEndedWeek = ICoralNftInterest(interest_).interestWeek(block.timestamp) + 1;
        }
        emit NftInterestUpdated(interest_);
    }

    /// @notice Manual NFT grant for early accounts. Settles finished weeks at the
    ///         old balance first, then mints. Does not change volume or `nftMinted`.
    function grantNft(
        address account,
        uint256 count
    ) external onlyOwner nonReentrant {
        if (account == address(0)) revert ZeroAddress();
        if (count == 0) revert AmountTooSmall();
        if (!accounts[account].registered) revert NotRegistered();
        if (grantedNfts[account] + count > importedNfts[account]) revert GrantExceedsImport();
        grantedNfts[account] += count;
        _settleInterest(account);
        nft.mint(account, count);
        emit NftGranted(account, count);
    }

    function setTokensPerUsdt(
        uint256 rate
    ) external onlyOwner {
        if (rate == 0) revert InvalidSchedule();
        tokensPerUsdt = rate;
        emit TokensPerUsdtUpdated(rate);
    }

    function importUsers(
        address[] calldata wallets,
        bytes32[] calldata codes
    ) external onlyOwner {
        if (importFrozen) revert ImportFrozenError();
        uint256 n = wallets.length;
        if (n != codes.length) revert LengthMismatch();
        for (uint256 i = 0; i < n; i++) {
            _importUser(wallets[i], codes[i]);
        }
    }

    function importReferrers(
        address[] calldata wallets,
        address[] calldata referrers
    ) external onlyOwner {
        if (importFrozen) revert ImportFrozenError();
        uint256 n = wallets.length;
        if (n != referrers.length) revert LengthMismatch();
        for (uint256 i = 0; i < n; i++) {
            address account = wallets[i];
            address referrer = referrers[i];
            if (!accounts[account].registered) revert NotRegistered();
            if (accounts[account].referrer != address(0)) revert AlreadyBound();
            _bindReferrer(account, referrer);
            emit ReferrerImported(account, referrer);
        }
    }

    function importVolumes(
        address[] calldata wallets,
        uint256[] calldata selfVolumes
    ) external onlyOwner {
        if (importFrozen) revert ImportFrozenError();
        uint256 n = wallets.length;
        if (n != selfVolumes.length) revert LengthMismatch();
        for (uint256 i = 0; i < n; i++) {
            address account = wallets[i];
            if (!accounts[account].registered) revert NotRegistered();
            uint256 prevSelf = accounts[account].selfVolume;
            accounts[account].selfVolume = selfVolumes[i];
            totalImported = totalImported - prevSelf + selfVolumes[i];
            uint256 nfts = _nftsOwed(selfVolumes[i]);
            uint256 prev = importedNfts[account];
            if (grantedNfts[account] > nfts) revert GrantExceedsImport();
            nftsAllocated = nftsAllocated - prev + nfts;
            if (nftsAllocated > nftCap) revert NftCapExceeded();
            importedNfts[account] = nfts;
            nftMinted[account] = nfts;
            emit VolumeImported(account, selfVolumes[i]);
        }
    }

    function _teamOutstanding() internal view returns (uint256) {
        if (rewards == address(0)) return 0;
        return ICoralRewardsView(rewards).outstanding();
    }

    function _register(
        address account,
        bytes32 code,
        bytes32 referrerCode
    ) internal {
        if (accounts[account].registered) revert AlreadyRegistered();
        _setCode(account, code);
        accounts[account].registered = true;
        address referrer = address(0);
        if (referrerCode != bytes32(0)) {
            referrer = _referrerFromCode(referrerCode, account);
            _bindReferrer(account, referrer);
        }
        emit Registered(account, code, referrer);
    }

    function _setCode(
        address account,
        bytes32 code
    ) internal {
        if (!_isValidInviteCode(code)) revert InvalidCode();
        if (codeToAccount[code] != address(0)) revert CodeTaken();
        if (account == address(0)) revert ZeroAddress();
        codeToAccount[code] = account;
        accounts[account].inviteCode = code;
    }

    function _importUser(
        address account,
        bytes32 code
    ) internal {
        if (account == address(0)) revert ZeroAddress();
        if (accounts[account].registered) revert AlreadyRegistered();
        _setCode(account, code);
        accounts[account].registered = true;
        emit UserImported(account, code);
    }

    function _referrerFromCode(
        bytes32 referrerCode,
        address account
    ) internal view returns (address referrer) {
        if (referrerCode == bytes32(0)) revert InvalidReferrer();
        referrer = codeToAccount[referrerCode];
        if (referrer == address(0) || !accounts[referrer].registered) revert InvalidReferrer();
        if (referrer == account) revert SelfReferral();
    }

    function _bindReferrer(
        address account,
        address referrer
    ) internal {
        if (referrer == address(0) || !accounts[referrer].registered) revert InvalidReferrer();
        if (referrer == account) revert SelfReferral();
        if (hasChildren[account]) revert HasChildren();
        accounts[account].referrer = referrer;
        hasChildren[referrer] = true;
    }

    function _contribute(
        address account,
        uint256 amount
    ) internal {
        if (!saleOpen) revert SaleClosedError();
        if (!accounts[account].registered) revert NotRegistered();
        if (amount < minIdo) revert AmountTooSmall();

        usdt.safeTransferFrom(account, address(this), amount);
        accounts[account].selfVolume += amount;
        totalContributed += amount;

        _settleDirect(account, amount);

        uint256 nemoAmount = tokensFor(amount);
        if (nemoAmount > 0) {
            CoralToken(address(nemo)).mint(account, nemoAmount);
            totalNemoAllocated += nemoAmount;
            emit NemoAllocated(account, nemoAmount);
        }
        _settleInterest(account);
        _syncNfts(account);
        emit Contributed(account, amount, accounts[account].selfVolume, nemoAmount);
    }

    function _settleInterest(
        address account
    ) internal {
        uint256 n = nftInterests.length;
        for (uint256 i = 0; i < n; i++) {
            ICoralNftInterest(nftInterests[i]).settle(account);
        }
    }

    function _syncNfts(
        address account
    ) internal {
        uint256 owed = _nftsOwed(accounts[account].selfVolume);
        uint256 minted = nftMinted[account];
        if (owed <= minted) return;
        uint256 count = owed - minted;
        uint256 room = nftCap - nftsAllocated;
        uint256 mintNow = count < room ? count : room;
        if (mintNow > 0) {
            nftsAllocated += mintNow;
            nftMinted[account] = minted + mintNow;
            nft.mint(account, mintNow);
            emit NftMinted(account, mintNow, minted + mintNow);
        }
        if (mintNow < count) emit NftDeferred(account, count - mintNow);
    }

    function _settleDirect(
        address from,
        uint256 amount
    ) internal {
        address referrer = accounts[from].referrer;
        if (referrer == address(0)) return;
        if (accounts[referrer].selfVolume < MIN_REWARD_SELF) return;
        uint256 reward = (amount * directReferralBps) / BPS_DENOMINATOR;
        if (reward == 0) return;
        accounts[referrer].directRewards += reward;
        totalDirectAccrued += reward;
        emit DirectRewardAccrued(referrer, from, reward);
    }

    function _nftsOwed(
        uint256 selfVolume
    ) internal pure returns (uint256) {
        if (selfVolume < NFT_MIN_SELF) return 0;
        return selfVolume / NFT_UNIT;
    }

    function _isValidInviteCode(
        bytes32 code
    ) internal pure returns (bool) {
        if (code == bytes32(0)) return false;
        bool ended = false;
        bool hasChar = false;
        for (uint256 i = 0; i < 32; i++) {
            uint8 c = uint8(code[i]);
            if (c == 0) {
                ended = true;
                continue;
            }
            if (ended) return false;
            bool ok = (c >= 0x41 && c <= 0x5A) || (c >= 0x30 && c <= 0x39);
            if (!ok) return false;
            hasChar = true;
        }
        return hasChar;
    }
}
