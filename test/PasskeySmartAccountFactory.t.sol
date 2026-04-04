// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PasskeySmartAccountFactory} from "../src/PasskeySmartAccountFactory.sol";
import {PasskeySmartAccount} from "../src/PasskeySmartAccount.sol";

contract PasskeySmartAccountFactoryTest is Test {
    PasskeySmartAccountFactory internal factory;

    function setUp() public {
        factory = new PasskeySmartAccountFactory();
    }

    function test_predict_matches_create2() public {
        bytes32 x = bytes32(uint256(1));
        bytes32 y = bytes32(uint256(2));
        bytes32 salt = keccak256("salt");
        address predicted = factory.predictAddress(x, y, salt);
        address deployed = factory.createAccount(x, y, salt);
        assertEq(predicted, deployed);
        PasskeySmartAccount acc = PasskeySmartAccount(payable(deployed));
        assertEq(acc.publicKeyX(), x);
        assertEq(acc.publicKeyY(), y);
    }
}
