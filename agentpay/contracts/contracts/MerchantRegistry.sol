// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MerchantRegistry
/// @notice On-chain registry of real-world merchants. Verified merchants gain
///         access to settlement, invoicing and machine-payable endpoints.
///         QIE Pass id is stored as a string for the reusable-KYC link.
contract MerchantRegistry {
    struct Merchant {
        address owner;
        string name;
        string metadataURI; // off-chain profile (docs, photos, location)
        string qiePassId;   // QIE Pass reusable-KYC reference (optional)
        bool verified;
        bool active;
        uint64 registeredAt;
    }

    address public verifier; // protocol operator / DAO that verifies merchants
    mapping(address => Merchant) private _merchants;
    address[] public merchantList;

    event MerchantRegistered(address indexed merchant, string name, string metadataURI);
    event MerchantVerified(address indexed merchant, bool verified);
    event MerchantUpdated(address indexed merchant, string name, string metadataURI);
    event MerchantStatusChanged(address indexed merchant, bool active);
    event VerifierChanged(address indexed newVerifier);

    modifier onlyVerifier() {
        require(msg.sender == verifier, "NOT_VERIFIER");
        _;
    }

    modifier onlyRegistered(address merchant) {
        require(_merchants[merchant].owner != address(0), "NOT_REGISTERED");
        _;
    }

    constructor(address _verifier) {
        require(_verifier != address(0), "ZERO_VERIFIER");
        verifier = _verifier;
    }

    function registerMerchant(string calldata name, string calldata metadataURI) external {
        require(bytes(name).length > 0, "EMPTY_NAME");
        require(_merchants[msg.sender].owner == address(0), "ALREADY_REGISTERED");

        _merchants[msg.sender] = Merchant({
            owner: msg.sender,
            name: name,
            metadataURI: metadataURI,
            qiePassId: "",
            verified: false,
            active: true,
            registeredAt: uint64(block.timestamp)
        });
        merchantList.push(msg.sender);

        emit MerchantRegistered(msg.sender, name, metadataURI);
    }

    function verifyMerchant(address merchant, bool verified) external onlyVerifier onlyRegistered(merchant) {
        _merchants[merchant].verified = verified;
        emit MerchantVerified(merchant, verified);
    }

    function setQiePassId(string calldata qiePassId) external onlyRegistered(msg.sender) {
        _merchants[msg.sender].qiePassId = qiePassId;
    }

    function updateProfile(string calldata name, string calldata metadataURI)
        external
        onlyRegistered(msg.sender)
    {
        _merchants[msg.sender].name = name;
        _merchants[msg.sender].metadataURI = metadataURI;
        emit MerchantUpdated(msg.sender, name, metadataURI);
    }

    function setActive(address merchant, bool active) external onlyVerifier onlyRegistered(merchant) {
        _merchants[merchant].active = active;
        emit MerchantStatusChanged(merchant, active);
    }

    function setVerifier(address newVerifier) external onlyVerifier {
        require(newVerifier != address(0), "ZERO_VERIFIER");
        verifier = newVerifier;
        emit VerifierChanged(newVerifier);
    }

    // ---------- views ----------

    function getMerchant(address merchant)
        external
        view
        returns (Merchant memory)
    {
        return _merchants[merchant];
    }

    function isVerifiedMerchant(address merchant) external view returns (bool) {
        Merchant storage m = _merchants[merchant];
        return m.owner != address(0) && m.verified && m.active;
    }

    function merchantCount() external view returns (uint256) {
        return merchantList.length;
    }
}
