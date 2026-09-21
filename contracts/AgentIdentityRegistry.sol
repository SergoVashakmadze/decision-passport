// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AgentIdentityRegistry
 * @notice An ERC-8004 identity registry for Monad testnet.
 *
 * The canonical ERC-8004 registries are Monad **mainnet** only — there is no code at
 * `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` on testnet. That leaves an agent's identity and its
 * decision batches on different chains, and the binding between them reduced to "one key controls
 * both records" rather than something a single chain attests.
 *
 * This is a conformant registry deployed alongside `DecisionRegistry` on testnet, so the whole
 * passport — decision, batch, anchorer, agent — resolves on one chain. It is deliberately not a
 * competing standard: the interface, the event signatures and the metadata semantics are ERC-8004's,
 * so `AgentIdentity` in this package reads this contract and the mainnet one through the same ABI,
 * and an agent registered here is registered on mainnet by changing one address.
 *
 * What it is not: canonical. Anyone may deploy one of these, so an identity here is worth exactly
 * as much as the deployment is trusted. The mainnet registry is the one to register in for a claim
 * that does not depend on trusting whoever deployed this.
 */
contract AgentIdentityRegistry {
    // ============ ERC-721 state ============

    string public constant name = "AgentIdentity";
    string public constant symbol = "AGENT";

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // ============ ERC-8004 state ============

    uint256 private _nextAgentId = 1;
    uint256 private _totalAgents;

    mapping(uint256 => string) private _agentURIs;
    mapping(uint256 => mapping(string => bytes)) private _metadata;
    mapping(uint256 => address) private _agentWallets;

    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    /**
     * Reserved: an agent wallet is a claim that another address acts for this agent, so it may only
     * be set through `setAgentWallet`, which requires that address to have signed for it. Writing it
     * as ordinary metadata would let anyone name any address as their agent's and thereby claim its
     * transactions — exactly the binding this registry exists to make meaningful.
     */
    string private constant AGENT_WALLET_KEY = "agentWallet";

    // ============ Events ============

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event AgentWalletSet(uint256 indexed agentId, address indexed newWallet, address indexed setBy);

    // ============ Errors ============

    error NonexistentAgent(uint256 agentId);
    error NotAuthorized(address account, uint256 agentId);
    error ReservedKey();
    error ZeroAddress();
    error SignatureExpired();
    error InvalidSignature();
    error NotOwner();
    error TransferToNonReceiver();

    // ============ EIP-712 ============

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant AGENT_WALLET_TYPEHASH =
        keccak256("AgentWallet(uint256 agentId,address wallet,uint256 deadline)");

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    constructor() {
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256("1"), block.chainid, address(this))
        );
    }

    /// @dev Rebuilt after a chain split, so a signature cannot be replayed onto the forked chain.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    // ============ Registration ============

    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId) {
        agentId = _register(agentURI);
        for (uint256 i = 0; i < metadata.length; i++) {
            _setMetadata(agentId, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        return _register(agentURI);
    }

    function register() external returns (uint256 agentId) {
        return _register("");
    }

    function _register(string memory agentURI) private returns (uint256 agentId) {
        agentId = _nextAgentId++;
        _totalAgents++;
        _owners[agentId] = msg.sender;
        _balances[msg.sender]++;
        _agentURIs[agentId] = agentURI;

        emit Transfer(address(0), msg.sender, agentId);
        emit Registered(agentId, agentURI, msg.sender);
    }

    // ============ Metadata ============

    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external {
        _requireAuthorized(agentId);
        _setMetadata(agentId, metadataKey, metadataValue);
    }

    function _setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) private {
        if (keccak256(bytes(metadataKey)) == keccak256(bytes(AGENT_WALLET_KEY))) revert ReservedKey();
        _metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        return _metadata[agentId][metadataKey];
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _requireAuthorized(agentId);
        _agentURIs[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function tokenURI(uint256 agentId) external view returns (string memory) {
        if (_owners[agentId] == address(0)) revert NonexistentAgent(agentId);
        return _agentURIs[agentId];
    }

    // ============ Agent wallets ============

    /**
     * @notice Binds an address as a wallet that may act for this agent.
     * @dev The wallet itself must sign, so an agent cannot name an address it does not control and
     *      thereby claim that address's anchored batches as its own. EOAs sign EIP-712; contract
     *      wallets are asked via ERC-1271.
     */
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external {
        _requireAuthorized(agentId);
        if (newWallet == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert SignatureExpired();

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(AGENT_WALLET_TYPEHASH, agentId, newWallet, deadline)))
        );
        if (!_isValidSignature(newWallet, digest, signature)) revert InvalidSignature();

        _agentWallets[agentId] = newWallet;
        emit AgentWalletSet(agentId, newWallet, msg.sender);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _agentWallets[agentId];
    }

    function unsetAgentWallet(uint256 agentId) external {
        _requireAuthorized(agentId);
        _agentWallets[agentId] = address(0);
        emit AgentWalletSet(agentId, address(0), msg.sender);
    }

    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) =
                signer.staticcall(abi.encodeWithSelector(0x1626ba7e, digest, signature));
            return ok && ret.length == 32 && abi.decode(ret, (bytes4)) == bytes4(0x1626ba7e);
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // Reject the malleable upper half of the curve, so one authorisation has one signature.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
        if (v != 27 && v != 28) return false;
        address recovered = ecrecover(digest, v, r, s);
        return recovered != address(0) && recovered == signer;
    }

    // ============ Authorisation ============

    /**
     * @notice Whether `account` may act for `agentId`: its owner, an approved operator, or a wallet
     *         the agent has bound with that wallet's own signature.
     * @dev This is the check that makes "agent N anchored this batch" mean more than an assertion.
     */
    function isAuthorizedOrOwner(address account, uint256 agentId) public view returns (bool) {
        address owner = _owners[agentId];
        if (owner == address(0)) return false;
        return account == owner
            || _tokenApprovals[agentId] == account
            || _operatorApprovals[owner][account]
            || _agentWallets[agentId] == account;
    }

    function _requireAuthorized(uint256 agentId) private view {
        if (_owners[agentId] == address(0)) revert NonexistentAgent(agentId);
        if (!isAuthorizedOrOwner(msg.sender, agentId)) revert NotAuthorized(msg.sender, agentId);
    }

    // ============ View ============

    function totalAgents() external view returns (uint256) {
        return _totalAgents;
    }

    function agentExists(uint256 agentId) external view returns (bool) {
        return _owners[agentId] != address(0);
    }

    // ============ ERC-721 ============

    function ownerOf(uint256 agentId) public view returns (address) {
        address owner = _owners[agentId];
        if (owner == address(0)) revert NonexistentAgent(agentId);
        return owner;
    }

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return _balances[owner];
    }

    function approve(address to, uint256 agentId) external {
        address owner = ownerOf(agentId);
        if (msg.sender != owner && !_operatorApprovals[owner][msg.sender]) revert NotOwner();
        _tokenApprovals[agentId] = to;
        emit Approval(owner, to, agentId);
    }

    function getApproved(uint256 agentId) external view returns (address) {
        if (_owners[agentId] == address(0)) revert NonexistentAgent(agentId);
        return _tokenApprovals[agentId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 agentId) public {
        if (!isAuthorizedOrOwner(msg.sender, agentId)) revert NotAuthorized(msg.sender, agentId);
        if (ownerOf(agentId) != from) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();

        // The agent wallet authorised the previous owner's agent, not the new owner's. Clearing it
        // on transfer stops a sale from silently carrying an authorisation the wallet never gave
        // the buyer — which would let a bought identity claim that wallet's batches.
        if (_agentWallets[agentId] != address(0)) {
            _agentWallets[agentId] = address(0);
            emit AgentWalletSet(agentId, address(0), msg.sender);
        }

        delete _tokenApprovals[agentId];
        _balances[from]--;
        _balances[to]++;
        _owners[agentId] = to;
        emit Transfer(from, to, agentId);
    }

    function safeTransferFrom(address from, address to, uint256 agentId) external {
        safeTransferFrom(from, to, agentId, "");
    }

    function safeTransferFrom(address from, address to, uint256 agentId, bytes memory data) public {
        transferFrom(from, to, agentId);
        if (to.code.length > 0) {
            (bool ok, bytes memory ret) = to.call(
                abi.encodeWithSelector(0x150b7a02, msg.sender, from, agentId, data)
            );
            if (!ok || ret.length != 32 || abi.decode(ret, (bytes4)) != bytes4(0x150b7a02)) revert TransferToNonReceiver();
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7    // ERC-165
            || interfaceId == 0x80ac58cd    // ERC-721
            || interfaceId == 0x5b5e139f;   // ERC-721Metadata
    }
}
