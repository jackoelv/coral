// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

import {CoralIdo} from "./CoralIdo.sol";
import {CoralToken} from "./CoralToken.sol";

/// @title FreeDaoNFTInterest
/// @notice Weekly ckey interest for NFT holders during the IDO.
///         Tiers are versioned by week so a parameter change does not rewrite
///         weeks that have already ended. Users pull the accrued amount themselves.
///         Mainnet weeks end at Sunday 00:00:00 Asia/Shanghai. The unique block N
///         is the last block still timestamped 23:59; block N+1 is the first at 00:00.
///         Local and BSC testnet follow the vault's short week clock.
contract FreeDaoNFTInterest is Ownable2Step, ReentrancyGuard {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_WEEKLY_BPS = 1000;
    uint256 public constant MAX_TIERS = 16;
    /// @dev 1970-01-04 00:00:00 Asia/Shanghai. Unix epoch Thursday plus 2 days and 16 hours.
    uint256 public constant FIRST_SUNDAY_BEIJING = 230400;
    uint256 public constant CALENDAR_WEEK = 7 days;

    struct Tier {
        uint256 minNfts;
        uint256 weeklyBps;
    }

    CoralIdo public immutable vault;
    CoralToken public immutable nemo;
    bool public immutable calendarWeeks;
    uint256 public startWeek;
    bool public saleOpened;
    /// @notice Set when the vault links a replacement. Accrual stops at `stopWeek`.
    bool public detached;
    uint256 public stopWeek;
    /// @notice 5% of the 1e9 ckey cap. Owner can lower it.
    uint256 public interestCap = 50_000_000e18;
    /// @notice Per-account cap as bps of that account's NFT principal. 10000 = 100%.
    uint256 public accountCapBps = 10_000;
    uint256 public totalAccrued;
    mapping(address => uint256) public lifetime;

    uint256 public versionCount;
    mapping(uint256 versionId => uint256 fromWeek) public versionFromWeek;
    mapping(uint256 versionId => uint256 tokensPerUsdt) public versionRate;
    mapping(uint256 versionId => Tier[]) internal versionTiers;

    mapping(address account => uint256 amount) public accrued;
    mapping(address account => uint256 week) public settledThrough;
    uint256 public totalInterestMinted;

    event TiersUpdated(uint256 indexed versionId, uint256 fromWeek, uint256 tokensPerUsdt);
    event InterestSettled(address indexed account, uint256 accrued, uint256 settledThrough);
    event InterestClaimed(address indexed account, uint256 amount);
    event InterestCapUpdated(uint256 cap);
    event AccountCapBpsUpdated(uint256 bps);

    error NotVault();
    error ZeroAddress();
    error NothingToClaim();
    error InvalidTiers();
    error InterestCapTooHigh();

    constructor(
        address vault_,
        address initialOwner
    ) Ownable(initialOwner) {
        if (vault_ == address(0) || initialOwner == address(0)) revert ZeroAddress();
        vault = CoralIdo(vault_);
        nemo = CoralToken(address(vault.nemo()));
        calendarWeeks = block.chainid == 56;
        Tier[] memory tiers = new Tier[](4);
        tiers[0] = Tier({minNfts: 2, weeklyBps: 100});
        tiers[1] = Tier({minNfts: 10, weeklyBps: 200});
        tiers[2] = Tier({minNfts: 20, weeklyBps: 250});
        tiers[3] = Tier({minNfts: 60, weeklyBps: 300});
        _writeTiers(0, 0, vault.tokensPerUsdt(), tiers);
        versionCount = 1;
    }

    function noteSaleOpened() external {
        if (msg.sender != address(vault)) revert NotVault();
        if (saleOpened) return;
        saleOpened = true;
        uint256 week = _week(block.timestamp);
        if (vault.idoEnded()) {
            uint256 ended = vault.idoEndedWeek();
            if (ended > week) week = ended;
        }
        startWeek = week;
    }

    /// @notice Freeze accrual at the current cutoff. The replacement contract starts at the same week.
    function noteDetached() external {
        if (msg.sender != address(vault)) revert NotVault();
        if (detached) return;
        uint256 week = _endExclusive();
        detached = true;
        stopWeek = week;
    }

    function setInterestCap(
        uint256 cap
    ) external onlyOwner {
        if (cap > 50_000_000e18) revert InterestCapTooHigh();
        interestCap = cap;
        emit InterestCapUpdated(cap);
    }

    function setAccountCapBps(
        uint256 bps
    ) external onlyOwner {
        if (bps > BPS_DENOMINATOR) revert InvalidTiers();
        accountCapBps = bps;
        emit AccountCapBpsUpdated(bps);
    }

    /// @notice Week index used for settlement. On mainnet this is the Beijing Sunday week.
    function interestWeek(
        uint256 timestamp
    ) public view returns (uint256) {
        return _week(timestamp);
    }

    /// @notice Unix time when mainnet week `week` starts (Sunday 00:00 Asia/Shanghai).
    ///         Block N is the last block with a timestamp strictly below the next boundary.
    function weekBoundary(
        uint256 week
    ) public pure returns (uint256) {
        return FIRST_SUNDAY_BEIJING + week * CALENDAR_WEEK;
    }

    function tiersOf(
        uint256 versionId
    ) external view returns (Tier[] memory) {
        return versionTiers[versionId];
    }

    function pending(
        address account
    ) external view returns (uint256) {
        (uint256 nextAccrued,) = _preview(account);
        return nextAccrued;
    }

    function setTiers(
        Tier[] calldata tiers
    ) external onlyOwner {
        _validate(tiers);
        uint256 week = _week(block.timestamp);
        uint256 rate = vault.tokensPerUsdt();
        uint256 id = versionCount - 1;
        if (versionFromWeek[id] == week) {
            _writeTiers(id, week, rate, tiers);
        } else {
            id = versionCount;
            _writeTiers(id, week, rate, tiers);
            versionCount = id + 1;
        }
        emit TiersUpdated(id, week, rate);
    }

    /// @notice Vault calls this before an NFT balance change, and before a claim.
    function settle(
        address account
    ) external {
        if (msg.sender != address(vault)) revert NotVault();
        _settle(account);
    }

    function claim() external nonReentrant {
        _settle(msg.sender);
        uint256 amount = accrued[msg.sender];
        if (amount == 0) revert NothingToClaim();
        accrued[msg.sender] = 0;
        totalInterestMinted += amount;
        nemo.mint(msg.sender, amount);
        emit InterestClaimed(msg.sender, amount);
    }

    function _settle(
        address account
    ) internal {
        (uint256 nextAccrued, uint256 nextSettled) = _preview(account);
        uint256 gained = nextAccrued - accrued[account];
        totalAccrued += gained;
        lifetime[account] += gained;
        accrued[account] = nextAccrued;
        settledThrough[account] = nextSettled;
        emit InterestSettled(account, nextAccrued, nextSettled);
    }

    function _preview(
        address account
    ) internal view returns (uint256 nextAccrued, uint256 nextSettled) {
        if (!saleOpened) return (accrued[account], settledThrough[account]);
        uint256 end = _endExclusive();
        uint256 from = settledThrough[account];
        if (from < startWeek) from = startWeek;
        if (from >= end) {
            return (accrued[account], settledThrough[account] > end ? settledThrough[account] : end);
        }

        uint256 nfts = vault.nft().balanceOf(account);
        uint256 cursor = from;
        uint256 extra = 0;
        while (cursor < end) {
            (uint256 id, uint256 next) = _versionFor(cursor);
            uint256 spanEnd = next < end ? next : end;
            if (spanEnd <= cursor) break;
            if (nfts > 0) {
                uint256 bps = _bps(id, nfts);
                if (bps > 0) {
                    uint256 principal = nfts * vault.NFT_UNIT() * versionRate[id] / 1e18;
                    extra += principal * bps * (spanEnd - cursor) / BPS_DENOMINATOR;
                }
            }
            cursor = spanEnd;
        }
        extra = _capExtra(account, nfts, extra);
        return (accrued[account] + extra, end);
    }

    function _capExtra(
        address account,
        uint256 nfts,
        uint256 extra
    ) internal view returns (uint256) {
        if (extra == 0) return 0;
        uint256 globalRoom = interestCap > totalAccrued ? interestCap - totalAccrued : 0;
        if (extra > globalRoom) extra = globalRoom;
        uint256 rate = versionRate[versionCount - 1];
        uint256 principal = nfts * vault.NFT_UNIT() * rate / 1e18;
        uint256 ceiling = principal * accountCapBps / BPS_DENOMINATOR;
        uint256 used = lifetime[account];
        uint256 accountRoom = ceiling > used ? ceiling - used : 0;
        if (extra > accountRoom) extra = accountRoom;
        return extra;
    }

    function _endExclusive() internal view returns (uint256) {
        if (detached) return stopWeek;
        if (vault.idoEnded()) return vault.idoEndedWeek();
        return _week(block.timestamp);
    }

    function _week(
        uint256 timestamp
    ) internal view returns (uint256) {
        if (calendarWeeks) return _calendarWeek(timestamp);
        return vault.currentWeek();
    }

    function _calendarWeek(
        uint256 timestamp
    ) internal pure returns (uint256) {
        if (timestamp < FIRST_SUNDAY_BEIJING) return 0;
        return (timestamp - FIRST_SUNDAY_BEIJING) / CALENDAR_WEEK;
    }

    function _versionFor(
        uint256 week
    ) internal view returns (uint256 id, uint256 nextWeek) {
        uint256 chosen = 0;
        uint256 count = versionCount;
        for (uint256 i = 0; i < count; i++) {
            if (versionFromWeek[i] <= week) {
                chosen = i;
            } else {
                return (chosen, versionFromWeek[i]);
            }
        }
        return (chosen, type(uint256).max);
    }

    function _bps(
        uint256 versionId,
        uint256 nftCount
    ) internal view returns (uint256 bps) {
        Tier[] storage tiers = versionTiers[versionId];
        uint256 n = tiers.length;
        for (uint256 i = 0; i < n; i++) {
            if (nftCount >= tiers[i].minNfts) bps = tiers[i].weeklyBps;
            else break;
        }
    }

    function _writeTiers(
        uint256 id,
        uint256 fromWeek,
        uint256 rate,
        Tier[] memory tiers
    ) internal {
        versionFromWeek[id] = fromWeek;
        versionRate[id] = rate;
        Tier[] storage stored = versionTiers[id];
        while (stored.length > 0) {
            stored.pop();
        }
        uint256 n = tiers.length;
        for (uint256 i = 0; i < n; i++) {
            stored.push(tiers[i]);
        }
    }

    function _validate(
        Tier[] calldata tiers
    ) internal pure {
        uint256 n = tiers.length;
        if (n == 0 || n > MAX_TIERS) revert InvalidTiers();
        uint256 prevMin = 0;
        for (uint256 i = 0; i < n; i++) {
            if (tiers[i].minNfts <= prevMin) revert InvalidTiers();
            if (tiers[i].weeklyBps == 0 || tiers[i].weeklyBps > MAX_WEEKLY_BPS) revert InvalidTiers();
            prevMin = tiers[i].minNfts;
        }
    }
}
