// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Deploy-time parameters. Pick one profile; the vault reverts if chainid does not match.
library CoralNetworks {
    struct Params {
        uint256 chainId;
        address usdt;
        uint256 rewardsDelay;
        uint256 nftCap;
        uint256 directReferralBps;
        uint256 minIdo;
        uint256 tokensPerUsdt;
        uint256 weekDuration;
        bool weekByBlock;
        uint256 ambassadorMin;
        uint256 partnerMin;
    }

    function local() internal pure returns (Params memory p) {
        p.chainId = 31_337;
        p.usdt = address(0);
        p.rewardsDelay = 60;
        _shared(p);
        p.weekDuration = 30;
        p.weekByBlock = true;
    }

    function bscTestnet() internal pure returns (Params memory p) {
        p.chainId = 97;
        p.usdt = 0x9E674AfE8C7c31DB30d4E2B93b524fe4302f0D57;
        p.rewardsDelay = 10 minutes;
        _shared(p);
        p.weekDuration = 1 hours;
        p.weekByBlock = false;
    }

    function bscMainnet() internal pure returns (Params memory p) {
        p.chainId = 56;
        p.usdt = 0x55d398326f99059fF775485246999027B3197955;
        p.rewardsDelay = 24 hours;
        _shared(p);
        p.weekDuration = 7 days;
        p.weekByBlock = false;
    }

    function _shared(
        Params memory p
    ) private pure {
        p.nftCap = 10_000;
        p.directReferralBps = 1000;
        p.minIdo = 1e18;
        p.tokensPerUsdt = 100e18;
        p.ambassadorMin = 100e18;
        p.partnerMin = 1000e18;
    }
}
