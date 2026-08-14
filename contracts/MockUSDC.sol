// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  MockUSDC (Rootstock testnet)
/// @notice A minimal ERC-20 that stands in for USDC on Rootstock testnet, because Rootstock
///         has no canonical USDC (mainnet or testnet). Anyone can `mint` any amount to any
///         address — DO NOT ship to mainnet. Purpose: unblock the x402-on-Rootstock PoC so
///         we can demo pay-per-call agent settlement without waiting on DOC/USDRIF liquidity.
/// @dev    Six decimals (matching real USDC). No allowance-race mitigation, no permit — this
///         is a testnet stub, not a production token.
contract MockUSDC {
    string public constant name = "USD Coin (Predge testnet mock)";
    string public constant symbol = "USDC";
    uint8  public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed to, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Mint(to, amount);
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        unchecked { balanceOf[msg.sender] -= amount; }
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a < amount) revert InsufficientAllowance();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        if (a != type(uint256).max) { unchecked { allowance[from][msg.sender] = a - amount; } }
        unchecked { balanceOf[from] -= amount; }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
