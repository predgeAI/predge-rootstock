// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only tokens covering the ERC-20 behaviours AgentJobERC20 must handle or refuse.

/// @dev Standard ERC-20, 18 decimals (like USDRIF), returns true.
contract StdToken {
    string public name = "Test USD";
    string public symbol = "TUSD";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function approve(address s, uint256 amt) external returns (bool) {
        allowance[msg.sender][s] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) public virtual returns (bool) {
        _move(msg.sender, to, amt);
        return true;
    }

    function transferFrom(address f, address to, uint256 amt) public virtual returns (bool) {
        _spend(f, amt);
        _move(f, to, amt);
        return true;
    }

    function _spend(address f, uint256 amt) internal {
        uint256 a = allowance[f][msg.sender];
        require(a >= amt, "allowance");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - amt;
    }

    function _move(address f, address to, uint256 amt) internal virtual {
        require(balanceOf[f] >= amt, "balance");
        balanceOf[f] -= amt;
        balanceOf[to] += amt;
    }
}

/// @dev Returns false instead of reverting when it fails (and, with `alwaysFalse`, even when it "succeeds").
contract ReturnsFalseToken is StdToken {
    bool public alwaysFalse;
    bool public transferFalse;

    function setAlwaysFalse(bool v) external {
        alwaysFalse = v;
    }

    function setTransferFalse(bool v) external {
        transferFalse = v;
    }

    function transfer(address to, uint256 amt) public override returns (bool) {
        if (transferFalse || balanceOf[msg.sender] < amt) return false;
        _move(msg.sender, to, amt);
        return true;
    }

    function transferFrom(address f, address to, uint256 amt) public override returns (bool) {
        if (alwaysFalse) return false; // moves nothing, says false
        if (allowance[f][msg.sender] < amt || balanceOf[f] < amt) return false;
        _spend(f, amt);
        _move(f, to, amt);
        return true;
    }
}

/// @dev USDT-style: transfer/transferFrom return nothing.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address s, uint256 amt) external {
        allowance[msg.sender][s] = amt;
    }

    function transfer(address to, uint256 amt) external {
        require(balanceOf[msg.sender] >= amt);
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
    }

    function transferFrom(address f, address to, uint256 amt) external {
        require(allowance[f][msg.sender] >= amt && balanceOf[f] >= amt);
        allowance[f][msg.sender] -= amt;
        balanceOf[f] -= amt;
        balanceOf[to] += amt;
    }
}

/// @dev Takes a 1% fee on every transfer (the recipient gets 99%).
contract FeeOnTransferToken is StdToken {
    function _move(address f, address to, uint256 amt) internal override {
        require(balanceOf[f] >= amt, "balance");
        uint256 fee = amt / 100;
        balanceOf[f] -= amt;
        balanceOf[to] += amt - fee;
        totalSupply -= fee;
    }
}

/// @dev Returns `true` but moves nothing (lying token): caught by the balance-delta check.
contract LyingToken is StdToken {
    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return true;
    }
}

/// @dev Calls back into a target during transfer/transferFrom (ERC-777-style hook) to test the lock.
contract ReentrantToken is StdToken {
    address public target;
    bytes public payload;
    bool public armed;
    bytes public lastRevert;
    bool public reentered;

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
        armed = true;
    }

    function _hook() internal {
        if (!armed) return;
        armed = false;
        (bool ok, bytes memory ret) = target.call(payload);
        // Record the inner revert (expected: Reentrancy) and let the outer transfer proceed.
        reentered = ok;
        lastRevert = ret;
    }

    function transfer(address to, uint256 amt) public override returns (bool) {
        _hook();
        return super.transfer(to, amt);
    }

    function transferFrom(address f, address to, uint256 amt) public override returns (bool) {
        _hook();
        return super.transferFrom(f, to, amt);
    }
}
