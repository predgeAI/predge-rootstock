// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentJobERC20} from "../contracts/v2/AgentJobERC20.sol";
import {IAgentJobV2} from "../contracts/v2/interfaces/IAgentJobV2.sol";
import {PredgeNoObjectionEvaluator as Eval} from "../contracts/rsk-poc/PredgeNoObjectionEvaluator.sol";
import {
    StdToken,
    ReturnsFalseToken,
    NoReturnToken,
    FeeOnTransferToken,
    LyingToken,
    ReentrantToken
} from "./mocks/Tokens.sol";

/// Shared fixture: an ERC-20 escrow + the unchanged no-objection evaluator, same periods as job #1.
abstract contract Base is Test {
    uint64 constant OBJ = 10 days;
    uint64 constant WIN = 24 days;
    uint256 constant AMT = 25e18; // 25 USDRIF (18 decimals)

    AgentJobERC20 job;
    Eval ev;
    address client = makeAddr("client");
    address provider = makeAddr("provider");
    address reviewer = makeAddr("reviewer");
    address stranger = makeAddr("stranger");
    bytes32 checklist = keccak256("ReRISE B2B evidence checklist v1");
    bytes32[] files;
    bytes32 spec;

    function _deploy(address token) internal {
        job = new AgentJobERC20(token, WIN);
        ev = new Eval(address(job), reviewer, OBJ);
        files.push(sha256("before.jpg"));
        files.push(sha256("after.jpg"));
        files.push(sha256("completion-report.pdf"));
        spec = ev.specHashFor(checklist, files.length);
    }

    function _manifest() internal view returns (bytes memory m, bytes32 d) {
        m = abi.encode(checklist, files);
        d = sha256(m);
    }

    function _submit(uint256 id) internal {
        (bytes memory m, bytes32 d) = _manifest();
        vm.prank(provider);
        job.submit(id, d, m);
    }

    function _solvent(address token) internal view {
        assertGe(StdToken(token).balanceOf(address(job)), job.totalEscrowed() + job.totalCredit(), "insolvent");
    }
}

contract AgentJobERC20Test is Base {
    StdToken tok;

    function setUp() public {
        tok = new StdToken();
        _deploy(address(tok));
        tok.mint(client, 1000e18);
    }

    function _open() internal returns (uint256 id) {
        vm.startPrank(client);
        tok.approve(address(job), AMT);
        id = job.createJob(provider, address(ev), spec, uint64(block.timestamp + 30 days), AMT);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ deployment

    function test_constructorChecks() public {
        vm.expectRevert(AgentJobERC20.ZeroAddress.selector);
        new AgentJobERC20(address(0), WIN);
        vm.expectRevert(AgentJobERC20.NotAContract.selector);
        new AgentJobERC20(makeAddr("eoa"), WIN);
        vm.expectRevert(AgentJobERC20.BadWindow.selector);
        new AgentJobERC20(address(tok), 0);
        assertEq(address(job.token()), address(tok));
        assertEq(job.evaluationWindow(), WIN);
        assertEq(ev.evaluationWindow(), WIN); // the unchanged evaluator reads the window from this contract
    }

    // ------------------------------------------------------------ create / fund

    function test_createJobPullsExactAmountViaApproveTransferFrom() public {
        uint256 before = tok.balanceOf(client);
        uint256 id = _open();
        assertEq(id, 1);
        assertEq(tok.balanceOf(address(job)), AMT);
        assertEq(tok.balanceOf(client), before - AMT);
        assertEq(tok.allowance(client, address(job)), 0);
        assertEq(job.totalEscrowed(), AMT);
        IAgentJobV2.Job memory j = job.getJob(id);
        assertEq(j.client, client);
        assertEq(j.provider, provider);
        assertEq(j.evaluator, address(ev));
        assertEq(j.escrow, AMT);
        assertEq(uint8(j.state), uint8(IAgentJobV2.State.Open));
        assertEq(j.specHash, spec);
    }

    function test_createJobWithoutApprovalReverts() public {
        vm.prank(client);
        vm.expectRevert(AgentJobERC20.TransferFailed.selector);
        job.createJob(provider, address(ev), spec, uint64(block.timestamp + 1 days), AMT);
        assertEq(job.jobCount(), 0);
    }

    function test_createJobInsufficientBalanceReverts() public {
        vm.startPrank(stranger);
        tok.approve(address(job), AMT);
        vm.expectRevert(AgentJobERC20.TransferFailed.selector);
        job.createJob(provider, address(ev), spec, uint64(block.timestamp + 1 days), AMT);
        vm.stopPrank();
    }

    function test_zeroAmountReverts() public {
        vm.prank(client);
        vm.expectRevert(AgentJobERC20.ZeroEscrow.selector);
        job.createJob(provider, address(ev), spec, uint64(block.timestamp + 1 days), 0);
    }

    function test_createJobArgumentChecks() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        vm.startPrank(client);
        tok.approve(address(job), AMT);
        vm.expectRevert(AgentJobERC20.ZeroAddress.selector);
        job.createJob(address(0), address(ev), spec, exp, AMT);
        vm.expectRevert(AgentJobERC20.ZeroAddress.selector);
        job.createJob(provider, address(0), spec, exp, AMT);
        vm.expectRevert(AgentJobERC20.EvaluatorNotIndependent.selector);
        job.createJob(provider, client, spec, exp, AMT);
        vm.expectRevert(AgentJobERC20.EvaluatorNotIndependent.selector);
        job.createJob(provider, provider, spec, exp, AMT);
        vm.expectRevert(AgentJobERC20.BadExpiry.selector);
        job.createJob(provider, address(ev), spec, uint64(block.timestamp), AMT);
        vm.stopPrank();
    }

    function test_nativeValueRejected() public {
        vm.deal(client, 1 ether);
        vm.startPrank(client);
        tok.approve(address(job), AMT);
        (bool ok,) = address(job).call{value: 1}(
            abi.encodeCall(job.createJob, (provider, address(ev), spec, uint64(block.timestamp + 1 days), AMT))
        );
        assertFalse(ok, "createJob accepted native value");
        (ok,) = address(job).call{value: 1}("");
        assertFalse(ok, "plain native transfer accepted");
        vm.stopPrank();
        assertEq(address(job).balance, 0);
    }

    // ------------------------------------------------------------ evaluator decisions (direct)

    function test_wrongCallers() public {
        uint256 id = _open();
        (bytes memory m, bytes32 d) = _manifest();
        vm.prank(stranger);
        vm.expectRevert(AgentJobERC20.NotProvider.selector);
        job.submit(id, d, m);
        _submit(id);
        vm.prank(client);
        vm.expectRevert(AgentJobERC20.NotEvaluator.selector);
        job.complete(id, bytes32("x"), "");
        vm.prank(provider);
        vm.expectRevert(AgentJobERC20.NotEvaluator.selector);
        job.reject(id, bytes32("x"), "");
        vm.prank(stranger);
        vm.expectRevert(Eval.NotClient.selector);
        ev.object(id, keccak256("not the client"));
        vm.prank(provider);
        vm.expectRevert(Eval.NotClient.selector);
        ev.object(id, keccak256("not the client"));
    }

    function test_submitChecks() public {
        uint256 id = _open();
        (bytes memory m, bytes32 d) = _manifest();
        vm.startPrank(provider);
        vm.expectRevert(AgentJobERC20.ZeroDeliverable.selector);
        job.submit(id, bytes32(0), "");
        vm.expectRevert(AgentJobERC20.HashMismatch.selector);
        job.submit(id, keccak256("other"), m);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(AgentJobERC20.PastDeadline.selector);
        job.submit(id, d, m);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ the evaluator paths in tokens

    function test_releaseOnSilencePaysProviderInTokens() public {
        uint256 id = _open();
        _submit(id);
        vm.expectRevert(Eval.ObjectionPeriodRunning.selector);
        ev.releaseOnSilence(id, checklist, files);
        vm.warp(block.timestamp + OBJ);
        vm.prank(stranger);
        ev.releaseOnSilence(id, checklist, files);
        assertEq(uint8(job.getJob(id).state), uint8(IAgentJobV2.State.Completed));
        assertEq(job.credit(provider), AMT);
        assertEq(job.totalEscrowed(), 0);
        vm.prank(provider);
        job.withdraw();
        assertEq(tok.balanceOf(provider), AMT);
        assertEq(tok.balanceOf(address(job)), 0);
        assertEq(job.totalCredit(), 0);
    }

    function test_objectionThenRefund() public {
        uint256 id = _open();
        _submit(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(client);
        ev.object(id, keccak256("written objection"));
        vm.warp(block.timestamp + OBJ);
        vm.expectRevert(Eval.OnHold.selector);
        ev.releaseOnSilence(id, checklist, files);
        vm.prank(stranger);
        vm.expectRevert(Eval.NotReviewer.selector);
        ev.resolve(id, false, keccak256("x"));
        uint256 before = tok.balanceOf(client);
        vm.prank(reviewer);
        ev.resolve(id, false, keccak256("refund decision"));
        assertEq(uint8(job.getJob(id).state), uint8(IAgentJobV2.State.Rejected));
        assertEq(job.getJob(id).reason, keccak256("refund decision"));
        assertEq(job.credit(client), AMT);
        assertEq(job.credit(provider), 0);
        vm.prank(client);
        job.withdraw();
        assertEq(tok.balanceOf(client), before + AMT);
    }

    function test_objectionThenReviewerPays() public {
        uint256 id = _open();
        _submit(id);
        vm.prank(client);
        ev.object(id, keccak256("written objection"));
        vm.prank(reviewer);
        ev.resolve(id, true, keccak256("pay decision"));
        assertEq(uint8(job.getJob(id).state), uint8(IAgentJobV2.State.Completed));
        vm.prank(provider);
        job.withdrawTo(stranger);
        assertEq(tok.balanceOf(stranger), AMT);
    }

    function test_objectionAfterPeriodRefused() public {
        uint256 id = _open();
        _submit(id);
        vm.warp(block.timestamp + OBJ);
        vm.prank(client);
        vm.expectRevert(Eval.ObjectionPeriodOver.selector);
        ev.object(id, keccak256("late"));
    }

    function test_reviewerSilentClientRefundedAfterWindow() public {
        uint256 id = _open();
        _submit(id);
        vm.prank(client);
        ev.object(id, keccak256("written objection"));
        vm.expectRevert(AgentJobERC20.NotExpired.selector);
        job.claimRefund(id);
        vm.warp(block.timestamp + WIN);
        vm.prank(reviewer);
        vm.expectRevert(AgentJobERC20.PastDeadline.selector);
        ev.resolve(id, true, keccak256("too late"));
        vm.prank(stranger);
        job.claimRefund(id);
        assertEq(uint8(job.getJob(id).state), uint8(IAgentJobV2.State.Expired));
        assertEq(job.credit(client), AMT);
    }

    function test_neverSubmittedRefundAfterExpiry() public {
        uint256 id = _open();
        vm.expectRevert(AgentJobERC20.NotExpired.selector);
        job.claimRefund(id);
        vm.warp(block.timestamp + 30 days);
        job.claimRefund(id);
        assertEq(job.credit(client), AMT);
    }

    // ------------------------------------------------------------ double claims

    function test_doubleClaimsRefused() public {
        uint256 id = _open();
        _submit(id);
        vm.warp(block.timestamp + OBJ);
        ev.releaseOnSilence(id, checklist, files);
        vm.expectRevert(Eval.BadState.selector);
        ev.releaseOnSilence(id, checklist, files);
        vm.expectRevert(AgentJobERC20.BadState.selector);
        job.claimRefund(id);
        vm.prank(address(ev));
        vm.expectRevert(AgentJobERC20.BadState.selector);
        job.reject(id, bytes32("again"), "");
        vm.startPrank(provider);
        job.withdraw();
        vm.expectRevert(AgentJobERC20.NothingToWithdraw.selector);
        job.withdraw();
        vm.stopPrank();
        vm.prank(client);
        vm.expectRevert(AgentJobERC20.NothingToWithdraw.selector);
        job.withdraw();
    }

    function test_doubleResolveAndDoubleObjectRefused() public {
        uint256 id = _open();
        _submit(id);
        vm.startPrank(client);
        ev.object(id, keccak256("one"));
        vm.expectRevert(Eval.AlreadyObjected.selector);
        ev.object(id, keccak256("two"));
        vm.stopPrank();
        vm.startPrank(reviewer);
        ev.resolve(id, false, keccak256("refund"));
        vm.expectRevert(Eval.BadState.selector);
        ev.resolve(id, true, keccak256("pay"));
        vm.stopPrank();
    }

    function test_withdrawToZeroRefused() public {
        vm.prank(client);
        vm.expectRevert(AgentJobERC20.ZeroRecipient.selector);
        job.withdrawTo(address(0));
    }

    // ------------------------------------------------------------ accounting

    function testFuzz_solventAcrossOutcomes(uint96 a, uint96 b, uint8 outcome) public {
        vm.assume(a > 0 && b > 0);
        tok.mint(client, uint256(a) + b);
        vm.startPrank(client);
        tok.approve(address(job), uint256(a) + b);
        uint256 id1 = job.createJob(provider, address(ev), spec, uint64(block.timestamp + 30 days), a);
        uint256 id2 = job.createJob(provider, address(ev), spec, uint64(block.timestamp + 30 days), b);
        vm.stopPrank();
        _solvent(address(tok));
        _submit(id1);
        _submit(id2);
        if (outcome % 3 == 0) {
            vm.warp(block.timestamp + OBJ);
            ev.releaseOnSilence(id1, checklist, files);
        } else {
            vm.prank(client);
            ev.object(id1, keccak256("o"));
            vm.prank(reviewer);
            ev.resolve(id1, outcome % 3 == 1, keccak256("d"));
        }
        _solvent(address(tok));
        vm.warp(block.timestamp + WIN);
        job.claimRefund(id2);
        _solvent(address(tok));
        assertEq(job.totalEscrowed(), 0);
        assertEq(job.totalCredit(), uint256(a) + b);
        if (job.credit(provider) > 0) {
            vm.prank(provider);
            job.withdraw();
        }
        vm.prank(client);
        job.withdraw();
        assertEq(tok.balanceOf(address(job)), 0);
    }
}

/// Non-standard tokens.
contract AgentJobERC20TokenEdgeTest is Base {
    function _fund(StdToken t) internal returns (uint256 id) {
        t.mint(client, 100e18);
        vm.startPrank(client);
        t.approve(address(job), AMT);
        id = job.createJob(provider, address(ev), spec, uint64(block.timestamp + 30 days), AMT);
        vm.stopPrank();
    }

    function test_tokenReturningFalseOnTransferFromReverts() public {
        ReturnsFalseToken t = new ReturnsFalseToken();
        _deploy(address(t));
        t.mint(client, 100e18);
        // No approval: the token returns false instead of reverting -> must revert, no job.
        vm.prank(client);
        vm.expectRevert(AgentJobERC20.TransferFailed.selector);
        job.createJob(provider, address(ev), spec, uint64(block.timestamp + 1 days), AMT);
        // Approved but the token still answers false -> must revert.
        t.setAlwaysFalse(true);
        vm.startPrank(client);
        t.approve(address(job), AMT);
        vm.expectRevert(AgentJobERC20.TransferFailed.selector);
        job.createJob(provider, address(ev), spec, uint64(block.timestamp + 1 days), AMT);
        vm.stopPrank();
        assertEq(job.jobCount(), 0);
        assertEq(job.totalEscrowed(), 0);
    }

    function test_tokenReturningFalseOnTransferKeepsCredit() public {
        ReturnsFalseToken t = new ReturnsFalseToken();
        _deploy(address(t));
        uint256 id = _fund(t);
        _submit(id);
        vm.warp(block.timestamp + OBJ);
        ev.releaseOnSilence(id, checklist, files);
        t.setTransferFalse(true);
        vm.prank(provider);
        vm.expectRevert(AgentJobERC20.TransferFailed.selector);
        job.withdraw();
        assertEq(job.credit(provider), AMT, "credit lost on failed transfer");
        t.setTransferFalse(false);
        vm.prank(provider);
        job.withdraw();
        assertEq(t.balanceOf(provider), AMT);
    }

    function test_noReturnTokenWorksEndToEnd() public {
        NoReturnToken t = new NoReturnToken();
        _deploy(address(t));
        t.mint(client, 100e18);
        vm.startPrank(client);
        t.approve(address(job), AMT);
        uint256 id = job.createJob(provider, address(ev), spec, uint64(block.timestamp + 30 days), AMT);
        vm.stopPrank();
        _submit(id);
        vm.prank(client);
        ev.object(id, keccak256("o"));
        vm.prank(reviewer);
        ev.resolve(id, false, keccak256("refund"));
        vm.prank(client);
        job.withdraw();
        assertEq(t.balanceOf(client), 100e18);
    }

    function test_feeOnTransferTokenRejected() public {
        FeeOnTransferToken t = new FeeOnTransferToken();
        _deploy(address(t));
        t.mint(client, 100e18);
        vm.startPrank(client);
        t.approve(address(job), AMT);
        vm.expectRevert(abi.encodeWithSelector(AgentJobERC20.UnexpectedAmountReceived.selector, AMT, AMT - AMT / 100));
        job.createJob(provider, address(ev), spec, uint64(block.timestamp + 30 days), AMT);
        vm.stopPrank();
        assertEq(job.jobCount(), 0);
    }

    function test_lyingTokenRejected() public {
        LyingToken t = new LyingToken();
        _deploy(address(t));
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentJobERC20.UnexpectedAmountReceived.selector, AMT, 0));
        job.createJob(provider, address(ev), spec, uint64(block.timestamp + 30 days), AMT);
    }

    function test_reentrancyOnWithdrawBlocked() public {
        ReentrantToken t = new ReentrantToken();
        _deploy(address(t));
        uint256 id = _fund(t);
        _submit(id);
        vm.warp(block.timestamp + OBJ);
        ev.releaseOnSilence(id, checklist, files);
        // During the outgoing transfer the token calls withdraw() again (as the job contract itself).
        t.arm(address(job), abi.encodeCall(job.withdraw, ()));
        vm.prank(provider);
        job.withdraw();
        assertFalse(t.reentered());
        assertEq(bytes4(t.lastRevert()), AgentJobERC20.Reentrancy.selector);
        assertEq(t.balanceOf(provider), AMT);
        assertEq(t.balanceOf(address(job)), 0);
    }

    function test_reentrancyOnCreateBlocked() public {
        ReentrantToken t = new ReentrantToken();
        _deploy(address(t));
        t.arm(address(job), abi.encodeCall(job.claimRefund, (1)));
        uint256 id = _fund(t);
        assertEq(id, 1);
        assertFalse(t.reentered());
        assertEq(bytes4(t.lastRevert()), AgentJobERC20.Reentrancy.selector);
        assertEq(job.getJob(1).escrow, AMT);
    }
}
