// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "../lib/forge-std/src/Script.sol";
import {CoralIdo} from "../src/CoralIdo.sol";

/// @notice Freeze import, open sale, register the broadcaster as ROOTANVL.
contract SeedLocal is Script {
    function run() external {
        uint256 pk =
            vm.envOr("LOCAL_PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address idoAddr = vm.envAddress("IDO_ADDRESS");
        CoralIdo ido = CoralIdo(idoAddr);

        vm.startBroadcast(pk);
        if (!ido.importFrozen()) {
            ido.freezeImport();
        }
        if (!ido.saleOpen()) {
            ido.openSale();
        }
        if (!ido.getAccount(vm.addr(pk)).registered) {
            bytes32 root;
            bytes memory raw = bytes("ROOTANVL");
            assembly {
                root := mload(add(raw, 32))
            }
            ido.register(root, bytes32(0));
        }
        vm.stopBroadcast();

        console2.log("seeded ROOTANVL on", idoAddr);
    }
}
