// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentJobERC20} from "../contracts/v2/AgentJobERC20.sol";
import {IAgentJobV2} from "../contracts/v2/interfaces/IAgentJobV2.sol";
import {PredgeNoObjectionEvaluator as Eval} from "../contracts/rsk-poc/PredgeNoObjectionEvaluator.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/// Job 2 (objection branch) against the REAL testnet USDRIF token, on a local fork of Rootstock testnet.
/// Skipped unless RSK_FORK=1:   RSK_FORK=1 forge test --match-contract Fork -vv
contract AgentJobERC20ForkTest is Test {
    // EIP-55 form of 0x8dbF326E12a9fF37ED6ddf75adA548c2640a6482 (that spelling is the RSK EIP-1191 checksum for chain 31)
    address constant USDRIF = 0x8dbf326e12a9fF37ED6DDF75adA548C2640A6482;
    uint256 constant AMT = 10e18;

    function test_job2ObjectionBranchInRealUSDRIF() public {
        if (!vm.envOr("RSK_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("rsk_testnet");
        assertEq(block.chainid, 31);
        IERC20 usd = IERC20(USDRIF);
        assertEq(usd.decimals(), 18);

        address client = makeAddr("ibuki-client");
        address provider = makeAddr("contractor");
        address reviewer = makeAddr("reviewer");
        AgentJobERC20 job = new AgentJobERC20(USDRIF, 24 days);
        Eval ev = new Eval(address(job), reviewer, 10 days);
        deal(USDRIF, client, AMT); // forge finds the balance slot behind the proxy

        bytes32 checklist = keccak256("checklist");
        bytes32[] memory files = new bytes32[](2);
        files[0] = sha256("a");
        files[1] = sha256("b");
        bytes32 spec = ev.specHashFor(checklist, files.length);

        vm.startPrank(client);
        assertTrue(usd.approve(address(job), AMT));
        uint256 id = job.createJob(provider, address(ev), spec, uint64(block.timestamp + 7 days), AMT);
        vm.stopPrank();
        assertEq(usd.balanceOf(address(job)), AMT);

        bytes memory m = abi.encode(checklist, files);
        bytes32 d = sha256(m);
        vm.prank(provider);
        job.submit(id, d, m);
        vm.prank(client);
        ev.object(id, keccak256("written objection"));
        vm.expectRevert(Eval.OnHold.selector);
        ev.releaseOnSilence(id, checklist, files);
        vm.prank(reviewer);
        ev.resolve(id, false, keccak256("refund decision"));
        assertEq(uint8(job.getJob(id).state), uint8(IAgentJobV2.State.Rejected));
        vm.prank(client);
        job.withdraw();
        assertEq(usd.balanceOf(client), AMT);
        assertEq(usd.balanceOf(address(job)), 0);
    }
}
