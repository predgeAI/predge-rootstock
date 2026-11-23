// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAgentJobV2} from "./interfaces/IAgentJobV2.sol";

/// @dev The three ERC-20 calls this contract makes. Return values are NOT trusted through this
///      interface: every transfer goes through `_safeTransfer` / `_safeTransferFrom` below.
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title  AgentJobERC20
/// @notice The ERC-20 twin of `AgentJobV2`: the same job lifecycle, the same evaluator surface and the
///         same `getJob` layout, but the escrow is one ERC-20 token (on Rootstock: USDRIF) instead of the
///         native coin. It exists next to the native contract; it does not replace or modify it.
///
///         Because it implements `IAgentJobV2` with identical semantics, any evaluator written for
///         `AgentJobV2` drives it unchanged. In particular `PredgeNoObjectionEvaluator` (objection window,
///         `releaseOnSilence`, reviewer `resolve`) is deployed against this contract byte-for-byte as is.
///
///         Lifecycle (identical to AgentJobV2, amounts in token units):
///           createJob  (client approves this contract, then calls createJob(..., amount); the contract
///                       pulls exactly `amount` with transferFrom)
///           submit     (provider, strictly before `expiredAt`)
///           complete / reject (evaluator, strictly before `submittedAt + evaluationWindow`)
///           claimRefund (anyone may trigger; the CLIENT is credited) when the job is still Open at or
///                       after `expiredAt`, or Submitted and the evaluator stayed silent for the whole window.
///           withdraw / withdrawTo (pull: every payout is a credit the recipient withdraws in tokens)
///
/// @dev    Token handling:
///           - one token per deployment, immutable, must be a contract at deploy time;
///           - transfers accept tokens that return `true` or return nothing, and revert on `false`
///             or on a revert (SafeERC20 semantics, implemented inline, no dependency);
///           - `createJob` measures the balance delta and reverts unless exactly `amount` arrived, so a
///             fee-on-transfer or rebasing-down token cannot create an under-funded job;
///           - no function is payable and there is no receive/fallback: native value is rejected.
///         Reentrancy: one lock over every state-changing entry point, plus checks-effects-interactions
///         (credits are zeroed and events emitted before the outgoing token call).
///         No owner, no admin, no upgrade path, no mutable parameter.
contract AgentJobERC20 is IAgentJobV2 {
    /// @notice The escrow token (USDRIF on Rootstock).
    IERC20Minimal public immutable token;
    /// @notice Seconds the evaluator has to decide after a submission. Immutable.
    uint64 public immutable evaluationWindow;

    uint256 public jobCount;
    /// @notice Sum of every job's escrow that has not been credited yet (Open or Submitted).
    uint256 public totalEscrowed;
    /// @notice Withdrawable token balance per account.
    mapping(address => uint256) public credit;
    /// @notice Sum of all credits not yet withdrawn.
    uint256 public totalCredit;

    mapping(uint256 => Job) private _jobs;
    uint256 private _lock = 1;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed evaluator,
        address provider,
        uint256 escrow,
        uint64 expiredAt,
        bytes32 specHash
    );
    event Submitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable, bool hashedOnChain);
    event Completed(uint256 indexed jobId, address indexed evaluator, address indexed recipient, uint256 amount, bytes32 reason);
    event Rejected(uint256 indexed jobId, address indexed evaluator, address indexed recipient, uint256 amount, bytes32 reason);
    event Refunded(uint256 indexed jobId, address indexed caller, address indexed recipient, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    error ZeroAddress();
    error NotAContract();
    error ZeroEscrow();
    error BadExpiry();
    error BadWindow();
    error NotProvider();
    error NotEvaluator();
    error BadState();
    error PastDeadline();
    error NotExpired();
    error HashMismatch();
    error ZeroDeliverable();
    error EvaluatorNotIndependent();
    error NothingToWithdraw();
    error ZeroRecipient();
    error TransferFailed();
    error UnexpectedAmountReceived(uint256 expected, uint256 received);
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param token_            the escrow token; must already be a deployed contract
    /// @param evaluationWindow_ seconds the evaluator has after a submission; must be non-zero
    constructor(address token_, uint64 evaluationWindow_) {
        if (token_ == address(0)) revert ZeroAddress();
        if (token_.code.length == 0) revert NotAContract();
        if (evaluationWindow_ == 0) revert BadWindow();
        token = IERC20Minimal(token_);
        evaluationWindow = evaluationWindow_;
    }

    /// @notice Client opens a job and escrows `amount` tokens. The client must first `approve` this
    ///         contract for at least `amount`. Same arguments as AgentJobV2 plus `amount`.
    function createJob(address provider, address evaluator, bytes32 specHash, uint64 expiredAt, uint256 amount)
        external
        nonReentrant
        returns (uint256 jobId)
    {
        if (provider == address(0) || evaluator == address(0)) revert ZeroAddress();
        if (evaluator == msg.sender || evaluator == provider) revert EvaluatorNotIndependent();
        if (amount == 0) revert ZeroEscrow();
        if (expiredAt <= block.timestamp) revert BadExpiry();

        jobId = ++jobCount;
        totalEscrowed += amount;
        Job storage j = _jobs[jobId];
        j.client = msg.sender;
        j.provider = provider;
        j.evaluator = evaluator;
        j.escrow = amount;
        j.expiredAt = expiredAt;
        j.state = State.Open;
        j.specHash = specHash;

        // Interaction last; the whole call reverts if the exact amount does not arrive.
        uint256 before = token.balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert UnexpectedAmountReceived(amount, received);

        emit JobCreated(jobId, msg.sender, evaluator, provider, amount, expiredAt, specHash);
    }

    /// @notice Provider submits the deliverable, strictly before `expiredAt`. Identical to AgentJobV2.
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata output) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.state != State.Open) revert BadState();
        if (msg.sender != j.provider) revert NotProvider();
        if (block.timestamp >= j.expiredAt) revert PastDeadline();
        if (deliverable == bytes32(0)) revert ZeroDeliverable();
        bool onChain = output.length != 0;
        if (onChain && sha256(output) != deliverable) revert HashMismatch();
        j.deliverable = deliverable;
        j.hashedOnChain = onChain;
        j.submittedAt = uint64(block.timestamp);
        j.state = State.Submitted;
        emit Submitted(jobId, msg.sender, deliverable, onChain);
    }

    /// @notice ERC-8183 `complete`. Evaluator only, inside the evaluation window. Credits the provider.
    function complete(uint256 jobId, bytes32 reason, bytes calldata) external nonReentrant {
        Job storage j = _decide(jobId, reason);
        j.state = State.Completed;
        uint256 amt = _release(j, j.provider);
        emit Completed(jobId, msg.sender, j.provider, amt, reason);
    }

    /// @notice ERC-8183 `reject`. Evaluator only, same timing as `complete`. Credits the client.
    function reject(uint256 jobId, bytes32 reason, bytes calldata) external nonReentrant {
        Job storage j = _decide(jobId, reason);
        j.state = State.Rejected;
        uint256 amt = _release(j, j.client);
        emit Rejected(jobId, msg.sender, j.client, amt, reason);
    }

    /// @notice Refund the client of a job that ran out of time. Callable by anyone.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        State s = j.state;
        if (s == State.Open) {
            if (block.timestamp < j.expiredAt) revert NotExpired();
        } else if (s == State.Submitted) {
            if (block.timestamp < uint256(j.submittedAt) + evaluationWindow) revert NotExpired();
        } else {
            revert BadState();
        }
        j.state = State.Expired;
        uint256 amt = _release(j, j.client);
        emit Refunded(jobId, msg.sender, j.client, amt);
    }

    /// @notice Withdraw the caller's whole credit (in tokens) to the caller.
    function withdraw() external nonReentrant {
        _withdraw(msg.sender);
    }

    /// @notice Withdraw the caller's whole credit to `to` (e.g. if the caller is blocklisted by the token).
    function withdrawTo(address to) external nonReentrant {
        if (to == address(0)) revert ZeroRecipient();
        _withdraw(to);
    }

    /// @inheritdoc IAgentJobV2
    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    // ---------------------------------------------------------------- internals

    function _decide(uint256 jobId, bytes32 reason) private returns (Job storage j) {
        j = _jobs[jobId];
        if (msg.sender != j.evaluator) revert NotEvaluator();
        if (j.state != State.Submitted) revert BadState();
        if (block.timestamp >= uint256(j.submittedAt) + evaluationWindow) revert PastDeadline();
        j.reason = reason;
    }

    function _release(Job storage j, address to) private returns (uint256 amt) {
        amt = j.escrow;
        j.escrow = 0;
        totalEscrowed -= amt;
        credit[to] += amt;
        totalCredit += amt;
    }

    function _withdraw(address to) private {
        uint256 amt = credit[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        credit[msg.sender] = 0;
        totalCredit -= amt;
        emit Withdrawn(msg.sender, to, amt);
        _safeTransfer(to, amt);
    }

    function _safeTransfer(address to, uint256 amount) private {
        _callToken(abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        _callToken(abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
    }

    /// @dev SafeERC20 semantics: success iff the call did not revert AND (it returned nothing OR it
    ///      returned an ABI-encoded `true`). `token` is checked to be a contract in the constructor.
    function _callToken(bytes memory data) private {
        (bool ok, bytes memory ret) = address(token).call(data);
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) != 1)) revert TransferFailed();
    }
}
