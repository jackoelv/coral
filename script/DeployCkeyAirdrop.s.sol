// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "../lib/forge-std/src/Script.sol";
import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {CkeyAirdrop} from "../src/CkeyAirdrop.sol";

/// @notice Deploy the claim airdrop only.
///         Does not call CoralToken.setMinter, setTransferAllowlist, mint, or fund.
///         After deployment the CKEY owner allowlists this contract, mints CKEY to itself,
///         approves this contract, and calls `fund`.
///         Mainnet broadcast still requires ALLOW_MAINNET=true. This script does not set that.
contract DeployCkeyAirdrop is Script {
    address internal constant MAINNET_CKEY = 0xf03B6888db7653F314a0105C5c4Ca847A097f60a;

    function run() external {
        address ckey = vm.envAddress("CKEY_ADDRESS");
        address owner = vm.envAddress("OWNER");
        address proposer = vm.envAddress("AIRDROP_PROPOSER");
        address reviewer = vm.envAddress("AIRDROP_REVIEWER");
        uint256 pk = vm.envUint("DEPLOY_PRIVATE_KEY");

        if (block.chainid == 56) {
            require(vm.envOr("ALLOW_MAINNET", false), "refusing mainnet broadcast without ALLOW_MAINNET=true");
            require(ckey == MAINNET_CKEY, "CKEY_ADDRESS is not mainnet CKEY");
        }
        require(ckey.code.length > 0, "CKEY_ADDRESS has no code");
        require(Ownable(ckey).owner() == owner, "OWNER must be the current CKEY owner");

        vm.startBroadcast(pk);
        CkeyAirdrop drop = new CkeyAirdrop(ckey, owner, proposer, reviewer);
        vm.stopBroadcast();

        require(address(drop.ckey()) == ckey && drop.owner() == owner, "deployed parameters differ");
        require(drop.isProposer(proposer) && drop.isReviewer(reviewer), "roles not set");

        console2.log("CkeyAirdrop", address(drop));
        console2.log("CKEY", ckey);
        console2.log("owner", owner);
        console2.log("proposer", proposer);
        console2.log("reviewer", reviewer);
    }
}
