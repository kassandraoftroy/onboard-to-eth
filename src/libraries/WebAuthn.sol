// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Adapted from https://github.com/base-org/webauthn-sol (MIT). P256 verification uses OpenZeppelin's
/// {P256} library (RIP-7212 precompile when available, Solidity fallback otherwise).

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {LibString} from "solady/utils/LibString.sol";

library WebAuthn {
    using LibString for string;

    struct WebAuthnAuth {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 challengeIndex;
        uint256 typeIndex;
        uint256 r;
        uint256 s;
    }

    bytes1 private constant _AUTH_DATA_FLAGS_UP = 0x01;
    bytes1 private constant _AUTH_DATA_FLAGS_UV = 0x04;
    uint256 private constant _P256_N_DIV_2 =
        0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8;
    bytes32 private constant _EXPECTED_TYPE_HASH = keccak256('"type":"webauthn.get"');

    function verify(
        bytes memory challenge,
        bool requireUV,
        WebAuthnAuth memory webAuthnAuth,
        uint256 x,
        uint256 y
    ) internal view returns (bool) {
        if (webAuthnAuth.s > _P256_N_DIV_2) {
            return false;
        }

        string memory t = webAuthnAuth.clientDataJSON.slice(webAuthnAuth.typeIndex, webAuthnAuth.typeIndex + 21);
        if (keccak256(bytes(t)) != _EXPECTED_TYPE_HASH) {
            return false;
        }

        bytes memory expectedChallenge = bytes(string.concat('"challenge":"', Base64.encodeURL(challenge), '"'));
        string memory actualChallenge = webAuthnAuth.clientDataJSON.slice(
            webAuthnAuth.challengeIndex,
            webAuthnAuth.challengeIndex + expectedChallenge.length
        );
        if (keccak256(bytes(actualChallenge)) != keccak256(expectedChallenge)) {
            return false;
        }

        if (webAuthnAuth.authenticatorData.length < 37) {
            return false;
        }
        if (webAuthnAuth.authenticatorData[32] & _AUTH_DATA_FLAGS_UP != _AUTH_DATA_FLAGS_UP) {
            return false;
        }
        if (requireUV && (webAuthnAuth.authenticatorData[32] & _AUTH_DATA_FLAGS_UV) != _AUTH_DATA_FLAGS_UV) {
            return false;
        }

        bytes32 clientDataJSONHash = sha256(bytes(webAuthnAuth.clientDataJSON));
        bytes32 messageHash = sha256(abi.encodePacked(webAuthnAuth.authenticatorData, clientDataJSONHash));

        return P256.verify(messageHash, bytes32(webAuthnAuth.r), bytes32(webAuthnAuth.s), bytes32(x), bytes32(y));
    }
}
