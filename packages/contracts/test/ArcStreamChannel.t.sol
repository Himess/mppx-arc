// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ArcStreamChannel} from "../src/ArcStreamChannel.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";

contract ArcStreamChannelTest is Test {
    ArcStreamChannel public channel;
    MockUSDC public usdc;

    address public payer;
    uint256 public payerKey;
    address public payee;
    uint256 public payeeKey;
    address public stranger;

    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 channelId,uint128 cumulativeAmount,uint256 nonce)");

    function setUp() public {
        (payer, payerKey) = makeAddrAndKey("payer");
        (payee, payeeKey) = makeAddrAndKey("payee");
        stranger = makeAddr("stranger");

        usdc = new MockUSDC();
        channel = new ArcStreamChannel(address(usdc));

        usdc.mint(payer, 1_000_000e6); // 1M USDC
        vm.prank(payer);
        usdc.approve(address(channel), type(uint256).max);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _openChannel(uint128 deposit) internal returns (bytes32) {
        bytes32 salt = keccak256("test-salt");
        vm.prank(payer);
        return channel.open(payee, deposit, salt);
    }

    function _signVoucher(
        uint256 signerKey,
        bytes32 channelId,
        uint128 cumulativeAmount,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", channel.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // ─── Open Tests ──────────────────────────────────────────────────────

    function test_open_success() public {
        bytes32 channelId = _openChannel(100e6);

        ArcStreamChannel.Channel memory ch = channel.getChannel(channelId);
        assertEq(ch.payer, payer);
        assertEq(ch.payee, payee);
        assertEq(ch.deposit, 100e6);
        assertEq(ch.settled, 0);
        assertTrue(ch.openedAt > 0);
        assertFalse(ch.closed);
        assertEq(usdc.balanceOf(address(channel)), 100e6);
    }

    function test_open_emitsEvent() public {
        bytes32 salt = keccak256("test-salt");
        bytes32 expectedId = channel.computeChannelId(payer, payee, salt);

        vm.expectEmit(true, true, true, true);
        emit ArcStreamChannel.ChannelOpened(expectedId, payer, payee, 100e6);

        vm.prank(payer);
        channel.open(payee, 100e6, salt);
    }

    function test_open_revertsZeroDeposit() public {
        vm.prank(payer);
        vm.expectRevert(ArcStreamChannel.InvalidDeposit.selector);
        channel.open(payee, 0, keccak256("salt"));
    }

    function test_open_revertsDuplicate() public {
        bytes32 salt = keccak256("test-salt");
        vm.prank(payer);
        channel.open(payee, 100e6, salt);

        vm.prank(payer);
        vm.expectRevert(ArcStreamChannel.ChannelAlreadyExists.selector);
        channel.open(payee, 100e6, salt);
    }

    function test_open_differentSaltsDifferentChannels() public {
        vm.startPrank(payer);
        bytes32 id1 = channel.open(payee, 50e6, keccak256("salt-1"));
        bytes32 id2 = channel.open(payee, 50e6, keccak256("salt-2"));
        vm.stopPrank();

        assertTrue(id1 != id2);
    }

    // ─── Settle Tests ────────────────────────────────────────────────────

    function test_settle_success() public {
        bytes32 channelId = _openChannel(100e6);
        bytes memory sig = _signVoucher(payerKey, channelId, 30e6, 1);

        vm.prank(payee);
        channel.settle(channelId, 30e6, 1, sig);

        ArcStreamChannel.Channel memory ch = channel.getChannel(channelId);
        assertEq(ch.settled, 30e6);
        assertEq(usdc.balanceOf(payee), 30e6);
        assertEq(usdc.balanceOf(address(channel)), 70e6);
    }

    function test_settle_incremental() public {
        bytes32 channelId = _openChannel(100e6);

        // First settle: 20 USDC
        bytes memory sig1 = _signVoucher(payerKey, channelId, 20e6, 1);
        vm.prank(payee);
        channel.settle(channelId, 20e6, 1, sig1);

        // Second settle: cumulative 50 USDC (delta = 30)
        bytes memory sig2 = _signVoucher(payerKey, channelId, 50e6, 2);
        vm.prank(payee);
        channel.settle(channelId, 50e6, 2, sig2);

        ArcStreamChannel.Channel memory ch = channel.getChannel(channelId);
        assertEq(ch.settled, 50e6);
        assertEq(usdc.balanceOf(payee), 50e6);
    }

    function test_settle_revertsNonPayee() public {
        bytes32 channelId = _openChannel(100e6);
        bytes memory sig = _signVoucher(payerKey, channelId, 30e6, 1);

        vm.prank(stranger);
        vm.expectRevert(ArcStreamChannel.OnlyPayee.selector);
        channel.settle(channelId, 30e6, 1, sig);
    }

    function test_settle_revertsExceedsDeposit() public {
        bytes32 channelId = _openChannel(100e6);
        bytes memory sig = _signVoucher(payerKey, channelId, 200e6, 1);

        vm.prank(payee);
        vm.expectRevert(ArcStreamChannel.AmountExceedsDeposit.selector);
        channel.settle(channelId, 200e6, 1, sig);
    }

    function test_settle_revertsDecreasingAmount() public {
        bytes32 channelId = _openChannel(100e6);

        bytes memory sig1 = _signVoucher(payerKey, channelId, 50e6, 1);
        vm.prank(payee);
        channel.settle(channelId, 50e6, 1, sig1);

        bytes memory sig2 = _signVoucher(payerKey, channelId, 30e6, 2);
        vm.prank(payee);
        vm.expectRevert(ArcStreamChannel.CumulativeAmountDecreased.selector);
        channel.settle(channelId, 30e6, 2, sig2);
    }

    function test_settle_revertsInvalidSignature() public {
        bytes32 channelId = _openChannel(100e6);
        // Sign with wrong key
        bytes memory sig = _signVoucher(payeeKey, channelId, 30e6, 1);

        vm.prank(payee);
        vm.expectRevert(ArcStreamChannel.InvalidSignature.selector);
        channel.settle(channelId, 30e6, 1, sig);
    }

    function test_settle_revertsInvalidNonce() public {
        bytes32 channelId = _openChannel(100e6);

        bytes memory sig1 = _signVoucher(payerKey, channelId, 30e6, 1);
        vm.prank(payee);
        channel.settle(channelId, 30e6, 1, sig1);

        // Same nonce again
        bytes memory sig2 = _signVoucher(payerKey, channelId, 40e6, 1);
        vm.prank(payee);
        vm.expectRevert(ArcStreamChannel.InvalidNonce.selector);
        channel.settle(channelId, 40e6, 1, sig2);
    }

    function test_settle_revertsOnClosedChannel() public {
        bytes32 channelId = _openChannel(100e6);

        bytes memory closeSig = _signVoucher(payerKey, channelId, 50e6, 1);
        vm.prank(payee);
        channel.close(channelId, 50e6, 1, closeSig);

        bytes memory sig = _signVoucher(payerKey, channelId, 60e6, 2);
        vm.prank(payee);
        vm.expectRevert(ArcStreamChannel.ChannelAlreadyClosed.selector);
        channel.settle(channelId, 60e6, 2, sig);
    }

    // ─── TopUp Tests ─────────────────────────────────────────────────────

    function test_topUp_success() public {
        bytes32 channelId = _openChannel(100e6);

        vm.prank(payer);
        channel.topUp(channelId, 50e6);

        ArcStreamChannel.Channel memory ch = channel.getChannel(channelId);
        assertEq(ch.deposit, 150e6);
        assertEq(usdc.balanceOf(address(channel)), 150e6);
    }

    function test_topUp_revertsNonPayer() public {
        bytes32 channelId = _openChannel(100e6);

        vm.prank(stranger);
        vm.expectRevert(ArcStreamChannel.OnlyPayer.selector);
        channel.topUp(channelId, 50e6);
    }

    function test_topUp_revertsZero() public {
        bytes32 channelId = _openChannel(100e6);

        vm.prank(payer);
        vm.expectRevert(ArcStreamChannel.InvalidDeposit.selector);
        channel.topUp(channelId, 0);
    }

    // ─── Close Tests ─────────────────────────────────────────────────────

    function test_close_success() public {
        bytes32 channelId = _openChannel(100e6);

        bytes memory sig = _signVoucher(payerKey, channelId, 60e6, 1);
        vm.prank(payee);
        channel.close(channelId, 60e6, 1, sig);

        ArcStreamChannel.Channel memory ch = channel.getChannel(channelId);
        assertTrue(ch.closed);
        assertEq(usdc.balanceOf(payee), 60e6);
        assertEq(usdc.balanceOf(payer), 1_000_000e6 - 100e6 + 40e6); // refund
    }

    function test_close_afterPartialSettle() public {
        bytes32 channelId = _openChannel(100e6);

        // Settle 30
        bytes memory sig1 = _signVoucher(payerKey, channelId, 30e6, 1);
        vm.prank(payee);
        channel.settle(channelId, 30e6, 1, sig1);

        // Close at 80
        bytes memory sig2 = _signVoucher(payerKey, channelId, 80e6, 2);
        vm.prank(payee);
        channel.close(channelId, 80e6, 2, sig2);

        ArcStreamChannel.Channel memory ch = channel.getChannel(channelId);
        assertTrue(ch.closed);
        assertEq(usdc.balanceOf(payee), 80e6); // 30 + 50
        assertEq(usdc.balanceOf(payer), 1_000_000e6 - 100e6 + 20e6); // 20 refund
    }

    function test_close_fullDeposit() public {
        bytes32 channelId = _openChannel(100e6);

        bytes memory sig = _signVoucher(payerKey, channelId, 100e6, 1);
        vm.prank(payee);
        channel.close(channelId, 100e6, 1, sig);

        assertEq(usdc.balanceOf(payee), 100e6);
        assertEq(usdc.balanceOf(address(channel)), 0);
    }

    function test_close_revertsNonPayee() public {
        bytes32 channelId = _openChannel(100e6);
        bytes memory sig = _signVoucher(payerKey, channelId, 50e6, 1);

        vm.prank(stranger);
        vm.expectRevert(ArcStreamChannel.OnlyPayee.selector);
        channel.close(channelId, 50e6, 1, sig);
    }

    // ─── RequestClose + Withdraw Tests ───────────────────────────────────

    function test_requestClose_success() public {
        bytes32 channelId = _openChannel(100e6);

        vm.prank(payer);
        channel.requestClose(channelId);

        ArcStreamChannel.Channel memory ch = channel.getChannel(channelId);
        assertTrue(ch.closeRequestedAt > 0);
    }

    function test_requestClose_revertsNonPayer() public {
        bytes32 channelId = _openChannel(100e6);

        vm.prank(stranger);
        vm.expectRevert(ArcStreamChannel.OnlyPayer.selector);
        channel.requestClose(channelId);
    }

    function test_withdraw_afterGracePeriod() public {
        bytes32 channelId = _openChannel(100e6);

        // Settle 30 first
        bytes memory sig = _signVoucher(payerKey, channelId, 30e6, 1);
        vm.prank(payee);
        channel.settle(channelId, 30e6, 1, sig);

        // Request close
        vm.prank(payer);
        channel.requestClose(channelId);

        // Warp past grace period
        vm.warp(block.timestamp + 15 minutes + 1);

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(payer);
        channel.withdraw(channelId);

        ArcStreamChannel.Channel memory ch = channel.getChannel(channelId);
        assertTrue(ch.closed);
        assertEq(usdc.balanceOf(payer) - payerBefore, 70e6); // 100 - 30 settled
    }

    function test_withdraw_revertsBeforeGracePeriod() public {
        bytes32 channelId = _openChannel(100e6);

        vm.prank(payer);
        channel.requestClose(channelId);

        vm.warp(block.timestamp + 10 minutes); // too early

        vm.prank(payer);
        vm.expectRevert(ArcStreamChannel.GracePeriodNotElapsed.selector);
        channel.withdraw(channelId);
    }

    function test_withdraw_revertsWithoutCloseRequest() public {
        bytes32 channelId = _openChannel(100e6);

        vm.prank(payer);
        vm.expectRevert(ArcStreamChannel.ChannelNotCloseRequested.selector);
        channel.withdraw(channelId);
    }

    // ─── ERC-1271 Smart Wallet Tests ─────────────────────────────────────

    function test_settle_withSmartWallet() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(payer);

        usdc.mint(address(wallet), 500e6);
        vm.prank(address(wallet));
        usdc.approve(address(channel), type(uint256).max);

        bytes32 salt = keccak256("wallet-salt");
        vm.prank(address(wallet));
        bytes32 channelId = channel.open(payee, 100e6, salt);

        // Sign voucher with the wallet's owner key
        bytes memory sig = _signVoucher(payerKey, channelId, 40e6, 1);

        vm.prank(payee);
        channel.settle(channelId, 40e6, 1, sig);

        assertEq(usdc.balanceOf(payee), 40e6);
    }

    // ─── View Functions Tests ────────────────────────────────────────────

    function test_computeChannelId_deterministic() public view {
        bytes32 salt = keccak256("test");
        bytes32 id1 = channel.computeChannelId(payer, payee, salt);
        bytes32 id2 = channel.computeChannelId(payer, payee, salt);
        assertEq(id1, id2);
    }

    function test_getChannelsBatch() public {
        bytes32 salt1 = keccak256("s1");
        bytes32 salt2 = keccak256("s2");

        vm.startPrank(payer);
        bytes32 id1 = channel.open(payee, 50e6, salt1);
        bytes32 id2 = channel.open(payee, 75e6, salt2);
        vm.stopPrank();

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = id1;
        ids[1] = id2;

        ArcStreamChannel.Channel[] memory chs = channel.getChannelsBatch(ids);
        assertEq(chs.length, 2);
        assertEq(chs[0].deposit, 50e6);
        assertEq(chs[1].deposit, 75e6);
    }

    function test_getVoucherHash() public view {
        bytes32 channelId = keccak256("test-channel");
        bytes32 hash = channel.getVoucherHash(channelId, 100e6, 1);
        assertTrue(hash != bytes32(0));
    }

    // ─── Fuzz Tests ──────────────────────────────────────────────────────

    function testFuzz_open_settle_close(uint128 deposit, uint128 settleAmount) public {
        deposit = uint128(bound(deposit, 1e6, 1_000_000e6));
        settleAmount = uint128(bound(settleAmount, 0, deposit));

        bytes32 channelId = _openChannel(deposit);

        if (settleAmount > 0) {
            bytes memory sig = _signVoucher(payerKey, channelId, settleAmount, 1);
            vm.prank(payee);
            channel.close(channelId, settleAmount, 1, sig);
        } else {
            bytes memory sig = _signVoucher(payerKey, channelId, 0, 1);
            vm.prank(payee);
            channel.close(channelId, 0, 1, sig);
        }

        ArcStreamChannel.Channel memory ch = channel.getChannel(channelId);
        assertTrue(ch.closed);
        assertEq(usdc.balanceOf(payee), settleAmount);
    }

    function testFuzz_settle_nonce_ordering(uint256 nonce1, uint256 nonce2) public {
        nonce1 = bound(nonce1, 1, type(uint128).max);
        nonce2 = bound(nonce2, 1, type(uint128).max);
        vm.assume(nonce1 != nonce2);

        bytes32 channelId = _openChannel(100e6);

        if (nonce1 < nonce2) {
            bytes memory sig1 = _signVoucher(payerKey, channelId, 30e6, nonce1);
            vm.prank(payee);
            channel.settle(channelId, 30e6, nonce1, sig1);

            bytes memory sig2 = _signVoucher(payerKey, channelId, 60e6, nonce2);
            vm.prank(payee);
            channel.settle(channelId, 60e6, nonce2, sig2);

            assertEq(channel.channelNonces(channelId), nonce2);
        } else {
            bytes memory sig1 = _signVoucher(payerKey, channelId, 30e6, nonce1);
            vm.prank(payee);
            channel.settle(channelId, 30e6, nonce1, sig1);

            bytes memory sig2 = _signVoucher(payerKey, channelId, 60e6, nonce2);
            vm.prank(payee);
            vm.expectRevert(ArcStreamChannel.InvalidNonce.selector);
            channel.settle(channelId, 60e6, nonce2, sig2);
        }
    }
}
