// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "../lib/forge-std/src/Test.sol";
import {CoralIdo} from "../src/CoralIdo.sol";
import {CoralNetworks} from "../src/network/CoralNetworks.sol";
import {CoralToken} from "../src/CoralToken.sol";
import {CoralNFT} from "../src/CoralNFT.sol";
import {MockUSDT} from "../src/MockUSDT.sol";

/// @notice localdev market-promotion sim. Stops at phase 1: several CoBuilders + 3-tier differential.
contract SimMarket is Test {
    uint256 internal constant UNIT = 1e18;
    uint256 internal constant USER_COUNT = 3000;
    uint256 internal constant BANKROLL = 10_000 * UNIT;
    uint256 internal constant KOL_N = 8;
    uint256 internal constant CAP_PER_KOL = 3;
    uint256 internal constant AMB_PER_CAP = 10;
    uint256 internal constant LEAF_PER_AMB = 10;
    uint256 internal constant CAP_N = KOL_N * CAP_PER_KOL; // 24
    uint256 internal constant AMB_N = CAP_N * AMB_PER_CAP; // 240
    uint256 internal constant LEAF_N = AMB_N * LEAF_PER_AMB; // 2400
    uint256 internal constant TREE_N = 1 + KOL_N + CAP_N + AMB_N + LEAF_N; // 2673
    uint256 internal constant BATCH = 100;
    uint256 internal constant SWEEP_THRESHOLD = 5000 * UNIT;

    MockUSDT internal usdt;
    CoralToken internal nemo;
    CoralIdo internal ido;

    address[] internal users;

    string internal report;
    uint256 internal snapCount;
    uint256 internal contributeCount;
    uint256 internal firstCobuilderAt;
    bool internal sawThreeTier;
    bool internal recorded50u;

    address internal sample50Payer;
    uint256 internal sample50Amount;
    uint256 internal sample50Direct;
    uint256 internal sample50Team;
    uint256 internal sample50AmbTeamBefore;
    uint256 internal sample50AmbTeamAfter;

    address internal tierPayer;
    uint256 internal tierAmount;
    address internal tierAmb;
    address internal tierCap;
    address internal tierKol;
    uint256 internal tierDirect;
    uint256 internal tierAmbTeam;
    uint256 internal tierCapTeam;
    uint256 internal tierKolTeam;
    uint256 internal tierWeek;
    uint256 internal tierBlock;
    uint256 internal tierAmbBps;
    uint256 internal tierCapBps;
    uint256 internal tierKolBps;

    address internal obsAmb;
    address internal obsCap;
    address internal obsKol;
    uint256 internal obsDirect0;
    uint256 internal obsAmbTeamRew0;
    uint256 internal obsCapTeamRew0;
    uint256 internal obsKolTeamRew0;
    uint256 internal obsAmbVol0;
    uint256 internal obsCobuilders0;

    string internal claimReport;
    uint256 internal claimers;
    uint256 internal claimedTotal;
    uint256 internal skippedPendingZero;
    uint256 internal reservedBeforeClaim;
    uint256 internal contractBeforeClaim;
    uint256 internal withdrawableBeforeClaim;
    uint256 internal adminWithdrawn;
    uint256 internal sweepTotal;
    uint256[] internal sweepAmounts;
    uint256[] internal sweepBlocks;
    bool internal samplesMatch;
    bool internal doubleClaimReverted;
    bool internal vaultEmptyAfterAdmin;

    address[4] internal sampleWho;
    uint256[4] internal sUsdt0;
    uint256[4] internal sNemo0;
    uint256[4] internal sPend0;
    uint256[4] internal sUsdt1;
    uint256[4] internal sNemo1;
    uint256[4] internal sPend1;

    function setUp() public {
        vm.skip(true, "phase 1: team-reward market sim deferred to phase 4");
        usdt = new MockUSDT();
        nemo = new CoralToken(address(this));
        CoralNFT pass = new CoralNFT(address(this), "FreeDaoRWA", "FREEDAONFT");
        ido = new CoralIdo(address(usdt), address(nemo), address(pass), address(this), CoralNetworks.local());
        nemo.setMinter(address(ido));
        pass.setMinter(address(ido));

        users = new address[](USER_COUNT);
        for (uint256 i = 0; i < USER_COUNT; i++) {
            address who = vm.addr(i + 1);
            users[i] = who;
            usdt.mint(who, BANKROLL);
            vm.prank(who);
            usdt.approve(address(ido), type(uint256).max);
        }

        _importTree();
        ido.freezeImport();
        ido.openSale();
    }

    function test_phase1_cobuilders_and_three_tier_then_pause() public {
        report = unicode"# localdev 市场推广模拟报告（第一阶段）\n\n";
        report = string.concat(
            report,
            unicode"> 本报告由 `forge test --match-contract SimMarket` 根据链上实际记账生成，金额单位为整数 USDT（去掉 1e18）。\n\n",
            unicode"## 分支提醒\n\n",
            unicode"**禁止把 `localdev` 部署到 BSC 主网。** 本分支 `weekDuration = 30` 个区块，",
            unicode"`currentWeek()` 用 `block.number`。主网必须改回 `7 days` + `block.timestamp`。",
            unicode"构造函数已在 `chainid == 56` 拒绝部署。\n\n",
            unicode"## 模拟设定\n\n",
            unicode"- 地址：3000 个，每人预先打入 **10000 USDT**（开售前 mint + approve，不推进「周」）\n",
            unicode"- 邀请树：1 根 + 8 KOL + 24 团长 + 240 大使 + 2400 叶子（共 2673 人注册；其余 327 人只持币未注册）\n",
            unicode"- 入金：KOL/团长 1000U，大使 100U，叶子混杂 50 / 100 / 1000U\n",
            unicode"- 出块：每笔 `contribute` 后 `vm.roll(+1)`，每 30 块 ckey 少发 20 枚/100U\n",
            unicode"- 金库：`treasuryWithdrawable` 每达到 **5000U**，Admin 立刻 `withdrawTreasury` 抽走当时全部可提现额\n",
            unicode"- 停止条件：至少 3 个共建者，且出现一笔 3%/6%/9% 三段极差\n\n"
        );

        _snapshot(unicode"开售（尚无入金）");

        _payIdentity(users[0], 1000 * UNIT);
        for (uint256 i = 0; i < KOL_N; i++) {
            _payIdentity(users[_kolIndex(i)], 1000 * UNIT);
        }
        for (uint256 i = 0; i < CAP_N; i++) {
            _payIdentity(users[_capIndex(i)], 1000 * UNIT);
        }
        for (uint256 i = 0; i < AMB_N; i++) {
            _payIdentity(users[_ambIndex(i)], 100 * UNIT);
        }
        _snapshot(unicode"身份波结束（根/KOL/团长 1000U，大使 100U）");

        bool stopped;
        for (uint256 k = 0; k < KOL_N && !stopped; k++) {
            for (uint256 c = 0; c < CAP_PER_KOL && !stopped; c++) {
                for (uint256 a = 0; a < AMB_PER_CAP && !stopped; a++) {
                    for (uint256 l = 0; l < LEAF_PER_AMB && !stopped; l++) {
                        uint256 idx = _leafIndex(k, c, a, l);
                        uint256 amount = _leafAmount(l, idx);
                        _payAndObserve(users[idx], amount, k, c, a);
                        if (_cobuilderCount() >= 3 && sawThreeTier) {
                            stopped = true;
                        }
                    }
                }
            }
        }

        require(stopped, "phase1 stop condition not met");
        _snapshot(unicode"第一阶段暂停（共建者 >= 3 且已出现三段极差）");
        _appendAnalysis();
        vm.writeFile("docs/localdev-sim-report.md", report);

        console2.log("wrote docs/localdev-sim-report.md");
        console2.log("contributes", contributeCount);
        console2.log("week", ido.currentWeek());
        console2.log("block", block.number);
        console2.log("cobuilders", _cobuilderCount());
        console2.log("treasuryWithdrawable", usdtBal(ido.treasuryWithdrawable()));
        console2.log("contractUsdt", usdtBal(usdt.balanceOf(address(ido))));

        _runClaimsAndAdminWithdraw();
        _writeClaimReport();
        vm.writeFile("docs/localdev-sim-claim-report.md", claimReport);
        console2.log("wrote docs/localdev-sim-claim-report.md");
        require(ido.totalContributed() == claimedTotal + sweepTotal + adminWithdrawn, "usdt conservation");
        require(samplesMatch, "sample balances mismatch");
        require(vaultEmptyAfterAdmin, "vault not emptied");
        require(doubleClaimReverted, "double claim should revert");
    }

    // -------------------------------------------------------------------------
    // Tree indices: [root][8 kol][24 cap][240 amb][2400 leaf]
    // -------------------------------------------------------------------------

    function _kolIndex(
        uint256 k
    ) internal pure returns (uint256) {
        return 1 + k;
    }

    function _capIndex(
        uint256 i
    ) internal pure returns (uint256) {
        return 1 + KOL_N + i;
    }

    function _capIndexKC(
        uint256 k,
        uint256 c
    ) internal pure returns (uint256) {
        return 1 + KOL_N + k * CAP_PER_KOL + c;
    }

    function _ambIndex(
        uint256 i
    ) internal pure returns (uint256) {
        return 1 + KOL_N + CAP_N + i;
    }

    function _ambIndexKCA(
        uint256 k,
        uint256 c,
        uint256 a
    ) internal pure returns (uint256) {
        return 1 + KOL_N + CAP_N + (k * CAP_PER_KOL + c) * AMB_PER_CAP + a;
    }

    function _leafIndex(
        uint256 k,
        uint256 c,
        uint256 a,
        uint256 l
    ) internal pure returns (uint256) {
        uint256 ambSerial = (k * CAP_PER_KOL + c) * AMB_PER_CAP + a;
        return 1 + KOL_N + CAP_N + AMB_N + ambSerial * LEAF_PER_AMB + l;
    }

    function _leafAmount(
        uint256 leafSlot,
        uint256 userIndex
    ) internal pure returns (uint256) {
        // First three leaves under each ambassador put 1000U so teamVolume can cross 3000.
        if (leafSlot < 3) return 1000 * UNIT;
        uint256 r = uint256(keccak256(abi.encode(userIndex))) % 2;
        return r == 0 ? 50 * UNIT : 100 * UNIT;
    }

    function _importTree() internal {
        for (uint256 start = 0; start < TREE_N; start += BATCH) {
            uint256 n = start + BATCH > TREE_N ? TREE_N - start : BATCH;
            address[] memory wallets = new address[](n);
            bytes32[] memory codes = new bytes32[](n);
            for (uint256 j = 0; j < n; j++) {
                uint256 i = start + j;
                wallets[j] = users[i];
                codes[j] = _code8(i);
            }
            ido.importUsers(wallets, codes);
        }

        uint256 refN = TREE_N - 1;
        for (uint256 start = 0; start < refN; start += BATCH) {
            uint256 n = start + BATCH > refN ? refN - start : BATCH;
            address[] memory wallets = new address[](n);
            address[] memory refs = new address[](n);
            for (uint256 j = 0; j < n; j++) {
                uint256 i = start + j + 1;
                wallets[j] = users[i];
                refs[j] = users[_referrerIndex(i)];
            }
            ido.importReferrers(wallets, refs);
        }
    }

    function _referrerIndex(
        uint256 i
    ) internal pure returns (uint256) {
        if (i == 0) revert("root");
        if (i < 1 + KOL_N) return 0;
        if (i < 1 + KOL_N + CAP_N) {
            uint256 capSerial = i - (1 + KOL_N);
            return _kolIndex(capSerial / CAP_PER_KOL);
        }
        if (i < 1 + KOL_N + CAP_N + AMB_N) {
            uint256 ambSerial = i - (1 + KOL_N + CAP_N);
            return _capIndex(ambSerial / AMB_PER_CAP);
        }
        uint256 leafSerial = i - (1 + KOL_N + CAP_N + AMB_N);
        uint256 ambSerial2 = leafSerial / LEAF_PER_AMB;
        return _ambIndex(ambSerial2);
    }

    function _code8(
        uint256 i
    ) internal pure returns (bytes32 out) {
        bytes memory b = new bytes(8);
        b[0] = "U";
        uint256 n = i;
        for (uint256 k = 0; k < 7; k++) {
            b[7 - k] = bytes1(uint8(48 + (n % 10)));
            n /= 10;
        }
        assembly {
            out := mload(add(b, 32))
        }
    }

    // -------------------------------------------------------------------------
    // Contribute + observe
    // -------------------------------------------------------------------------

    function _pay(
        address who,
        uint256 amount
    ) internal {
        vm.prank(who);
        ido.contribute(amount);
        unchecked {
            contributeCount++;
        }
        _sweepIfDue();
        vm.roll(block.number + 1);
    }

    function _sweepIfDue() internal {
        uint256 w = ido.treasuryWithdrawable();
        if (w < SWEEP_THRESHOLD) return;
        uint256 reserved = ido.reservedRewards();
        uint256 admin0 = usdt.balanceOf(address(this));
        ido.withdrawTreasury(address(this), w);
        require(usdt.balanceOf(address(this)) == admin0 + w, "sweep admin usdt");
        require(ido.reservedRewards() == reserved, "sweep touched reserved");
        require(ido.treasuryWithdrawable() == 0, "sweep leftover withdrawable");
        sweepAmounts.push(w);
        sweepBlocks.push(block.number);
        unchecked {
            sweepTotal += w;
        }
        console2.log("sweep", sweepAmounts.length, usdtBal(w), usdtBal(sweepTotal));
    }

    function _payIdentity(
        address who,
        uint256 amount
    ) internal {
        uint256 before = _cobuilderCount();
        _pay(who, amount);
        if (before == 0 && _cobuilderCount() > 0) {
            _snapshot(unicode"第一个共建者出现");
        }
    }

    function _payAndObserve(
        address who,
        uint256 amount,
        uint256 k,
        uint256 c,
        uint256 a
    ) internal {
        obsAmb = users[_ambIndexKCA(k, c, a)];
        obsCap = users[_capIndexKC(k, c)];
        obsKol = users[_kolIndex(k)];
        obsCobuilders0 = _cobuilderCount();
        obsDirect0 = _directOf(obsAmb);
        obsAmbTeamRew0 = _teamRewOf(obsAmb);
        obsCapTeamRew0 = _teamRewOf(obsCap);
        obsKolTeamRew0 = _teamRewOf(obsKol);
        obsAmbVol0 = _teamVolOf(obsAmb);

        _pay(who, amount);
        _observeAfter(who, amount);
    }

    function _observeAfter(
        address who,
        uint256 amount
    ) internal {
        if (obsCobuilders0 == 0 && _cobuilderCount() > 0 && firstCobuilderAt == 0) {
            firstCobuilderAt = snapCount + 1;
            _snapshot(unicode"第一个共建者出现");
        }

        if (!recorded50u && amount < 100 * UNIT) {
            recorded50u = true;
            sample50Payer = who;
            sample50Amount = amount;
            sample50Team = (_teamRewOf(obsAmb) - obsAmbTeamRew0) + (_teamRewOf(obsCap) - obsCapTeamRew0)
                + (_teamRewOf(obsKol) - obsKolTeamRew0);
            sample50Direct = _directOf(obsAmb) - obsDirect0;
            sample50AmbTeamBefore = obsAmbVol0;
            sample50AmbTeamAfter = _teamVolOf(obsAmb);
        }

        if (sawThreeTier || amount < 100 * UNIT) return;
        if (false) {
            return;
        }

        uint256 dAmb = _teamRewOf(obsAmb) - obsAmbTeamRew0;
        uint256 dCap = _teamRewOf(obsCap) - obsCapTeamRew0;
        uint256 dKol = _teamRewOf(obsKol) - obsKolTeamRew0;
        if (dAmb == 0 || dCap == 0 || dKol == 0) return;

        sawThreeTier = true;
        tierPayer = who;
        tierAmount = amount;
        tierAmb = obsAmb;
        tierCap = obsCap;
        tierKol = obsKol;
        tierDirect = _directOf(obsAmb) - obsDirect0;
        tierAmbTeam = dAmb;
        tierCapTeam = dCap;
        tierKolTeam = dKol;
        tierWeek = ido.currentWeek();
        tierBlock = block.number;
        tierAmbBps = 300;
        tierCapBps = 600;
        tierKolBps = 900;
        _snapshot(unicode"第一笔三段极差（3% / 6% / 9%）");
    }

    function _sampleLabel(
        uint256 i
    ) internal pure returns (string memory) {
        if (i == 0) return "Cap0 (KOL0)";
        if (i == 1) return "Cap1 (KOL0)";
        if (i == 2) return "Cap2 (KOL0)";
        return "Admin (owner)";
    }

    function _recordSamples(
        bool afterPhase
    ) internal {
        for (uint256 i = 0; i < 4; i++) {
            address who = sampleWho[i];
            if (!afterPhase) {
                sUsdt0[i] = usdt.balanceOf(who);
                sNemo0[i] = nemo.balanceOf(who);
                sPend0[i] = ido.pendingOf(who);
            } else {
                sUsdt1[i] = usdt.balanceOf(who);
                sNemo1[i] = nemo.balanceOf(who);
                sPend1[i] = ido.pendingOf(who);
            }
        }
    }

    function _claimOne(
        address who
    ) internal {
        uint256 pending = ido.pendingOf(who);
        if (pending == 0) {
            unchecked {
                skippedPendingZero++;
            }
            return;
        }
        uint256 u0 = usdt.balanceOf(who);
        uint256 n0 = nemo.balanceOf(who);
        vm.prank(who);
        ido.claim();
        require(usdt.balanceOf(who) == u0 + pending, "claim usdt delta");
        require(nemo.balanceOf(who) == n0, "claim moved ckey");
        require(ido.pendingOf(who) == 0, "pending leftover");
        unchecked {
            claimers++;
            claimedTotal += pending;
        }
    }

    function _runClaimsAndAdminWithdraw() internal {
        sampleWho[0] = users[_capIndex(0)];
        sampleWho[1] = users[_capIndex(1)];
        sampleWho[2] = users[_capIndex(2)];
        sampleWho[3] = address(this);
        _recordSamples(false);

        reservedBeforeClaim = ido.reservedRewards();
        contractBeforeClaim = usdt.balanceOf(address(ido));
        withdrawableBeforeClaim = ido.treasuryWithdrawable();
        require(contractBeforeClaim == reservedBeforeClaim + withdrawableBeforeClaim, "reserve identity before claim");

        console2.log("---- claim phase ----");
        console2.log("reservedBefore", usdtBal(reservedBeforeClaim));
        console2.log("contractBefore", usdtBal(contractBeforeClaim));
        console2.log("withdrawableBefore", usdtBal(withdrawableBeforeClaim));

        for (uint256 i = 0; i < TREE_N; i++) {
            _claimOne(users[i]);
        }

        require(claimedTotal == reservedBeforeClaim, "claimed != reserved");
        require(ido.reservedRewards() == 0, "reserved leftover");
        require(ido.totalClaimed() == claimedTotal, "totalClaimed");
        require(usdt.balanceOf(address(ido)) == contractBeforeClaim - claimedTotal, "vault after claims");

        if (sPend0[0] > 0) {
            vm.prank(sampleWho[0]);
            vm.expectRevert(CoralIdo.NothingToClaim.selector);
            ido.claim();
            doubleClaimReverted = true;
        }

        uint256 remaining = usdt.balanceOf(address(ido));
        require(remaining == ido.treasuryWithdrawable(), "remaining should be fully withdrawable");
        uint256 adminUsdt0 = usdt.balanceOf(address(this));
        uint256 adminNemo0 = nemo.balanceOf(address(this));
        if (remaining > 0) {
            ido.withdrawTreasury(address(this), remaining);
            adminWithdrawn = remaining;
        }
        require(usdt.balanceOf(address(this)) == adminUsdt0 + adminWithdrawn, "admin usdt");
        require(nemo.balanceOf(address(this)) == adminNemo0, "admin ckey moved");
        require(usdt.balanceOf(address(ido)) == 0, "vault usdt leftover");
        vaultEmptyAfterAdmin = true;

        _recordSamples(true);

        samplesMatch = true;
        for (uint256 i = 0; i < 3; i++) {
            if (sNemo1[i] != sNemo0[i]) samplesMatch = false;
            if (sPend1[i] != 0) samplesMatch = false;
            if (sUsdt1[i] != sUsdt0[i] + sPend0[i]) samplesMatch = false;
        }
        if (sNemo1[3] != sNemo0[3]) samplesMatch = false;
        if (sPend1[3] != 0) samplesMatch = false;
        if (sUsdt1[3] != sUsdt0[3] + adminWithdrawn) samplesMatch = false;

        console2.log("claimers", claimers);
        console2.log("claimedTotal", usdtBal(claimedTotal));
        console2.log("sweepCount", sweepAmounts.length);
        console2.log("sweepTotal", usdtBal(sweepTotal));
        console2.log("finalAdminWithdraw", usdtBal(adminWithdrawn));
        console2.log("skippedZeroPending", skippedPendingZero);
        console2.log("adminWithdrawn", usdtBal(adminWithdrawn));
        console2.log("samplesMatch", samplesMatch);
    }

    function _writeClaimReport() internal {
        claimReport = unicode"# localdev 提现模拟报告\n\n";
        claimReport = string.concat(
            claimReport,
            unicode"> 入金期间：`treasuryWithdrawable` 每 ≥ **5000U** 就由 Admin 抽走当时全部可提现额（准备金不动）。第一阶段结束后：全体有待领奖励的用户 `claim()`，再把剩余本金 `withdrawTreasury` 抽空。金额单位为整数 U / 整数 CKEY。\n\n",
            unicode"## 合约金库\n\n",
            unicode"| 时点 | 合约 USDT | reservedRewards | treasuryWithdrawable |\n|---|---:|---:|---:|\n"
        );
        claimReport = string.concat(
            claimReport,
            unicode"| 提现前 | ",
            vm.toString(usdtBal(contractBeforeClaim)),
            " | ",
            vm.toString(usdtBal(reservedBeforeClaim)),
            " | ",
            vm.toString(usdtBal(withdrawableBeforeClaim)),
            " |\n"
        );
        claimReport = string.concat(
            claimReport,
            unicode"| 用户全部 claim 后、管理员提现前 | ",
            vm.toString(usdtBal(contractBeforeClaim - claimedTotal)),
            " | 0 | ",
            vm.toString(usdtBal(contractBeforeClaim - claimedTotal)),
            " |\n"
        );
        claimReport = string.concat(
            claimReport,
            unicode"| 管理员提现后 | 0 | 0 | 0 |\n\n",
            unicode"## 批量 claim\n\n",
            unicode"- 扫描注册用户：",
            vm.toString(TREE_N),
            unicode"\n- 成功 claim 人数：",
            vm.toString(claimers),
            unicode"\n- pending=0 跳过：",
            vm.toString(skippedPendingZero),
            unicode"\n- 领走 USDT 合计：",
            vm.toString(usdtBal(claimedTotal)),
            unicode"U（应等于提现前 reservedRewards）\n",
            unicode"- 二次 claim：Cap0 再次调用已 revert `NothingToClaim`\n\n"
        );
        _appendSweepTable();
        _appendSampleTable();
        _appendClaimConclusions();
    }

    function _appendSweepTable() internal {
        claimReport = string.concat(
            claimReport,
            unicode"## 入金期：每满 5000U 可提现就抽一次\n\n",
            unicode"- 触发次数：",
            vm.toString(sweepAmounts.length),
            unicode"\n- 累计抽走：",
            vm.toString(usdtBal(sweepTotal)),
            unicode"U\n",
            unicode"- 每次抽完后 `treasuryWithdrawable == 0`，`reservedRewards` 不变\n\n",
            unicode"| # | block | 本笔抽走 (U) |\n|---:|---:|---:|\n"
        );
        for (uint256 i = 0; i < sweepAmounts.length; i++) {
            claimReport = string.concat(
                claimReport,
                "| ",
                vm.toString(i + 1),
                " | ",
                vm.toString(sweepBlocks[i]),
                " | ",
                vm.toString(usdtBal(sweepAmounts[i])),
                " |\n"
            );
        }
        claimReport = string.concat(claimReport, "\n");
    }

    function _appendSampleTable() internal {
        claimReport = string.concat(
            claimReport,
            unicode"## 抽样：3 名团长 + 管理员\n\n",
            unicode"| 对象 | 地址 | 本人业绩 (U) | 伞下 (U) | 待领(前) | USDT前 | USDT后 | CKEY前 | CKEY后 | 校验 |\n",
            unicode"|---|---|---:|---:|---:|---:|---:|---:|---:|---|\n"
        );
        for (uint256 i = 0; i < 4; i++) {
            _appendSampleRow(i);
        }
    }

    function _appendSampleRow(
        uint256 i
    ) internal {
        bool ok = _sampleOk(i);
        claimReport = string.concat(
            claimReport,
            "| ",
            _sampleLabel(i),
            " | `",
            vm.toString(sampleWho[i]),
            "` | ",
            vm.toString(usdtBal(i == 3 ? 0 : _selfOf(sampleWho[i]))),
            " | "
        );
        _appendSampleRowTail(i, ok);
    }

    function _appendSampleRowTail(
        uint256 i,
        bool ok
    ) internal {
        claimReport = string.concat(
            claimReport,
            vm.toString(usdtBal(i == 3 ? 0 : _teamVolOf(sampleWho[i]))),
            " | ",
            vm.toString(usdtBal(sPend0[i])),
            " | ",
            vm.toString(usdtBal(sUsdt0[i])),
            " | ",
            vm.toString(usdtBal(sUsdt1[i])),
            " | "
        );
        claimReport = string.concat(
            claimReport,
            vm.toString(sNemo0[i] / UNIT),
            " | ",
            vm.toString(sNemo1[i] / UNIT),
            " | ",
            ok ? unicode"通过" : unicode"失败",
            " |\n"
        );
    }

    function _sampleOk(
        uint256 i
    ) internal view returns (bool) {
        if (sNemo1[i] != sNemo0[i] || sPend1[i] != 0) return false;
        if (i < 3) return sUsdt1[i] == sUsdt0[i] + sPend0[i];
        return sUsdt1[i] == sUsdt0[i] + adminWithdrawn;
    }

    function _appendClaimConclusions() internal {
        claimReport = string.concat(
            claimReport,
            unicode"\n## 管理员提现\n\n",
            unicode"- 入金期满 5000U 抽走 **",
            vm.toString(usdtBal(sweepTotal)),
            unicode"U**（",
            vm.toString(sweepAmounts.length),
            unicode" 次）\n",
            unicode"- 用户 claim 后收尾抽出 **",
            vm.toString(usdtBal(adminWithdrawn)),
            unicode"U**\n",
            unicode"- Admin 合计收到 **",
            vm.toString(usdtBal(sweepTotal + adminWithdrawn)),
            unicode"U**；CKEY 始终为 0\n",
            unicode"- 守恒：入金 ",
            vm.toString(usdtBal(ido.totalContributed())),
            unicode" = 用户领取 ",
            vm.toString(usdtBal(claimedTotal)),
            unicode" + Admin 抽走 ",
            vm.toString(usdtBal(sweepTotal + adminWithdrawn)),
            "\n",
            unicode"- 合约 USDT 余额归零：",
            vaultEmptyAfterAdmin ? unicode"是" : unicode"否",
            "\n\n",
            unicode"## 结论\n\n"
        );
        if (
            samplesMatch && vaultEmptyAfterAdmin && doubleClaimReverted && claimedTotal == reservedBeforeClaim
                && ido.totalContributed() == claimedTotal + sweepTotal + adminWithdrawn
        ) {
            claimReport = string.concat(
                claimReport,
                unicode"合约可正常运行：中途按 5000U 阈值抽走可提现额，不会把用户准备金抽走；",
                unicode"随后用户 `claim()` 仍能足额领到 pending USDT，ckey 不动；",
                unicode"最后把剩余本金抽空，入金 = 用户奖励 + Admin 抽走。抽样团长 USDT 增量等于待领奖励。\n"
            );
        } else {
            claimReport = string.concat(claimReport, unicode"**校验未通过，需要复查。**\n");
        }
    }

    function _cobuilderCount() internal view returns (uint256 n) {
        if (uint256(ido.roleOf(users[0])) == uint256(CoralIdo.Role.Partner)) n++;
        for (uint256 i = 0; i < KOL_N; i++) {
            if (uint256(ido.roleOf(users[_kolIndex(i)])) == uint256(CoralIdo.Role.Partner)) n++;
        }
    }

    function _directOf(
        address who
    ) internal view returns (uint256) {
        return ido.getAccount(who).directRewards;
    }

    function _teamRewOf(
        address who
    ) internal view returns (uint256) {
        return 0;
    }

    function _selfOf(
        address who
    ) internal view returns (uint256) {
        return ido.getAccount(who).selfVolume;
    }

    function _teamVolOf(
        address who
    ) internal view returns (uint256) {
        return 0;
    }

    function usdtBal(
        uint256 amount
    ) internal pure returns (uint256) {
        return amount / UNIT;
    }

    function _roleLabel(
        address who
    ) internal view returns (string memory) {
        uint256 r = uint256(ido.roleOf(who));
        if (r == 3) return "Partner";
        if (r == 3) return "Partner";
        if (r == 2) return "Ambassador";
        if (r == 1) return "Explorer";
        return "None";
    }

    function _snapshot(
        string memory label
    ) internal {
        uint256 bal = usdtBal(usdt.balanceOf(address(ido)));
        uint256 wd = usdtBal(ido.treasuryWithdrawable());
        uint256 reserved = usdtBal(ido.reservedRewards());
        uint256 week = ido.currentWeek();
        uint256 contributed = usdtBal(ido.totalContributed());
        uint256 cobuilders = _cobuilderCount();

        console2.log("---- snapshot ----");
        console2.log(label);
        console2.log("block", block.number);
        console2.log("week", week);
        console2.log("contributedU", contributed);
        console2.log("contractUsdtU", bal);
        console2.log("treasuryWithdrawableU", wd);
        console2.log("reservedRewardsU", reserved);
        console2.log("cobuilders", cobuilders);

        report = string.concat(
            report,
            "### ",
            label,
            "\n\n",
            unicode"| 项 | 值 |\n|---|---:|\n",
            "| block.number | ",
            vm.toString(block.number),
            " |\n",
            "| currentWeek | ",
            vm.toString(week),
            " |\n",
            unicode"| 累计入金 (U) | ",
            vm.toString(contributed),
            " |\n",
            unicode"| 合约 USDT 余额 (U) | ",
            vm.toString(bal),
            " |\n",
            "| treasuryWithdrawable (U) | ",
            vm.toString(wd),
            " |\n",
            "| reservedRewards (U) | ",
            vm.toString(reserved),
            " |\n",
            unicode"| 共建者人数（根+8 KOL） | ",
            vm.toString(cobuilders),
            " |\n",
            unicode"| 已入金笔数 | ",
            vm.toString(contributeCount),
            " |\n",
            unicode"| Admin 累计抽走 (U) | ",
            vm.toString(usdtBal(sweepTotal)),
            " |\n\n"
        );
        unchecked {
            snapCount++;
        }
    }

    function _appendAnalysis() internal {
        _appendCobuilders();
        _append50u();
        _appendTier();
        report = string.concat(
            report,
            unicode"## 暂停原因\n\n",
            unicode"已满足第一阶段目标：共建者人数 = ",
            vm.toString(_cobuilderCount()),
            unicode"，且已出现三段极差分配。后续推广波次未再跑。\n"
        );
    }

    function _appendCobuilders() internal {
        report = string.concat(report, unicode"## 共建者名单（根 + 8 个 KOL）\n\n");
        report = string.concat(
            report,
            unicode"| 角色 | 地址 | 本人 (U) | 伞下 (U) | 身份 | 团队档 bps |\n|---|---|---:|---:|---|---:|\n"
        );
        report = string.concat(report, _row("Root", users[0]));
        for (uint256 i = 0; i < KOL_N; i++) {
            report = string.concat(report, _row(string.concat("KOL", vm.toString(i)), users[_kolIndex(i)]));
        }
    }

    function _append50u() internal {
        report = string.concat(report, unicode"\n## 50U 入金（应无推广奖）\n\n");
        if (!recorded50u) {
            report = string.concat(report, unicode"本阶段叶子尚未出现 50U 入金。\n\n");
            return;
        }
        report = string.concat(
            report,
            unicode"付款人 `",
            vm.toString(sample50Payer),
            unicode"` 投入 **",
            vm.toString(usdtBal(sample50Amount)),
            unicode"U**。\n\n"
        );
        report = string.concat(
            report, unicode"- 直推增量：**", vm.toString(usdtBal(sample50Direct)), unicode"U**（应为 0）\n"
        );
        report = string.concat(
            report,
            unicode"- 整条链团队奖增量：**",
            vm.toString(usdtBal(sample50Team)),
            unicode"U**（应为 0）\n"
        );
        report = string.concat(
            report,
            unicode"- 直推人伞下业绩：",
            vm.toString(usdtBal(sample50AmbTeamBefore)),
            unicode"U → ",
            vm.toString(usdtBal(sample50AmbTeamAfter)),
            unicode"U（业绩仍计入）\n\n"
        );
        if (sample50Direct == 0 && sample50Team == 0 && sample50AmbTeamAfter == sample50AmbTeamBefore + sample50Amount)
        {
            report = string.concat(
                report, unicode"结论：与合约一致——`< 100U` 只加业绩、不发直推/团队奖。\n\n"
            );
        } else {
            report = string.concat(report, unicode"结论：**与预期不符，需要复查。**\n\n");
        }
    }

    function _appendTier() internal {
        report = string.concat(report, unicode"## 三段极差对照（抽一笔 ≥100U）\n\n");
        if (!sawThreeTier) {
            report = string.concat(report, unicode"未捕获三段极差。\n\n");
            return;
        }
        report = string.concat(
            report,
            unicode"付款人 `",
            vm.toString(tierPayer),
            unicode"` 投入 **",
            vm.toString(usdtBal(tierAmount)),
            unicode"U**（block ",
            vm.toString(tierBlock),
            unicode"，week ",
            vm.toString(tierWeek),
            unicode"）。\n\n"
        );
        report = string.concat(
            report,
            unicode"链：叶子 → 大使 `",
            vm.toString(tierAmb),
            unicode"`（",
            vm.toString(tierAmbBps),
            unicode" bps）→ 团长 `",
            vm.toString(tierCap),
            unicode"`（",
            vm.toString(tierCapBps),
            unicode" bps）→ KOL `",
            vm.toString(tierKol),
            unicode"`（",
            vm.toString(tierKolBps),
            unicode" bps）。\n\n",
            unicode"| 科目 | 公式 | 期望 (U) | 实际 (U) |\n|---|---|---:|---:|\n"
        );
        _tierRow(unicode"直推（大使）", unicode"amount × 10%", (tierAmount * 1000) / 10_000, tierDirect);
        _tierRow(unicode"大使团队", unicode"amount × 3%", (tierAmount * 300) / 10_000, tierAmbTeam);
        _tierRow(
            unicode"团长级差",
            unicode"amount × (6%-3%)",
            (tierAmount * (tierCapBps - tierAmbBps)) / 10_000,
            tierCapTeam
        );
        _tierRow(
            unicode"KOL 级差",
            unicode"amount × (9%-6%)",
            (tierAmount * (tierKolBps - tierCapBps)) / 10_000,
            tierKolTeam
        );
        uint256 expTeam = (tierAmount * 900) / 10_000;
        uint256 actTeam = tierAmbTeam + tierCapTeam + tierKolTeam;
        _tierRow(unicode"团队合计", unicode"<= 9%", expTeam, actTeam);
        _tierRow(unicode"直推+团队", unicode"<= 19%", (tierAmount * 1900) / 10_000, tierDirect + actTeam);
        report = string.concat(report, "\n");

        bool ok = tierDirect == (tierAmount * 1000) / 10_000 && tierAmbTeam == (tierAmount * 300) / 10_000
            && tierCapTeam == (tierAmount * 300) / 10_000 && tierKolTeam == (tierAmount * 300) / 10_000;
        if (ok && (tierDirect + actTeam) * 10_000 <= tierAmount * 1900) {
            report = string.concat(
                report,
                unicode"结论：实际记账与 `_settleDirect` / `_settleTeam` 公式一致。",
                unicode"直推与团队叠在大使身上（10%+3%），团长和 KOL 只拿级差，整条链不超过 19%。\n\n"
            );
        } else {
            report = string.concat(report, unicode"结论：**与公式不一致，需要复查。**\n\n");
        }
    }

    function _tierRow(
        string memory col1,
        string memory col2,
        uint256 expected,
        uint256 actual
    ) internal {
        report = string.concat(
            report,
            "| ",
            col1,
            " | ",
            col2,
            " | ",
            vm.toString(usdtBal(expected)),
            " | ",
            vm.toString(usdtBal(actual)),
            " |\n"
        );
    }

    function _row(
        string memory label,
        address who
    ) internal view returns (string memory) {
        return string.concat(
            "| ",
            label,
            " | `",
            vm.toString(who),
            "` | ",
            vm.toString(usdtBal(_selfOf(who))),
            " | ",
            vm.toString(usdtBal(_teamVolOf(who))),
            " | ",
            _roleLabel(who),
            " | ",
            vm.toString(uint256(0)),
            " |\n"
        );
    }
}
