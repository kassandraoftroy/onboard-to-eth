// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PasskeySmartAccount} from "./PasskeySmartAccount.sol";

/// @title PasskeySmartAccountFactory
/// @notice CREATE2 deployment so the same pubkey and salt yield the same account address on every chain where
///         this factory is deployed at the same address with the same bytecode.
contract PasskeySmartAccountFactory {
    error PasskeySmartAccountFactory_DeployFailed();

    event AccountCreated(address indexed account, bytes32 indexed pubKeyX, bytes32 indexed pubKeyY, bytes32 salt);

    function accountBytecode(bytes32 pubKeyX, bytes32 pubKeyY) public pure returns (bytes memory) {
        return abi.encodePacked(type(PasskeySmartAccount).creationCode, abi.encode(pubKeyX, pubKeyY));
    }

    function accountInitCodeHash(bytes32 pubKeyX, bytes32 pubKeyY) public pure returns (bytes32) {
        return keccak256(accountBytecode(pubKeyX, pubKeyY));
    }

    function predictAddress(bytes32 pubKeyX, bytes32 pubKeyY, bytes32 salt) public view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, accountInitCodeHash(pubKeyX, pubKeyY)));
        return address(uint160(uint256(h)));
    }

    function createAccount(bytes32 pubKeyX, bytes32 pubKeyY, bytes32 salt) external returns (address account) {
        bytes memory bytecode = accountBytecode(pubKeyX, pubKeyY);
        assembly ("memory-safe") {
            account := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        if (account == address(0)) revert PasskeySmartAccountFactory_DeployFailed();
        emit AccountCreated(account, pubKeyX, pubKeyY, salt);
    }
}
