// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Dev stand-in for the Marlin Oyster market (MarketV1 on Arbitrum
/// One, 0x9d95D61eA056721E358BC49fE995caBF3B86A34B): a job is a prepaid
/// balance drained at `rate` per second, where rate carries EXTRA_DECIMALS
/// more decimals than the token (USDC 6 + 12 = 18 on the real market). The
/// farm's lease loop reads `jobs()` and calls `jobDeposit()`; this mock keeps
/// those two signatures, `jobSettle`, `EXTRA_DECIMALS` and `token` identical
/// to the real ABI so the same code runs on anvil and against Marlin.
contract MockOysterMarket {
    using SafeERC20 for IERC20;

    struct Job {
        string metadata;
        address owner;
        address provider;
        uint256 rate; // token units per second, scaled by 10**EXTRA_DECIMALS
        uint256 balance; // token units
        uint256 lastSettled;
    }

    IERC20 public immutable token;
    uint256 public constant EXTRA_DECIMALS = 12;
    mapping(bytes32 => Job) public jobs;
    uint256 public jobIndex;

    event JobOpened(bytes32 indexed job, string metadata, address indexed owner, address indexed provider, uint256 rate, uint256 balance, uint256 timestamp);
    event JobDeposited(bytes32 indexed job, address indexed from, uint256 amount);
    event JobWithdrew(bytes32 indexed job, address indexed to, uint256 amount);
    event JobSettled(bytes32 indexed job, uint256 amount, uint256 timestamp);
    event JobClosed(bytes32 indexed job);

    constructor(IERC20 token_) {
        token = token_;
    }

    function jobOpen(string calldata metadata, address provider, uint256 rate, uint256 balance) external {
        bytes32 job = keccak256(abi.encodePacked(address(this), jobIndex++));
        token.safeTransferFrom(msg.sender, address(this), balance);
        jobs[job] = Job(metadata, msg.sender, provider, rate, balance, block.timestamp);
        emit JobOpened(job, metadata, msg.sender, provider, rate, balance, block.timestamp);
    }

    /// @notice Charge the job for the time elapsed since it was last settled.
    function jobSettle(bytes32 job) public {
        Job storage j = jobs[job];
        require(j.owner != address(0), "Market: no job");
        uint256 usage = (j.rate * (block.timestamp - j.lastSettled)) / 10 ** EXTRA_DECIMALS;
        if (usage > j.balance) usage = j.balance;
        j.balance -= usage;
        j.lastSettled = block.timestamp;
        if (usage > 0) token.safeTransfer(j.provider, usage);
        emit JobSettled(job, usage, block.timestamp);
    }

    /// @notice Anyone may top a job up (the farm tops up its own).
    function jobDeposit(bytes32 job, uint256 amount) external {
        require(jobs[job].owner != address(0), "Market: no job");
        token.safeTransferFrom(msg.sender, address(this), amount);
        jobs[job].balance += amount;
        emit JobDeposited(job, msg.sender, amount);
    }

    function jobWithdraw(bytes32 job, uint256 amount) external {
        Job storage j = jobs[job];
        require(msg.sender == j.owner, "Market: not owner");
        jobSettle(job);
        require(amount <= j.balance, "Market: balance");
        j.balance -= amount;
        token.safeTransfer(msg.sender, amount);
        emit JobWithdrew(job, msg.sender, amount);
    }

    function jobClose(bytes32 job) external {
        Job storage j = jobs[job];
        require(msg.sender == j.owner, "Market: not owner");
        jobSettle(job);
        uint256 refund = j.balance;
        delete jobs[job];
        if (refund > 0) token.safeTransfer(msg.sender, refund);
        emit JobClosed(job);
    }

    /// @notice Seconds of runtime left at the current rate, after settling
    /// what has elapsed (view; the same arithmetic the farm does off-chain).
    function remainingSeconds(bytes32 job) external view returns (uint256) {
        Job storage j = jobs[job];
        if (j.rate == 0) return type(uint256).max;
        uint256 scaled = j.balance * 10 ** EXTRA_DECIMALS;
        uint256 used = j.rate * (block.timestamp - j.lastSettled);
        return used >= scaled ? 0 : (scaled - used) / j.rate;
    }
}
