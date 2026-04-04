// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WebAuthn} from "./libraries/WebAuthn.sol";

/// @title PasskeySmartAccount
/// @notice Minimal smart account controlled by a secp256r1 (P-256 / WebAuthn) public key. Each successful
///         `execute` consumes an incrementing nonce and binds the signature to `chainid`, target call, and value.
contract PasskeySmartAccount {
    bytes32 public immutable publicKeyX;
    bytes32 public immutable publicKeyY;

    uint256 public nonce;

    error PasskeySmartAccount_InvalidSignature();
    error PasskeySmartAccount_CallFailed();

    constructor(bytes32 pubKeyX, bytes32 pubKeyY) {
        publicKeyX = pubKeyX;
        publicKeyY = pubKeyY;
    }

    receive() external payable {}

    /// @notice Builds the opaque `challenge` bytes that must be passed to WebAuthn (as `options.publicKey.challenge`).
    function digest(address to, uint256 value, bytes calldata data) public view returns (bytes memory) {
        return abi.encodePacked(nonce, block.chainid, to, value, keccak256(data));
    }

    /// @dev Verifies a WebAuthn assertion for the current `digest(to, value, data)` and performs the call.
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        bool requireUserVerification,
        WebAuthn.WebAuthnAuth calldata auth
    ) external payable {
        bytes memory challenge = digest(to, value, data);
        if (
            !WebAuthn.verify(
                challenge,
                requireUserVerification,
                _toMem(auth),
                uint256(publicKeyX),
                uint256(publicKeyY)
            )
        ) {
            revert PasskeySmartAccount_InvalidSignature();
        }
        unchecked {
            nonce++;
        }
        (bool ok,) = to.call{value: value}(data);
        if (!ok) revert PasskeySmartAccount_CallFailed();
    }

    function _toMem(WebAuthn.WebAuthnAuth calldata a) private pure returns (WebAuthn.WebAuthnAuth memory m) {
        m = WebAuthn.WebAuthnAuth({
            authenticatorData: a.authenticatorData,
            clientDataJSON: a.clientDataJSON,
            challengeIndex: a.challengeIndex,
            typeIndex: a.typeIndex,
            r: a.r,
            s: a.s
        });
    }
}
