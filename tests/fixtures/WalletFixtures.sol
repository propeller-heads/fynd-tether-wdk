// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 PropellerHeads AG
pragma solidity 0.8.33;

/// Test-only token: permissionless minting, optional USDT-like approval reset.
contract FixtureToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool private requireReset;

    function setRequireReset(bool enabled) external { requireReset = enabled; }
    function mint(address recipient, uint256 value) external { balanceOf[recipient] += value; }

    function approve(address spender, uint256 value) external returns (bool) {
        require(!requireReset || value == 0 || allowance[msg.sender][spender] == 0, "reset required");
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transferFrom(address owner, address recipient, uint256 value) external returns (bool) {
        require(allowance[owner][msg.sender] >= value, "insufficient allowance");
        require(balanceOf[owner] >= value, "insufficient balance");
        allowance[owner][msg.sender] -= value;
        balanceOf[owner] -= value;
        balanceOf[recipient] += value;
        return true;
    }
}

/// Test-only settlement harness with the supported outer ABI, not Tycho's router.
/// Its route bytes contain one uint256 output amount; it does not execute DEX routes.
/// Client-fee checks mirror TychoRouterV3._verifyClientSignature for EOA receivers.
contract FixtureRouter {
    address constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant CLIENT_FEE_TYPEHASH = keccak256(
        "ClientFee(uint32 clientFeeBps,address clientFeeReceiver,"
        "uint256 maxClientContribution,uint256 deadline,"
        "uint256 amountIn,address tokenIn,address tokenOut,"
        "uint256 expectedAmountOut,uint256 minAmountOut,address receiver,bytes swaps)"
    );

    struct ClientFeeParams {
        uint32 clientFeeBps;
        address clientFeeReceiver;
        uint256 maxClientContribution;
        uint256 deadline;
        bytes clientSignature;
    }

    function singleSwap(
        uint256 amountIn, address tokenIn, address tokenOut,
        uint256 expectedAmountOut, uint256 minAmountOut, address receiver,
        ClientFeeParams calldata fee, bytes calldata route
    ) external payable returns (uint256 amountOut) {
        verifyClientFee(fee, amountIn, tokenIn, tokenOut, expectedAmountOut, minAmountOut, receiver, route);
        amountOut = abi.decode(route, (uint256));
        require(amountIn > 0 && expectedAmountOut > 0 && minAmountOut > 0, "zero amount");
        require(amountOut >= minAmountOut, "minimum output");
        if (tokenIn == NATIVE) require(msg.value == amountIn, "native value");
        else {
            require(msg.value == 0, "unexpected value");
            require(FixtureToken(tokenIn).transferFrom(msg.sender, address(this), amountIn));
        }
        if (tokenOut == NATIVE) {
            (bool sent,) = receiver.call{value: amountOut}("");
            require(sent, "native output");
        } else FixtureToken(tokenOut).mint(receiver, amountOut);
    }

    function verifyClientFee(
        ClientFeeParams calldata fee, uint256 amountIn, address tokenIn, address tokenOut,
        uint256 expectedAmountOut, uint256 minAmountOut, address receiver, bytes calldata route
    ) private view {
        if (fee.clientFeeReceiver == address(0)) {
            require(fee.clientFeeBps == 0 && fee.maxClientContribution == 0, "zero receiver fee");
            return;
        }
        require(block.timestamp <= fee.deadline, "expired client signature");
        bytes32 domain = keccak256(abi.encode(
            DOMAIN_TYPEHASH, keccak256("TychoRouter"), keccak256("1"), block.chainid, address(this)
        ));
        bytes32 structHash = keccak256(abi.encode(
            CLIENT_FEE_TYPEHASH, fee.clientFeeBps, fee.clientFeeReceiver, fee.maxClientContribution,
            fee.deadline, amountIn, tokenIn, tokenOut, expectedAmountOut, minAmountOut, receiver,
            keccak256(route)
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        require(fee.clientSignature.length == 65, "signature length");
        bytes32 r = bytes32(fee.clientSignature[0:32]);
        bytes32 s = bytes32(fee.clientSignature[32:64]);
        uint8 v = uint8(fee.clientSignature[64]);
        require(ecrecover(digest, v, r, s) == fee.clientFeeReceiver, "invalid client signature");
    }
}
