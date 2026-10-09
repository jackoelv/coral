// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "../lib/forge-std/src/Script.sol";
import {MockUSDT} from "../src/MockUSDT.sol";
import {CoralToken} from "../src/CoralToken.sol";
import {FreeDaoNFT} from "../src/FreeDaoNFT.sol";
import {CoralIdo} from "../src/CoralIdo.sol";
import {CoralRewards} from "../src/CoralRewards.sol";
import {FreeDaoNFTInterest} from "../src/FreeDaoNFTInterest.sol";
import {CoralNetworks} from "../src/network/CoralNetworks.sol";

/// @notice Deploy vault + rewards for local, bscTestnet, or bscMainnet.
///         Mainnet broadcast requires ALLOW_MAINNET=true. This task does not set that.
contract Deploy is Script {
    function run() external virtual {
        _deploy(vm.envOr("NETWORK", string("local")));
    }

    function _deploy(
        string memory network
    ) internal {
        bytes32 kind = keccak256(bytes(network));
        bool mainnet = kind == keccak256("bscMainnet");
        if (mainnet && !vm.envOr("ALLOW_MAINNET", false)) {
            revert("refusing mainnet broadcast without ALLOW_MAINNET=true");
        }

        CoralNetworks.Params memory params;
        if (kind == keccak256("local")) params = CoralNetworks.local();
        else if (kind == keccak256("bscTestnet")) params = CoralNetworks.bscTestnet();
        else if (mainnet) params = CoralNetworks.bscMainnet();
        else revert("NETWORK must be local, bscTestnet, or bscMainnet");

        require(block.chainid == params.chainId, "RPC chain does not match NETWORK");

        uint256 pk;
        if (kind == keccak256("local")) {
            pk = vm.envOr("LOCAL_PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        } else if (kind == keccak256("bscTestnet")) {
            pk = vm.envUint("TEST_PRIVATE_KEY");
        } else {
            pk = vm.envUint("MAINNET_PRIVATE_KEY");
        }
        address deployer = vm.addr(pk);
        address owner = vm.envOr("OWNER", deployer);

        vm.startBroadcast(pk);
        address usdtAddr = params.usdt;
        if (usdtAddr == address(0)) {
            MockUSDT usdt = new MockUSDT();
            usdtAddr = address(usdt);
            if (kind == keccak256("local")) {
                address[4] memory users = [
                    0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
                    0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
                    0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,
                    0x90F79bf6EB2c4f870365E785982E1f101E93b906
                ];
                for (uint256 i = 0; i < users.length; i++) {
                    usdt.mint(users[i], 1_000_000e18);
                }
            }
        }

        CoralToken nemo = new CoralToken(deployer);
        FreeDaoNFT nft = new FreeDaoNFT(deployer, "FreeDaoRWA", "FREEDAONFT");
        string memory nftImage = vm.envOr("NFT_IMAGE_URI", string(""));
        if (bytes(nftImage).length != 0) nft.setImageURI(nftImage);
        CoralIdo ido = new CoralIdo(usdtAddr, address(nemo), address(nft), owner, params);
        nemo.setMinter(address(ido));
        nft.setMinter(address(ido));
        CoralRewards rewards = new CoralRewards(address(ido), owner, params);
        FreeDaoNFTInterest interest = new FreeDaoNFTInterest(address(ido), owner);
        nemo.setInterestMinter(address(interest));
        if (owner == deployer) {
            ido.setRewards(address(rewards));
            ido.setNftInterest(address(interest));
        }
        if (owner != deployer) {
            nemo.transferOwnership(owner);
            nft.transferOwnership(owner);
        }
        vm.stopBroadcast();

        console2.log("network", network);
        console2.log("USDT", usdtAddr);
        console2.log("CKEY", address(nemo));
        console2.log("FreeDaoNFT", address(nft));
        console2.log("FreeDaoNFT image", nft.imageURI());
        console2.log("CoralIdo", address(ido));
        console2.log("CoralRewards", address(rewards));
        console2.log("FreeDaoNFTInterest", address(interest));
        console2.log("owner", owner);
    }
}
