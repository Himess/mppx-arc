// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcStreamChannel} from "../src/ArcStreamChannel.sol";

contract Deploy is Script {
    // Arc Testnet USDC
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ArcStreamChannel channel = new ArcStreamChannel(ARC_USDC);
        console2.log("ArcStreamChannel deployed at:", address(channel));
        console2.log("USDC address:", ARC_USDC);
        console2.log("Domain separator:", vm.toString(channel.domainSeparator()));

        vm.stopBroadcast();
    }
}
