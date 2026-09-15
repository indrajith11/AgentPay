// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CreditPassport
/// @notice Portable on-chain credit identity built from REAL payment history.
///         Every on-time machine call, invoice repayment and subscription
///         charge raises the subject's score; defaults lower it. Lending
///         partners (or future underwriting contracts) read getScore() —
///         the "credit invisibility" fix for informal merchants and for
///         humans whose agents pay for them.
contract CreditPassport {
    uint256 public constant SCORE_MIN = 300;
    uint256 public constant SCORE_MAX = 850;
    uint256 public constant ON_TIME_POINTS = 8;
    uint256 public constant DEFAULT_PENALTY = 120;
    uint256 public constant VOLUME_STEP = 1_000 ether; // +2 pts per step of token units

    address public verifier;
    mapping(address => bool) public authorizedRecorders;

    struct Profile {
        uint256 score;
        uint256 onTimeCount;
        uint256 lateCount;
        uint256 defaultCount;
        uint256 volumeTotal; // cumulative token units (all tokens summed)
        uint64 firstPaymentAt;
        uint64 lastPaymentAt;
    }

    mapping(address => Profile) public profiles;
    address[] public subjectList;

    event PaymentRecorded(address indexed subject, uint256 amount, bool onTime, uint256 newScore);
    event DefaultRecorded(address indexed subject, uint256 amount, uint256 newScore);
    event RecorderUpdated(address indexed recorder, bool authorized);

    error NotAuthorized();
    error NotVerifier();

    constructor(address _verifier) {
        require(_verifier != address(0), "ZERO_VERIFIER");
        verifier = _verifier;
    }

    modifier onlyVerifier() {
        if (msg.sender != verifier) revert NotVerifier();
        _;
    }

    modifier onlyRecorder() {
        if (!authorizedRecorders[msg.sender]) revert NotAuthorized();
        _;
    }

    function setRecorder(address recorder, bool authorized) external onlyVerifier {
        authorizedRecorders[recorder] = authorized;
        emit RecorderUpdated(recorder, authorized);
    }

    function _touch(address subject) private {
        if (profiles[subject].firstPaymentAt == 0) {
            profiles[subject].firstPaymentAt = uint64(block.timestamp);
            profiles[subject].score = SCORE_MIN; // new subjects start at the floor, not 0
            subjectList.push(subject);
        }
        profiles[subject].lastPaymentAt = uint64(block.timestamp);
    }

    /// @notice Record a repayment/payment. onTime = settled within terms.
    function recordPayment(address subject, uint256 amount, bool onTime) external onlyRecorder {
        require(subject != address(0), "ZERO_SUBJECT");
        _touch(subject);

        Profile storage p = profiles[subject];
        if (onTime) {
            p.onTimeCount += 1;
            p.score = _min(SCORE_MAX, p.score + ON_TIME_POINTS);
        } else {
            p.lateCount += 1;
            // late but repaid: small +1 (still proof of repayment)
            p.score = _min(SCORE_MAX, p.score + 1);
        }
        p.volumeTotal += amount;
        p.score = _min(SCORE_MAX, p.score + (amount / VOLUME_STEP) * 2);

        emit PaymentRecorded(subject, amount, onTime, p.score);
    }

    /// @notice Record a default (never repaid within grace).
    function recordDefault(address subject, uint256 amount) external onlyRecorder {
        require(subject != address(0), "ZERO_SUBJECT");
        _touch(subject);

        Profile storage p = profiles[subject];
        p.defaultCount += 1;
        p.score = p.score > SCORE_MIN + DEFAULT_PENALTY ? p.score - DEFAULT_PENALTY : SCORE_MIN;

        emit DefaultRecorded(subject, amount, p.score);
    }

    /// @notice Seed a score from off-chain history (e.g. existing merchants).
    function seedScore(address subject, uint256 score, uint256 volumeTotal) external onlyVerifier {
        require(profiles[subject].firstPaymentAt == 0, "ALREADY_SEEDED");
        require(score >= SCORE_MIN && score <= SCORE_MAX, "BAD_SCORE");

        Profile storage p = profiles[subject];
        p.score = score;
        p.volumeTotal = volumeTotal;
        p.firstPaymentAt = uint64(block.timestamp);
        subjectList.push(subject);
    }

    // ---------- views ----------

    function getScore(address subject)
        external
        view
        returns (
            uint256 score,
            uint256 onTimeCount,
            uint256 lateCount,
            uint256 defaultCount,
            uint256 volumeTotal
        )
    {
        Profile storage p = profiles[subject];
        return (p.score, p.onTimeCount, p.lateCount, p.defaultCount, p.volumeTotal);
    }

    /// @notice Lending-tier helper: 0 = none, 1 = starter, 2 = growth, 3 = prime.
    function tier(address subject) external view returns (uint8) {
        uint256 s = profiles[subject].score;
        if (s >= 720) return 3;
        if (s >= 600) return 2;
        if (s > 300) return 1;
        return 0;
    }

    function subjectCount() external view returns (uint256) {
        return subjectList.length;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
