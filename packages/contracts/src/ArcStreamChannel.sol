// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArcStreamChannel
/// @notice Payment channel escrow contract for MPP sessions on Circle's Arc chain.
///         USDC-only — designed for Arc where USDC is the native gas token.
/// @dev Supports ERC-1271 smart wallet payers via SignatureChecker.
contract ArcStreamChannel is EIP712, ReentrancyGuard {
    // ─── Types ───────────────────────────────────────────────────────────

    struct Channel {
        address payer;
        address payee;
        uint128 deposit;
        uint128 settled;
        uint64 openedAt;
        uint64 closeRequestedAt;
        bool closed;
    }

    // ─── Constants ───────────────────────────────────────────────────────

    /// @notice Arc Testnet USDC — the only supported token.
    address public immutable USDC;

    /// @notice Grace period after close request before payer can withdraw.
    uint64 public constant CLOSE_GRACE_PERIOD = 15 minutes;

    /// @notice EIP-712 typehash for voucher signatures.
    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 channelId,uint128 cumulativeAmount,uint256 nonce)");

    // ─── State ───────────────────────────────────────────────────────────

    mapping(bytes32 => Channel) public channels;
    mapping(bytes32 => uint256) public channelNonces;

    // ─── Events ──────────────────────────────────────────────────────────

    event ChannelOpened(bytes32 indexed channelId, address indexed payer, address indexed payee, uint128 deposit);
    event ChannelSettled(bytes32 indexed channelId, uint128 amount, uint256 nonce);
    event ChannelToppedUp(bytes32 indexed channelId, uint128 newDeposit);
    event ChannelCloseRequested(bytes32 indexed channelId, uint64 closableAt);
    event ChannelClosed(bytes32 indexed channelId, uint128 payeeAmount, uint128 payerRefund);
    event ChannelWithdrawn(bytes32 indexed channelId, uint128 payerRefund);

    // ─── Errors ──────────────────────────────────────────────────────────

    error ChannelAlreadyExists();
    error ChannelDoesNotExist();
    error ChannelAlreadyClosed();
    error ChannelNotCloseRequested();
    error GracePeriodNotElapsed();
    error InvalidDeposit();
    error InvalidSignature();
    error InvalidNonce();
    error AmountExceedsDeposit();
    error CumulativeAmountDecreased();
    error OnlyPayer();
    error OnlyPayee();
    error TransferFailed();

    // ─── Constructor ─────────────────────────────────────────────────────

    constructor(address usdc_) EIP712("Arc Stream Channel", "1") {
        USDC = usdc_;
    }

    // ─── External Functions ──────────────────────────────────────────────

    /// @notice Open a new payment channel by depositing USDC.
    /// @param payee The server/merchant receiving payments.
    /// @param deposit Amount of USDC to escrow (6 decimals).
    /// @param salt Unique salt for deterministic channel ID.
    function open(address payee, uint128 deposit, bytes32 salt) external nonReentrant returns (bytes32 channelId) {
        if (deposit == 0) revert InvalidDeposit();

        channelId = computeChannelId(msg.sender, payee, salt);
        if (channels[channelId].openedAt != 0) revert ChannelAlreadyExists();

        channels[channelId] = Channel({
            payer: msg.sender,
            payee: payee,
            deposit: deposit,
            settled: 0,
            openedAt: uint64(block.timestamp),
            closeRequestedAt: 0,
            closed: false
        });

        if (!IERC20(USDC).transferFrom(msg.sender, address(this), deposit)) revert TransferFailed();

        emit ChannelOpened(channelId, msg.sender, payee, deposit);
    }

    /// @notice Settle accumulated payments using a signed voucher from the payer.
    /// @dev Cumulative — each voucher includes the total amount owed so far.
    function settle(
        bytes32 channelId,
        uint128 cumulativeAmount,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant {
        Channel storage ch = _getActiveChannel(channelId);
        if (msg.sender != ch.payee) revert OnlyPayee();
        if (cumulativeAmount < ch.settled) revert CumulativeAmountDecreased();
        if (cumulativeAmount > ch.deposit) revert AmountExceedsDeposit();
        if (nonce <= channelNonces[channelId]) revert InvalidNonce();

        bytes32 voucherHash = _hashVoucher(channelId, cumulativeAmount, nonce);
        if (!SignatureChecker.isValidSignatureNow(ch.payer, voucherHash, signature)) revert InvalidSignature();

        uint128 delta = cumulativeAmount - ch.settled;
        ch.settled = cumulativeAmount;
        channelNonces[channelId] = nonce;

        if (delta > 0) {
            if (!IERC20(USDC).transfer(ch.payee, delta)) revert TransferFailed();
        }

        emit ChannelSettled(channelId, cumulativeAmount, nonce);
    }

    /// @notice Add more USDC to an existing channel.
    function topUp(bytes32 channelId, uint128 additionalDeposit) external nonReentrant {
        Channel storage ch = _getActiveChannel(channelId);
        if (msg.sender != ch.payer) revert OnlyPayer();
        if (additionalDeposit == 0) revert InvalidDeposit();

        ch.deposit += additionalDeposit;

        if (!IERC20(USDC).transferFrom(msg.sender, address(this), additionalDeposit)) revert TransferFailed();

        emit ChannelToppedUp(channelId, ch.deposit);
    }

    /// @notice Payee closes the channel with a final voucher, settling remaining funds.
    function close(
        bytes32 channelId,
        uint128 cumulativeAmount,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant {
        Channel storage ch = _getActiveChannel(channelId);
        if (msg.sender != ch.payee) revert OnlyPayee();
        if (cumulativeAmount < ch.settled) revert CumulativeAmountDecreased();
        if (cumulativeAmount > ch.deposit) revert AmountExceedsDeposit();
        if (nonce <= channelNonces[channelId]) revert InvalidNonce();

        bytes32 voucherHash = _hashVoucher(channelId, cumulativeAmount, nonce);
        if (!SignatureChecker.isValidSignatureNow(ch.payer, voucherHash, signature)) revert InvalidSignature();

        uint128 payeeAmount = cumulativeAmount - ch.settled;
        uint128 payerRefund = ch.deposit - cumulativeAmount;

        ch.settled = cumulativeAmount;
        ch.closed = true;
        channelNonces[channelId] = nonce;

        if (payeeAmount > 0) {
            if (!IERC20(USDC).transfer(ch.payee, payeeAmount)) revert TransferFailed();
        }
        if (payerRefund > 0) {
            if (!IERC20(USDC).transfer(ch.payer, payerRefund)) revert TransferFailed();
        }

        emit ChannelClosed(channelId, payeeAmount, payerRefund);
    }

    /// @notice Payer requests channel close. After grace period, payer can withdraw.
    function requestClose(bytes32 channelId) external {
        Channel storage ch = _getActiveChannel(channelId);
        if (msg.sender != ch.payer) revert OnlyPayer();

        ch.closeRequestedAt = uint64(block.timestamp);

        emit ChannelCloseRequested(channelId, uint64(block.timestamp) + CLOSE_GRACE_PERIOD);
    }

    /// @notice Payer withdraws remaining deposit after grace period elapsed.
    function withdraw(bytes32 channelId) external nonReentrant {
        Channel storage ch = _getActiveChannel(channelId);
        if (msg.sender != ch.payer) revert OnlyPayer();
        if (ch.closeRequestedAt == 0) revert ChannelNotCloseRequested();
        if (block.timestamp < ch.closeRequestedAt + CLOSE_GRACE_PERIOD) revert GracePeriodNotElapsed();

        uint128 payerRefund = ch.deposit - ch.settled;
        ch.closed = true;

        if (payerRefund > 0) {
            if (!IERC20(USDC).transfer(ch.payer, payerRefund)) revert TransferFailed();
        }

        emit ChannelWithdrawn(channelId, payerRefund);
    }

    // ─── View Functions ──────────────────────────────────────────────────

    function computeChannelId(address payer, address payee, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(payer, payee, salt));
    }

    function getChannel(bytes32 channelId) external view returns (Channel memory) {
        return channels[channelId];
    }

    function getChannelsBatch(bytes32[] calldata channelIds) external view returns (Channel[] memory result) {
        result = new Channel[](channelIds.length);
        for (uint256 i = 0; i < channelIds.length; i++) {
            result[i] = channels[channelIds[i]];
        }
    }

    function getVoucherHash(bytes32 channelId, uint128 cumulativeAmount, uint256 nonce) external view returns (bytes32) {
        return _hashVoucher(channelId, cumulativeAmount, nonce);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─── Internal Functions ──────────────────────────────────────────────

    function _getActiveChannel(bytes32 channelId) internal view returns (Channel storage ch) {
        ch = channels[channelId];
        if (ch.openedAt == 0) revert ChannelDoesNotExist();
        if (ch.closed) revert ChannelAlreadyClosed();
    }

    function _hashVoucher(bytes32 channelId, uint128 cumulativeAmount, uint256 nonce) internal view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount, nonce)));
    }
}
